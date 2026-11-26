// End-to-end check of live dictation in the message box (web/src/voice/dictation.ts + liveDictation.ts),
// in a real browser against the real server and a fake speech server. The browser's microphone plays
// a clip: speech, a pause, more speech, quiet. Checks that:
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

  let liveSeen = '';
  await test('words appear in the box while still talking, with a wave beside the mic', async () => {
    await page.getByRole('button', { name: 'Dictate' }).click();
    await page.locator('.mic-wave').waitFor({ timeout: 5000 });
    // Before the first pause (0.5 + 3 s), the box already shows words.
    const t0 = Date.now();
    await page.waitForFunction(() => /w\d/.test(document.querySelector('textarea.composer__input').value), null, { timeout: 4000 });
    liveSeen = await box.inputValue();
    assert.ok(Date.now() - t0 < 4000);
    assert.match(liveSeen, /^Hello w1/);
    assert.equal(await box.getAttribute('readonly'), '', 'the box is read-only while dictating');
    // The wave moves: some bar is taller than the resting height.
    await page.waitForFunction(() => [...document.querySelectorAll('.mic-wave span')].some((s) => /scaleY\((0\.[3-9]|1)/.test(s.style.transform)), null, { timeout: 3000 });
    if (shots) await page.screenshot({ path: path.join(shots, 'web-live.png'), clip: { x: 0, y: 560, width: 1000, height: 140 } });
  });

  await test('the pause settles the first stretch; stopping gives both stretches', async () => {
    await sleep(6500); // past the second stretch
    await page.getByRole('button', { name: 'Stop dictation' }).click();
    await page.locator('.mic-wave').waitFor({ state: 'detached', timeout: 8000 });
    const final = await box.inputValue();
    // Two settled stretches of about 3 s and 2.4 s: "w1..w8" and "w1..w6" give or take a word.
    const parts = final.replace(/^Hello /, '').split(/ (?=w1\b)/);
    assert.equal(parts.length, 2, `two stretches: ${final}`);
    assert.ok(heard.length >= 3, `asked more than once while talking (${heard.length})`);
    assert.ok(Math.max(...heard) < 6, `no request covered the whole recording (longest ${Math.max(...heard).toFixed(1)} s)`);
    assert.equal(await box.getAttribute('readonly'), null);
  });

  await test('nothing was sent', async () => {
    const { rows } = await api('GET', `/bots/${bot.id}/rows`);
    assert.equal(rows.filter((r) => r.body.role === 'user').length, 0);
    assert.deepEqual(errors, []);
  });
  await browser.close();

  await test('Escape cancels and puts the box back', async () => {
    browser = await launch(mic);
    const o = await open();
    await o.box.fill('Keep this');
    await o.page.getByRole('button', { name: 'Dictate' }).click();
    await o.page.waitForFunction(() => /w\d/.test(document.querySelector('textarea.composer__input').value), null, { timeout: 5000 });
    await o.page.keyboard.press('Escape');
    await o.page.locator('.mic-wave').waitFor({ state: 'detached', timeout: 3000 });
    await sleep(800);
    assert.equal(await o.box.inputValue(), 'Keep this');
    assert.deepEqual(o.errors, []);
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
