// "Let YBots use this PC": the rules the PC enforces on its own, whatever the server sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { approvalDigest, UsedApprovals, resolveInside, makeExecutor, RfbSession, compactLength, changedTiles, handleClip, MAX_CLIP } = require('../src/remote-core.js');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-remote-')));
const shared = path.join(tmp, 'shared');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(shared);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(shared, 'a.txt'), 'hello');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
fs.symlinkSync(outside, path.join(shared, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

const approve = (tool, args, id = `apr_${Math.random()}`) => ({ id, digest: approvalDigest(id, tool, [], args) });
function executor(over = {}) {
  const used = new UsedApprovals();
  const runs = [];
  const ex = makeExecutor({
    folders: () => [{ name: 'shared', path: shared }],
    commands: () => true,
    blocked: () => [],
    used,
    run: async (command, cwd) => { runs.push({ command, cwd }); return { code: 0, output: 'ran', timedOut: false }; },
    ...over,
  });
  return { ex, runs, used };
}
const leonard = { id: 'bot_l', name: 'Leonard' };

test('the digest matches the server\'s canonical form (keys sorted at every level)', () => {
  const a = approvalDigest('apr_1', 'pc_run', [], { pc: 'X', command: 'dir', opts: { b: 1, a: [2, { d: 1, c: 2 }] } });
  const b = approvalDigest('apr_1', 'pc_run', [], { opts: { a: [2, { c: 2, d: 1 }], b: 1 }, command: 'dir', pc: 'X' });
  assert.equal(a, b);
  // The real server's digest is checked against this one end to end in tests/machines-e2e.mjs.
});

test('paths: inside is fine; outside, .., links out and relative paths are refused', () => {
  assert.equal(resolveInside(path.join(shared, 'a.txt'), [shared]), path.join(shared, 'a.txt'));
  assert.throws(() => resolveInside(path.join(outside, 'secret.txt'), [shared]), /outside/);
  assert.throws(() => resolveInside(path.join(shared, '..', 'outside', 'secret.txt'), [shared]), /outside/);
  assert.throws(() => resolveInside(path.join(shared, 'escape', 'secret.txt'), [shared]), /outside/);
  assert.throws(() => resolveInside('a.txt', [shared]), /full path/);
  assert.throws(() => resolveInside('//server/share/x', [shared]), /Network/);
  assert.equal(resolveInside(path.join(shared, 'new.txt'), [shared], { mustExist: false }), path.join(shared, 'new.txt'));
  assert.throws(() => resolveInside(path.join(shared + '-sibling', 'x'), [shared], { mustExist: false }), /folder does not exist|outside/);
});

test('a dangling link inside a shared folder is never written through', () => {
  const target = path.join(outside, `planted-${process.pid}.txt`);
  const link = path.join(shared, `dangling-${process.pid}.txt`);
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => resolveInside(link, [shared], { mustExist: false }), /link/);
    assert.equal(fs.existsSync(target), false);
  } finally { fs.unlinkSync(link); }
});

test('bots on the block list are refused, whatever their case or spacing', async () => {
  const { ex } = executor({ blocked: () => ['Robin', 'Sheldon'] });
  for (const name of ['Robin', 'robin', ' SHELDON ']) {
    const r = await ex.handle({ tool: 'pc_read_file', args: { path: path.join(shared, 'a.txt') }, bot: { id: 'x', name } });
    assert.equal(r.ok, false);
    assert.match(r.output, /does not allow/);
  }
  const r = await ex.handle({ tool: 'pc_read_file', args: { path: path.join(shared, 'a.txt') }, bot: leonard });
  assert.deepEqual(r, { ok: true, output: 'hello' });
});

test('changes need an approval for the exact call, used once', async () => {
  const { ex } = executor();
  const args = { pc: 'X', path: path.join(shared, 'b.txt'), content: 'one' };
  assert.match((await ex.handle({ tool: 'pc_write_file', args, bot: leonard })).output, /needs an approval/);
  const wrong = approve('pc_write_file', { ...args, content: 'two' });
  assert.match((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: wrong })).output, /does not match/);
  assert.equal(fs.existsSync(args.path), false);
  const ok = approve('pc_write_file', args);
  assert.equal((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: ok })).ok, true);
  assert.equal(fs.readFileSync(args.path, 'utf8'), 'one');
  assert.match((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: ok })).output, /already used/);
});

