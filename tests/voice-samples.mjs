// Voice samples (the play button next to each voice): the voice list comes from the speech server,
// each sample is made once and then served from disk, callers at the same time share one request,
// and the warm-up makes them all ahead of time. Uses a fake speech server (OpenAI audio API, plus
// Speaches' GET /v1/models/{id} voice list). Needs a built server (`npm run build -w server`).
//   node tests/voice-samples.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-samples-'));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const MODEL = 'speaches-ai/Kokoro-82M-v1.0-ONNX';

const VOICES = [
  { id: 'af_heart', name: 'af_heart', gender: 'female', language: 'en-us' },
  { id: 'am_onyx', name: 'am_onyx', gender: 'male', language: 'en-us' },
  { id: 'bf_emma', name: 'bf_emma', gender: 'female', language: 'en-gb' },
  { id: 'jf_alpha', name: 'jf_alpha', gender: 'female', language: 'ja' },
  // Like Kokoro's Chinese voices on a Speaches without a Chinese phonemizer: 200 and no audio.
  { id: 'zf_xiaobei', name: 'zf_xiaobei', gender: 'female', language: 'zh' },
];
const SPEAKS = VOICES.filter((v) => v.id !== 'zf_xiaobei');
const spoken = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.method === 'GET' && req.url === `/v1/models/${MODEL}`) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ id: MODEL, task: 'text-to-speech', voices: VOICES }));
  }
  if (req.url === '/v1/audio/speech') {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    spoken.push(body);
    await new Promise((r) => setTimeout(r, 150)); // slow, so callers at the same time overlap
    if (body.voice === 'zf_xiaobei') { res.setHeader('content-type', 'audio/mpeg'); return res.end(); }
    res.setHeader('content-type', body.response_format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    return res.end(Buffer.from(`${body.response_format}:${body.voice}:${body.speed}:${body.input}`));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const start = (extra = {}) => {
  const p = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
    cwd: path.join(root, 'server'),
    env: {
      PATH: process.env.PATH, HOME: dir,
      PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET, DEV_LOGIN: '1',
      DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
      HERMES_BIN: '/bin/false', HERMES_URL: FAKE, HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
      CLEFTBOT_NO_SCHEDULER: '1', COMPUTER: 'off', VOICE_URL: `${FAKE}/v1`, ...extra,
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 150)); }
};

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

