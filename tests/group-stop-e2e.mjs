// End-to-end check of Stop in a group chat (server/src/agent/room-runs.ts) through the real server.
// Two member Bots share a fake Hermes that streams half an answer to a group message and then hangs.
// The group must show both members working; stopping one member ends only that one; stopping the group
// ends the rest, adds "Stopped." and frees the group at once; a member's group turn still queued behind
// its own work is dropped without touching that work. Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:
//   node tests/group-stop-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-stop-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes (both members; told apart by their API key) ----
let hang = true;
const started = { primary: 0, b: 0 };
const groupStarted = { primary: 0, b: 0 };
const disconnected = { primary: 0, b: 0 };
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      const who = (req.headers.authorization ?? '').includes('key-b') ? 'b' : 'primary';
      const group = body.includes('[Group chat');
      started[who]++;
      if (group) groupStarted[who]++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (hang) {
        send('response.output_text.delta', { delta: `Half from ${who}` });
        res.on('close', () => { if (!res.writableEnded) disconnected[who]++; });
        return;
      }
      send('response.output_text.delta', { delta: 'done' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'done' }] } });
      send('response.completed', { response: {} });
      return res.end();
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(HERMES_PORT, '127.0.0.1');

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { default: Database } = await import(path.join(root, 'server/node_modules/better-sqlite3/lib/index.js')).catch(() => import(path.join(root, 'node_modules/better-sqlite3/lib/index.js')));

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const a = bots.find((b) => b.isPrimary);
  assert.ok(a, 'the account has a primary bot');
  const made = await api('POST', '/bots', { name: 'Bea' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const b = made.json.bot;
  // Bea runs on the same fake Hermes, as a managed engine with its own key.
  fs.mkdirSync(path.join(dir, 'engines', b.id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engines', b.id, '.env'), 'API_SERVER_KEY=key-b\n');
  const sql = new Database(path.join(dir, 'test.db'));
  sql.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(HERMES_PORT, b.id);
  sql.close();
  const room = await api('POST', '/rooms', { name: 'Pair', botIds: [a.id, b.id] });
  assert.equal(room.status, 200, JSON.stringify(room.json));
  const roomId = room.json.id;

  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const liveOf = async (id) => (await api('GET', '/bots')).json.live.find((l) => l.botId === id);
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const notices = async (id) => (await rows(id)).filter((x) => x.body.type === 'notice').map((x) => x.body.text);

  await test('a group message shows both members working', async () => {
    const r = await api('POST', `/bots/${roomId}/messages`, { text: 'plan dinner' });
    assert.equal(r.status, 200);
    const live = await until('both members working', async () => {
      const l = await liveOf(roomId);
      return l?.isRunning && l.members?.filter((m) => m.state === 'working').length === 2 ? l : null;
    });
    assert.deepEqual(live.members.map((m) => m.name).sort(), [a.name, 'Bea'].sort());
    await until('both engines to have started', async () => groupStarted.primary === 1 && groupStarted.b === 1);
  });

  await test('stopping one member ends only that one', async () => {
    const s = await api('POST', `/bots/${roomId}/interrupt`, { member: b.id });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.stopped, ['Bea']);
    await until("Bea's stream to close", async () => disconnected.b === 1);
    assert.equal(disconnected.primary, 0, 'the other member keeps going');
    const l = await liveOf(roomId);
    assert.equal(l.isRunning, true);
    assert.deepEqual(l.members.map((m) => m.id), [a.id]);
    assert.ok((await notices(roomId)).includes('Stopped Bea.'));
    await until("Bea's own chat to say why", async () => (await notices(b.id)).includes('Stopped (a reply to the group "Pair").'));
    assert.ok((await rows(b.id)).some((x) => x.body.role === 'assistant' && x.body.text === 'Half from b'), 'what Bea wrote is kept');
  });

  await test('Stop in the group ends the rest and frees the group', async () => {
    const s = await api('POST', `/bots/${roomId}/interrupt`);
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.stopped, [a.name]);
    assert.equal((await liveOf(roomId)).isRunning, false, 'the group is free at once');
    await until('the primary stream to close', async () => disconnected.primary === 1);
    assert.equal((await notices(roomId)).filter((t) => t === 'Stopped.').length, 1);
    await until('the member to stop working', async () => (await liveOf(a.id))?.isRunning === false);
  });

  await test("a member's queued group turn is dropped, its own work is not", async () => {
    // The primary Bot is busy in its own chat; the group's turn for it waits behind that.
    await api('POST', `/bots/${a.id}/messages`, { text: 'my own task' });
    await until('own turn running', async () => (await liveOf(a.id))?.isRunning && started.primary === 2);
    await api('POST', `/bots/${roomId}/messages`, { text: 'second group message' });
    const l = await until('the group to show one working, one queued', async () => {
      const x = await liveOf(roomId);
      return x?.members?.length === 2 && x.members.find((m) => m.id === a.id)?.state === 'queued' ? x : null;
    });
    assert.equal(l.members.find((m) => m.id === b.id).state, 'working');
    await until('Bea started', async () => groupStarted.b === 2);
    const s = await api('POST', `/bots/${roomId}/interrupt`);
    assert.deepEqual(s.json.stopped.sort(), [a.name, 'Bea'].sort());
    await until("Bea's stream to close", async () => disconnected.b === 2);
    assert.equal(disconnected.primary, 1, "the primary Bot's own turn is untouched");
    assert.equal((await liveOf(a.id)).isRunning, true);
    // Its own turn ends; the dropped group turn must not start after it.
    await api('POST', `/bots/${a.id}/interrupt`);
    await until('the own turn to stop', async () => disconnected.primary === 2);
    await sleep(800);
    assert.equal(groupStarted.primary, 1, 'the dropped group turn never reached the engine');
    assert.equal((await liveOf(roomId)).isRunning, false);
  });

  await test('the group answers again right after, and Stop with nothing running is harmless', async () => {
    hang = false;
    await api('POST', `/bots/${roomId}/messages`, { text: 'and now?' });
    await until('both members to finish', async () => groupStarted.primary === 2 && groupStarted.b === 3 && (await liveOf(roomId))?.isRunning === false);
    const before = (await notices(roomId)).length;
    const s = await api('POST', `/bots/${roomId}/interrupt`);
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.stopped, []);
    assert.equal((await notices(roomId)).length, before, 'no notice when nothing was stopped');
  });

  await test('a member id is refused outside a group', async () => {
    assert.equal((await api('POST', `/bots/${a.id}/interrupt`, { member: b.id })).status, 400);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