test('commands: only with the switch on, in a shared folder', async () => {
  let on = false;
  const { ex, runs } = executor({ commands: () => on });
  const args = { pc: 'X', command: 'dir' };
  assert.match((await ex.handle({ tool: 'pc_run', args, bot: leonard, approval: approve('pc_run', args) })).output, /turned off/);
  on = true;
  const r = await ex.handle({ tool: 'pc_run', args, bot: leonard, approval: approve('pc_run', args) });
  assert.equal(r.ok, true);
  assert.equal(runs[0].cwd, shared);
  const away = { pc: 'X', command: 'dir', cwd: outside };
  assert.match((await ex.handle({ tool: 'pc_run', args: away, bot: leonard, approval: approve('pc_run', away) })).output, /outside/);
});

test('a shared folder itself cannot be deleted or moved; unknown tools are refused', async () => {
  const { ex } = executor();
  const args = { pc: 'X', path: shared };
  assert.match((await ex.handle({ tool: 'pc_delete', args, bot: leonard, approval: approve('pc_delete', args) })).output, /cannot be deleted/);
  assert.match((await ex.handle({ tool: 'pc_format_disk', args, bot: leonard })).output, /does not know/);
});

test('Tight compact length', () => {
  assert.deepEqual([...compactLength(5)], [5]);
  assert.deepEqual([...compactLength(200)], [0xc8, 0x01]);
  assert.deepEqual([...compactLength(20000)], [0xa0, 0x9c, 0x01]);
});

test('RFB: handshake, then changed tiles as Tight JPEG; input is ignored', () => {
  const out = [];
  const s = new RfbSession((b) => out.push(Buffer.from(b)), 'TESTPC');
  const w = 256, h = 128;
  const frame = (fill) => ({ width: w, height: h, bgra: Buffer.alloc(w * h * 4, fill), jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  s.start(frame(0));
  assert.equal(out.shift().toString(), 'RFB 003.008\n');
  s.receive(Buffer.from('RFB 003.008\n'));
  assert.deepEqual([...out.shift()], [1, 1]);
  s.receive(Buffer.from([1]));
  assert.equal(out.shift().readUInt32BE(), 0);
  s.receive(Buffer.from([1]));
  const init = out.shift();
  assert.equal(init.readUInt16BE(0), w);
  assert.equal(init.readUInt16BE(2), h);
  assert.equal(init.subarray(24).toString(), 'TESTPC');
  // SetEncodings [Tight], then a full update request.
  const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(7, 4);
  s.receive(enc);
  s.receive(Buffer.from([3, 0, 0, 0, 0, 0, 1, 0, 0, 128]));
  let upd = out.shift();
  assert.equal(upd[0], 0);
  assert.equal(upd.readUInt16BE(2), 2, 'two 128x128 tiles');
  assert.equal(upd.readInt32BE(4 + 8), 7, 'Tight');
  assert.equal(upd[4 + 12], 0x90, 'JPEG');
  // Pointer and key events change nothing and are not answered.
  s.receive(Buffer.from([5, 1, 0, 10, 0, 10]));
  s.receive(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x41]));
  assert.equal(out.length, 0);
  // Incremental: nothing new, nothing sent; one tile changes, one rect sent.
  s.receive(Buffer.from([3, 1, 0, 0, 0, 0, 1, 0, 0, 128]));
  s.frame(frame(0));
  assert.equal(out.length, 0);
  const f = frame(0); f.bgra.fill(9, 0, 4); s.frame(f);
  upd = out.shift();
  assert.equal(upd.readUInt16BE(2), 1);
  assert.deepEqual(changedTiles(null, f.bgra, w, h).length, 2);
});

// ---------- taking control (input.js) ----------
const { InputMapper, windowsLine, xdotoolArgs, PS_LOOP } = require('../src/input.js');

