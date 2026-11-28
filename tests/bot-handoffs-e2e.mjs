// Typed, durable handoffs between bots (server/src/bot-handoffs.ts): send_to_bot with task, bounds and
// good_answer; the answer lands word for word in the asking chat under the answering bot's name with no
// model run for the asker; @mentions work the same way; a hop that keeps failing makes the asker say so;
// a hop cut off by a restart runs again. Real server, fake Hermes, a throwaway database.
//   npm run build -w server && node tests/bot-handoffs-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-handoffs-e2e-'));
const PORT = 19100 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const DB = path.join(dir, 'test.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every reply asked of the fake Hermes: which engine (by key) and what it was told. */
const requests = [];
let hangSlow = true;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const input = (() => { try { const j = JSON.parse(body); return typeof j.input === 'string' ? j.input : JSON.stringify(j.input); } catch { return ''; } })();
    const who = req.headers.authorization === 'Bearer key-b' ? 'bea' : 'lead';
    requests.push({ who, input });
    const hop = /handed you this|@mentioned you in their chat/.test(input);
    if (hop && input.includes('ALWAYSFAIL')) { res.statusCode = 500; return res.end('{"error":{"message":"engine broke"}}'); }
    if (hop && input.includes('SLOW') && hangSlow) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; } // never finishes
    const text = hop ? `Backups are fine: last one ran at 03:30. (${input.includes('SLOW') ? 'after restart' : 'first try'})` : 'ok';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text }] } })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`);
    res.end();
  });
}).listen(HERMES_PORT, '127.0.0.1');

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');

let server; let log = ''; let exited;
const startServer = () => {
  server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
    cwd: path.join(root, 'server'),
    env: {
      PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
      ORGO_API_KEY: 'unused', DB_PATH: DB, ENGINES_DIR: path.join(dir, 'engines'),
      HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
      APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', DEV_LOGIN: '1', HOP_BACKOFF_MS: '0,200,200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  exited = new Promise((r) => server.on('exit', (code, sig) => r({ code, sig })));
};
const waitUp = async () => {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); return; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
};

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}\n${log.slice(-1500)}`); }
};

