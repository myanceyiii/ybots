// End-to-end check of the Stop button through the real server: a fake Hermes streams half an answer and
// then hangs; POST /bots/:id/interrupt must close the engine stream (Hermes interrupts the agent run when
// its SSE client goes away), keep the half answer, add "Stopped.", clear the working state and leave the
// chat usable. Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/stop-turn-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-turn-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
let turns = 0;
let hang = true;
let disconnected = 0;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      turns++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (hang) {
        // Half an answer, then nothing until the app goes away.
        send('response.output_text.delta', { delta: 'Half an ans' });
        res.on('close', () => { if (!res.writableEnded) disconnected++; });
        return;
      }
      send('response.output_text.delta', { delta: 'second answer' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'second answer' }] } });
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
  const liveOf = async () => (await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id);
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };

  await test('Stop ends a running turn and keeps what was written', async () => {
    const r = await api('POST', `/bots/${bot.id}/messages`, { text: 'write me something long' });
    assert.equal(r.status, 200);
    await until('the turn to be running with half an answer', async () => (await liveOf())?.isRunning && (await rows()).some((x) => x.body.role === 'assistant' && x.body.text === 'Half an ans'));
    const s = await api('POST', `/bots/${bot.id}/interrupt`);
    assert.equal(s.status, 200);
    await until('Hermes to see the stream close', async () => disconnected === 1);
    await until('the working state to clear', async () => (await liveOf())?.isRunning === false);
    const all = await rows();
    const half = all.find((x) => x.body.role === 'assistant' && x.body.text === 'Half an ans');
    assert.ok(half, 'the half answer is kept');
    assert.equal(half.body.streaming, false, 'and no longer shows as streaming');
    assert.ok(all.some((x) => x.body.type === 'notice' && x.body.text === 'Stopped.'), 'a Stopped. line is added');
  });

  await test('the chat works again right after', async () => {
    hang = false;
    const before = turns;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'and now?' });
    await until('the next answer', async () => (await rows()).some((x) => x.body.role === 'assistant' && x.body.text === 'second answer'));
    assert.equal(turns, before + 1);
    assert.equal((await liveOf())?.isRunning, false);
  });

  await test('Stop with nothing running is harmless', async () => {
    const s = await api('POST', `/bots/${bot.id}/interrupt`);
    assert.equal(s.status, 200);
    assert.equal((await rows()).filter((x) => x.body.type === 'notice' && x.body.text === 'Stopped.').length, 1);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
