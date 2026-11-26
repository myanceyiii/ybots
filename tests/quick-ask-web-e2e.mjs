// End-to-end check of the quick-ask card on the web (web/src/components/QuickAsk.tsx), the page the
// Windows Talk popup shows too: /?talk shows only the card, it listens at once, the words appear as you
// speak, and when you stop talking they are sent by themselves (no Send press). Escape goes on to the app.
// Throwaway database and a fake speech server; needs no Hermes. Run after `npm run build`:
//   node tests/quick-ask-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-live-e2e-'));
const PORT = 20000 + Math.floor(Math.random() * 500);
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
    VOICE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, VOICE_SAMPLES_WARM: '0',
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

// The microphone: 0.5 s quiet, 2.4 s "speech", then quiet (played once).
const mic = path.join(dir, 'mic.wav');
const R = 48000;
fs.writeFileSync(mic, wav([...silence(0.5, R), ...voice(2.4, R), ...silence(30, R)], R));

const { chromium } = await import('playwright');
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

  browser = await chromium.launch({
    ...(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}%noloop`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: shots ? 2 : 1, permissions: ['microphone'] });
  const link = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((await link.json()).url);
  await page.goto(`${BASE}/?talk`);

  await test('/?talk shows only the card, listening at once', async () => {
    await page.locator('.quickask__card').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('textarea.composer__input').count(), 0, 'not the whole app');
    await page.locator('.quickask__wave').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => /w\d/.test(document.querySelector('.quickask__words')?.textContent ?? ''), null, { timeout: 5000 });
    if (shots) await page.screenshot({ path: path.join(shots, 'web-talk-listening.png') });
  });

  await test('sent by itself once you stop talking, then waits for the answer', async () => {
    const t0 = Date.now();
    let sent = null;
    for (let i = 0; i < 40 && !sent; i++) {
      await sleep(250);
      const { rows } = await api('GET', `/bots/${bot.id}/rows`);
      sent = rows.find((r) => r.body.role === 'user');
    }
    assert.ok(sent, 'a message was sent without pressing Send');
    assert.match(sent.body.text, /^w1/);
    assert.ok(Date.now() - t0 < 9000);
    await page.locator('.quickask__asked').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.quickask__asked').textContent(), /^w1/);
    assert.equal(await page.locator('.quickask__wave').count(), 0, 'stopped listening');
    if (shots) await page.screenshot({ path: path.join(shots, 'web-talk-sent.png') });
  });

  await test('Share screen is offered; Escape goes on to the whole app', async () => {
    assert.equal(await page.getByRole('button', { name: 'Share screen' }).count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('textarea.composer__input').waitFor({ timeout: 8000 });
    assert.ok(!page.url().includes('talk'), 'the link is tidied away');
    assert.deepEqual(errors, []);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.stack}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill();
  fake.close();
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
