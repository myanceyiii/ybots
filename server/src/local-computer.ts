import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { env } from './env.js';
import type { OrgoComputer, OrgoScreen } from './orgo.js';

/**
 * The bots' screens on this machine, in place of an Orgo computer (COMPUTER=local).
 *
 * Every screen is an X display: the default screen is :99 (where the primary bot's agent lives),
 * and each extra bot gets :100, :101, ... Each display runs
 *   - Xvfb (the display itself),
 *   - a window manager when one is installed (xfwm4, openbox or fluxbox), so windows can be
 *     maximised and closed like on a desktop,
 *   - x11vnc on 127.0.0.1 only, with a password kept in LOCAL_STATE_DIR, for the live view
 *     (vnc.ts relays it to the browser; the password never leaves the server).
 * These run detached, so the bots' browsers survive a restart of this server. A display that
 * somebody else already runs (say a desktop session on :99) is used as it is.
 *
 * The object at the bottom speaks the same calls as the Orgo client (orgo.ts), so computer.ts,
 * the screenshot route and the rest work unchanged.
 */

const DEFAULT_DISPLAY = 99;
const FIRST_EXTRA = 100;
/** x11vnc port for display N; well clear of X's own 6000+N. */
export const vncPort = (n: number) => 15900 + n;

const stateDir = () => env.localStateDir;
const pidFile = (what: string, n: number) => path.join(stateDir(), `${what}-${n}.pid`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const displayNumber = (screenId: string) => (screenId === 'default' ? DEFAULT_DISPLAY : Number(screenId.replace('screen-', '')));
const screenIdFor = (n: number) => (n === DEFAULT_DISPLAY ? 'default' : `screen-${n}`);

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

function readPid(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Whether X display :n is up: its lock file names a live process. */
export function displayUp(n: number): boolean {
  return alive(readPid(`/tmp/.X${n}-lock`));
}

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** Start a long-lived helper outside this process, so it outlives a server restart. */
function startDetached(cmd: string, args: string[], n: number, what: string, extraEnv: Record<string, string> = {}): number | undefined {
  fs.mkdirSync(stateDir(), { recursive: true });
  const log = fs.openSync(path.join(stateDir(), `${what}-${n}.log`), 'a');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', LANG: process.env.LANG ?? 'C.UTF-8', DISPLAY: `:${n}`, ...extraEnv },
  });
  // A missing Xvfb, x11vnc or window manager gives an 'error' event: logged, never an unhandled one.
  child.on('error', (e) => console.warn(`[local-computer] could not start ${what} on :${n}: ${String(e?.message ?? e)}`));
  child.unref();
  fs.closeSync(log);
  if (child.pid) fs.writeFileSync(pidFile(what, n), String(child.pid));
  return child.pid;
}

function size(): { width: number; height: number } {
  const [w, h] = env.localResolution.split('x').map(Number);
  return { width: w, height: h };
}

/** What `xdpyinfo` says the display's size is; the configured size when it cannot tell. */
async function displaySize(n: number): Promise<{ width: number; height: number }> {
  const out = await run('xdpyinfo', ['-display', `:${n}`], 5000).catch(() => '');
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(out);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : size();
}

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

