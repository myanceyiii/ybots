// End-to-end check of pinned boards (server/src/board-pin.ts) through the real server: a bot's live
// progress view pins itself, update_view keeps it pinned and marks it done, and a person can unpin and pin it.
// Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/board-pin-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pin-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: every turn answers "ok" at once and records what it was told ----
const told = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      told.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: 'ok' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'ok' }] } });
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
  const call = async (args) => (await mcp('tools/call', { name: 'show_view', arguments: args })).result?.content?.[0]?.text ?? '';
  const tool = async (name, args) => (await mcp('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const viewRow = async (id) => (await rows()).find((r) => r.body?.card === 'view' && r.body.viewId === id);

  let viewId;
  await test('a live progress view pins itself when shown', async () => {
    const out = await tool('show_view', { title: 'Cluster rebuild', blocks: [{ id: 'p', type: 'progress', label: 'Coverage', value: 1, max: 3, live: true }, { id: 'k', type: 'checklist', items: [{ text: 'A', done: true }, { text: 'B', done: false }] }] });
    viewId = out.match(/view (vw_[0-9a-f]+)/)?.[1];
    assert.ok(viewId, out);
    const r = await viewRow(viewId);
    assert.equal(r.body.pin?.on, true);
    assert.equal(r.body.pin.by, 'auto');
  });
  await test('a plain table view does not pin; pin: true pins it', async () => {
    const a = (await tool('show_view', { title: 'Plain', blocks: [{ type: 'table', columns: ['a'], rows: [['1']] }] })).match(/view (vw_[0-9a-f]+)/)[1];
    assert.equal((await viewRow(a)).body.pin, undefined);
    const b = (await tool('show_view', { title: 'Pinned plain', pin: true, blocks: [{ type: 'table', columns: ['a'], rows: [['1']] }] })).match(/view (vw_[0-9a-f]+)/)[1];
    assert.equal((await viewRow(b)).body.pin?.by, 'bot');
  });
  await test('a person unpins it, the bot moving it again does not bring it back, and the person can pin it again', async () => {
    const r = await viewRow(viewId);
    const off = await api('POST', `/bots/${bot.id}/cards/${r.seq}/pin`, { on: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal((await viewRow(viewId)).body.pin.on, false);
    assert.match(await tool('update_view', { view_id: viewId, changes: [{ id: 'p', value: 2 }] }), /^Updated/);
    assert.equal((await viewRow(viewId)).body.pin.on, false);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${r.seq}/pin`, { on: true })).status, 200);
    assert.equal((await viewRow(viewId)).body.pin.on, true);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${r.seq}/pin`, { on: 'yes' })).status, 400);
  });
  await test('finishing the bar and ticking the last item marks it done', async () => {
    await tool('update_view', { view_id: viewId, changes: [{ id: 'p', value: 3 }] });
    assert.equal((await viewRow(viewId)).body.pin.doneAt, undefined, 'an unticked item is still open');
    const r = await viewRow(viewId);
    const item = r.body.blocks.find((b) => b.id === 'k').items[1].id;
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${r.seq}/view`, { op: 'check', block: 'k', item, done: true })).status, 200);
    const done = (await viewRow(viewId)).body.pin;
    assert.equal(done.on, true);
    assert.ok(done.doneAt > 0);
  });
  await test('update_view pin: false unpins', async () => {
    assert.match(await tool('update_view', { view_id: viewId, pin: false }), /^Updated/);
    assert.equal((await viewRow(viewId)).body.pin.on, false);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
