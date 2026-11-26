// Tests for server/src/local-computer.ts on real X displays. Needs Xvfb, x11vnc, xdpyinfo and
// ImageMagick (`scripts/setup-local.sh` installs them) and a built server: `npm run build -w server`,
// then `node tests/local-computer.mjs`. Uses displays :99 and :100 upwards and stops what it started.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-'));
Object.assign(process.env, {
  COMPUTER: 'local', LOCAL_STATE_DIR: dir, LOCAL_RESOLUTION: '1024x640',
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'test.db'),
});
const lc = await import('../server/dist/local-computer.js');
const { orgo } = await import('../server/dist/orgo.js');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};
const defaultWasUp = lc.displayUp(99);
const started = [];

await test('the Orgo client is the local one', () => {
  assert.equal(orgo.getComputer, lc.localOrgo.getComputer);
});

await test('the computer is running and the default screen :99 comes up', async () => {
  const c = await orgo.getComputer('local');
  assert.equal(c.status, 'running');
  assert.equal(lc.displayUp(99), true);
});

let extra;
await test('a new screen is a new display with the configured size', async () => {
  extra = await orgo.createScreen('local');
  started.push(extra.id);
  assert.match(extra.id, /^screen-1\d\d$/);
  assert.equal(lc.displayUp(lc.displayNumber(extra.id)), true);
  assert.deepEqual([extra.width, extra.height], [1024, 640]);
  assert.equal(extra.default, false);
});

await test('a second screen gets the next display', async () => {
  const s = await orgo.createScreen('local');
  started.push(s.id);
  assert.notEqual(s.id, extra.id);
});

await test('the screens are listed, the default one first', async () => {
  const list = await orgo.listScreens('local');
  assert.equal(list[0].id, 'default');
  for (const id of started) assert.ok(list.some((s) => s.id === id), `missing ${id}`);
});

await test('a screenshot is a JPEG of the screen', async () => {
  const s = await orgo.screenshot('local', extra.id);
  const jpeg = Buffer.from(s.image, 'base64');
  assert.equal(s.mime_type, 'image/jpeg');
  assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
  assert.deepEqual([s.width, s.height], [1024, 640]);
});

await test('the live view: x11vnc on 127.0.0.1 with a password, speaking RFB', async () => {
  const t = await lc.vncTarget(extra.id);
  assert.equal(t.host, '127.0.0.1');
  assert.equal(t.password.length, 8);
  assert.equal(fs.statSync(path.join(dir, 'vnc-password')).mode & 0o777, 0o600);
  const hello = await new Promise((resolve, reject) => {
    const s = net.connect({ host: t.host, port: t.port });
    s.once('data', (d) => { s.destroy(); resolve(d.toString()); });
    s.once('error', reject);
    setTimeout(() => reject(new Error('no answer')), 5000);
  });
  assert.match(hello, /^RFB 003\.00\d/);
  // It asks for VNC authentication (type 2), so nobody gets in without the password.
  const types = await new Promise((resolve, reject) => {
    const s = net.connect({ host: t.host, port: t.port });
    let stage = 0;
    s.on('data', (d) => {
      if (stage++ === 0) { s.write('RFB 003.008\n'); return; }
      s.destroy();
      resolve([...d.subarray(1, 1 + d[0])]);
    });
    s.once('error', reject);
    setTimeout(() => reject(new Error('no security types')), 5000);
  });
  assert.deepEqual(types, [2]);
});

await test('asking for the same screen again starts nothing new', async () => {
  const before = fs.readdirSync(dir).filter((f) => f.endsWith('.pid')).length;
  await orgo.getScreen('local', extra.id);
  await lc.vncTarget(extra.id);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.pid')).length, before);
});

await test('a screen that died comes back when asked for', async () => {
  const n = lc.displayNumber(extra.id);
  await lc.stopDisplay(n);
  for (let i = 0; i < 30 && lc.displayUp(n); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lc.displayUp(n), false);
  const s = await orgo.getScreen('local', extra.id);
  assert.equal(s.id, extra.id);
  assert.equal(lc.displayUp(n), true);
});

await test('deleting a screen stops its display; the default one is never stopped', async () => {
  for (const id of started) await orgo.deleteScreen('local', id);
  await orgo.deleteScreen('local', 'default');
  await new Promise((r) => setTimeout(r, 500));
  for (const id of started) assert.equal(lc.displayUp(lc.displayNumber(id)), false, `${id} still up`);
  assert.equal(lc.displayUp(99), true);
});

// Leave :99 as it was found.
if (!defaultWasUp) {
  for (const what of ['vnc', 'wm', 'xvfb']) {
    try { process.kill(Number(fs.readFileSync(path.join(dir, `${what}-99.pid`), 'utf8')), 'SIGTERM'); } catch { /* not ours */ }
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
