// End-to-end check of steering (server/src/steer-mode.ts) through the real server, with a fake Hermes:
//  - Steer (the default): a message sent while the bot works is marked "Steering", starts no turn, and is
//    handed to the cleft-bot-gate plugin at the next tool step (POST /mcp/<bot>/steer); approval cards stay open.
//  - A note the bot never reached becomes the next turn when the reply ends.
//  - Several notes in a row go together. A shared engine (the primary) only gets notes for a call the app's turn made.
//  - Queue keeps the old behaviour (waits, expires an open card); Interrupt stops the reply and starts over.
//  - In a group, a member already answering the group takes a new group message as a note.
// Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/steering-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-e2e-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: each turn announces a terminal call, then waits until the test lets it finish ----
const requests = []; // { who, body }
const open = []; // finishers of turns still running
let disconnected = 0;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      const who = (req.headers.authorization ?? '').includes('key-b') ? 'b' : 'primary';
      requests.push({ who, body });
      const n = requests.length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const call = { type: 'function_call', call_id: `c${n}`, name: 'terminal', arguments: JSON.stringify({ command: `ls /tmp/${n}` }) };
      send('response.output_item.added', { item: call });
      res.on('close', () => { if (!res.writableEnded) disconnected++; });
      open.push({
        who, n,
        finish: () => {
          if (res.writableEnded || res.destroyed) return;
          send('response.output_item.done', { item: { type: 'function_call_output', call_id: `c${n}`, output: 'ok' } });
          send('response.output_text.delta', { delta: `answer ${n}` });
          send('response.output_item.done', { item: { type: 'message', content: [{ text: `answer ${n}` }] } });
          send('response.completed', { response: {} });
          res.end();
        },
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(HERMES_PORT, '127.0.0.1');
const finishAll = () => { for (const t of open.splice(0)) t.finish(); };

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
  finishAll();
  await sleep(300);
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
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const rows = async (id = bot.id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const liveOf = async (id = bot.id) => (await api('GET', '/bots')).json.live.find((l) => l.botId === id);
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const mcp = (slug, kind, body) => fetch(`${BASE}/mcp/${slug}/${kind}`, {
    method: 'POST', headers: { authorization: `Bearer ${crypto.createHmac('sha256', SECRET).update(`mcp:${slug}`).digest('hex')}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const claim = async (slug, n, extra = {}) => (await (await mcp(slug, 'steer', { tool: 'terminal', args: { command: `ls /tmp/${n}` }, session_id: `s${n}`, ...extra })).json()).steer;
  const rowOf = async (text, id = bot.id) => (await rows(id)).find((x) => x.body.type === 'message' && x.body.role === 'user' && x.body.text === text);
  const made = await api('POST', '/bots', { name: 'Bea' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const b = made.json.bot;
  fs.mkdirSync(path.join(dir, 'engines', b.id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engines', b.id, '.env'), 'API_SERVER_KEY=key-b\n');
  const sql = new Database(path.join(dir, 'test.db'));
  sql.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(HERMES_PORT, b.id);
  sql.close();
  const turnRunning = async (count) => until(`turn ${count} to be running`, async () => requests.length === count && (await liveOf())?.isRunning);

  await test('a bot starts with Steer, and the setting only takes steer, queue or interrupt', async () => {
    assert.equal(bot.busySend, 'steer');
    const bad = await api('PATCH', `/bots/${bot.id}`, { busySend: 'later' });
    assert.equal(bad.status, 400);
    const ok = await api('PATCH', `/bots/${bot.id}`, { busySend: 'queue' });
    assert.equal(ok.json.bot.busySend, 'queue');
    await api('PATCH', `/bots/${bot.id}`, { busySend: 'steer' });
  });

  await test('Steer: a message sent mid-reply is marked, starts no turn, and reaches the bot at the next tool step', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'plan my week' });
    await turnRunning(1);
    const sent = await api('POST', `/bots/${bot.id}/messages`, { text: 'and keep Friday free' });
    assert.equal(sent.status, 200);
    await until('the row to be marked', async () => (await rowOf('and keep Friday free'))?.body.steer === 'pending');
    // A call this turn did not make gets nothing (the primary engine is shared with other front-ends).
    assert.equal(await claim('primary', 99), null);
    const note = await claim('primary', 1);
    assert.match(note, /Steering note from .*while you were working on this reply/);
    assert.match(note, /and keep Friday free/);
    assert.match(note, /never answers or approves an approval card/);
    assert.equal((await rowOf('and keep Friday free')).body.steer, 'read');
    assert.equal(await claim('primary', 1), null, 'a note is handed over once');
    finishAll();
    await until('the reply to finish', async () => (await liveOf())?.isRunning === false);
    await sleep(300);
    assert.equal(requests.length, 1, 'no second turn was started for the note');
  });

  await test('the session the plugin named keeps finding its chat for later tool steps', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'first' });
    await turnRunning(2);
    assert.equal(await claim('primary', 2), null, 'nothing to hand over yet, but the session is learned');
    await api('POST', `/bots/${bot.id}/messages`, { text: 'also this' });
    await api('POST', `/bots/${bot.id}/messages`, { text: 'and that' });
    const note = await claim('primary', 77, { session_id: 's2' });
    assert.match(note, /Steering notes from/);
    assert.match(note, /also this[\s\S]*\n\n[\s\S]*and that/);
  });

  await test('a note the bot never reached becomes the next turn', async () => {
    const before = requests.length;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'draft the email' });
    await turnRunning(before + 1);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'make it short' });
    finishAll();
    await until('the note to start the next turn', async () => requests.length === before + 2);
    assert.match(requests[before + 1].body, /make it short/);
    assert.equal((await rowOf('make it short')).body.steer, 'next');
  });

  await test('Steer leaves an open approval card alone; Queue still expires it', async () => {
    const before = requests.length;
    await api('POST', `/bots/${b.id}/messages`, { text: 'clean up' });
    await until('Bea to start', async () => requests.length === before + 1);
    const n = before + 1;
    let gateSaid = null;
    void mcp(b.id, 'gate', { tool: 'terminal', args: { command: `rm -rf /tmp/${n}` } }).then((r) => r.json()).then((j) => { gateSaid = j; }).catch((e) => { gateSaid = String(e); });
    const card = await until('an approval card', async () => { if (gateSaid) throw new Error(`the gate answered ${JSON.stringify(gateSaid)}`); return (await rows(b.id)).find((x) => x.body.type === 'card' && x.body.card === 'approval' && x.body.status === 'pending'); });
    await api('POST', `/bots/${b.id}/messages`, { text: 'only the old ones' });
    await until('the note to be marked', async () => (await rowOf('only the old ones', b.id))?.body.steer === 'pending');
    assert.equal((await rows(b.id)).find((x) => x.seq === card.seq).body.status, 'pending', 'the card is still open');
    await api('PATCH', `/bots/${b.id}`, { busySend: 'queue' });
    await api('POST', `/bots/${b.id}/messages`, { text: 'never mind' });
    await until('the card to expire', async () => (await rows(b.id)).find((x) => x.seq === card.seq).body.status === 'expired');
    assert.equal((await rowOf('never mind', b.id)).body.steer, undefined, 'a queued message is not marked');
    finishAll();
    await until('the queued message to get its own turn', async () => requests.some((r, i) => i > before && r.body.includes('never mind')));
    await api('PATCH', `/bots/${b.id}`, { busySend: 'steer' });
  });

  await test('Interrupt stops the reply in progress and starts over with the message', async () => {
    await api('PATCH', `/bots/${bot.id}`, { busySend: 'interrupt' });
    const before = requests.length;
    const gone = disconnected;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'long job' });
    await turnRunning(before + 1);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'actually do this instead' });
    await until('the engine stream to close', async () => disconnected === gone + 1);
    await until('the new turn', async () => requests.length === before + 2);
    assert.match(requests[before + 1].body, /actually do this instead/);
    assert.ok((await rows()).some((x) => x.body.type === 'notice' && x.body.text === 'Stopped.'));
    await api('PATCH', `/bots/${bot.id}`, { busySend: 'steer' });
  });

  await test('Stop still stops a reply, and a waiting note then becomes the next turn', async () => {
    const before = requests.length;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'research flights' });
    await turnRunning(before + 1);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'window seat' });
    await api('POST', `/bots/${bot.id}/interrupt`);
    await until('the note to run next', async () => requests.length === before + 2 && requests[before + 1].body.includes('window seat'));
  });

  await test('in a group, a member already answering takes a new group message as a note', async () => {
    const room = (await api('POST', '/rooms', { name: 'Pair', botIds: [bot.id, b.id] })).json;
    const roomId = room.bot?.id ?? room.room?.id ?? room.id;
    assert.ok(roomId, JSON.stringify(room));
    const before = requests.length;
    await api('POST', `/bots/${roomId}/messages`, { text: '@Bea find a restaurant' });
    await until('Bea to start', async () => requests.length === before + 1 && requests[before].who === 'b');
    await api('POST', `/bots/${roomId}/messages`, { text: '@Bea somewhere quiet' });
    await until('the group row to be marked', async () => (await rowOf('@Bea somewhere quiet', roomId))?.body.steer === 'pending');
    // Bea's own engine runs only the app's turns: with one chat working, any tool step of hers takes the note.
    const note = await claim(b.id, 12345);
    assert.match(note, /in the group "Pair"/);
    assert.match(note, /somewhere quiet/);
    assert.equal((await rowOf('@Bea somewhere quiet', roomId)).body.steer, 'read');
    finishAll();
    await sleep(500);
    assert.equal(requests.length, before + 1, 'Bea got no second group turn');
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  finishAll();
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
