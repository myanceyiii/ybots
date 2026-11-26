// End-to-end check of local screens and voice through the real server, with stand-ins for the parts
// that would otherwise need setting up: a fake speech server (OpenAI audio API) and a fake Hermes agent
// (its /v1/responses stream). Covers:
//   - the live-view relay (browser RFB through the app to x11vnc) and screenshots on local displays,
//   - every voice route, spoken approvals, "goodbye", and Whisper noise,
//   - a whole call in headless Chrome: its microphone plays a recorded clip, the page hears it, the
//     bot answers, and the answer is spoken.
// Needs Xvfb, x11vnc, ImageMagick, Google Chrome and a built app (`npm run build`).
//   node tests/local-voice-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-voice-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---------- a WAV maker ----------

function wav(samples, rate = 24000) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const silence = (s, rate) => new Array(Math.round(s * rate)).fill(0);
/** Something speech-like and loud: a wobbling tone with a little noise. */
const voice = (s, rate) => Array.from({ length: Math.round(s * rate) }, (_, i) => {
  const t = i / rate;
  return 0.35 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 3 * t)) * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + 0.02 * (Math.random() - 0.5);
});

// ---------- fake speech server + fake Hermes ----------

const heard = []; // transcription requests
const spoken = []; // speech requests
const asked = []; // what the bot was sent
let nextTexts = [];
const reply = 'Sure. The Smith deposition is on March third. Want me to put it on your calendar?';

const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === '/v1/audio/transcriptions') {
    const s = body.toString('latin1');
    heard.push({ model: /name="model"\r\n\r\n([^\r]*)/.exec(s)?.[1], hasWav: s.includes('RIFF') && s.includes('WAVE'), bytes: body.length });
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ text: nextTexts.length ? nextTexts.shift() : 'When is the Smith deposition?' }));
  }
  if (req.url === '/v1/audio/speech') {
    spoken.push(JSON.parse(body.toString()));
    res.setHeader('content-type', 'audio/wav');
    return res.end(wav(voice(0.25, 24000)));
  }
  if (req.url === '/health') return res.end('{"ok":true}');
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[]}'); }
  if (req.url === '/v1/responses') {
    asked.push(JSON.parse(body.toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { id: 'r1' } });
    for (const piece of reply.match(/\S+\s*/g)) { await new Promise((r) => setTimeout(r, 30)); send('response.output_text.delta', { delta: piece }); }
    send('response.completed', { response: { id: 'r1' } });
    return res.end();
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ apps: [{
  id: 'demo', name: 'Demo CMS', command: process.execPath, args: [path.join(root, 'tests/fixtures/demo-mcp-server.mjs')],
}] }));

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET, DEV_LOGIN: '1',
    COMPUTER: 'local', LOCAL_STATE_DIR: path.join(dir, 'computer'), LOCAL_RESOLUTION: '1024x640',
    DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: FAKE, HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
    APPS_CONFIG: path.join(dir, 'apps.json'), CLEFTBOT_NO_SCHEDULER: '1',
    VOICE_URL: `${FAKE}/v1`, VOICE_APPROVALS: '1', VOICE_SAMPLES_WARM: '0',
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
const until = async (what, fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 150)); }
};

