// Bot pictures against a stand-in image service: pictures come back with the right type (JPEG from
// the bridge, PNG otherwise), a refused prompt shows the service's own reason, tweaks send the bot's
// picture as the reference, a new picture makes the pose set, and a bot's look card only changes the
// look when the owner picks a picture on it.
// Run after `npm run build -w server`:  node tests/avatar-generate.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-generate-'));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// A 1x1 JPEG and PNG, as an image service would send them (bare base64).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const asked = [];
let holdSlow = true;
const held = [];
const images = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const { prompt, n, image } = JSON.parse(body);
    asked.push({ prompt, n, image: image ?? null });
    res.setHeader('content-type', 'application/json');
    // "slow": hold the answer until the test lets it go (a server restart happens meanwhile).
    if (prompt.includes('slow') && holdSlow) { held.push(res); return; }
    if (prompt.includes('refuse')) { res.statusCode = 422; res.end(JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } })); return; }
    res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ b64_json: i % 2 ? PNG : JPEG })) }));
  });
});
await new Promise((r) => images.listen(0, '127.0.0.1', r));

const serverEnv = {
  PATH: process.env.PATH, HOME: dir,
  PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
  ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
  HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  APPS_CONFIG: path.join(dir, 'apps.json'), CLEFTBOT_NO_SCHEDULER: '1',
  AVATAR_IMAGE_URL: `http://127.0.0.1:${images.address().port}/v1/images/generations`,
};
let log = '';
const startServer = () => {
  const p = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], { cwd: path.join(root, 'server'), env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  return p;
};
let server = startServer();
const serverUp = async () => {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await new Promise((r) => setTimeout(r, 200)); }
  }
};

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

