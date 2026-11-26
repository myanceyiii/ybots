// Copy and paste with a bot's screen (server/src/clipboard.ts) on a real X display. Needs Xvfb and xclip
// (scripts/setup-local.sh installs them) and a built server: `npm run build -w server`, then
// `node tests/clipboard-local.mjs`. Uses display :131 and stops what it started.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-local-'));
Object.assign(process.env, { COMPUTER: 'local', LOCAL_STATE_DIR: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'test.db') });
const clip = await import('../server/dist/clipboard.js');

const D = ':131';
const xvfb = spawn('Xvfb', [D, '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !fs.existsSync('/tmp/.X11-unix/X131'); i++) await sleep(100);

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};
const xread = (sel) => execFileSync('xclip', ['-selection', sel, '-o'], { env: { ...process.env, DISPLAY: D } }).toString();

try {
  await test('an empty clipboard reads as nothing, not an error', async () => {
    assert.deepEqual(await clip.readDisplayClipboard(D), { text: '', cut: false });
  });
  await test('paste: the text lands on the clipboard and the middle-click selection, Unicode intact', async () => {
    const text = 'Smart “quotes” — dashes, émoji 👋\nand a second line';
    await clip.writeDisplayClipboard(D, text);
    assert.equal(xread('clipboard'), text);
    assert.equal(xread('primary'), text);
  });
  await test('copy: what an app copied there comes back', async () => {
    const c = spawn('xclip', ['-selection', 'clipboard', '-i'], { env: { ...process.env, DISPLAY: D }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.stdin.end('copied in the bot’s browser');
    await new Promise((r) => c.on('exit', r));
    assert.deepEqual(await clip.readDisplayClipboard(D), { text: 'copied in the bot’s browser', cut: false });
  });
  await test('limits: empty and oversized pastes are refused; a big copy is cut on a character boundary', async () => {
    await assert.rejects(clip.writeDisplayClipboard(D, ''), /nothing to paste/);
    await assert.rejects(clip.writeDisplayClipboard(D, 'x'.repeat(clip.MAX_CLIPBOARD_BYTES + 1)), /too much/);
    const cut = clip.cutUtf8('é'.repeat(clip.MAX_CLIPBOARD_BYTES));
    assert.equal(cut.cut, true);
    assert.ok(Buffer.byteLength(cut.text) <= clip.MAX_CLIPBOARD_BYTES);
    assert.ok(!cut.text.includes('�'));
  });
  await test('a display that is not running says so', async () => {
    await assert.rejects(clip.readDisplayClipboard(':139'), /isn't running/);
  });
} finally {
  xvfb.kill();
  try { execFileSync('pkill', ['-f', `xclip.*`], { stdio: 'ignore' }); } catch { /* none left */ }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}
