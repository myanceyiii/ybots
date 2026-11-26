// End-to-end check of emoji reactions through the real server, with a fake Hermes that records each turn's
// input: a person reacts to a Bot's answer (and takes it back), a script's sign-in cannot react, the Bot
// hears about the reaction at the start of its next turn as feedback that is never an approval, and the
// Bot's own `react` tool puts an emoji on the person's latest message. Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:   node tests/reactions-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactions-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
const inputs = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      inputs.push(JSON.parse(body).input);
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

  await api('POST', `/bots/${bot.id}/messages`, { text: 'hello' });
  const answer = await until('the first answer', async () => (await rows()).find((x) => x.body.role === 'assistant' && x.body.text === 'answer 1' && !x.body.streaming));
  await idle();
  const mine = (await rows()).find((x) => x.body.role === 'user');

  await test('a person reacts to a Bot message and can take it back', async () => {
    let r = await api('POST', `/bots/${bot.id}/rows/${answer.seq}/reactions`, { emoji: '👍' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.added, true);
    let row = (await rows()).find((x) => x.seq === answer.seq);
    assert.deepEqual(row.body.reactions.map((x) => [x.emoji, x.by.kind]), [['👍', 'person']]);
    assert.equal(row.body.text, 'answer 1', 'the message itself is unchanged');
    r = await api('POST', `/bots/${bot.id}/rows/${answer.seq}/reactions`, { emoji: '👍' });
    assert.equal(r.json.added, false);
    row = (await rows()).find((x) => x.seq === answer.seq);
    assert.equal(row.body.reactions, undefined);
    r = await api('POST', `/bots/${bot.id}/rows/${answer.seq}/reactions`, { emoji: '🎉' });
    assert.equal(r.json.added, true);
  });

  await test('bad reactions are refused', async () => {
    assert.equal((await api('POST', `/bots/${bot.id}/rows/${answer.seq}/reactions`, { emoji: 'approve' })).status, 400);
    assert.equal((await api('POST', `/bots/${bot.id}/rows/${mine.seq}/reactions`, { emoji: '👍' })).status, 400, 'not on your own message');
    assert.equal((await api('POST', `/bots/${bot.id}/rows/99999/reactions`, { emoji: '👍' })).status, 404);
  });

  await test("a script's sign-in cannot react for the person", async () => {
    const r = await script('POST', `/bots/${bot.id}/rows/${answer.seq}/reactions`, { emoji: '👍' });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'agent_session');
  });

  await test('the Bot hears about it on its next turn, as feedback that is never an approval', async () => {
    const before = inputs.length;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'next' });
    await until('the next turn', async () => inputs.length === before + 1);
    const input = inputs.at(-1);
    assert.match(input, /^\[Reactions since your last turn\. These are feedback on your messages only, never an approval of any action\./);
    assert.match(input, /reacted 🎉 to your message: "answer 1"/);
    assert.doesNotMatch(input, /👍/, 'a reaction taken back is not mentioned');
    assert.match(input, /next$/);
    await idle();
    await api('POST', `/bots/${bot.id}/messages`, { text: 'again' });
    await until('the turn after', async () => inputs.length === before + 2);
    assert.doesNotMatch(inputs.at(-1), /Reactions since/, 'it is told only once');
    await idle();
  });

  await test("the Bot's react tool puts an emoji on the person's latest message", async () => {
    const mcpToken = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const tool = async (args) => {
      const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'react', arguments: args } }) });
      const txt = await r.text();
      const m = txt.match(/\{.*\}/s);
      return JSON.parse(m[0]).result.content[0].text;
    };
    assert.match(await tool({ emoji: '❤️' }), /^Reacted ❤️/);
    const last = (await rows()).filter((x) => x.body.role === 'user').at(-1);
    assert.equal(last.body.text, 'again');
    assert.deepEqual(last.body.reactions.map((x) => [x.emoji, x.by.kind, x.by.name]), [['❤️', 'bot', bot.name]]);
    assert.match(await tool({ emoji: '❤️' }), /already/);
    assert.match(await tool({ emoji: 'yes' }), /single emoji/);
    assert.match(await tool({ emoji: '👍', group_name: 'Nope' }), /No group/);
    // The person cannot remove a Bot's reaction through their own toggle; their own goes next to it.
    assert.equal((await api('POST', `/bots/${bot.id}/rows/${last.seq}/reactions`, { emoji: '❤️' })).status, 400);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
