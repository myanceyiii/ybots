import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { isSilo } from './silo.js';
import { isOutside } from './outside.js';
import { screenFor } from './computer.js';
import { displayNumber } from './local-computer.js';

/**
 * Copy and paste between a person's own device and a bot's screen (docs/remote-pc.md, "Copy and paste").
 *
 * Text only, at most MAX_CLIPBOARD_BYTES, and only when the person presses Paste or Copy (or the
 * matching shortcut while driving): nothing is ever synced in the background. On this machine's screens
 * (COMPUTER=local) the X clipboard of the bot's display is set and read with xclip (or xsel); the bytes
 * never touch disk. Siloed and outside bots have no screen here, so they have no clipboard either.
 * Paired PCs go through machines.ts instead, behind the PC's own "copy and paste" switch.
 */

export const MAX_CLIPBOARD_BYTES = 256 * 1024;

export class ClipboardError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** The tool that reaches the X clipboard here, with its read and write arguments. */
function tool(): { cmd: string; read: string[]; write: (sel: string) => string[] } {
  if (which('xclip')) return { cmd: 'xclip', read: ['-selection', 'clipboard', '-o'], write: (sel) => ['-selection', sel, '-i'] };
  if (which('xsel')) return { cmd: 'xsel', read: ['--clipboard', '--output'], write: (sel) => [sel === 'clipboard' ? '--clipboard' : '--primary', '--input'] };
  throw new ClipboardError('Copy and paste needs xclip on the server (sudo apt install xclip).', 501);
}

/** Bytes cut to at most `max` without splitting a character. */
export function cutUtf8(text: string, max = MAX_CLIPBOARD_BYTES): { text: string; cut: boolean } {
  const b = Buffer.from(text, 'utf8');
  if (b.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // back to a character boundary
  return { text: b.subarray(0, end).toString('utf8'), cut: true };
}

/** Checks a pasted text: a string, not empty, not too big. Returns it unchanged. */
export function checkPaste(text: unknown): string {
  if (typeof text !== 'string') throw new ClipboardError('Send the text to paste.', 400);
  if (!text.length) throw new ClipboardError('There is nothing to paste.', 400);
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) throw new ClipboardError(`That is too much to paste at once (${MAX_CLIPBOARD_BYTES / 1024} KB at most).`, 413);
  return text;
}

async function botDisplay(userId: string, botId: string): Promise<string> {
  if (isSilo(botId) || isOutside(botId)) throw new ClipboardError("This bot's screen isn't on this server, so copy and paste can't reach it.");
  if (env.computer !== 'local') throw new ClipboardError('Copy and paste works with screens on this server (COMPUTER=local) only.', 501);
  const { screenId } = await screenFor(userId, botId);
  const n = displayNumber(screenId);
  if (!Number.isInteger(n)) throw new ClipboardError('This bot has no screen yet.');
  return `:${n}`;
}

const xEnv = (display: string) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', LANG: 'C.UTF-8', DISPLAY: display });

/** What is on the bot's screen's clipboard now ('' when nothing is). */
export async function readBotClipboard(userId: string, botId: string): Promise<{ text: string; cut: boolean }> {
  return readDisplayClipboard(await botDisplay(userId, botId));
}

/** What is on X display `display`'s clipboard ('' when nothing, or not text). */
export async function readDisplayClipboard(display: string): Promise<{ text: string; cut: boolean }> {
  const t = tool();
  const out = await new Promise<Buffer>((resolve, reject) => {
    execFile(t.cmd, t.read, { env: xEnv(display), timeout: 4000, maxBuffer: MAX_CLIPBOARD_BYTES * 4, encoding: 'buffer' }, (err, stdout, stderr) => {
      // xclip says "target STRING not available" when the clipboard is empty: that is just nothing copied.
      if (err && /not available|no selection|can't open|cannot open/i.test(String(stderr))) {
        if (/open display/i.test(String(stderr))) reject(new ClipboardError("The bot's screen isn't running.", 503));
        else resolve(Buffer.alloc(0));
        return;
      }
      if (err) reject(new ClipboardError(`Couldn't read the clipboard: ${String(stderr || err.message).slice(0, 200)}`, 502));
      else resolve(stdout);
    });
  });
  if (out.includes(0)) return { text: '', cut: false }; // not text (an image or a file list)
  return cutUtf8(out.toString('utf8'));
}

/** Put text on the bot's screen's clipboard (and the middle-click selection), ready for Ctrl+V there. */
export async function writeBotClipboard(userId: string, botId: string, text: string): Promise<void> {
  checkPaste(text);
  await writeDisplayClipboard(await botDisplay(userId, botId), text);
}

/** Put text on X display `display`'s clipboard and middle-click selection. */
export async function writeDisplayClipboard(display: string, text: string): Promise<void> {
  checkPaste(text);
  const t = tool();
  for (const sel of ['clipboard', 'primary']) {
    await new Promise<void>((resolve, reject) => {
      // xclip and xsel stay in the background to hand the text to whoever pastes it, until something else is
      // copied there: detached, so they outlive this request (and a restart of this server).
      const child = spawn(t.cmd, t.write(sel), { env: xEnv(display), stdio: ['pipe', 'ignore', 'pipe'], detached: true });
      let err = '';
      child.stderr?.on('data', (d) => { if (err.length < 500) err += d; });
      const timer = setTimeout(() => { child.stderr?.destroy(); resolve(); }, 3000); // still serving: that is fine
      child.on('error', (e) => { clearTimeout(timer); reject(new ClipboardError(`Couldn't set the clipboard: ${e.message}`, 502)); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        child.stderr?.destroy(); // the background copy keeps its end; we are done listening
        if (code === 0) resolve();
        else reject(new ClipboardError(/open display/i.test(err) ? "The bot's screen isn't running." : `Couldn't set the clipboard: ${err.slice(0, 200) || `exit ${code}`}`, 502));
      });
      child.stdin.end(text, 'utf8');
      child.unref();
    });
  }
}