let browser;
try {
  await until('the server', () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false), 20000);
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  // Sign in the way a person does (through a link): a session made straight from the owner key is a
  // script's, and a script can never answer a card, by voice or otherwise.
  const made = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', name: 'Alex Owner', link: true }) });
  assert.equal(made.status, 200);
  const signIn = await fetch(`${BASE}${new URL((await made.json()).url).pathname}`, { redirect: 'manual' });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'the link signs in');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, json: type.includes('json') ? await r.json() : null, bytes: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const turn = async (callId, text, card) => {
    nextTexts.push(text);
    const fd = new FormData();
    fd.append('botId', bot.id); fd.append('callId', callId);
    if (card) { fd.append('approvalId', card.approvalId); fd.append('digest', card.digest); }
    fd.append('file', new Blob([wav(voice(0.6, 24000))], { type: 'audio/wav' }), 'turn.wav');
    const r = await fetch(`${BASE}/api/voice/turn`, { method: 'POST', headers: { cookie }, body: fd });
    return { status: r.status, json: await r.json() };
  };

  // ---------- local screens ----------

  await test('the computer is this machine and it is running', async () => {
    const { json } = await api('GET', '/computer');
    assert.equal(json.computer.status, 'running');
  });

  await test('the live view relays the bot\'s screen without exposing the VNC password', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/bots/${bot.id}/screen?mode=watch`, ['binary'], { headers: { cookie, origin: BASE } });
    const q = [];
    let waiting = null;
    ws.on('message', (d) => { q.push(Buffer.from(d)); waiting?.(); });
    const read = async (n) => {
      for (;;) {
        const all = Buffer.concat(q);
        if (all.length >= n) { q.length = 0; if (all.length > n) q.push(all.subarray(n)); return all.subarray(0, n); }
        await new Promise((r) => { waiting = r; setTimeout(r, 15000); });
        if (ws.readyState !== WebSocket.OPEN && Buffer.concat(q).length < n) throw new Error('relay closed');
      }
    };
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    ws.send(Buffer.from('RFB 003.008\n'));
    assert.deepEqual([...(await read(2))], [1, 1], 'the browser is offered "no password": the app did the VNC login itself');
    ws.send(Buffer.from([1]));
    assert.equal((await read(4)).readUInt32BE(), 0);
    ws.send(Buffer.from([1]));
    const init = await read(24);
    assert.deepEqual([init.readUInt16BE(0), init.readUInt16BE(2)], [1024, 640]);
    ws.close();
  });

  await test('a screenshot of the bot\'s screen comes from the local display', async () => {
    const r = await api('GET', `/bots/${bot.id}/screenshot`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/jpeg');
    assert.equal(r.bytes[0], 0xff);
  });

  // ---------- voice routes ----------

  await test('voice options list the local voices', async () => {
    const { json } = await api('GET', '/voice/options');
    assert.ok(json.voices.some((v) => v.id === 'af_heart'));
    assert.equal(json.approvalsByVoice, true);
  });

  let callId;
  await test('a call starts with a record in the chat and a greeting by name', async () => {
    const { json } = await api('POST', '/voice/session', { botId: bot.id });
    callId = json.callId;
    assert.match(json.greeting, /^Hi Alex, it's /);
    assert.equal(json.voice, 'af_heart', 'an old xAI voice falls back to the default');
    assert.ok((await rows()).some((r) => r.body.type === 'event' && r.body.event === 'voice-call' && r.body.call.phase === 'started'));
  });

  await test('speech comes back as WAV from the local speech server', async () => {
    const r = await api('POST', '/voice/speak', { botId: bot.id, text: 'Hello there.' });
    assert.equal(r.type, 'audio/wav');
    assert.equal(r.bytes.subarray(0, 4).toString(), 'RIFF');
    const last = spoken.at(-1);
    assert.deepEqual([last.input, last.voice, last.response_format, last.model], ['Hello there.', 'af_heart', 'wav', 'speaches-ai/Kokoro-82M-v1.0-ONNX']);
  });

  await test('what you say becomes a message to the bot, and its answer lands in the chat', async () => {
    const before = asked.length;
    const r = await turn(callId, 'When is the Smith deposition?');
    assert.equal(r.json.text, 'When is the Smith deposition?');
    assert.ok(r.json.seq);
    const row = (await rows()).find((x) => x.seq === r.json.seq);
    assert.equal(row.body.from.kind, 'voice');
    assert.ok(heard.at(-1).hasWav);
    // The first turn also sets up the bot's screen (its browser, wallpaper), which can take a while.
    await until('the bot to be asked', () => asked.length > before, 120000);
    assert.match(asked.at(-1).input, /live voice call/);
    assert.match(asked.at(-1).input, /When is the Smith deposition\?$/);
    await until('the reply', async () => (await rows()).some((x) => x.body.type === 'message' && x.body.role === 'assistant' && !x.body.streaming && x.body.text === reply), 30000);
  });

  await test('Whisper\'s noise ("Thank you.") is ignored', async () => {
    const n = (await rows()).length;
    const r = await turn(callId, 'Thank you.');
    assert.equal(r.json.text, '');
    assert.equal((await rows()).length, n);
  });

  const pendingCards = async () => (await rows()).filter((x) => x.body.type === 'card' && x.body.card === 'approval' && x.body.status === 'pending').map((x) => x.body);
  const ask = (id, to) => {
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    return fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'demo__send_note', arguments: { to, message: { subject: 'Moved', body: 'x' } } } }) }).then((r) => r.json());
  };

  await test('a spoken "yes" with no card read out is sent back to the screen', async () => {
    const pending = ask(1, 'jane');
    await until('an approval card', async () => (await pendingCards()).length === 1);
    const r = await turn(callId, 'Yes, send it.');
    assert.equal(r.json.action, 'review-card');
    assert.equal((await pendingCards()).length, 1);
    // A stale digest for the right card is refused too.
    const [card] = await pendingCards();
    const stale = await turn(callId, 'Yes.', { approvalId: card.approvalId, digest: 'x'.repeat(64) });
    assert.equal(stale.json.action, 'review-card');
    assert.equal((await pendingCards()).length, 1);
    const ok = await turn(callId, 'Yes, send it.', card);
    assert.equal(ok.json.action, 'approved');
    assert.match((await pending).result.content[0].text, /allowed \(Alex Owner, voice call\)[^]*sent "Moved" to jane$/);
  });

  await test('a spoken "yes" is refused while two actions wait', async () => {
    const a = ask(3, 'ann');
    await until('one card', async () => (await pendingCards()).length === 1);
    const [first] = await pendingCards();
    const b = ask(4, 'ben');
    await until('two cards', async () => (await pendingCards()).length === 2);
    const r = await turn(callId, 'Yes.', first);
    assert.equal(r.json.action, 'review-card');
    assert.match(r.json.reason, /2 actions are waiting/);
    assert.equal((await pendingCards()).length, 2);
    // Clear them by voice one at a time is not allowed; answer them as the screen would.
    for (const card of await pendingCards()) await api('POST', `/approvals/${card.approvalId}`, { decision: 'deny', digest: card.digest });
    await Promise.all([a, b]);
  });

  await test('a spoken "no" cancels the card that was read out', async () => {
    const pending = ask(2, 'bob');
    await until('an approval card', async () => (await pendingCards()).length === 1);
    const [card] = await pendingCards();
    const r = await turn(callId, 'No, cancel that.', card);
    assert.equal(r.json.action, 'declined');
    assert.match((await pending).result.content[0].text, /declined/);
  });

  await test('"goodbye" hangs up without asking the bot anything', async () => {
    const before = asked.length;
    const r = await turn(callId, 'Okay, goodbye!');
    assert.equal(r.json.action, 'hangup');
    await new Promise((x) => setTimeout(x, 300));
    assert.equal(asked.length, before);
  });

  await test('ending the call records its length and what was asked', async () => {
    await api('POST', '/voice/end', { botId: bot.id, callId, transcript: [{ role: 'user', text: 'When is the Smith deposition?' }] });
    const ended = (await rows()).find((x) => x.body.type === 'event' && x.body.event === 'voice-call' && x.body.call.phase === 'ended');
    assert.match(ended.body.text, /^Voice call ended · \d+s · 1 request$/);
  });

  await test('dictation in the composer goes to the local speech server', async () => {
    nextTexts.push('Draft a reply to opposing counsel.');
    const fd = new FormData();
    fd.append('file', new Blob([wav(voice(0.5, 24000))], { type: 'audio/wav' }), 'd.wav');
    const r = await fetch(`${BASE}/api/voice/stt`, { method: 'POST', headers: { cookie }, body: fd }).then((x) => x.json());
    assert.equal(r.text, 'Draft a reply to opposing counsel.');
  });

  // ---------- a whole call in a real browser ----------

  await test('a call in Chrome: it greets you, hears you, and speaks the bot\'s answer', async () => {
    const { chromium } = await import('playwright');
    // The fake microphone: 2.5 s quiet, 1.5 s "speech", then quiet (played once).
    const mic = path.join(dir, 'mic.wav');
    fs.writeFileSync(mic, wav([...silence(2.5, 48000), ...voice(1.5, 48000), ...silence(6, 48000)], 48000));
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}%noloop`, '--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    await ctx.addCookies(cookie.split('; ').map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    const before = { heard: heard.length, spoken: spoken.length, asked: asked.length };
    nextTexts.push('When is the Smith deposition?');
    await page.getByRole('button', { name: /Start voice chat with/ }).click();
    await until('the greeting to be spoken', () => spoken.slice(before.spoken).some((s) => /^Hi Alex, it's /.test(s.input)));
    await until('the page to hear the fake microphone and send it', () => heard.length > before.heard, 20000);
    const sent = heard.at(-1);
    assert.ok(sent.hasWav && sent.bytes > 40000, `a WAV of about 1.5 s was sent (${sent.bytes} bytes)`);
    await until('the bot to be asked', () => asked.length > before.asked);
    await until('the whole answer to be spoken', () => spoken.slice(before.spoken).some((s) => s.input.includes('calendar?')), 30000);
    const said = spoken.slice(before.spoken).map((s) => s.input).join(' ');
    assert.ok(said.includes('The Smith deposition is on March third.'), `spoken: ${said}`);
    assert.ok(said.includes('Want me to put it on your calendar?'));
    await page.getByRole('button', { name: 'End call' }).click();
    await until('the call to be recorded', async () => (await rows()).filter((x) => x.body.type === 'event' && x.body.event === 'voice-call' && x.body.call.phase === 'ended').length >= 2);
    assert.deepEqual(errors, []);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.message}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  fake.close();
  // Stop the displays the server started (they are detached on purpose, to outlive the app).
  const state = path.join(dir, 'computer');
  for (const f of fs.existsSync(state) ? fs.readdirSync(state) : []) {
    if (f.endsWith('.pid')) { try { process.kill(Number(fs.readFileSync(path.join(state, f), 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures && process.env.SHOW_LOG) console.log(log);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
