// End-to-end check of "Let YBots use this PC" (docs/remote-pc.md) through the real server, with a
// stand-in PC built from the Windows app's own rules (desktop/src/remote-core.js):
//   pairing by code, the signed link, online status, a blocked bot (PC_BLOCKED_BOTS) refused everywhere, reads in shared folders,
//   changes only after an approval card (the PC checks the server's digest), commands, the screen
//   relay (watch only) and removal. Run after `npm run build -w server`:  node tests/machines-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { makeExecutor, UsedApprovals, RfbSession, handleClip } = require(path.join(root, 'desktop/src/remote-core.js'));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'machines-e2e-')));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const shared = path.join(dir, 'shared');
fs.mkdirSync(shared);
fs.writeFileSync(path.join(shared, 'notes.txt'), 'hello from the PC');
fs.writeFileSync(path.join(dir, 'private.txt'), 'not shared');

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9',
    HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), CLEFTBOT_NO_SCHEDULER: '1', MAX_BOTS: '10',
    OWNER_EMAIL: 'owner@example.com', ALLOWED_EMAILS: 'owner@example.com', PC_BLOCKED_BOTS: 'Robin',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the stand-in PC ----------
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const pcState = { folders: [{ name: 'shared', path: shared }], commands: false, screen: false, control: false, clipboard: false, blocked: ['Robin'], version: 'test' };
let pcBoard = 'secret on the PC';
const executor = makeExecutor({
  folders: () => pcState.folders, commands: () => pcState.commands, blocked: () => pcState.blocked, used: new UsedApprovals(),
  run: (command, cwd, timeoutMs) => new Promise((resolve) => {
    const c = spawn('/bin/sh', ['-c', command], { cwd });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, output: out, timedOut: false }); });
  }),
});
function connectPc(machineId, key = keys.privateKey) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/machines/link`);
  const pc = { ws, closed: null, ready: false, viewers: new Map(), calls: [], input: [], opens: [], clips: [] };
  ws.on('message', async (data, isBinary) => {
    if (isBinary) { const n = data[0]; pc.viewers.get(data.subarray(1, 1 + n).toString())?.receive(Buffer.from(data.subarray(1 + n))); return; }
    const msg = JSON.parse(data.toString());
    if (msg.t === 'challenge') ws.send(JSON.stringify({ t: 'hello', machineId, sig: crypto.sign(null, Buffer.from(`cleft-machine-link:v1:${machineId}:${msg.nonce}`), key).toString('base64'), state: pcState }));
    else if (msg.t === 'ready') pc.ready = true;
    else if (msg.t === 'call') { pc.calls.push(msg); const r = await executor.handle(msg); ws.send(JSON.stringify({ t: 'result', id: msg.id, ...r })); }
    else if (msg.t === 'clip') {
      pc.clips.push(msg);
      const r = handleClip(msg, { enabled: () => pcState.screen && pcState.control && pcState.clipboard, controlling: () => pc.opens.some((o) => o.control && pc.viewers.has(o.sid)), read: () => pcBoard, write: (t) => { pcBoard = t; } });
      ws.send(JSON.stringify({ t: 'result', id: msg.id, ...r }));
    }
    else if (msg.t === 'screen-open') {
      pc.opens.push(msg);
      if (!pcState.screen) { ws.send(JSON.stringify({ t: 'screen-closed', sid: msg.sid, reason: 'off' })); return; }
      const head = Buffer.concat([Buffer.from([msg.sid.length]), Buffer.from(msg.sid)]);
      // Records every input event that reaches the PC, whatever the mode, so the relay's filtering shows.
      const v = new RfbSession((b) => ws.send(Buffer.concat([head, b])), 'TESTPC', (...a) => pc.input.push({ control: msg.control, a }));
      pc.viewers.set(msg.sid, v);
      v.start({ width: 256, height: 128, bgra: Buffer.alloc(256 * 128 * 4, 40), jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    }
  });
  ws.on('close', (code) => { pc.closed = code; });
  return pc;
}
const until = async (fn, what, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error(`timed out: ${what}`); };

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/health`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signed = // A person's sign-in: the owner key makes a link and a browser opens it (a session straight from the
  // owner key is a script's and may not answer approval cards).
  await fetch(`${BASE}${new URL((await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json()).url).pathname}`, { redirect: 'manual' });
  const cookie = signed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const mk = async (name) => (await api('POST', '/bots', { name, avatarShape: bots[0].avatarShape, avatarColor: bots[0].avatarColor, mode: bots[0].mode })).json.bot;
  const leonard = await mk('Leonard');
  const robin = await mk('Robin');
  const mcp = async (bot, method, params) => (await (await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex')}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const call = async (bot, name, args) => (await mcp(bot, 'tools/call', { name, arguments: args })).content[0].text;
  const answerCard = async (bot, tool, decision) => {
    const card = await until(async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows.find((r) => r.body?.card === 'approval' && r.body.tool === tool && r.body.status === 'pending'), `a ${tool} card`);
    const r = await api('POST', `/approvals/${card.body.approvalId}`, { decision, digest: card.body.digest });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return card;
  };

  let machineId;
  await test('pairing: a PC key is required; the code is approved by a signed-in person; no sign-in link is made', async () => {
    assert.equal((await fetch(`${BASE}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'machine', device: 'TESTPC', publicKey: 'bm90IGEga2V5' }) })).status, 400);
    const p = await (await fetch(`${BASE}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'machine', device: 'TESTPC', publicKey }) })).json();
    const info = await api('GET', `/auth/pair/${p.id}/info`);
    assert.equal(info.json.kind, 'machine');
    assert.equal((await api('POST', `/auth/pair/${p.id}/answer`, { allow: true })).status, 200);
    const poll = await (await fetch(`${BASE}/api/auth/pair/${p.id}`, { headers: { 'x-pair-secret': p.secret } })).json();
    assert.equal(poll.state, 'allowed');
    assert.equal(poll.link, undefined, 'no sign-in link for a machine pairing');
    machineId = poll.machineId;
    assert.match(machineId, /^pc_/);
  });

  await test('new PC: offline, Leonard allowed, Robin blocked and cannot be switched on', async () => {
    const m = (await api('GET', '/machines')).json.machines[0];
    assert.equal(m.online, false);
    assert.ok(m.bots.includes(leonard.id));
    assert.ok(!m.bots.includes(robin.id));
    assert.ok(m.blockedBots.includes(robin.id));
    const r = await api('PATCH', `/machines/${machineId}`, { bots: [leonard.id, robin.id] });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Robin can never use a PC/);
  });

  await test('the link: a wrong key is refused; the right one brings the PC online', async () => {
    const bad = connectPc(machineId, crypto.generateKeyPairSync('ed25519').privateKey);
    await until(() => bad.closed, 'bad key closed');
    assert.equal(bad.closed, 4403);
    const unknown = connectPc('pc_nope');
    await until(() => unknown.closed, 'unknown closed');
    assert.equal(unknown.closed, 4403);
  });
  const pc = connectPc(machineId);
  await until(() => pc.ready, 'PC ready');
  await test('online, with the PC\'s folders', async () => {
    const m = (await api('GET', '/machines')).json.machines[0];
    assert.equal(m.online, true);
    assert.equal(m.folders[0].path, shared);
  });

  await test('Robin: no PC tools offered, and calling one is refused before the PC hears of it', async () => {
    const names = (await mcp(robin, 'tools/list')).tools.map((t) => t.name);
    assert.ok(!names.includes('pc_run'));
    assert.ok((await mcp(leonard, 'tools/list')).tools.some((t) => t.name === 'pc_run'));
    const before = pc.calls.length;
    assert.match(await call(robin, 'pc_read_file', { pc: 'TESTPC', path: path.join(shared, 'notes.txt') }), /may not use PCs/);
    assert.match(await call(robin, 'pc_list', {}), /may not use PCs/);
    assert.equal(pc.calls.length, before);
    // Renaming her does not unblock her: the block follows the bot, not its name.
    assert.equal((await api('PATCH', `/bots/${robin.id}`, { name: 'Pen' })).status, 200);
    assert.match(await call(robin, 'pc_list', {}), /may not use PCs/);
    assert.equal((await api('PATCH', `/bots/${robin.id}`, { name: 'Robin' })).status, 200);
  });

  await test('the PC refuses Robin on its own too, even if the server asked', async () => {
    const r = await executor.handle({ tool: 'pc_read_file', args: { path: path.join(shared, 'notes.txt') }, bot: { id: robin.id, name: 'Robin' } });
    assert.match(r.output, /does not allow Robin/);
  });

  await test('reads run inside shared folders only', async () => {
    assert.equal(await call(leonard, 'pc_read_file', { pc: 'TESTPC', path: path.join(shared, 'notes.txt') }), 'hello from the PC');
    assert.match(await call(leonard, 'pc_read_file', { pc: 'TESTPC', path: path.join(dir, 'private.txt') }), /outside the folders shared/);
    assert.match(await call(leonard, 'pc_list', {}), /TESTPC/);
  });

  await test('a write waits for the card; after Allow the PC checks the server\'s digest and writes', async () => {
    const target = path.join(shared, 'from-leonard.txt');
    const pending = call(leonard, 'pc_write_file', { pc: 'TESTPC', path: target, content: 'written' });
    await answerCard(leonard, 'pc_write_file', 'allow');
    assert.match(await pending, /Wrote 7 bytes/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'written');
    const sent = pc.calls.at(-1);
    assert.ok(sent.approval?.id && sent.approval?.digest, 'approval travelled with the call');
  });

  await test('Deny: nothing happens on the PC', async () => {
    const target = path.join(shared, 'notes.txt');
    const before = pc.calls.length;
    const pending = call(leonard, 'pc_delete', { pc: 'TESTPC', path: target });
    await answerCard(leonard, 'pc_delete', 'deny');
    assert.match(await pending, /declined/);
    assert.ok(fs.existsSync(target));
    assert.equal(pc.calls.length, before);
  });

  await test('"Always allow" on a PC card: that bot, that action, that PC run unasked; the PC still gets an exact one-time approval', async () => {
    const args = { pc: 'TESTPC', path: path.join(shared, 'twice.txt'), content: 'x' };
    const one = call(leonard, 'pc_write_file', args);
    const card = await answerCard(leonard, 'pc_write_file', 'always');
    assert.equal(card.body.canAlways, true);
    assert.equal(card.body.risk, 'host');
    assert.match(card.body.alwaysNote, /PC/);
    assert.doesNotMatch(await one, /declined|Refused/);
    const before = pc.calls.length;
    const two = await call(leonard, 'pc_write_file', { ...args, content: 'y' });
    assert.doesNotMatch(two, /declined|Refused|Skipped/, 'ran without a card');
    assert.equal(fs.readFileSync(args.path, 'utf8'), 'y');
    assert.equal(pc.calls.length, before + 1);
    const { json } = await api('GET', `/allow-rules?botId=${leonard.id}`);
    const rule = json.rules.find((r) => r.tool.startsWith('pc__pc_write_file__'));
    assert.ok(rule, 'rule listed');
    assert.equal(rule.label, 'PC: write a file on TESTPC');
    assert.equal(rule.uses, 1);
    // Another action on the same PC still asks.
    const del = call(leonard, 'pc_delete', { pc: 'TESTPC', path: args.path });
    await answerCard(leonard, 'pc_delete', 'deny');
    assert.match(await del, /declined/);
    // Removing the rule makes it ask again.
    assert.equal((await api('DELETE', `/allow-rules/${rule.id}`)).status, 200);
    const three = call(leonard, 'pc_write_file', args);
    await answerCard(leonard, 'pc_write_file', 'deny');
    assert.match(await three, /declined/);
  });

  await test('commands: refused while the PC has them off, then run after a card', async () => {
    assert.match(await call(leonard, 'pc_run', { pc: 'TESTPC', command: 'echo hi' }), /turned off/);
    pcState.commands = true;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
    await until(async () => (await api('GET', '/machines')).json.machines[0].commands, 'commands on');
    const on = call(leonard, 'pc_run', { pc: 'TESTPC', command: 'echo hi; pwd' });
    await answerCard(leonard, 'pc_run', 'allow');
    const out = await on;
    assert.match(out, /Exit code 0/);
    assert.match(out, /hi/);
    assert.ok(out.includes(shared));
  });

  const openViewer = (headers = { cookie, origin: BASE }, mode = 'watch') => new Promise((resolve) => {
    const v = new WebSocket(`ws://127.0.0.1:${PORT}/api/machines/${machineId}/screen?mode=${mode}`, ['binary'], { headers });
    const got = [];
    v.on('message', (d) => got.push(Buffer.from(d)));
    v.on('open', () => resolve({ v, got, failed: false }));
    v.on('unexpected-response', (_req, res) => resolve({ v, got, failed: res.statusCode }));
    v.on('error', () => {});
  });

  await test('screen: refused without a sign-in; closed while the PC has viewing off', async () => {
    assert.equal((await openViewer({ origin: BASE })).failed, 401);
    const { v } = await openViewer();
    const code = await new Promise((r) => v.on('close', (c) => r(c)));
    assert.ok(code !== 1005);
  });

  await test('screen: relayed to a signed-in viewer, watch only', async () => {
    pcState.screen = true;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
    await until(async () => (await api('GET', '/machines')).json.machines[0].screen, 'screen on');
    const { v, got, failed } = await openViewer();
    assert.equal(failed, false);
    const bytes = () => Buffer.concat(got);
    await until(() => bytes().length >= 12, 'version');
    v.send(Buffer.from('RFB 003.008\n'));
    await until(() => bytes().length >= 14, 'security');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18, 'result');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18 + 24 + 6, 'server init');
    const init = bytes().subarray(18);
    assert.equal(init.readUInt16BE(0), 256);
    const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(7, 4);
    v.send(enc);
    v.send(Buffer.from([5, 1, 0, 10, 0, 10])); // a click: must never reach the PC
    v.send(Buffer.from([3, 0, 0, 0, 0, 0, 1, 0, 0, 128]));
    await until(() => bytes().length > 18 + 24 + 6 + 4, 'an update');
    const upd = bytes().subarray(18 + 24 + 6);
    assert.equal(upd[0], 0);
    assert.equal(upd.readUInt16BE(2), 2);
    assert.deepEqual(pc.input, [], 'no input reached the PC while watching');
    v.close();
  });

  const handshake = async (v, got) => {
    const bytes = () => Buffer.concat(got);
    await until(() => bytes().length >= 12, 'version');
    v.send(Buffer.from('RFB 003.008\n'));
    await until(() => bytes().length >= 14, 'security');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18, 'result');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18 + 24 + 6, 'server init');
  };

  await test('take control: refused while the PC has it off, and never opened as control', async () => {
    const opens = pc.opens.length;
    const { v } = await openViewer(undefined, 'control');
    const code = await new Promise((r) => v.on('close', (c) => r(c)));
    assert.ok(code !== 1005);
    assert.equal(pc.opens.length, opens, 'the server refused before asking the PC');
  });

  await test('take control: with the PC allowing it, mouse and keys reach the PC; the clipboard never does', async () => {
    pcState.control = true;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
    await until(async () => (await api('GET', '/machines')).json.machines[0].control, 'control on');
    const { v, got, failed } = await openViewer(undefined, 'control');
    assert.equal(failed, false);
    await handshake(v, got);
    assert.equal(pc.opens.at(-1).control, true);
    v.send(Buffer.from([5, 1, 0, 10, 0, 20]));
    v.send(Buffer.from([6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69])); // clipboard "hi"
    v.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x41]));
    await until(() => pc.input.length >= 2, 'input at the PC');
    await sleep(200);
    assert.deepEqual(pc.input.map((i) => i.a), [['pointer', 1, 10, 20, 256, 128], ['key', true, 0x41]]);
    v.close();
    const log = (await api('GET', `/machines/${machineId}/log`)).json.log;
    assert.ok(log.some((l) => l.tool === 'screen' && l.outcome === 'took control'), 'logged');
  });

  await test('copy and paste: off by default; then only while someone has control; never in the log', async () => {
    let r = await api('GET', `/machines/${machineId}/clipboard`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /off on that PC/);
    assert.equal((await api('GET', '/machines')).json.machines[0].clipboard, false);
    pcState.clipboard = true;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
    await until(async () => (await api('GET', '/machines')).json.machines[0].clipboard, 'clipboard on');
    r = await api('PUT', `/machines/${machineId}/clipboard`, { text: 'hi' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Take control/);
    assert.equal(pc.clips.length, 0, 'the PC was never asked without a control session');
    const { v, got, failed } = await openViewer(undefined, 'control');
    assert.equal(failed, false);
    await handshake(v, got);
    r = await api('GET', `/machines/${machineId}/clipboard`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.text, 'secret on the PC');
    r = await api('PUT', `/machines/${machineId}/clipboard`, { text: 'from “my” laptop 👋' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(pcBoard, 'from “my” laptop 👋');
    assert.equal((await api('PUT', `/machines/${machineId}/clipboard`, { text: '' })).status, 400);
    assert.equal((await api('PUT', `/machines/${machineId}/clipboard`, { text: 'x'.repeat(256 * 1024 + 1) })).status, 413);
    // A page on another site can't push text onto the PC with the person's cookie.
    const cross = await fetch(`${BASE}/api/machines/${machineId}/clipboard`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(cross.status, 403);
    v.close();
    await until(async () => (await api('GET', `/machines/${machineId}/clipboard`)).status === 409, 'refused again once control ends');
    const log = (await api('GET', `/machines/${machineId}/log`)).json.log;
    assert.ok(log.some((l) => l.tool === 'clipboard' && l.outcome === 'pasted to the PC'));
    assert.ok(!JSON.stringify(log).includes('secret on the PC') && !JSON.stringify(log).includes('laptop'), 'the text is never logged');
    // Turning taking control off turns copy and paste off with it.
    pcState.control = false;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
    await until(async () => !(await api('GET', '/machines')).json.machines[0].clipboard, 'clipboard off with control');
    pcState.control = true;
    pc.ws.send(JSON.stringify({ t: 'state', state: pcState }));
  });

  await test('copy and paste: a bot screen needs xclip and a local screen; other people\'s bots are refused', async () => {
    assert.equal((await api('GET', `/bots/nope/clipboard`)).status, 404);
    const r = await api('GET', `/bots/${leonard.id}/clipboard`);
    // This test server has no local screens (COMPUTER is not local), so it says so rather than failing oddly.
    assert.ok([501, 409, 503].includes(r.status), JSON.stringify(r));
    assert.ok(r.json.error);
  });

  await test('take control: a bot has no tool for it', async () => {
    const tools = (await mcp(leonard, 'tools/list')).tools.map((t) => t.name);
    assert.ok(tools.includes('pc_run'));
    assert.ok(!tools.some((t) => /control|mouse|click|key/.test(t)));
  });

  await test('remove: the PC is told and cut off, its key stops working', async () => {
    assert.equal((await api('DELETE', `/machines/${machineId}`)).status, 200);
    await until(() => pc.closed, 'PC closed');
    assert.equal(pc.closed, 4403);
    assert.equal((await api('GET', '/machines')).json.machines.length, 0);
    const again = connectPc(machineId);
    await until(() => again.closed, 'closed again');
    assert.equal(again.closed, 4403);
    assert.equal((await mcp(leonard, 'tools/list')).tools.some((t) => t.name === 'pc_run'), false);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup: ${e.stack}`);
} finally {
  server.kill('SIGTERM');
  if (failures) console.log(log.split('\n').slice(-30).join('\n'));
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}
