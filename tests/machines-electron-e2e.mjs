// The real Windows app's "Let YBots use this PC" against the real server, on Linux under Xvfb:
// pair from the app's own page (approved by code, as a phone would), the signed link, a read and a
// command through approval cards, Robin refused, and the screen captured by Electron and relayed.
// Run after `npm run build -w server` and `cd desktop && npm install`:
//   dbus-run-session -- sh -c 'echo -n test | gnome-keyring-daemon --unlock --components=secrets >/dev/null; xvfb-run -a node tests/machines-electron-e2e.mjs'
// (a real keyring, so Electron's safeStorage can protect the PC key as it does on Windows)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'desktop/package.json'));
const { _electron: electron } = require('playwright');
const WebSocket = createRequire(path.join(root, 'package.json'))('ws');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-electron-')));
const shared = path.join(dir, 'shared');
fs.mkdirSync(shared);
fs.writeFileSync(path.join(shared, 'hello.txt'), 'from the real app');
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error(`timed out: ${what}`); };

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET, DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'e'), HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'h'), CLEFTBOT_NO_SCHEDULER: '1', MAX_BOTS: '10', OWNER_EMAIL: 'owner@example.com', ALLOWED_EMAILS: 'owner@example.com' },
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };
let app;
try {
  for (let i = 0; ; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { if (i > 100) throw new Error(log); await sleep(200); } }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = // A person's sign-in: the owner key makes a link and a browser opens it (a session straight from the
  // owner key is a script's and may not answer approval cards).
  await fetch(`${BASE}${new URL((await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json()).url).pathname}`, { redirect: 'manual' });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (m, p, b) => { const x = await fetch(`${BASE}/api${p}`, { method: m, headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: x.status, json: await x.json().catch(() => null) }; };
  const { json: { bots } } = await api('GET', '/bots');
  const mk = async (name) => (await api('POST', '/bots', { name, avatarShape: bots[0].avatarShape, avatarColor: bots[0].avatarColor, mode: bots[0].mode })).json.bot;
  const leonard = await mk('Leonard');
  const robin = await mk('Robin');
  const call = async (bot, name, args) => (await (await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex')}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content[0].text;

  // The app's settings: our server's address, and (as if picked on the page) a shared folder with
  // commands and screen viewing on.
  const userData = path.join(dir, 'app');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ address: BASE }));
  fs.writeFileSync(path.join(userData, 'remote.json'), JSON.stringify({ folders: [{ name: 'shared', path: shared }], commands: true, screen: true, control: true }));
  app = await electron.launch({ executablePath: require('electron'), args: [path.join(root, 'desktop'), '--password-store=gnome-libsecret', '--no-sandbox'], env: { ...process.env, CLEFT_USER_DATA: userData, CLEFT_NO_TRAY: '1' } });
  const win = await app.firstWindow();
  await win.waitForLoadState();

  await test('pair from the app\'s own page; approved by code from a signed-in device', async () => {
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), 'file://' + path.join(root, 'desktop/src/pages/remote.html'));
    await win.waitForSelector('#pair:not([hidden])');
    await win.click('#pair');
    const code = await until(async () => { const t = await win.textContent('#pair-code'); return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(t ?? '') ? t : null; }, 'a pairing code');
    const p = await api('GET', `/auth/pair-code/${code}`);
    assert.equal(p.json.kind, 'machine');
    assert.equal((await api('POST', `/auth/pair/${p.json.id}/answer`, { allow: true })).status, 200);
    await until(async () => (await win.textContent('#status')) === 'YBots can use this PC', 'online on the PC page');
    const m = (await api('GET', '/machines')).json.machines[0];
    assert.equal(m.online, true);
    assert.equal(m.folders[0].path, shared);
  });

  await test('a read in the shared folder, through the real app', async () => {
    assert.equal(await call(leonard, 'pc_read_file', { pc: os.hostname(), path: path.join(shared, 'hello.txt') }), 'from the real app');
  });

  await test('Robin is refused', async () => {
    assert.match(await call(robin, 'pc_read_file', { pc: os.hostname(), path: path.join(shared, 'hello.txt') }), /may not use PCs/);
  });

  await test('a command after Allow on its card; the PC page logs it', async () => {
    const pending = call(leonard, 'pc_run', { pc: os.hostname(), command: 'echo from-the-pc' });
    const card = await until(async () => (await api('GET', `/bots/${leonard.id}/rows`)).json.rows.find((x) => x.body?.card === 'approval' && x.body.status === 'pending'), 'card');
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow', digest: card.body.digest });
    assert.match(await pending, /from-the-pc/);
    await until(async () => /Leonard: run done/.test(await win.textContent('#log')), 'logged on the PC');
  });

  await test('the screen: captured by Electron, relayed as RFB', async () => {
    const machineId = (await api('GET', '/machines')).json.machines[0].id;
    const v = new WebSocket(`ws://127.0.0.1:${PORT}/api/machines/${machineId}/screen`, ['binary'], { headers: { cookie, origin: BASE } });
    const got = [];
    v.on('message', (d) => got.push(Buffer.from(d)));
    await new Promise((res, rej) => { v.on('open', res); v.on('error', rej); });
    const bytes = () => Buffer.concat(got);
    await until(() => bytes().length >= 12, 'version');
    v.send(Buffer.from('RFB 003.008\n'));
    await until(() => bytes().length >= 14, 'security');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18, 'ok');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18 + 24, 'init');
    const init = bytes().subarray(18);
    assert.ok(init.readUInt16BE(0) > 0 && init.readUInt16BE(2) > 0, 'a real screen size');
    const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(7, 4);
    v.send(enc);
    v.send(Buffer.from([3, 0, 0, 0, 0, 0, 0x7f, 0xff, 0x7f, 0xff]));
    const headLen = 18 + 24 + init.readUInt32BE(20);
    await until(() => bytes().length > headLen + 4, 'a frame');
    assert.equal(bytes()[headLen], 0, 'FramebufferUpdate');
    console.log(`     screen ${init.readUInt16BE(0)}x${init.readUInt16BE(2)}, first update ${bytes().length - headLen} bytes`);
    v.close();
  });

  await test('take control: the mouse moves on the real screen (xdotool stands in for SendInput)', async () => {
    const { execFileSync } = await import('node:child_process');
    const where = () => Object.fromEntries(execFileSync('xdotool', ['getmouselocation', '--shell']).toString().trim().split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
    const machineId = (await api('GET', '/machines')).json.machines[0].id;
    assert.equal((await api('GET', '/machines')).json.machines[0].control, true);
    const v = new WebSocket(`ws://127.0.0.1:${PORT}/api/machines/${machineId}/screen?mode=control`, ['binary'], { headers: { cookie, origin: BASE } });
    const got = [];
    v.on('message', (d) => got.push(Buffer.from(d)));
    await new Promise((res, rej) => { v.on('open', res); v.on('error', rej); });
    const bytes = () => Buffer.concat(got);
    await until(() => bytes().length >= 12, 'version');
    v.send(Buffer.from('RFB 003.008\n'));
    await until(() => bytes().length >= 14, 'security');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18, 'ok');
    v.send(Buffer.from([1]));
    await until(() => bytes().length >= 18 + 24, 'init');
    const init = bytes().subarray(18);
    const fbW = init.readUInt16BE(0), fbH = init.readUInt16BE(2);
    await until(async () => (await win.textContent('#status')) === 'Someone is controlling this PC', 'PC page says so');
    const p = Buffer.alloc(6); p[0] = 5; p[1] = 0; p.writeUInt16BE(Math.round(fbW / 4), 2); p.writeUInt16BE(Math.round(fbH / 4), 4);
    v.send(p);
    const at = await until(() => { const l = where(); return Math.abs(l.X - 1280 / 4) < 4 && Math.abs(l.Y - 1024 / 4) < 4 ? l : null; }, 'the pointer moved');
    console.log(`     pointer at ${at.X},${at.Y}`);
    v.close();
    await until(async () => (await win.textContent('#status')) === 'YBots can use this PC', 'control ended on the PC');
    assert.match(await win.textContent('#log'), /Control of this screen ended/);
  });

  await test('Turn off: the PC goes offline', async () => {
    await win.click('#toggle');
    await until(async () => !(await api('GET', '/machines')).json.machines[0].online, 'offline');
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup: ${e.stack}`);
} finally {
  await app?.close().catch(() => {});
  server.kill('SIGTERM');
  if (failures) console.log(log.split('\n').slice(-20).join('\n'));
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}
