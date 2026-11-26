// End-to-end check of the fixes for an agent's tools going stale or stuck (2026-11-23, Leonard):
//  - /mcp sessions: initialize gives a session id; a keepalive ping on a session from before a restart, or
//    whose tool list changed, is answered 404 so the agent reconnects and lists the new tools; tool calls on
//    such a session still work;
//  - the Hermes gate lets the tool-search bridge (tool_call, tool_search, tool_describe) through without a card;
//  - a card the gate asked for expires when the agent stops waiting;
//  - a work progress bar left short of full when a turn ends says Stopped; a gauge is left alone.
// Throwaway database, fake Hermes.  Run after `npm run build -w server`:  node tests/tool-refresh-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-refresh-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: every turn answers "ok" at once and records what it was told ----
const told = [];
let reply = 'ok';
let duringTurn = null;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      told.push(body);
      if (duringTurn) { const f = duringTurn; duringTurn = null; await f(); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: reply });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: reply }] } });
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
  // A person's sign-in (a link), so the test can turn off Howard's free-run like the owner would.
  const made = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) });
  assert.equal(made.status, 200);
  const signIn = await fetch(`${BASE}${new URL((await made.json()).url).pathname}`, { redirect: 'manual' });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  // Howard's free-run lets every terminal command through (maintainer-guard.ts); these cases need a card.
  { const off = await api('PUT', `/bots/${bot.id}/free-terminal`, { on: false }); assert.equal(off.status, 200, JSON.stringify(off.json)); }
  assert.ok(bot, 'the account has a primary bot');
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
  let rpc = 0;
  const mcp = async (method, params) => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }) });
    return r.json();
  };

  const post = (method, params, sid, id = bot.id, tok = token) => fetch(`${BASE}/mcp/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
  });

  let sid;
  await test('initialize hands out a session id', async () => {
    const r = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.status, 200);
    sid = r.headers.get('mcp-session-id');
    assert.match(sid ?? '', /^[0-9a-f]{32}$/);
    assert.equal((await r.json()).result.serverInfo.name, 'hq');
  });

  await test('a ping before the first tools/list is fine', async () => {
    assert.equal((await post('ping', {}, sid)).status, 200);
  });

  await test('tools/list then ping: the session is current', async () => {
    const r = await post('tools/list', {}, sid);
    const tools = (await r.json()).result.tools.map((t) => t.name);
    for (const t of ['show_view', 'update_view', 'offer_choices']) assert.ok(tools.includes(t), `${t} is listed`);
    assert.equal((await post('ping', {}, sid)).status, 200);
  });

  await test('a ping with no session id is answered as before', async () => {
    assert.equal((await post('ping', {})).status, 200);
  });

  await test('a ping on a session this server never gave (from before a restart) is 404', async () => {
    const r = await post('ping', {}, 'deadbeef'.repeat(4));
    assert.equal(r.status, 404);
    assert.match(JSON.stringify(await r.json()), /Session not found/);
  });

  await test('a tool call on an unknown session still runs', async () => {
    const r = await post('tools/call', { name: 'list_apps', arguments: {} }, 'deadbeef'.repeat(4));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.result, JSON.stringify(j));
  });

  await test('when the tool list changes, the next ping says reconnect, and a fresh list makes it current again', async () => {
    const r1 = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const s2 = r1.headers.get('mcp-session-id');
    await post('tools/list', {}, s2);
    assert.equal((await post('ping', {}, s2)).status, 200);
    // A closed session is gone too (the agent sends DELETE when it disconnects).
    const del = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': s2 } });
    assert.equal(del.status, 204);
    assert.equal((await post('ping', {}, s2)).status, 404);
  });

  await test('the gate lets tool_call, tool_search and tool_describe through during a turn, with no card', async () => {
    const gate = (tool, args = {}, signal) => fetch(`${BASE}/mcp/${bot.id}/gate`, { method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) }).then((r) => r.json());
    const answers = {};
    let expiredOk = null;
    duringTurn = async () => {
      answers.call = await gate('tool_call', { calls: [{ name: 'mcp__hq__update_view', arguments: { view_id: 'vw_x', changes: [] } }] });
      answers.search = await gate('tool_search', { query: 'update view' });
      answers.describe = await gate('tool_describe', { name: 'mcp__hq__offer_choices' });
      // A tool that asks: the agent gives up waiting after a moment; the card must expire, not stay open.
      const ac = new AbortController();
      const p = gate('terminal', { command: 'touch /tmp/x' }, ac.signal).catch(() => 'aborted');
      const card = await until('the terminal card', async () => (await rows()).find((r) => r.body.card === 'approval' && r.body.status === 'pending'));
      ac.abort();
      assert.equal(await p, 'aborted');
      expiredOk = await until('the card to expire', async () => (await rows()).find((r) => r.seq === card.seq && r.body.status === 'expired'));
    };
    reply = 'done';
    await api('POST', `/bots/${bot.id}/messages`, { text: 'go' });
    await until('the turn to use the gate', async () => answers.describe && expiredOk);
    assert.deepEqual(answers.call, { action: 'allow' });
    assert.deepEqual(answers.search, { action: 'allow' });
    assert.deepEqual(answers.describe, { action: 'allow' });
    assert.ok(!(await rows()).some((r) => r.body.card === 'approval' && /tool call/i.test(r.body.title ?? '')), 'no "tool call" card');
    await until('the turn to end', async () => (await rows()).some((r) => r.body.type === 'message' && r.body.role === 'assistant' && r.body.text === 'done'));
  });

  await test('a work bar left short when the turn ends says Stopped; a gauge and a full bar are left alone', async () => {
    let made = {};
    duringTurn = async () => {
      const t = async (args) => (await (await post('tools/call', { name: 'show_view', arguments: args })).json()).result.content[0].text;
      made.work = await t({ title: 'October spending', blocks: [{ id: 'p1', type: 'progress', label: 'Pulling October spending', value: 0, max: 3, note: 'Step 1 of 3: reading accounts' }] });
      made.live = await t({ title: 'Live', blocks: [{ id: 'p2', type: 'progress', label: 'Working', value: 10, live: true }] });
      made.gauge = await t({ title: 'Groceries', blocks: [{ id: 'g', type: 'progress', label: 'Groceries spent', value: 600, max: 1000, note: '$600 of $1,000' }] });
      made.full = await t({ title: 'Done', blocks: [{ id: 'f', type: 'progress', label: 'All done', value: 3, max: 3, note: 'Step 3 of 3' }] });
    };
    reply = 'partial';
    await api('POST', `/bots/${bot.id}/messages`, { text: 'progress please' });
    await until('the reply', async () => (await rows()).some((r) => r.body.type === 'message' && r.body.text === 'partial'));
    const views = async () => (await rows()).filter((r) => r.body.card === 'view' && !r.body.quick);
    const byTitle = async (t) => (await views()).find((r) => r.body.title === t).body.blocks[0];
    const work = await until('the work bar to say Stopped', async () => { const b = await byTitle('October spending'); return /^Stopped/.test(b.note ?? '') ? b : null; });
    assert.match(work.note, /last step: Step 1 of 3: reading accounts/);
    assert.match((await byTitle('Live')).note ?? '', /^Stopped/);
    assert.equal((await byTitle('Groceries')).note, '$600 of $1,000');
    assert.equal((await byTitle('Done')).note, 'Step 3 of 3');
    // The bot moves the stopped bar again: the Stopped note goes.
    const id = made.work.match(/view (vw_[0-9a-f]+)/)[1];
    const u = await (await post('tools/call', { name: 'update_view', arguments: { view_id: id, changes: [{ id: 'p1', value: 2 }] } })).json();
    assert.ok(!u.result.isError, JSON.stringify(u));
    const moved = await byTitle('October spending');
    assert.equal(moved.value, 2);
    assert.ok(!/^Stopped/.test(moved.note ?? ''), moved.note);
  });

} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
