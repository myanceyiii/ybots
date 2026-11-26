// End-to-end check of routine posts through the real server, with a fake Hermes: a routine's words carry
// the routine's name (from.kind 'routine'); a routine set to "post only when something is found" that ends
// with stay_silent leaves no message at all (its notes are dropped) and its run row says "nothing to report";
// one that finds something posts; one set to report every run posts live. Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:   node tests/routines-quiet-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const Database = createRequire(path.join(root, 'server/package.json'))('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-quiet-e2e-'));
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
      const input = JSON.parse(body).input;
      inputs.push(input);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const say = (t) => { send('response.output_text.delta', { delta: t }); send('response.output_item.done', { item: { type: 'message', content: [{ text: t }] } }); };
      const callTool = (id, name) => {
        send('response.output_item.added', { item: { type: 'function_call', call_id: id, name, arguments: '{}' } });
        send('response.output_item.done', { item: { type: 'function_call_output', call_id: id, output: 'ok' } });
      };
      const n = inputs.length;
      // A note to itself, a search, then either nothing (stay_silent) or a finding.
      if (/Routine "Silent watch"/.test(input)) { say('Name searches can miss card descriptors; check amounts too.'); callTool(`c${n}a`, 'mcp_finance_search_transactions'); say('Nothing yet.'); callTool(`c${n}b`, 'mcp_hq_stay_silent'); }
      else if (/Routine "Found watch"/.test(input)) { callTool(`c${n}a`, 'mcp_finance_search_transactions'); say('The $594.95 charge posted today.'); }
      else if (/Routine "Loud watch"/.test(input)) { callTool(`c${n}a`, 'mcp_finance_search_transactions'); say('Nothing new today.'); callTool(`c${n}b`, 'mcp_hq_stay_silent'); }
      else say(`answer ${n}`);
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
    APPS_CONFIG: path.join(dir, 'apps.json'), // The scheduler stays on: "Run now" goes through it. These routines' own times never come.
    SPEECH: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });

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
  const linked = await (await owner({ email: 'owner@example.com', link: true })).json();
  const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json();
  assert.ok(token, 'a person session');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
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
  const idle = () => until('the turn to finish', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id)?.isRunning);

  // Routines are made by the bot's create_routine tool; here they go straight into the test database.
  const db = new Database(path.join(dir, 'test.db'));
  const add = (id, name, quiet) => db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,quiet) VALUES (?,?,?,?,'0 9 1 1 *','UTC',1,?,?)").run(id, bot.id, name, `Check for ${name}.`, Date.now(), quiet ? 1 : 0);
  add('rt_silent', 'Silent watch', true);
  add('rt_found', 'Found watch', true);
  add('rt_loud', 'Loud watch', false);
  const run = async (id) => {
    const before = inputs.length;
    assert.equal((await api('POST', `/routines/${id}/run`)).status, 200);
    await until('the routine turn', async () => inputs.length > before);
    await idle();
    return inputs.at(-1);
  };
  const said = async () => (await rows()).filter((x) => x.body.type === 'message' && x.body.role === 'assistant' && x.body.text);

  await test('routines list says whether each posts only when something is found', async () => {
    const { json } = await api('GET', `/bots/${bot.id}/routines`);
    assert.deepEqual(json.routines.map((r) => [r.name, r.quiet]), [['Silent watch', true], ['Found watch', true], ['Loud watch', false]]);
  });

  await test('a quiet routine that stays silent leaves no message, and its run row says so', async () => {
    const input = await run('rt_silent');
    assert.match(input, /posts only when something is found/);
    assert.equal((await said()).length, 0, JSON.stringify(await said()));
    const ev = (await rows()).find((x) => x.body.type === 'event' && x.body.ref === 'rt_silent');
    assert.equal(ev.body.text, 'Routine ran: Silent watch · nothing to report');
    assert.ok((await rows()).some((x) => x.body.type === 'tool-call'), 'its steps are still there to look at');
  });

  await test('a quiet routine that finds something posts it, labelled with the routine', async () => {
    await run('rt_found');
    const msgs = await said();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body.text, 'The $594.95 charge posted today.');
    assert.deepEqual(msgs[0].body.from, { kind: 'routine', id: 'rt_found', name: 'Found watch' });
    const ev = (await rows()).find((x) => x.body.type === 'event' && x.body.ref === 'rt_found');
    assert.equal(ev.body.text, 'Running routine: Found watch');
  });

  await test('a routine set to report every run posts even when it stays silent', async () => {
    const input = await run('rt_loud');
    assert.match(input, /report every run/);
    const msgs = (await said()).filter((x) => x.body.from?.id === 'rt_loud');
    assert.deepEqual(msgs.map((x) => x.body.text), ['Nothing new today.']);
  });

  await test('the switch can be changed, and bad values are refused', async () => {
    let r = await api('PATCH', '/routines/rt_loud', { quiet: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.routine.quiet, true);
    assert.equal(r.json.routine.enabled, true, 'quiet alone leaves it running');
    r = await api('PATCH', '/routines/rt_loud', { quiet: 'yes' });
    assert.equal(r.status, 400);
    r = await api('PATCH', '/routines/rt_loud', {});
    assert.equal(r.status, 400);
    r = await api('PATCH', '/routines/rt_loud', { enabled: false });
    assert.equal(r.json.routine.enabled, false);
    assert.equal(r.json.routine.quiet, true);
  });

  await test('a message the person sends is not labelled as a routine', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'hello' });
    const a = await until('the answer', async () => (await said()).find((x) => /^answer/.test(x.body.text)));
    assert.equal(a.body.from, undefined);
  });
  db.close();
} finally {
  server.kill();
  hermes.close();
}
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
