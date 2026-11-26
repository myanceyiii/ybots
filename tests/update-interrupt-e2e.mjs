// A deploy restarts the server. A bot that is mid-reply then must say so in its chat ("Interrupted by an
// update") instead of the reply silently vanishing (Alex, 2026-11-24: Howard "ran for 11 seconds and then
// disappeared" during a deploy). Also: the machine-local health answer names the busy bots, which cleft-ops
// waits for. Real server, fake Hermes whose reply hangs, a throwaway database.
//   npm run build -w server && node tests/update-interrupt-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-interrupt-e2e-'));
const PORT = 18500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake Hermes: starts a reply and never finishes it.
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Working on it' })}\n\n`);
  });
}).listen(HERMES_PORT, '127.0.0.1');

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');
const DB = path.join(dir, 'test.db');
const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: DB, ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', DEV_LOGIN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const exited = new Promise((r) => server.on('exit', (code, sig) => r({ code, sig })));

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}\n${log.slice(-1200)}`); }
};

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const signIn = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const bot = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);

  await test('health from the machine names no busy bot while idle', async () => {
    const { commit, uptimeSec, ...h } = await (await fetch(`${BASE}/api/health`)).json();
    assert.deepEqual(h, { ok: true, engine: 'hermes', busy: [] });
    assert.equal(typeof uptimeSec, 'number');
  });

  await api('POST', `/bots/${bot.id}/messages`, { text: 'please do a long job' });

  await test('a running reply makes its bot busy in the health answer', async () => {
    let h;
    for (let i = 0; i < 50; i++) { h = await (await fetch(`${BASE}/api/health`)).json(); if (h.busy?.length) break; await sleep(100); }
    assert.deepEqual(h.busy, [bot.name]);
  });

  await test('health through a proxy says only ok', async () => {
    const h = await (await fetch(`${BASE}/api/health`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
    assert.deepEqual(h, { ok: true, engine: 'hermes' });
  });

  await test('a restart (SIGTERM) leaves "Interrupted by an update" in the chat and exits cleanly', async () => {
    server.kill('SIGTERM');
    const { code } = await Promise.race([exited, sleep(10000).then(() => ({ code: 'timeout' }))]);
    assert.equal(code, 0, 'exits 0');
    const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
    let notices;
    if (DatabaseSync) {
      const db = new DatabaseSync(DB, { readOnly: true });
      notices = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice'").all(bot.id).map((r) => JSON.parse(r.body).text);
    } else {
      const Database = (await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'))).default;
      const db = new Database(DB, { readonly: true });
      notices = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice'").all(bot.id).map((r) => JSON.parse(r.body).text);
    }
    assert.ok(notices.some((t) => /Interrupted by an update to the app\. Send your message again/.test(t)), JSON.stringify(notices));
    assert.ok(!notices.includes('Stopped.'), 'not the plain Stop line');
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.stack}\n${log.slice(-2000)}`);
} finally {
  server.kill('SIGKILL'); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