test('input: pointer mask changes become moves, presses, releases and wheel notches', () => {
  const m = new InputMapper();
  assert.deepEqual(m.pointer(0, 0, 0, 101, 51), [{ t: 'move', x: 0, y: 0 }]);
  assert.deepEqual(m.pointer(1, 50, 25, 101, 51), [{ t: 'move', x: 0.5, y: 0.5 }, { t: 'button', b: 'left', down: true }]);
  assert.deepEqual(m.pointer(1, 50, 25, 101, 51), [], 'nothing new');
  assert.deepEqual(m.pointer(4, 50, 25, 101, 51), [{ t: 'button', b: 'left', down: false }, { t: 'button', b: 'right', down: true }]);
  assert.deepEqual(m.pointer(4 | 8, 50, 25, 101, 51), [{ t: 'wheel', dy: 1 }]);
  assert.deepEqual(m.pointer(4, 50, 25, 101, 51), [], 'wheel release is not a notch');
  assert.deepEqual(m.pointer(4 | 16, 999, 999, 101, 51), [{ t: 'move', x: 1, y: 1 }, { t: 'wheel', dy: -1 }], 'clamped to the screen');
  assert.deepEqual(m.releaseAll(), [{ t: 'button', b: 'right', down: false }], 'a held button is let go');
});

test('input: keys become virtual keys, characters, or keys while Ctrl is held; releaseAll lets go', () => {
  const m = new InputMapper();
  assert.deepEqual(m.key(true, 0x61), [{ t: 'char', code: 0x61, viaKey: false, down: true }]);
  assert.deepEqual(m.key(false, 0x61), [{ t: 'char', code: 0x61, viaKey: false, down: false }]);
  assert.deepEqual(m.key(false, 0x61), [], 'not held, nothing to release');
  assert.deepEqual(m.key(true, 0xffe3), [{ t: 'vk', vk: 0xa2, ext: false, down: true }], 'Ctrl');
  assert.deepEqual(m.key(true, 0x63), [{ t: 'char', code: 0x63, viaKey: true, down: true }], 'Ctrl+C goes as its key');
  assert.deepEqual(m.key(true, 0xff51), [{ t: 'vk', vk: 0x25, ext: true, down: true }], 'Left arrow is extended');
  assert.deepEqual(m.key(true, 0xffc9), [{ t: 'vk', vk: 0x7b, ext: false, down: true }], 'F12');
  assert.deepEqual(m.key(true, 0x010020ac), [{ t: 'char', code: 0x20ac, viaKey: true, down: true }], 'Unicode keysym (euro)');
  assert.deepEqual(m.key(true, 0x1008ff13), [], 'unknown keysym ignored');
  const rel = m.releaseAll();
  assert.equal(rel.length, 5, "Ctrl, c, Left, F12 and the euro");
  assert.ok(rel.every((a) => a.down === false));
});

test('input: Windows lines for SendInput, xdotool arguments elsewhere', () => {
  assert.equal(windowsLine({ t: 'move', x: 0.5, y: 1 }), 'M 32768 65535 0 32769');
  assert.equal(windowsLine({ t: 'button', b: 'left', down: true }), 'M 0 0 0 2');
  assert.equal(windowsLine({ t: 'button', b: 'right', down: false }), 'M 0 0 0 16');
  assert.equal(windowsLine({ t: 'wheel', dy: -1 }), 'M 0 0 -120 2048');
  assert.equal(windowsLine({ t: 'vk', vk: 0x25, ext: true, down: false }), 'K 37 3');
  assert.equal(windowsLine({ t: 'char', code: 0x20ac, down: true, viaKey: false }), 'C 8364 1 0');
  assert.match(PS_LOOP, /SendInput/);
  assert.doesNotMatch(PS_LOOP, /RunAs|Start-Process/, 'never elevates');
  assert.deepEqual(xdotoolArgs({ t: 'move', x: 1, y: 0 }, 1920, 1080), ['mousemove', '1919', '0']);
  assert.deepEqual(xdotoolArgs({ t: 'char', code: 0x61, down: true }, 1, 1), ['keydown', '0x61']);
});

