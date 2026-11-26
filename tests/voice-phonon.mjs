// Phonon as the call voice (VOICE_TTS_ENGINE=phonon): speech from its own server at VOICE_TTS_URL while
// Whisper stays at VOICE_URL, its voice list grouped, raw audio wrapped in a proper WAV, speech streamed
// as it is made, requests taking turns instead of hitting its 429, bots' Kokoro voices moved to Phonon
// ones, and a call in headless Chrome that plays the streamed speech. Fake Phonon + fake Speaches +
// fake Hermes. Needs a built app (`npm run build`) and Chrome for the last check.
//   node tests/voice-phonon.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-phonon-'));
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

const tone = (s, rate = 24000) => {
  const b = Buffer.alloc(Math.round(s * rate) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / rate)), i * 2);
  return b;
};
function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- fake Phonon (ptts-openai-server): one generation at a time, 429 past that ----------
const VOICES = ['Easton', 'Hadley', 'Preston', 'Maeve', 'Edwin', 'Grub the Ogre', 'default'];
const spoken = [];
let busy = 0, maxBusy = 0, refused = 0;
const phonon = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.method === 'GET' && req.url === '/v1/audio/voices') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ voices: VOICES, aliases: {} })); }
  if (req.url === '/v1/audio/speech') {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (busy >= 1) { refused++; res.statusCode = 429; return res.end('{"error":"server_busy"}'); }
    busy++; maxBusy = Math.max(maxBusy, busy);
    spoken.push(body);
    try {
      if (body.speed !== 1) { res.statusCode = 400; return res.end('{"error":"speed"}'); }
      if (body.response_format === 'mp3') { res.setHeader('content-type', 'audio/mpeg'); await new Promise((r) => setTimeout(r, 40)); return res.end(Buffer.from(`ID3 mp3:${body.voice}:${body.input}`)); }
      if (body.response_format !== 'pcm') { res.statusCode = 400; return res.end('{"error":"format"}'); }
      // 1 s of audio in 5 pieces, 80 ms apart; odd-sized pieces so the server has to keep samples whole.
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      const pcm = tone(1);
      const cuts = [0, 4801, 9600, 24001, 36000, pcm.length];
      for (let i = 0; i < cuts.length - 1; i++) { res.write(pcm.subarray(cuts[i], cuts[i + 1])); await new Promise((r) => setTimeout(r, 80)); }
      return res.end();
    } finally { busy--; }
  }
  res.statusCode = 404; res.end();
});
// ---------- fake Speaches (Whisper only) + fake Hermes ----------
const heard = [];
const asked = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url === '/v1/audio/transcriptions') { heard.push(1); res.setHeader('content-type', 'application/json'); return res.end('{"text":"When is the dentist?"}'); }
  if (req.url === '/v1/audio/speech') { res.statusCode = 500; return res.end('{"error":"speech must not come from Speaches"}'); }
  if (req.url === '/health') return res.end('{"ok":true}');
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[]}'); }
  if (req.url === '/v1/responses') {
    asked.push(1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { id: 'r1' } });
    send('response.output_text.delta', { delta: 'Tuesday at nine. Want a reminder?' });
    send('response.completed', { response: { id: 'r1' } });
    return res.end();
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => phonon.listen(0, '127.0.0.1', r));
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const PHONON = `http://127.0.0.1:${phonon.address().port}`;
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const start = () => {
  const p = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
    cwd: path.join(root, 'server'),
    env: {
      PATH: process.env.PATH, HOME: dir,
      PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET, DEV_LOGIN: '1',
      DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
      HERMES_BIN: '/bin/false', HERMES_URL: FAKE, HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
      CLEFTBOT_NO_SCHEDULER: '1', COMPUTER: 'off',
      VOICE_URL: `${FAKE}/v1`, VOICE_TTS_URL: `${PHONON}/v1`, VOICE_TTS_ENGINE: 'phonon', VOICE_TTS_CONCURRENCY: '1',
      VOICE_SAMPLES_WARM_DELAY_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  return p;
};
const until = async (what, fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

let server = start();
let browser;
try {
  await until('the server', () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false));
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const made = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', name: 'Alex Owner', link: true }) });
  const signIn = await fetch(`${BASE}${new URL((await made.json()).url).pathname}`, { redirect: 'manual' });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, json: type.includes('json') ? await r.json() : null, bytes: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);

  await test('the voice list is Phonon\'s, grouped, without "default", and with one speed', async () => {
    // The first ask starts reading Phonon's list (the built-in table is shown until then).
    const json = await until('Phonon\'s own list', async () => { const o = (await api('GET', '/voice/options')).json; return o.voices.some((v) => v.id === 'Grub the Ogre') && o; });
    const ids = json.voices.map((v) => v.id);
    assert.deepEqual(ids, ['Easton', 'Hadley', 'Preston', 'Edwin', 'Maeve', 'Grub the Ogre']);
    assert.deepEqual(json.voices.find((v) => v.id === 'Hadley'), { id: 'Hadley', name: 'Hadley', gender: 'female', language: 'en-us', group: 'American English' });
    assert.equal(json.voices.find((v) => v.id === 'Maeve').name, 'Maeve (British)');
    assert.equal(json.voices.find((v) => v.id === 'Grub the Ogre').group, 'Character voices');
    assert.deepEqual(json.speeds, [1]);
    assert.equal(json.defaultVoice, 'Easton');
    assert.equal(json.streams, true);
  });

  await test('the warm-up makes every voice\'s sample as MP3 at speed 1, one at a time', async () => {
    await until('six samples', () => spoken.filter((s) => s.response_format === 'mp3').length >= 6);
    assert.ok(spoken.filter((s) => s.response_format === 'mp3').every((s) => s.speed === 1 && s.model === 'phonon'));
  });

  await test('speech without streaming is a proper WAV (length in the header, whole samples)', async () => {
    const r = await api('POST', '/voice/speak', { botId: bot.id, text: 'Hello there.', speed: 1.3 });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.type, 'audio/wav');
    assert.equal(r.bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(r.bytes.readUInt32LE(40), 48000, 'one second of 24 kHz 16-bit audio');
    assert.equal(r.bytes.readUInt32LE(24), 24000);
    assert.equal(r.bytes.length, 44 + 48000);
    const last = spoken.at(-1);
    assert.deepEqual([last.response_format, last.speed, last.voice], ['pcm', 1, 'Easton']);
  });

  await test('streamed speech: the header and first audio arrive long before the end', async () => {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/voice/speak`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ botId: bot.id, text: 'Streaming now.', stream: true }) });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const got = [];
    let firstAudioAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(Buffer.from(value));
      if (!firstAudioAt && Buffer.concat(got).length > 44) firstAudioAt = Date.now() - t0;
    }
    const total = Date.now() - t0;
    const all = Buffer.concat(got);
    assert.equal(all.subarray(0, 4).toString(), 'RIFF');
    assert.equal(all.readUInt32LE(40), 0xffffffff, 'length unknown while streaming');
    assert.equal(all.length, 44 + 48000);
    assert.ok(got.slice(1).every((b) => b.length % 2 === 0), 'every piece holds whole samples');
    assert.ok(firstAudioAt < total - 200, `first audio at ${firstAudioAt} ms, done at ${total} ms`);
  });

  await test('requests at the same time take turns: Phonon never says busy', async () => {
    const before = refused;
    const rs = await Promise.all([1, 2, 3, 4].map((i) => api('POST', '/voice/speak', { botId: bot.id, text: `Sentence ${i}.` })));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(refused, before);
    assert.equal(maxBusy, 1);
  });

  await test('a bot with a Kokoro voice is moved to the Phonon voice of the same kind on start', async () => {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    const db = new Database(path.join(dir, 'test.db'));
    db.prepare('UPDATE bots SET voice=? WHERE id=?').run('af_heart', bot.id);
    db.close();
    server = start();
    await until('the server again', () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false));
    const { json } = await api('GET', '/bots');
    assert.equal(json.bots.find((b) => b.id === bot.id).voice, 'Hadley');
    const s = await api('POST', '/voice/session', { botId: bot.id });
    assert.equal(s.json.voice, 'Hadley');
    await api('POST', '/voice/end', { botId: bot.id, callId: s.json.callId, transcript: [] });
  });

  await test('a call in Chrome plays the streamed speech (the call bar shows Speaking)', async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    await ctx.addCookies(cookie.split('; ').map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    const before = spoken.length;
    await page.getByRole('button', { name: /Start voice chat with/ }).click();
    await until('the greeting to be asked for, streamed', () => spoken.slice(before).some((s) => /^Hi Alex, it's /.test(s.input) && s.response_format === 'pcm'));
    await page.waitForSelector('.vcall.is-speaking', { timeout: 10000 });
    await page.waitForSelector('.vcall:not(.is-speaking)', { timeout: 10000 });
    await page.getByRole('button', { name: 'End call' }).click();
    assert.deepEqual(errors, []);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.message}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  phonon.close(); fake.close();
  if (failures) console.log(server.log.slice(-3000));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
