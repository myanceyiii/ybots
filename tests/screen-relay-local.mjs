// The live-screen relay (server/src/vnc.ts) against a real x11vnc: the viewer is greeted at once, a screen
// opens fast, a hung x11vnc is restarted, and a viewer's "gave up" report is logged. Needs Xvfb and x11vnc
// (scripts/setup-local.sh) and a built server: `npm run build -w server`, then `node tests/screen-relay-local.mjs`.
// Starts its own server on a free port with display :99 and stops what it started.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-relay-'));
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://localhost:${port}`;
let log = '';
const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url).pathname,
  env: { ...process.env, COMPUTER: 'local', DEV_LOGIN: '1', HERMES_BIN: '/bin/false', PORT: String(port), APP_URL: base, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 't.db'), LOCAL_STATE_DIR: path.join(dir, 'state'), DATA_DIR: path.join(dir, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !log.includes('server on'); i++) await sleep(100);

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const login = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com', name: 'Dev' }) });
const token = /cleftbot_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
const auth = { authorization: `Bearer ${token}` };
const bot = (await (await fetch(`${base}/api/bots`, { headers: auth })).json()).bots[0].id;

/** Open the screen as a viewer and run the RFB handshake to the first frame. Times in ms from opening. */
function view() {
  return new Promise((resolve) => {
    const t0 = Date.now(); const at = {}; let buf = Buffer.alloc(0); let st = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bots/${bot}/screen?mode=watch`, ['binary'], { headers: auth });
    const done = (r) => { clearTimeout(to); try { ws.close(); } catch { /* */ } resolve({ ...at, result: r }); };
    const to = setTimeout(() => done('timeout'), 20000);
    ws.on('close', (c, why) => done(`closed ${c} ${why}`));
    ws.on('message', (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      for (;;) {
        if (st === 0 && buf.length >= 12) { at.greeting = Date.now() - t0; buf = buf.subarray(12); ws.send(Buffer.from('RFB 003.008\n')); st = 1; continue; }
        if (st === 1 && buf.length >= 2) { buf = buf.subarray(2); ws.send(Buffer.from([1])); st = 2; continue; }
        if (st === 2 && buf.length >= 4) { buf = buf.subarray(4); ws.send(Buffer.from([1])); st = 3; continue; }
        if (st === 3 && buf.length >= 24) {
          const nl = buf.readUInt32BE(20); if (buf.length < 24 + nl) break;
          const w = buf.readUInt16BE(0), h = buf.readUInt16BE(2); buf = buf.subarray(24 + nl); at.init = Date.now() - t0;
          ws.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
          const r = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]); r.writeUInt16BE(w, 6); r.writeUInt16BE(h, 8); ws.send(r); st = 4; continue;
        }
        if (st === 4 && buf.length) { at.frame = Date.now() - t0; return done('ok'); }
        break;
      }
    });
  });
}
const vncPid = () => Number(fs.readFileSync(path.join(dir, 'state', 'vnc-99.pid'), 'utf8'));

try {
  await test('the viewer is greeted at once and the first frame follows', async () => {
    await view(); // the first one starts Xvfb and x11vnc
    const v = await view();
    assert.equal(v.result, 'ok');
    assert.ok(v.greeting < 200, `greeting after ${v.greeting} ms`);
    assert.ok(v.frame < 3000, `frame after ${v.frame} ms`);
  });
  await test('x11vnc runs without naps (an idle one answered every 250 ms)', () => {
    const args = fs.readFileSync(`/proc/${vncPid()}/cmdline`, 'utf8').split('\0');
    assert.ok(args.includes('-nonap'), args.join(' '));
  });
  await test('a hung x11vnc is restarted and the screen opens anyway', async () => {
    const hung = vncPid();
    process.kill(hung, 'SIGSTOP');
    const v = await view();
    assert.equal(v.result, 'ok');
    assert.notEqual(vncPid(), hung);
    assert.match(log, /restarting x11vnc on :99 \(it stopped answering\)/);
  });
  await test('a viewer that gave up is logged with its cause', async () => {
    const r = await fetch(`${base}/api/bots/${bot}/screen/problem`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ tries: 6, cause: 'The connection dropped.\nsecond line', code: 1006, opened: true, ms: 900, client: 'android' }) });
    assert.equal(r.status, 200);
    await sleep(100);
    assert.match(log, /android gave up after 6 tries \(last link: code 1006, opened, 900 ms\): The connection dropped\. second line/);
  });
} finally {
  server.kill();
  for (const what of ['vnc', 'wm', 'xvfb']) {
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'state', `${what}-99.pid`), 'utf8')), 'SIGKILL'); } catch { /* not ours or gone */ }
  }
  try { execFileSync('pkill', ['-KILL', '-f', `rfbauth ${dir}`]); } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}
