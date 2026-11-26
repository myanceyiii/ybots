// Undo "New conversation", through the real server with a fake Hermes: the earlier chat comes back with its
// rows and its model history, new messages carry on after it, and undo is refused once something was said in
// the new chat or when there is nothing to undo. Throwaway database.
// Run after `npm run build -w server`:   node tests/fresh-undo-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-undo-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
const inputs = [];
const convs = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      inputs.push(JSON.parse(body).input);
      convs.push(JSON.parse(body).conversation);
      const answer = `answer ${inputs.length}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: answer });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: answer }] } });
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

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (body) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // A person's session: a one-time sign-in link opened by "the phone app" (bearer token).
  const linked = await (await owner({ email: 'owner@example.com', link: true })).json();
  const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json();
  assert.ok(token, 'a person session');
  // A script's session (a Claude thread).
  const scriptIn = await owner({ email: 'owner@example.com', agent: 'Claude: test' });
  const scriptCookie = scriptIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (auth, method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...auth, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const api = (m, p, b) => call({ authorization: `Bearer ${token}` }, m, p, b);
  const script = (m, p, b) => call({ cookie: scriptCookie }, m, p, b);
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const idle = () => until('the turn to finish', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id)?.isRunning);

  const mcp = async (name, args) => {
    const mcpToken = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const m = (await r.text()).match(/\{.*\}/s);
    return JSON.parse(m[0]).result.content[0].text;
  };

  const say = async (text) => {
    const r = await api('POST', `/bots/${bot.id}/messages`, { text });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await until('the answer', async () => (await rows()).some((x) => x.body.role === 'assistant' && x.body.text === `answer ${inputs.length}` && inputs.length > 0));
    await idle();
  };
  const texts = async () => (await rows()).filter((x) => x.kind === 'message').map((x) => x.body.text);

  await test('nothing to undo before a clear', async () => {
    assert.equal((await api('POST', `/bots/${bot.id}/fresh/undo`)).status, 409);
  });

  await test('New conversation can be undone, and the chat carries on where it was', async () => {
    await say('first question');
    const before = await texts();
    assert.ok(before.includes('first question'));
    const g1 = (await api('GET', `/bots/${bot.id}/rows`)).json.generation;
    assert.equal((await api('POST', `/bots/${bot.id}/fresh`)).status, 200);
    assert.equal((await rows()).length, 0, 'the new chat is empty');
    const undo = await api('POST', `/bots/${bot.id}/fresh/undo`);
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.equal(undo.json.generation, g1);
    assert.deepEqual(await texts(), before, 'the earlier rows are back');
    await say('second question');
    const after = await rows();
    assert.ok(after.map((x) => x.body.text).includes('second question'));
    const seqs = after.map((x) => x.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no row was written over');
    // The engine carries on the same thread (it is keyed by the conversation's generation).
    assert.ok(convs[0], 'the engine was given a conversation');
    assert.equal(convs.at(-1), convs[0], 'the same engine conversation after the undo');
    assert.equal((await api('POST', `/bots/${bot.id}/fresh/undo`)).status, 409, 'only once');
  });

  await test('undo is refused once something was said in the new chat', async () => {
    assert.equal((await api('POST', `/bots/${bot.id}/fresh`)).status, 200);
    await say('a new start');
    const r = await api('POST', `/bots/${bot.id}/fresh/undo`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already said/);
    assert.ok((await texts()).includes('a new start'));
  });

  await test('a second clear after an undo starts a clean chat', async () => {
    assert.equal((await api('POST', `/bots/${bot.id}/fresh`)).status, 200);
    assert.equal((await api('POST', `/bots/${bot.id}/fresh/undo`)).status, 200);
    assert.equal((await api('POST', `/bots/${bot.id}/fresh`)).status, 200);
    assert.equal((await rows()).length, 0);
    await say('clean');
    assert.deepEqual((await texts()).filter((t) => t === 'clean').length, 1);
    assert.notEqual(convs.at(-1), convs[0], 'a new engine conversation');
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