try {
  startServer();
  await waitUp();
  const signIn = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const lead = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  const made = await api('POST', '/bots', { name: 'Bea' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const bea = made.json.bot;
  fs.mkdirSync(path.join(dir, 'engines', bea.id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engines', bea.id, '.env'), 'API_SERVER_KEY=key-b\n');
  { const sql = new Database(DB); sql.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(HERMES_PORT, bea.id); sql.close(); }

  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const until = async (what, fn, tries = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const callTool = async (name, args) => {
    const r = await fetch(`${BASE}/mcp/primary`, {
      method: 'POST',
      headers: { authorization: `Bearer ${crypto.createHmac('sha256', SECRET).update('mcp:primary').digest('hex')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    return j.result?.content?.map((c) => c.text).join('') ?? JSON.stringify(j);
  };
  const answerRow = async (id, needle) => (await rows(id)).find((r) => r.body.type === 'message' && r.body.handoff?.role === 'answer' && r.body.text.includes(needle));

  await test('send_to_bot takes typed fields; the ask shows in the other chat; the answer lands word for word with no model run for the asker', async () => {
    const before = requests.filter((r) => r.who === 'lead').length;
    const out = await callTool('send_to_bot', { bot_name: 'Bea', task: 'Check the backups', bounds: 'Only last night', good_answer: 'One line with the time' });
    assert.match(out, /^Handed to Bea\./);
    const ask = (await rows(bea.id)).find((r) => r.body.handoff?.role === 'ask');
    assert.ok(ask, 'the ask is in Bea\'s chat');
    assert.equal(ask.body.from.id, lead.id);
    assert.match(ask.body.text, /Check the backups[\s\S]*Bounds: Only last night[\s\S]*A good answer: One line with the time/);
    const ans = await until('the answer in the asking chat', () => answerRow(lead.id, 'first try'));
    assert.equal(ans.body.role, 'assistant');
    assert.deepEqual({ kind: ans.body.from.kind, id: ans.body.from.id, name: ans.body.from.name }, { kind: 'bot', id: bea.id, name: 'Bea' });
    assert.equal(ans.body.text, 'Backups are fine: last one ran at 03:30. (first try)');
    assert.equal(ans.body.handoff.askedBy, lead.name);
    const beaTurn = requests.filter((r) => r.who === 'bea').at(-1);
    assert.match(beaTurn.input, /written word for word into .*chat under your name/);
    assert.match(beaTurn.input, /never approves anything/);
    await sleep(300);
    assert.equal(requests.filter((r) => r.who === 'lead').length, before, 'no model ran for the asker');
  });

  await test('the asker is told on its next turn what landed, once', async () => {
    await api('POST', `/bots/${lead.id}/messages`, { text: 'anything new?' });
    const turn = await until('the next lead turn', () => requests.filter((r) => r.who === 'lead').at(-1)?.input.includes('anything new?') && requests.filter((r) => r.who === 'lead').at(-1));
    assert.match(turn.input, /Answers to your handoffs landed[\s\S]*Bea, asked "Check the backups": Backups are fine/);
    await until('that turn to finish', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === lead.id)?.isRunning);
    await api('POST', `/bots/${lead.id}/messages`, { text: 'and now?' });
    const next = await until('another lead turn', () => requests.filter((r) => r.who === 'lead').at(-1)?.input.includes('and now?') && requests.filter((r) => r.who === 'lead').at(-1));
    assert.doesNotMatch(next.input, /Answers to your handoffs landed/);
  });

  await test('a refused handoff says why: no such bot, yourself, a duplicate', async () => {
    assert.match(await callTool('send_to_bot', { bot_name: 'Nobody', task: 'x' }), /No bot named/);
    assert.match(await callTool('send_to_bot', { bot_name: lead.name, task: 'x' }), /That is you/);
    assert.match(await callTool('send_to_bot', { bot_name: 'Bea' }), /Not sent\. Say what the task is/);
  });

  await test('@Bea in the lead chat: Bea answers in that chat under her name, marked as an answer to the mention', async () => {
    await until('lead idle', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === lead.id)?.isRunning);
    await api('POST', `/bots/${lead.id}/messages`, { text: '@Bea are the backups ok?' });
    const ans = await until('the mention answer', () => answerRow(lead.id, 'first try') && rows(lead.id).then((rs) => rs.find((r) => r.body.handoff?.role === 'answer' && r.body.handoff.kind === 'mention')));
    assert.equal(ans.body.from.name, 'Bea');
    const leadTurn = requests.filter((r) => r.who === 'lead' && r.input.includes('@Bea are the backups ok?')).at(-1);
    assert.match(leadTurn.input, /Bea answers in this chat directly, under their own name/);
  });

  await test('a hop that fails every attempt: the asking bot is sent back to say nothing came back', async () => {
    await until('lead idle', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === lead.id)?.isRunning);
    const out = await callTool('send_to_bot', { bot_name: 'Bea', task: 'ALWAYSFAIL check' });
    assert.match(out, /^Handed to Bea/);
    const told = await until('the asker told it failed', () => requests.find((r) => r.who === 'lead' && r.input.includes('failed for good')), 200);
    assert.match(told.input, /Nothing came back\. Tell your owner plainly/);
    assert.equal(requests.filter((r) => r.who === 'bea' && r.input.includes('ALWAYSFAIL')).length, 3, 'three attempts');
  });

  await test('a hop cut off by a restart runs again and still lands', async () => {
    await until('lead idle', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === lead.id)?.isRunning);
    const out = await callTool('send_to_bot', { bot_name: 'Bea', task: 'SLOW check' });
    assert.match(out, /^Handed to Bea/);
    await until('Bea working on it', () => requests.find((r) => r.who === 'bea' && r.input.includes('SLOW')));
    server.kill('SIGKILL');
    await exited;
    hangSlow = false;
    startServer();
    await waitUp();
    const ans = await until('the answer after the restart', () => answerRow(lead.id, 'after restart'), 200);
    assert.equal(ans.body.from.name, 'Bea');
    const sql = new Database(DB, { readonly: true });
    const hop = sql.prepare("SELECT status, attempts FROM bot_hops WHERE task='SLOW check'").get();
    sql.close();
    assert.deepEqual(hop, { status: 'answered', attempts: 2 });
  });

  await test('at most four open handoffs; the fifth is refused, not dropped', async () => {
    hangSlow = true;
    for (let i = 0; i < 4; i++) assert.match(await callTool('send_to_bot', { bot_name: 'Bea', task: `SLOW job ${i}` }), /^Handed to Bea/);
    assert.match(await callTool('send_to_bot', { bot_name: 'Bea', task: 'SLOW job 4' }), /at most 4/);
    assert.match(await callTool('send_to_bot', { bot_name: 'Bea', task: 'SLOW job 0' }), /already asked Bea exactly this/);
  });
} finally {
  server?.kill('SIGKILL');
  hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
process.exit(0);