test('RfbSession: input reaches onInput only when given (taking control)', () => {
  const got = [];
  const s = new RfbSession(() => {}, 'PC', (...a) => got.push(a));
  s.start({ width: 200, height: 100, bgra: Buffer.alloc(200 * 100 * 4), jpeg: () => Buffer.alloc(0) });
  s.receive(Buffer.from('RFB 003.008\n'));
  s.receive(Buffer.from([1]));
  s.receive(Buffer.from([1]));
  s.receive(Buffer.from([5, 1, 0, 10, 0, 20]));
  s.receive(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x41]));
  s.receive(Buffer.from([6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69])); // clipboard: ignored
  assert.deepEqual(got, [['pointer', 1, 10, 20, 200, 100], ['key', true, 0x41]]);
});

test('copy and paste: only with the switch on and someone in control; text only, size-capped', () => {
  let board = 'on the PC';
  const opts = (enabled, controlling) => ({ enabled: () => enabled, controlling: () => controlling, read: () => board, write: (t) => { board = t; } });
  assert.match(handleClip({ op: 'get' }, opts(false, true)).output, /off on this PC/);
  assert.equal(handleClip({ op: 'set', text: 'x' }, opts(false, true)).ok, false);
  assert.match(handleClip({ op: 'get' }, opts(true, false)).output, /Nobody has control/);
  assert.equal(board, 'on the PC', 'nothing written while refused');
  assert.deepEqual(handleClip({ op: 'get' }, opts(true, true)), { ok: true, output: 'on the PC' });
  assert.equal(handleClip({ op: 'set', text: 'héllo “quotes” 👋' }, opts(true, true)).ok, true);
  assert.equal(board, 'héllo “quotes” 👋');
  assert.equal(handleClip({ op: 'set', text: '' }, opts(true, true)).ok, false);
  assert.equal(handleClip({ op: 'set', text: 42 }, opts(true, true)).ok, false);
  assert.match(handleClip({ op: 'set', text: 'a'.repeat(MAX_CLIP + 1) }, opts(true, true)).output, /too much/);
  board = 'b'.repeat(MAX_CLIP + 10);
  assert.equal(Buffer.byteLength(handleClip({ op: 'get' }, opts(true, true)).output), MAX_CLIP);
  assert.equal(handleClip({ op: 'wipe' }, opts(true, true)).ok, false);
});

test('used approvals are kept for a day however many there are (no early eviction)', () => {
  const used = new UsedApprovals();
  used.add('first');
  for (let i = 0; i < 2500; i++) used.add(`apr_${i}`);
  assert.equal(used.has('first'), true);
  const old = new UsedApprovals([{ id: 'stale', at: Date.now() - 25 * 3600_000 }]);
  old.add('fresh');
  assert.equal(old.has('stale'), false);
  assert.equal(old.has('fresh'), true);
});

test('an approval the server marks as expired or too old is refused', async () => {
  const { ex } = executor();
  const args = { path: path.join(shared, 'b.txt'), content: 'x' };
  const a1 = { ...approve('pc_write_file', args), expiresAt: Date.now() - 1000 };
  assert.match((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: a1 })).output, /expired/);
  const a2 = { ...approve('pc_write_file', args), at: Date.now() - 31 * 60_000 };
  assert.match((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: a2 })).output, /expired/);
  const a3 = { ...approve('pc_write_file', args), at: Date.now() - 60_000, expiresAt: Date.now() + 60_000 };
  assert.equal((await ex.handle({ tool: 'pc_write_file', args, bot: leonard, approval: a3 })).ok, true);
});

test('a bot refused by name stays refused by its id after a rename', async () => {
  const ids = [];
  const { ex } = executor({ blocked: () => ['Robin'], blockedIds: () => ids.map((b) => b.id), rememberBlockedId: (id, name) => ids.push({ id, name }) });
  const r1 = await ex.handle({ tool: 'pc_list_files', args: { path: shared }, bot: { id: 'bot_p', name: 'Robin' } });
  assert.match(r1.output, /does not allow/);
  assert.deepEqual(ids, [{ id: 'bot_p', name: 'Robin' }]);
  const r2 = await ex.handle({ tool: 'pc_list_files', args: { path: shared }, bot: { id: 'bot_p', name: 'Helper' } });
  assert.match(r2.output, /does not allow/);
  const r3 = await ex.handle({ tool: 'pc_list_files', args: { path: shared }, bot: leonard });
  assert.doesNotMatch(r3.output ?? '', /does not allow/);
});