function runBuffer(cmd: string, args: string[], extraEnv: Record<string, string>, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr ?? err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

const starting = new Map<number, Promise<void>>();

/** Make sure display :n is up, with its window manager. Starts what is missing. */
export function ensureDisplay(n: number): Promise<void> {
  const running = starting.get(n);
  if (running) return running;
  const p = (async () => {
    if (!displayUp(n)) {
      if (!which('Xvfb')) throw new Error('Xvfb is not installed; run scripts/setup-local.sh');
      const { width, height } = size();
      // Our own displays only: no TCP, no extensions a desktop would not have.
      startDetached('Xvfb', [`:${n}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-dpi', '96'], n, 'xvfb');
      for (let i = 0; i < 50 && !displayUp(n); i++) await sleep(100);
      if (!displayUp(n)) throw new Error(`display :${n} did not start (see ${path.join(stateDir(), `xvfb-${n}.log`)})`);
    }
    if (!alive(readPid(pidFile('wm', n)))) {
      const wm = ['xfwm4', 'openbox', 'fluxbox'].find((w) => which(w));
      if (wm) startDetached(wm, wm === 'xfwm4' ? ['--compositor=off'] : [], n, 'wm');
    }
  })().finally(() => starting.delete(n));
  starting.set(n, p);
  return p;
}

/**
 * Whether a pid from a pid file is still the program we started for display :n. A pid can be reused after a
 * reboot or a crash: only a process whose environment has our DISPLAY=:n is signalled.
 */
function ourPid(pid: number | null, n: number): boolean {
  if (!alive(pid)) return false;
  try { return fs.readFileSync(`/proc/${pid}/environ`).toString('latin1').split('\0').includes(`DISPLAY=:${n}`); }
  catch { return process.platform !== 'linux'; }
}

/** Stop what this module started on display :n (never the default screen). */
export async function stopDisplay(n: number): Promise<void> {
  if (n === DEFAULT_DISPLAY) return;
  for (const what of ['vnc', 'wm', 'xvfb']) {
    const pid = readPid(pidFile(what, n));
    if (ourPid(pid, n)) { try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ } }
    try { fs.unlinkSync(pidFile(what, n)); } catch { /* none */ }
  }
}

// ---------- VNC for the live view ----------

/** The VNC password for this machine's screens: made once, kept with mode 0600, never sent to a browser. */
export function vncPassword(): string {
  const file = path.join(stateDir(), 'vnc-password');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* make one */ }
  fs.mkdirSync(stateDir(), { recursive: true });
  // VNC auth uses only the first 8 characters.
  const pw = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  fs.writeFileSync(file, pw, { mode: 0o600 });
  return pw;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/**
 * x11vnc's options for the live view. `-nonap` matters: by default x11vnc "naps" once its screen has been
 * idle for a minute and then answers only every 250 ms or so, which made every step of the VNC handshake
 * wait that long (about 1.5 s to open a screen nobody had watched lately, measured on Host2 2026-11-25);
 * with -nonap it answers at once. Without a viewer x11vnc does not poll the screen, so this costs nothing.
 * Bump VNC_FLAGS_VERSION when these change: an x11vnc started with older flags is restarted.
 */
const VNC_FLAGS_VERSION = '2';
const vncArgs = (n: number, port: number, passFile: string) =>
  ['-display', `:${n}`, '-rfbport', String(port), '-localhost', '-rfbauth', passFile, '-forever', '-shared', '-noxdamage', '-nonap', '-quiet'];
const vncFlagsFile = (n: number) => path.join(stateDir(), `vnc-${n}.flags`);

/** Stop this display's x11vnc (the one we started, or any x11vnc on its port) and wait until it is gone. */
async function stopVnc(n: number): Promise<void> {
  const pattern = `x11vnc .*-rfbport ${vncPort(n)}( |$)`;
  const left = async () => (await run('pgrep', ['-f', pattern], 5000).catch(() => '')).trim() !== '';
  const pid = readPid(pidFile('vnc', n));
  if (ourPid(pid, n)) { try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ } }
  // One started before the pid file existed, or by an older build, is found by its port.
  await run('pkill', ['-f', pattern], 5000).catch(() => '');
  for (let i = 0; i < 20 && (await left()); i++) await sleep(100);
  // A hung (or stopped) x11vnc ignores SIGTERM.
  if (await left()) {
    if (ourPid(pid, n)) { try { process.kill(pid!, 'SIGKILL'); } catch { /* gone */ } }
    await run('pkill', ['-KILL', '-f', pattern], 5000).catch(() => '');
    for (let i = 0; i < 20 && (await left()); i++) await sleep(100);
  }
  try { fs.unlinkSync(pidFile('vnc', n)); } catch { /* none */ }
}

const vncStarting = new Map<number, Promise<void>>();

/**
 * Where the live view of a screen can be reached: x11vnc on 127.0.0.1, started if needed. `restart`
 * replaces a running one (the relay asks for that when x11vnc stopped answering).
 */
export async function vncTarget(screenId: string, opts: { restart?: boolean } = {}): Promise<{ host: string; port: number; password: string }> {
  const n = displayNumber(screenId);
  await ensureDisplay(n);
  const port = vncPort(n);
  const password = vncPassword();
  const pending = vncStarting.get(n);
  if (pending) await pending;
  else {
    const p = (async () => {
      let up = await portOpen(port);
      const current = (() => { try { return fs.readFileSync(vncFlagsFile(n), 'utf8').trim(); } catch { return ''; } })();
      if (up && (opts.restart || current !== VNC_FLAGS_VERSION)) {
        console.log(`[vnc] restarting x11vnc on :${n} (${opts.restart ? 'it stopped answering' : 'new options'})`);
        await stopVnc(n);
        up = await portOpen(port);
      }
      if (up) return;
      if (!which('x11vnc')) throw new Error('x11vnc is not installed; run scripts/setup-local.sh');
      const passFile = path.join(stateDir(), 'vnc-passfile');
      if (!fs.existsSync(passFile)) await run('x11vnc', ['-storepasswd', password, passFile], 10_000);
      fs.chmodSync(passFile, 0o600);
      startDetached('x11vnc', vncArgs(n, port, passFile), n, 'vnc');
      for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);
      if (!(await portOpen(port))) throw new Error(`x11vnc did not start on :${n} (see ${path.join(stateDir(), `vnc-${n}.log`)})`);
      fs.writeFileSync(vncFlagsFile(n), VNC_FLAGS_VERSION);
    })().finally(() => vncStarting.delete(n));
    vncStarting.set(n, p);
    await p;
  }
  return { host: '127.0.0.1', port, password };
}

// ---------- screenshots ----------

async function screenshot(screenId: string): Promise<{ image: string; mime_type: string; width: number; height: number }> {
  const n = displayNumber(screenId);
  await ensureDisplay(n);
  const { width, height } = await displaySize(n);
  let jpeg: Buffer | null = null;
  if (which('import')) {
    jpeg = await runBuffer('import', ['-silent', '-window', 'root', '-quality', '75', 'jpeg:-'], { DISPLAY: `:${n}` }).catch(() => null);
  }
  if (!jpeg?.length && which('ffmpeg')) {
    jpeg = await runBuffer('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-video_size', `${width}x${height}`, '-i', `:${n}`, '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], {}).catch(() => null);
  }
  if (!jpeg?.length) throw new Error('could not take a screenshot (install imagemagick or ffmpeg)');
  return { image: jpeg.toString('base64'), mime_type: 'image/jpeg', width, height };
}

// ---------- the Orgo-shaped client ----------

/** Displays this module manages (or found running) that count as screens: :99 and :100 upwards. */
function knownDisplays(): number[] {
  const out = new Set<number>([DEFAULT_DISPLAY]);
  for (const f of fs.existsSync(stateDir()) ? fs.readdirSync(stateDir()) : []) {
    const m = /^xvfb-(\d+)\.pid$/.exec(f);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

async function screenInfo(n: number): Promise<OrgoScreen> {
  const { width, height } = await displaySize(n);
  return { id: screenIdFor(n), display: `:${n}`, width, height, default: n === DEFAULT_DISPLAY };
}

const notHere = (what: string) => async (): Promise<never> => { throw new Error(`${what} is not available with local screens`); };

export const localOrgo = {
  workspaces: notHere('Orgo workspaces'),
  createComputer: notHere('Creating computers'),
  async getComputer(id: string): Promise<OrgoComputer> {
    await ensureDisplay(DEFAULT_DISPLAY);
    return { id, status: 'running', name: 'this machine', asleep: null };
  },
  // This machine is always on; there is nothing to start, wake or put to sleep.
  async start(_id: string) { await ensureDisplay(DEFAULT_DISPLAY); return {}; },
  async resume(_id: string) { await ensureDisplay(DEFAULT_DISPLAY); return {}; },
  async suspend(_id: string) { return {}; },
  /** The relay asks vncTarget for local screens; this is here so the shape matches. */
  async vncPassword(_id: string) { return { password: vncPassword(), desktop_api_token: '' }; },

  async listScreens(_id: string): Promise<OrgoScreen[]> {
    const up = knownDisplays().filter(displayUp);
    return Promise.all(up.map(screenInfo));
  },
  async createScreen(_id: string): Promise<OrgoScreen> {
    let n = FIRST_EXTRA;
    while (displayUp(n) || alive(readPid(pidFile('xvfb', n)))) n++;
    await ensureDisplay(n);
    return screenInfo(n);
  },
  /** A screen that went away (the machine restarted) is started again rather than lost. */
  async getScreen(_id: string, screen: string): Promise<OrgoScreen> {
    const n = displayNumber(screen);
    if (!Number.isInteger(n) || n < DEFAULT_DISPLAY) throw new Error(`no screen ${screen}`);
    await ensureDisplay(n);
    return screenInfo(n);
  },
  async deleteScreen(_id: string, screen: string): Promise<void> {
    await stopDisplay(displayNumber(screen));
  },

  screenshot: (_id: string, screen?: string) => screenshot(screen ?? 'default'),
  click: notHere('Orgo input calls'),
  move: notHere('Orgo input calls'),
  drag: notHere('Orgo input calls'),
  type: notHere('Orgo input calls'),
  key: notHere('Orgo input calls'),
  scroll: notHere('Orgo input calls'),
  /** box.ts runs commands itself when the computer is local; nothing should get here. */
  bash: notHere('Orgo shell calls'),
  exportFile: notHere('Orgo file export'),
};
