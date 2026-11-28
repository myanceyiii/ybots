// End-to-end check of the routine safety rules (server/src/routines.ts, from OpenBot's "fatigue rule"), through
// the real server with a fake Hermes: a failing routine posts its error once, then only its run line changes;
// the tenth failure in a row switches it off and says so; Turn back on starts the count again; a schedule
// more often than every 15 minutes is refused; at most 20 recurring routines are on per person (one-time
// reminders do not count). Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:   node tests/routine-safety-e2e.mjs
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-safety-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
const inputs = [];
let broken = true;
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
      if (broken && /Routine "Broken watch"/.test(input)) send('response.failed', { response: { error: { message: 'the mail connector is signed out' } } });
      else { send('response.output_text.delta', { delta: 'Found one.' }); send('response.output_item.done', { item: { type: 'message', content: [{ text: 'Found one.' }] } }); send('response.completed', { response: {} }); }
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

  const db = new Database(path.join(dir, 'test.db'));
  const add = (id, name, { schedule = '0 9 1 1 *', enabled = 1, once = 0 } = {}) => db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,quiet,run_once) VALUES (?,?,?,?,?,'UTC',?,?,0,?)").run(id, bot.id, name, `Check for ${name}.`, schedule, enabled, Date.now(), once);
  add('rt_broken', 'Broken watch');
  const run = async (id) => {
    const before = inputs.length;
    assert.equal((await api('POST', `/routines/${id}/run`)).status, 200);
    await until('the routine turn', async () => inputs.length > before);
    await idle();
    await sleep(100);
  };
  const notices = async () => (await rows()).filter((x) => x.body.type === 'notice' && x.body.tone === 'error');
  const routine = async (id) => (await api('GET', `/bots/${bot.id}/routines`)).json.routines.find((r) => r.id === id);

  await test('the first failure posts the error once', async () => {
    await run('rt_broken');
    const n = await notices();
    assert.equal(n.length, 1, JSON.stringify(n));
    assert.match(n[0].body.text, /signed out|failed/i);
    const r = await routine('rt_broken');
    assert.equal(r.failCount, 1);
    assert.match(r.lastError, /signed out/);
    assert.equal(r.enabled, true);
  });

  await test('later failures stay quiet: only the run line says it failed again', async () => {
    for (let i = 2; i <= 9; i++) await run('rt_broken');
    assert.equal((await notices()).length, 1);
    const runs = (await rows()).filter((x) => x.body.type === 'event' && x.body.ref === 'rt_broken');
    assert.equal(runs.at(-1).body.text, 'Routine failed again: Broken watch (9 in a row)');
    const r = await routine('rt_broken');
    assert.equal(r.failCount, 9);
    assert.equal(r.enabled, true);
  });

  await test('the tenth failure in a row switches it off and says so', async () => {
    await run('rt_broken');
    const r = await routine('rt_broken');
    assert.equal(r.enabled, false);
    assert.ok(r.autoOffAt > 0, 'autoOffAt is set');
    assert.equal(r.failCount, 10);
    const n = await notices();
    assert.equal(n.length, 2);
    assert.match(n[1].body.text, /turned off after 10 failures in a row/);
  });

  await test('Turn back on starts the count again, and a good run keeps it at zero', async () => {
    const p = await api('PATCH', '/routines/rt_broken', { enabled: true });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.routine.enabled, true);
    assert.equal(p.json.routine.autoOffAt, null);
    assert.equal(p.json.routine.failCount, 0);
    broken = false;
    await run('rt_broken');
    const r = await routine('rt_broken');
    assert.equal(r.failCount, 0);
    assert.equal(r.lastError, null);
  });

  await test('a success between failures resets the count', async () => {
    broken = true;
    await run('rt_broken');
    assert.equal((await routine('rt_broken')).failCount, 1);
    broken = false;
    await run('rt_broken');
    assert.equal((await routine('rt_broken')).failCount, 0);
  });

  await test('a schedule more often than every 15 minutes cannot be switched on', async () => {
    add('rt_fast', 'Fast watch', { schedule: '*/5 * * * *', enabled: 0 });
    const p = await api('PATCH', '/routines/rt_fast', { enabled: true });
    assert.equal(p.status, 409);
    assert.match(p.json.error, /every 15 minutes/);
    add('rt_ok', 'Quarter watch', { schedule: '*/15 * * * *', enabled: 0 });
    assert.equal((await api('PATCH', '/routines/rt_ok', { enabled: true })).status, 200);
  });

  await test('at most 20 recurring routines are on; one-time reminders do not count', async () => {
    // On now: rt_broken, rt_ok. Add 18 more on, then two one-time reminders.
    for (let i = 0; i < 18; i++) add(`rt_n${i}`, `Watch ${i}`);
    add('rt_once1', 'Once 1', { once: 1 });
    add('rt_off', 'Spare watch', { enabled: 0 });
    const p = await api('PATCH', '/routines/rt_off', { enabled: true });
    assert.equal(p.status, 409);
    assert.match(p.json.error, /20 routines/);
    assert.equal((await api('PATCH', '/routines/rt_ok', { enabled: false })).status, 200);
    assert.equal((await api('PATCH', '/routines/rt_off', { enabled: true })).status, 200);
  });
  db.close();
} finally {
  server.kill();
  hermes.close();
}
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
