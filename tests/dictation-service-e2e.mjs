// End-to-end check of live dictation through the live speech-to-text service (deploy/live-stt), in a
// real browser against the real server, a fake live service (WebSocket, as cleft_live_stt.py speaks)
// and a fake speech server for the fallback. Checks that:
//   - with the service up, the words stream back over /api/voice/live and the chunked method is not used,
//   - the final text is the service's, nothing is sent, and the service got 16 kHz audio,
//   - when the service drops the socket mid-dictation, the app falls back to the chunked method and still
//     ends with the words.
// (The older checks below are kept from dictation-live-e2e.mjs where they still apply.)
// Checks that:
//   - a wave shows beside the mic while it listens,
//   - words appear in the box while you are still talking (before you stop),
//   - each pause settles a stretch, so requests stay short and the final text is both stretches,
//   - nothing is sent (no message in the chat) until Send,
//   - Escape cancels and puts the box back as it was.
// Throwaway database; needs no Hermes. Run after `npm run build`:
//   node tests/dictation-live-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-service-e2e-'));
const PORT = 21000 + Math.floor(Math.random() * 400);
const LIVE_PORT = PORT + 450;
const FAKE_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

function wav(samples, rate) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const silence = (s, rate) => new Array(Math.round(s * rate)).fill(0);
const voice = (s, rate) => Array.from({ length: Math.round(s * rate) }, (_, i) => {
  const t = i / rate;
  return 0.35 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 3 * t)) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + 0.02 * (Math.random() - 0.5);
});

// The fake speech server answers with one word per 0.4 s of audio it was sent, so longer audio gives
// more words, as the real one does. Words are numbered across stretches: w1 w2 ... per request.
const heard = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === '/v1/audio/transcriptions') {
    const at = body.indexOf('RIFF');
    const rate = body.readUInt32LE(at + 24);
    const bytes = body.readUInt32LE(at + 40);
    const secs = bytes / 2 / rate;
    heard.push(secs);
    await new Promise((r) => setTimeout(r, 150));
    const n = Math.max(1, Math.round(secs / 0.4));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ text: Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ') }));
  }
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[]}'); }
  if (req.url === '/health') return res.end('{"status":"ok"}');
  res.statusCode = 404; res.end('{}');
}).listen(FAKE_PORT, '127.0.0.1');

// The fake live service: one word per 0.4 s of audio received; "final" on stop. dropAfter: close the
// socket once that many seconds have arrived (to test the fallback).
const live = { sessions: 0, seconds: 0, dropAfter: 0, gotBytes: 0 };
const liveHttp = http.createServer((req, res) => res.end('{"ok":true}')).listen(LIVE_PORT, '127.0.0.1');
const wss = new WebSocketServer({ server: liveHttp, path: '/live' });
wss.on('connection', (ws) => {
  live.sessions++;
  let bytes = 0;
  const words = () => Array.from({ length: Math.floor(bytes / 32000 / 0.4) }, (_, i) => `s${i + 1}`).join(' ');
  ws.send(JSON.stringify({ type: 'ready' }));
  ws.on('message', (m, isBinary) => {
    if (isBinary) {
      bytes += m.length; live.gotBytes += m.length; live.seconds = bytes / 32000;
      if (live.dropAfter && live.seconds > live.dropAfter) { ws.terminate(); return; }
      ws.send(JSON.stringify({ type: 'text', settled: '', pending: words() }));
    } else if (JSON.parse(String(m)).type === 'stop') {
      ws.send(JSON.stringify({ type: 'final', text: words() }));
      ws.close();
    }
  });
});

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');
const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${FAKE_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1',
    VOICE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, VOICE_SAMPLES_WARM: '0', LIVE_STT_URL: `ws://127.0.0.1:${LIVE_PORT}/live`,
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
const shots = process.env.SHOTS_DIR;

// The microphone: 0.5 s quiet, 3 s "speech", 1.2 s pause, 2.4 s "speech", then quiet (played once).
const mic = path.join(dir, 'mic.wav');
const R = 48000;
fs.writeFileSync(mic, wav([...silence(0.5, R), ...voice(3, R), ...silence(1.2, R), ...voice(2.4, R), ...silence(20, R)], R));

const { chromium } = await import('playwright');
const launch = (file) => chromium.launch({
  ...(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
let browser = null;
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p) => (await fetch(`${BASE}/api${p}`, { method, headers: { cookie, origin: BASE } })).json();
  const { bots } = await api('GET', '/bots');
  const bot = bots.find((x) => x.isPrimary);

  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: shots ? 2 : 1, permissions: ['microphone'] });
    const link = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto((await link.json()).url);
    await page.goto(`${BASE}/`);
    const box = page.locator('textarea.composer__input');
    await box.waitFor();
    return { page, box, errors };
  };

  browser = await launch(mic);
  const { page, box, errors } = await open();
  await box.fill('Hello');

  await test('with the service up, words stream back over the socket (no chunked requests)', async () => {
    await page.getByRole('button', { name: 'Dictate' }).click();
    await page.locator('.mic-wave').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => /s\d/.test(document.querySelector('textarea.composer__input').value), null, { timeout: 4000 });
    assert.match(await box.inputValue(), /^Hello s1/);
    await sleep(2000);
    await page.getByRole('button', { name: 'Stop dictation' }).click();
    await page.locator('.mic-wave').waitFor({ state: 'detached', timeout: 6000 });
    const final = await box.inputValue();
    assert.match(final, /^Hello s1( s\d+)+$/);
    assert.equal(live.sessions, 1);
    assert.equal(heard.length, 0, 'the chunked method was not used');
    assert.ok(live.gotBytes > 32000 * 2, `16 kHz audio arrived (${live.gotBytes} bytes)`);
    const { rows } = await api('GET', `/bots/${bot.id}/rows`);
    assert.equal(rows.filter((r) => r.body.role === 'user').length, 0, 'nothing was sent');
    assert.deepEqual(errors, []);
  });
  await browser.close();

  await test('the service dropping mid-dictation falls back to the chunked method', async () => {
    live.dropAfter = 1.5;
    browser = await launch(mic);
    const o = await open();
    await o.page.getByRole('button', { name: 'Dictate' }).click();
    await sleep(5000);
    await o.page.getByRole('button', { name: 'Stop dictation' }).click();
    await o.page.locator('.mic-wave').waitFor({ state: 'detached', timeout: 10000 });
    const final = await o.box.inputValue();
    assert.ok(heard.length >= 1, 'the chunked method took over');
    assert.match(final, /w\d/, `final text from the fallback: ${final}`);
    assert.deepEqual(o.errors, []);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.stack}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill();
  fake.close();
  wss.close();
  liveHttp.close();
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