let server = start({ VOICE_SAMPLES_WARM: '0' });
try {
  await until('the server', () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false));
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', name: 'Owner' }) });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const get = (p) => fetch(`${BASE}/api${p}`, { headers: { cookie } });

  await test('the voice list is the speech server\'s, named and grouped', async () => {
    const list = await until('the served list', async () => {
      const j = await (await get('/voice/options')).json();
      return j.voices.length === VOICES.length ? j.voices : null;
    });
    assert.deepEqual(list.map((v) => v.id), VOICES.map((v) => v.id));
    assert.deepEqual(list.find((v) => v.id === 'bf_emma'), { id: 'bf_emma', name: 'Emma (British)', gender: 'female', language: 'en-gb', group: 'British English' });
    assert.equal(list.find((v) => v.id === 'am_onyx').name, 'Onyx');
    assert.equal(list.find((v) => v.id === 'jf_alpha').group, 'Japanese');
  });

  await test('a sample is an MP3 of that voice saying its sentence, in its own language', async () => {
    const r = await get('/voice/sample?voice=bf_emma&speed=1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.match(r.headers.get('cache-control'), /max-age=86400/);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "mp3:bf_emma:1:Hi, I'm Emma. This is how I'll sound when we talk.");
    const ja = Buffer.from(await (await get('/voice/sample?voice=jf_alpha')).arrayBuffer()).toString();
    assert.match(ja, /^mp3:jf_alpha:1:こんにちは/);
  });

  await test('a sample is made once, then served from disk', async () => {
    const before = spoken.length;
    for (let i = 0; i < 3; i++) assert.equal((await get('/voice/sample?voice=bf_emma&speed=1')).status, 200);
    assert.equal(spoken.length, before);
    const files = fs.readdirSync(path.join(dir, 'voice-samples'));
    assert.equal(files.filter((f) => f.endsWith('.mp3')).length, 2);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0);
  });

  await test('taps at the same time share one request', async () => {
    const before = spoken.length;
    const all = await Promise.all([1, 2, 3, 4].map(() => get('/voice/sample?voice=af_heart')));
    assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(spoken.length - before, 1);
  });

  await test('speeds snap to the settings\' speeds; unknown voices are refused', async () => {
    const t = Buffer.from(await (await get('/voice/sample?voice=af_heart&speed=1.17')).arrayBuffer()).toString();
    assert.match(t, /^mp3:af_heart:1\.15:/);
    assert.equal((await get('/voice/sample?voice=xx_nobody')).status, 404);
    assert.equal((await get('/voice/sample?voice=../../etc')).status, 404);
  });

  await test('a voice the server can\'t speak is refused, then no longer offered', async () => {
    const r = await get('/voice/sample?voice=zf_xiaobei');
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /no audio/);
    const j = await (await get('/voice/options')).json();
    assert.ok(!j.voices.some((v) => v.id === 'zf_xiaobei'));
    assert.equal(j.voices.length, SPEAKS.length);
  });

  await test('an empty clip left on disk is made again', async () => {
    const before = spoken.length;
    const files = fs.readdirSync(path.join(dir, 'voice-samples')).filter((f) => f.endsWith('.mp3'));
    for (const f of files) fs.writeFileSync(path.join(dir, 'voice-samples', f), '');
    const r = await get('/voice/sample?voice=bf_emma&speed=1');
    assert.ok(Buffer.from(await r.arrayBuffer()).length > 0);
    assert.equal(spoken.length - before, 1);
  });

  await test('signed-out callers get nothing', async () => {
    const r = await fetch(`${BASE}/api/voice/sample?voice=af_heart`);
    assert.equal(r.status, 401);
  });

  // ---------- warm-up ----------
  server.kill(); await new Promise((r) => server.once('exit', r));
  fs.rmSync(path.join(dir, 'voice-samples'), { recursive: true, force: true });
  const before = spoken.length;
  server = start({ VOICE_SAMPLES_WARM_DELAY_MS: '200' });
  await test('the warm-up makes every voice\'s sample ahead of time, one at a time', async () => {
    await until('the warm-up', () => server.log.includes('voice samples ready'));
    const made = spoken.slice(before);
    assert.deepEqual(made.map((s) => s.voice).sort(), VOICES.map((v) => v.id).sort());
    assert.ok(made.every((s) => s.response_format === 'mp3' && s.speed === 1));
    assert.equal(fs.readdirSync(path.join(dir, 'voice-samples')).filter((f) => f.endsWith('.mp3')).length, SPEAKS.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'voice-samples', 'cannot-speak.json'), 'utf8')).ids, ['zf_xiaobei']);
    assert.match(server.log, /left out 1 that can't speak here \(zf_xiaobei\)/);
    const j = await (await fetch(`${BASE}/api/voice/options`, { headers: { cookie } })).json();
    assert.deepEqual(j.voices.map((v) => v.id), SPEAKS.map((v) => v.id));
  });
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  const again = spoken.length;
  server = start({ VOICE_SAMPLES_WARM_DELAY_MS: '200' });
  await test('after a restart the voice that cannot speak is neither offered nor tried again', async () => {
    const ids = async () => { try { return (await (await fetch(`${BASE}/api/voice/options`, { headers: { cookie } })).json()).voices.map((v) => v.id); } catch { return []; } };
    // Until the speech server's own list is read, the built-in list is offered; the broken voice is in neither.
    const want = SPEAKS.map((v) => v.id).join();
    await until('the list without it', async () => { const got = await ids(); assert.ok(!got.includes('zf_xiaobei'), 'never offered after the restart'); return got.join() === want; });
    await until('the warm-up', () => server.log.includes('voice samples ready'));
    assert.ok(!spoken.slice(again).some((s) => s.voice === 'zf_xiaobei'));
  });
} finally {
  server.kill();
  fake.close();
  if (failures) { console.log(server.log.slice(-3000)); }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}