try {
  await serverUp();
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('/bots');
  const bot = bots[0];

  await test('three pictures come back, each marked with its real type', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a cheerful robot' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.candidates.length, 3);
    assert.ok(r.json.candidates[0].startsWith('data:image/jpeg;base64,'));
    assert.ok(r.json.candidates[1].startsWith('data:image/png;base64,'));
  });
  await test("a refused prompt shows the service's own reason", async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'please refuse this' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /said no: Your request was rejected by the safety system\./);
  });
  await test('a chosen picture can be saved as the bot\'s look', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a cheerful robot' });
    const put = await fetch(`${BASE}/api/bots/${bot.id}/avatar`, { method: 'PUT', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ image: r.json.candidates[0] }) });
    assert.equal(put.status, 200);
    const got = await fetch(`${BASE}/api/bots/${bot.id}/avatar`, { headers: { cookie } });
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
  });
  const mcp = async (name, args) => {
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const botNow = async () => (await api('/bots')).json.bots.find((b) => b.id === bot.id);
  const waitFor = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const rows = async () => (await api(`/bots/${bot.id}/rows`)).json.rows;
  const lookCards = async () => (await rows()).filter((r) => r.body.type === 'card' && r.body.card === 'look');

  await test('the apps start a picture run and ask until it is done (no long request a proxy could cut off)', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a cheerful robot', count: 2, wait: false });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.ok(r.json.run);
    const done = await waitFor('run', async () => { const s = (await api(`/bots/${bot.id}/avatar/generate/${r.json.run}`)).json; return s.state !== 'making' && s; });
    assert.equal(done.state, 'done');
    assert.equal(done.candidates.length, 3);
    const refused = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'please refuse this', wait: false });
    const failed = await waitFor('run', async () => { const s = (await api(`/bots/${bot.id}/avatar/generate/${refused.json.run}`)).json; return s.state !== 'making' && s; });
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /rejected by the safety system/);
    const lost = await api(`/bots/${bot.id}/avatar/generate/run_unknown`);
    assert.equal(lost.status, 404);
    assert.match(lost.json.error, /server restarted/);
  });

  await test('a finished run can be asked for again, and is listed until an app has shown it', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a calm owl', count: 2, wait: false });
    const first = await waitFor('run', async () => { const s = (await api(`/bots/${bot.id}/avatar/generate/${r.json.run}`)).json; return s.state !== 'making' && s; });
    const second = (await api(`/bots/${bot.id}/avatar/generate/${r.json.run}`)).json;
    assert.deepEqual(second, first, 'a reply lost on the way (a phone asleep) can be asked for again');
    const listed = (await api(`/bots/${bot.id}/avatar/runs`)).json.runs;
    const mine = listed.find((x) => x.id === r.json.run);
    assert.ok(mine, 'listed for an app that comes back');
    assert.equal(mine.state, 'done');
    assert.equal(mine.ask.description, 'a calm owl');
    assert.equal((await api(`/bots/${bot.id}/avatar/generate/${r.json.run}/seen`, {})).status, 200);
    assert.ok(!(await api(`/bots/${bot.id}/avatar/runs`)).json.runs.some((x) => x.id === r.json.run), 'not offered again once shown');
    assert.equal((await api(`/bots/${bot.id}/avatar/generate/${r.json.run}`)).json.state, 'done', 'still readable after it was shown');
  });

  await test('a run that was drawing when the server restarted is drawn again', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a slow tortoise', count: 1, wait: false });
    await waitFor('asked once', async () => held.length === 1);
    assert.equal((await api(`/bots/${bot.id}/avatar/runs`)).json.runs.find((x) => x.id === r.json.run)?.state, 'making');
    server.kill();
    await new Promise((res) => server.once('exit', res));
    for (const h of held.splice(0)) h.destroy();
    holdSlow = false;
    server = startServer();
    await serverUp();
    const done = await waitFor('run after restart', async () => { const s = (await api(`/bots/${bot.id}/avatar/generate/${r.json.run}`)).json; return s.state !== 'making' && s; });
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.candidates.length, 3);
  });

  await test('it always draws 3 pictures, whatever count an older app sends', async () => {
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a cheerful robot', count: 6 });
    assert.equal(r.json.candidates.length, 3);
    const big = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'a cheerful robot', count: 50 });
    assert.equal(big.json.candidates.length, 3);
  });

  await test('a new picture makes all eleven poses from it', async () => {
    const b = await waitFor('poses', async () => { const b = await botNow(); return b.avatarPoseJob?.state === 'ready' && b; });
    assert.equal(Object.keys(b.avatarPoses).length, 11);
    assert.equal(b.avatarPoseJob.done, 11);
    const poseCalls = asked.filter((a) => a.prompt.startsWith('The same character'));
    assert.equal(poseCalls.length, 11);
    assert.ok(poseCalls.every((a) => a.image && a.image.startsWith('data:image/') && a.n === 1), 'every pose starts from the picture');
    const got = await fetch(`${BASE}${b.avatarPoses.thinking}`, { headers: { cookie } });
    assert.equal(got.status, 200);
  });

  await test('a tweak sends the bot\'s picture as the reference', async () => {
    asked.length = 0;
    const r = await api(`/bots/${bot.id}/avatar/generate`, { prompt: 'add sunglasses', intent: 'tweak', count: 2 });
    assert.equal(r.status, 200);
    assert.ok(asked[0].image?.startsWith('data:image/jpeg'), 'reference sent');
    assert.match(asked[0].prompt, /reference picture: add sunglasses/);
  });

  await test('one pose can be made again, and poses can be turned off', async () => {
    asked.length = 0;
    const r = await api(`/bots/${bot.id}/avatar/poses`, { poses: ['happy'], note: 'keep the hat on' });
    assert.equal(r.status, 200);
    await waitFor('one pose', async () => (await botNow()).avatarPoseJob?.state === 'ready' && asked.length === 1);
    assert.match(asked[0].prompt, /keep the hat on/);
    const del = await fetch(`${BASE}/api/bots/${bot.id}/avatar/poses`, { method: 'DELETE', headers: { cookie, origin: BASE } });
    assert.equal(del.status, 200);
    assert.deepEqual((await botNow()).avatarPoses, {});
  });

  await test("a bot's look card fills with pictures and changes nothing until one is picked", async () => {
    const picture = async () => Buffer.from(await (await fetch(`${BASE}/api/bots/${bot.id}/avatar`, { headers: { cookie } })).arrayBuffer()).toString('base64');
    const before = await picture();
    const out = await mcp('change_my_look', { description: 'add a red scarf', intent: 'tweak', count: 4 });
    assert.ok(!out.isError, JSON.stringify(out));
    const card = await waitFor('pictures', async () => { const c = (await lookCards()).at(-1); return c?.body.status === 'pending' && c; });
    assert.equal(card.body.candidates.length, 3);
    assert.equal(card.body.intent, 'tweak');
    assert.equal(await picture(), before, 'look unchanged before a pick');
    const pic = await fetch(`${BASE}/api/bots/${bot.id}/look/${card.body.candidates[2]}`, { headers: { cookie } });
    assert.equal(pic.status, 200);
    const more = await api(`/bots/${bot.id}/look-cards/${card.seq}/more`, { count: 2, style: 'plush' });
    assert.equal(more.status, 200);
    const card2 = await waitFor('more pictures', async () => { const c = (await lookCards()).at(-1); return c?.body.status === 'pending' && c.body.candidates.length === 6 && c; });
    assert.equal(card2.body.style, 'plush');
    const pick = await api(`/bots/${bot.id}/look-cards/${card.seq}/choose`, { candidateId: card2.body.candidates[5] });
    assert.equal(pick.status, 200, JSON.stringify(pick.json));
    assert.equal(await picture(), Buffer.from(await (await fetch(`${BASE}/api/bots/${bot.id}/look/${card2.body.candidates[5]}`, { headers: { cookie } })).arrayBuffer()).toString('base64'), 'the chosen picture is the look now');
    const all = await rows();
    assert.equal(all.find((r) => r.seq === card.seq).body.status, 'applied');
    assert.ok(all.some((r) => r.body.card === 'look-reveal' && r.body.candidateId === card2.body.candidates[5]), 'reveal card shown');
    const again = await api(`/bots/${bot.id}/look-cards/${card.seq}/choose`, { candidateId: card2.body.candidates[0] });
    assert.equal(again.status, 409, 'a used card cannot be used again');
  });

  await test('a picture that is not on the card cannot be chosen', async () => {
    await mcp('change_my_look', { description: 'a fox', intent: 'new', count: 1 });
    const card = await waitFor('pictures', async () => { const c = (await lookCards()).at(-1); return c?.body.status === 'pending' && c; });
    const r = await api(`/bots/${bot.id}/look-cards/${card.seq}/choose`, { candidateId: 'look_not_mine' });
    assert.equal(r.status, 400);
  });

  await test('the owner can open a look card without asking the bot (used for outside bots)', async () => {
    asked.length = 0;
    const r = await api(`/bots/${bot.id}/look-cards`, { description: 'Add a hat', intent: 'new' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const card = await waitFor('pictures', async () => { const c = (await lookCards()).find((x) => x.seq === r.json.seq); return c?.body.status === 'pending' && c; });
    assert.equal(card.body.intent, 'new');
    assert.ok(card.body.candidates.length >= 1);
    assert.match(asked[0].prompt, /Add a hat/);
    const long = await api(`/bots/${bot.id}/look-cards`, { description: 'x'.repeat(1001) });
    assert.equal(long.status, 400);
  });

  await test('going back to the shape is a card too', async () => {
    await mcp('change_my_look', { description: '', intent: 'default' });
    const card = (await lookCards()).at(-1);
    assert.equal(card.body.intent, 'default');
    assert.equal(card.body.status, 'pending');
    const r = await api(`/bots/${bot.id}/look-cards/${card.seq}/choose`, { candidateId: null });
    assert.equal(r.status, 200);
    const b = await botNow();
    assert.equal(b.avatarImageUrl, null);
    assert.deepEqual(b.avatarPoses, {});
  });

  await test('a look card that was drawing when the server restarted is drawn again', async () => {
    holdSlow = true;
    const r = await api(`/bots/${bot.id}/look-cards`, { description: 'a slow snail', intent: 'new', count: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await waitFor('asked', async () => held.length === 1);
    server.kill();
    await new Promise((res) => server.once('exit', res));
    for (const h of held.splice(0)) h.destroy();
    holdSlow = false;
    server = startServer();
    await serverUp();
    const card = await waitFor('card after restart', async () => { const c = (await lookCards()).find((x) => x.seq === r.json.seq); return c?.body.status !== 'making' && c; });
    assert.equal(card.body.status, 'pending', JSON.stringify(card.body));
    assert.equal(card.body.candidates.length, 3);
    assert.equal(card.body.resumes, 1);
  });
} finally {
  server.kill();
  images.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
