// End-to-end check of side chats (server/src/side-chats.ts) through the real server and a fake Hermes:
// a bot's side chat has its own conversation and Hermes session, runs while the main chat is still busy,
// is named from its first message, can be renamed, deleted and brought back; an approval card from the
// Hermes gate and a card from an app tool land in the side chat that made the call, not the main chat;
// the bot's settings stay on the bot. Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:   node tests/side-chats-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chats-e2e-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Hermes: "hang" hangs until the app goes away; "gate" asks the app's gate before a terminal call;
// "ask" calls the app's ask_user tool over MCP; anything else answers at once. ----
const seen = [];
let botIdForMcp = null;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    seen.push({ conversation: b.conversation, input: b.input, instructions: b.instructions });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${botIdForMcp}`).digest('hex');
    if (/hang/.test(b.input)) { send('response.output_text.delta', { delta: 'Working on it' }); return; }
    if (/gate/.test(b.input)) {
      const args = { command: `rm -rf /tmp/${b.conversation}` };
      send('response.output_item.added', { item: { type: 'function_call', name: 'terminal', call_id: 'c1', arguments: JSON.stringify(args) } });
      await sleep(100);
      const r = await fetch(`${BASE}/mcp/${botIdForMcp}/gate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'terminal', args }) }).then((x) => x.json()).catch(() => ({ action: 'block' }));
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify(r) } });
      send('response.output_text.delta', { delta: `gate said ${r.action}` });
      send('response.completed', { response: {} });
      return res.end();
    }
    if (/ask/.test(b.input)) {
      const args = { question: `Which one? (${b.conversation})`, options: ['A', 'B'] };
      send('response.output_item.added', { item: { type: 'function_call', name: 'mcp_hq_ask_user', call_id: 'c2', arguments: JSON.stringify(args) } });
      await sleep(100);
      const r = await fetch(`${BASE}/mcp/${botIdForMcp}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user', arguments: args } }) }).then((x) => x.json());
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c2', output: r.result?.content?.[0]?.text ?? '' } });
      send('response.completed', { response: {} });
      return res.end();
    }
    send('response.output_text.delta', { delta: `answer to ${b.input.slice(-20)}` });
    send('response.output_item.done', { item: { type: 'message', content: [{ text: `answer to ${b.input.slice(-20)}` }] } });
    send('response.completed', { response: {} });
    res.end();
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
  botIdForMcp = bot.id;
  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const sides = async () => (await api('GET', `/bots/${bot.id}/side-chats`)).json.chats;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };

  let side;
  await test('a side chat is made, listed, and not shown as a bot of its own', async () => {
    assert.deepEqual(await sides(), []);
    const r = await api('POST', `/bots/${bot.id}/side-chats`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    side = r.json.chat;
    assert.equal(side.botId, bot.id);
    assert.equal(side.title, 'New chat');
    assert.equal((await sides()).length, 1);
    const list = (await api('GET', '/bots')).json.bots;
    assert.ok(!list.some((b) => b.id === side.id), 'not in the bot list');
    assert.equal(list.find((b) => b.id === bot.id).sideChats.count, 1);
  });

  await test('the side chat answers while the main chat is still working', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'hang on this one' });
    await until('the main chat to be working', async () => (await rows(bot.id)).some((x) => x.body.text === 'Working on it'));
    await api('POST', `/bots/${side.id}/messages`, { text: 'Plan the grocery list for this week please' });
    await until('the side chat to answer', async () => (await rows(side.id)).some((x) => x.body.role === 'assistant' && /answer to/.test(x.body.text)));
    const live = (await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id);
    assert.equal(live.isRunning, true, 'the main chat is still working');
    assert.ok(!(await rows(bot.id)).some((x) => /grocery/.test(x.body.text ?? '')), 'nothing of the side chat in the main chat');
  });

  await test('each chat is its own Hermes session, and the side chat is told what it is', async () => {
    const main = seen.find((s) => /hang/.test(s.input));
    const sc = seen.find((s) => /grocery/.test(s.input));
    assert.equal(main.conversation, `hq-${bot.id}-g1`);
    assert.equal(sc.conversation, `hq-${side.id}-g1`);
    assert.match(sc.instructions, /side chat titled/);
    assert.doesNotMatch(main.instructions, /side chat titled/);
  });

  await test("a side chat's reply notifies as the bot, naming the side chat", async () => {
    const r = await api('GET', '/notify/recent');
    const n = (r.json.notices ?? r.json).find((x) => x.chatId === side.id);
    assert.ok(n, `a notice for the side chat: ${JSON.stringify(r.json).slice(0, 300)}`);
    assert.equal(n.botId, bot.id);
    assert.match(n.title, / · /);
  });

  await test('it is named from its first message, and can be renamed', async () => {
    assert.equal((await sides())[0].title, 'Plan the grocery list for this week please');
    const r = await api('PATCH', `/side-chats/${side.id}`, { title: '  Groceries  ' });
    assert.equal(r.status, 200);
    assert.equal((await sides())[0].title, 'Groceries');
    assert.equal((await api('PATCH', `/side-chats/${side.id}`, { title: ' ' })).status, 400);
  });

  await test('an approval card from the Hermes gate lands in the side chat that asked', async () => {
    await api('POST', `/bots/${side.id}/messages`, { text: 'gate please' });
    const card = await until('a card in the side chat', async () => (await rows(side.id)).find((x) => x.body.card === 'approval'));
    assert.ok(!(await rows(bot.id)).some((x) => x.body.card === 'approval'), 'no card in the main chat');
    assert.equal((await sides())[0].live.awaiting !== null, true, 'the side chat shows it is waiting');
    const d = await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'deny', digest: card.body.digest });
    assert.ok(d.status === 200 || d.status === 403, `answered: ${d.status}`);
    if (d.status === 200) await until('the turn to finish', async () => (await rows(side.id)).some((x) => /gate said block/.test(x.body.text ?? '')));
    else await api('POST', `/bots/${side.id}/interrupt`);
  });

  await test("an app tool's card (ask_user) lands in the side chat that called it", async () => {
    const s2 = (await api('POST', `/bots/${bot.id}/side-chats`, { title: 'Second' })).json.chat;
    await api('POST', `/bots/${s2.id}/messages`, { text: 'ask me' });
    const q = await until('a question card', async () => (await rows(s2.id)).find((x) => x.body.card === 'question'));
    assert.match(q.body.question, new RegExp(s2.id));
    assert.ok(!(await rows(bot.id)).some((x) => x.body.card === 'question'), 'not in the main chat');
    assert.ok(!(await rows(side.id)).some((x) => x.body.card === 'question'), 'not in the other side chat');
  });

  await test('delete takes it out of the list and stops it; Undo brings it back', async () => {
    const before = (await sides()).length;
    const d = await api('DELETE', `/side-chats/${side.id}`);
    assert.equal(d.status, 200);
    assert.equal((await sides()).length, before - 1);
    assert.equal((await api('POST', `/bots/${side.id}/messages`, { text: 'still there?' })).status, 404);
    const u = await api('POST', `/side-chats/${side.id}/restore`);
    assert.equal(u.status, 200);
    assert.equal((await sides()).length, before);
    assert.ok((await rows(side.id)).some((x) => /grocery/i.test(x.body.text ?? '')), 'its messages are back');
  });

  await test("a side chat has the bot's settings and cannot change them", async () => {
    assert.equal((await api('PATCH', `/bots/${side.id}`, { name: 'Other' })).status, 400);
    assert.equal((await api('DELETE', `/bots/${side.id}`)).status, 400);
    assert.equal((await api('POST', `/bots/${side.id}/side-chats`, {})).status, 400);
    await api('PATCH', `/bots/${bot.id}`, { instructions: 'Always say hi.' });
    await api('POST', `/bots/${side.id}/messages`, { text: 'hello again' });
    await until('the next side turn', async () => seen.some((s) => /hello again/.test(s.input)));
    assert.match(seen.find((s) => /hello again/.test(s.input)).instructions, /Always say hi/);
  });

  await test('Stop in the main chat leaves the side chats alone', async () => {
    const stops = async () => (await rows(side.id)).filter((x) => x.body.text === 'Stopped.').length;
    const before = await stops();
    await api('POST', `/bots/${bot.id}/interrupt`);
    await until('the main chat to stop', async () => (await rows(bot.id)).some((x) => x.body.text === 'Stopped.'));
    assert.equal(await stops(), before);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}\n${log.slice(-2000)}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
