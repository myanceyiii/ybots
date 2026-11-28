'use strict';
// "Let YBots use this PC" (docs/remote-pc.md): the parts that need no Electron, so they can be
// tested on their own. remote.js wires them to the window, the screen and the link to the server.
//
//   - approvalDigest: the same hash the server puts on an approval card (server/src/agent/loop.ts).
//     Anything that changes this PC must arrive with an approval whose digest matches the exact call,
//     and each approval runs once. One the person "always allowed" (for that bot, action and PC) comes
//     the same way, marked with `rule`, and the activity line says so.
//   - resolveInside: every path must resolve (links followed) to a place inside a shared folder.
//   - makeExecutor: runs the pc_* tools under those rules, plus this PC's own block list and switches.
//   - handleClip: copy and paste while someone has control, behind its own switch (off by default).
//   - RfbSession: a small RFB (VNC) server for one viewer, fed with screen captures; it sends changed
//     tiles as Tight JPEG rectangles, which noVNC (web and Android) understands. It ignores input.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------- approvals ----------

/** JSON with object keys sorted at every level; must match canonical() in server/src/agent/loop.ts. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function approvalDigest(approvalId, tool, tools, args) {
  return crypto.createHash('sha256').update(canonical({ approvalId, tool, tools, args })).digest('hex');
}

const KEEP_USED_MS = 24 * 3600_000;
/** An approval older than this is refused even if the server sends it (cards expire after 25 minutes). */
const MAX_APPROVAL_AGE_MS = 30 * 60_000;

/** Approval ids already used, so one approval runs one thing once. Kept on disk by remote.js. */
class UsedApprovals {
  constructor(list = []) { this.ids = new Map(list.map((x) => [x.id, x.at])); }
  has(id) { return this.ids.has(id); }
  add(id) {
    this.ids.set(id, Date.now());
    // Cards expire after 25 minutes; an id is kept for a whole day, however many there are, so a used
    // approval can never run again while it could still be valid. (Ids are short; a busy day is small.)
    const cutoff = Date.now() - KEEP_USED_MS;
    for (const [k, at] of this.ids) if (at < cutoff) this.ids.delete(k);
  }
  toJSON() { return [...this.ids].map(([id, at]) => ({ id, at })); }
}

// ---------- paths ----------

const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);

/**
 * The real path `p` stands for, if it is inside one of `roots` (real paths of the shared folders);
 * throws a sentence otherwise. A path that does not exist yet is allowed when its folder exists and is
 * inside (for writing a new file or folder). Device paths, UNC paths and NTFS streams are refused.
 */
function resolveInside(p, roots, { mustExist = true } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('A path is needed.');
  const raw = p.trim();
  if (/^[\\/]{2}/.test(raw)) throw new Error('Network and device paths are not allowed.');
  if (WIN && /:/.test(raw.replace(/^[A-Za-z]:/, ''))) throw new Error('That path is not allowed.');
  if (!path.isAbsolute(raw)) throw new Error('Use a full path, inside a shared folder.');
  const full = path.resolve(raw);
  let real;
  try {
    real = fs.realpathSync.native(full);
  } catch {
    if (mustExist) throw new Error('No such file or folder.');
    // Not there yet. A link with nothing at its end (a dangling one) also lands here: writing to it would
    // create whatever it points at, maybe outside the shared folders, so only a name that is truly free passes.
    try { fs.lstatSync(full); throw new Error('That is a link to something that is not there; links are not followed.'); }
    catch (e) { if (e && e.code !== 'ENOENT') throw e.code ? new Error('That path is not allowed.') : e; }
    const parent = path.dirname(full);
    let realParent;
    try { realParent = fs.realpathSync.native(parent); } catch { throw new Error('Its folder does not exist.'); }
    real = path.join(realParent, path.basename(full));
  }
  for (const root of roots) {
    const r = norm(root);
    const x = norm(real);
    if (x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return real;
  }
  throw new Error('That is outside the folders shared on this PC.');
}

// ---------- tools ----------

/** Bots this PC always refuses, whatever the server says. */
const DEFAULT_BLOCKED = [];

const CHANGES = new Set(['pc_write_file', 'pc_make_folder', 'pc_move', 'pc_delete', 'pc_run']);
const READS = new Set(['pc_list_files', 'pc_read_file']);
const MAX_READ = 256 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;

/**
 * Runs the server's pc_* calls under this PC's own rules:
 *   opts.folders()   -> [{ name, path }] shared folders (paths as the person picked them)
 *   opts.commands()  -> whether "Allow commands" is on
 *   opts.blocked()   -> bot names this PC refuses (none by default)
 *   opts.blockedIds() / opts.rememberBlockedId(id, listedName) -> ids of bots refused by name before (kept across renames)
 *   opts.used        -> UsedApprovals; opts.saveUsed() after each use
 *   opts.run(command, cwd, timeoutMs) -> Promise<{ code, output, timedOut }>
 *   opts.onActivity(text) -> tell the person what is happening (tray, bar)
 */
function makeExecutor(opts) {
  const roots = () => opts.folders().map((f) => { try { return fs.realpathSync.native(f.path); } catch { return null; } }).filter(Boolean);

  async function handle(call) {
    const tool = String(call?.tool ?? '');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const botName = String(call?.bot?.name ?? '').trim();
    const botId = String(call?.bot?.id ?? '').trim();
    if (!botName) return { ok: false, output: 'Refused: the request did not say which bot sent it.' };
    // A bot once refused by name stays refused by its id, so renaming it does not let it in.
    const hit = [...DEFAULT_BLOCKED, ...opts.blocked()].find((b) => String(b).trim().toLowerCase() === botName.toLowerCase());
    const byName = hit !== undefined;
    if (byName && botId) opts.rememberBlockedId?.(botId, String(hit).trim());
    if (byName || (botId && (opts.blockedIds?.() ?? []).includes(botId))) return { ok: false, output: `This PC does not allow ${botName}.` };
    if (!CHANGES.has(tool) && !READS.has(tool)) return { ok: false, output: `This PC does not know ${tool}.` };
    if (!opts.folders().length) return { ok: false, output: 'No folders are shared on this PC.' };

    // A change the person always allowed for this bot, action and PC still arrives as a one-time
    // approval for this exact call; it is marked so the person here can see it was not asked about.
    const viaRule = CHANGES.has(tool) && typeof call.approval?.rule === 'string';
    const act = (text) => opts.onActivity?.(viaRule ? `${text} (always allowed)` : text);
    if (CHANGES.has(tool)) {
      const a = call.approval;
      if (!a || typeof a.id !== 'string' || typeof a.digest !== 'string') return { ok: false, output: 'Refused: this needs an approval from the person, and none came with it.' };
      if (approvalDigest(a.id, tool, [], args) !== a.digest) return { ok: false, output: 'Refused: the approval does not match this exact action.' };
      if (opts.used.has(a.id)) return { ok: false, output: 'Refused: that approval was already used.' };
      // When the server says when the approval was given or when it expires, the PC checks it too.
      const now = Date.now();
      if (typeof a.expiresAt === 'number' && a.expiresAt < now) return { ok: false, output: 'Refused: that approval has expired.' };
      if (typeof a.at === 'number' && now - a.at > MAX_APPROVAL_AGE_MS) return { ok: false, output: 'Refused: that approval has expired.' };
      opts.used.add(a.id);
      opts.saveUsed?.();
    }
    const shared = roots();
    try {
      switch (tool) {
        case 'pc_list_files': {
          const dir = resolveInside(args.path, shared);
          const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map((e) => {
            let size;
            try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch { /* */ }
            return { name: e.name, type: e.isDirectory() ? 'folder' : e.isFile() ? 'file' : 'other', ...(size !== undefined ? { size } : {}) };
          });
          return { ok: true, output: JSON.stringify({ path: dir, entries }, null, 2) };
        }
        case 'pc_read_file': {
          const file = resolveInside(args.path, shared);
          const st = fs.statSync(file);
          if (!st.isFile()) return { ok: false, output: 'That is not a file.' };
          if (st.size > MAX_READ) return { ok: false, output: `That file is ${st.size} bytes; at most ${MAX_READ} can be read.` };
          const buf = fs.readFileSync(file);
          if (buf.includes(0)) return { ok: false, output: 'That looks like a binary file; only text files can be read.' };
          return { ok: true, output: buf.toString('utf8') };
        }
        case 'pc_write_file': {
          const content = String(args.content ?? '');
          if (Buffer.byteLength(content) > MAX_WRITE) return { ok: false, output: 'That is too much to write at once (2 MB at most).' };
          const file = resolveInside(args.path, shared, { mustExist: false });
          if (fs.existsSync(file) && !fs.statSync(file).isFile()) return { ok: false, output: 'That is a folder.' };
          act(`${botName} is writing ${path.basename(file)}`);
          // Checked again right before writing: a link made in between is refused, not followed.
          try { if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, output: 'That is a link; links are not written through.' }; } catch { /* not there yet */ }
          fs.writeFileSync(file, content);
          return { ok: true, output: `Wrote ${Buffer.byteLength(content)} bytes to ${file}.` };
        }
        case 'pc_make_folder': {
          const dir = resolveInside(args.path, shared, { mustExist: false });
          fs.mkdirSync(dir);
          return { ok: true, output: `Made ${dir}.` };
        }
        case 'pc_move': {
          const from = resolveInside(args.from, shared);
          const to = resolveInside(args.to, shared, { mustExist: false });
          if (shared.some((r) => norm(r) === norm(from))) return { ok: false, output: 'A shared folder itself cannot be moved.' };
          if (fs.existsSync(to)) return { ok: false, output: 'Something is already there.' };
          act(`${botName} is moving ${path.basename(from)}`);
          fs.renameSync(from, to);
          return { ok: true, output: `Moved ${from} to ${to}.` };
        }
        case 'pc_delete': {
          const target = resolveInside(args.path, shared);
          if (shared.some((r) => norm(r) === norm(target))) return { ok: false, output: 'A shared folder itself cannot be deleted.' };
          const st = fs.lstatSync(target);
          act(`${botName} is deleting ${path.basename(target)}`);
          if (st.isDirectory()) fs.rmdirSync(target); // empty folders only
          else fs.unlinkSync(target);
          return { ok: true, output: `Deleted ${target}.` };
        }
        case 'pc_run': {
          if (!opts.commands()) return { ok: false, output: 'Commands are turned off on this PC.' };
          const command = String(args.command ?? '');
          if (!command.trim()) return { ok: false, output: 'No command given.' };
          const cwd = args.cwd ? resolveInside(args.cwd, shared) : shared[0];
          if (!cwd) return { ok: false, output: 'No shared folder to run in.' };
          const seconds = Math.min(600, Math.max(1, Number(args.timeoutSeconds) || 60));
          act(`${botName} is running a command`);
          const r = await opts.run(command, cwd, seconds * 1000);
          const out = r.output.length > MAX_OUTPUT ? `${r.output.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} bytes]` : r.output;
          return { ok: !r.timedOut && r.code === 0, output: `${r.timedOut ? `Stopped after ${seconds} s.\n` : `Exit code ${r.code}.\n`}${out}` };
        }
        default:
          return { ok: false, output: 'Unknown tool.' };
      }
    } catch (e) {
      return { ok: false, output: String(e?.message ?? e) };
    }
  }
  return { handle };
}

// ---------- copy and paste ----------

const MAX_CLIP = 256 * 1024;

/**
 * The server's copy and paste requests ({ t: 'clip', op: 'get' | 'set', text }) under this PC's rules:
 * only with "Allow copy and paste" on (it needs taking control on too), only while someone has taken
 * control, text only, at most 256 KB. Nothing is sent unless the person on the other end pressed Copy.
 *   opts.enabled()     -> the switch is on (and taking control is on)
 *   opts.controlling() -> someone has control right now
 *   opts.read()        -> the PC's clipboard text
 *   opts.write(text)   -> put text on the PC's clipboard
 */
function handleClip(msg, opts) {
  if (!opts.enabled()) return { ok: false, output: 'Copy and paste is off on this PC.' };
  if (!opts.controlling()) return { ok: false, output: 'Nobody has control of this PC right now.' };
  if (msg?.op === 'set') {
    const text = msg.text;
    if (typeof text !== 'string' || !text.length) return { ok: false, output: 'There is nothing to paste.' };
    if (Buffer.byteLength(text) > MAX_CLIP) return { ok: false, output: 'That is too much to paste at once (256 KB at most).' };
    opts.write(text);
    return { ok: true, output: '' };
  }
  if (msg?.op === 'get') {
    let text = String(opts.read() ?? '');
    if (Buffer.byteLength(text) > MAX_CLIP) text = Buffer.from(text).subarray(0, MAX_CLIP).toString('utf8').replace(/\uFFFD$/, '');
    return { ok: true, output: text };
  }
  return { ok: false, output: 'Unknown clipboard request.' };
}

// ---------- the screen as RFB ----------

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

/** Tight's compact length: 7 bits per byte, low bits first, at most 3 bytes. */
function compactLength(n) {
  const out = [n & 0x7f];
  if (n > 0x7f) { out[0] |= 0x80; out.push((n >> 7) & 0x7f); if (n > 0x3fff) { out[1] |= 0x80; out.push((n >> 14) & 0xff); } }
  return Buffer.from(out);
}

const TIGHT = 7;
const RAW = 0;
const DESKTOP_SIZE = -223;
const TILE = 128;

/** Which TILE x TILE tiles differ between two BGRA frames of the same size. */
function changedTiles(prev, next, width, height) {
  const tiles = [];
  for (let ty = 0; ty < height; ty += TILE) {
    for (let tx = 0; tx < width; tx += TILE) {
      const w = Math.min(TILE, width - tx);
      const h = Math.min(TILE, height - ty);
      let differs = !prev;
      for (let y = ty; !differs && y < ty + h; y++) {
        const off = (y * width + tx) * 4;
        if (prev.compare(next, off, off + w * 4, off, off + w * 4) !== 0) differs = true;
      }
      if (differs) tiles.push({ x: tx, y: ty, w, h });
    }
  }
  return tiles;
}

/**
 * One viewer's RFB session. `write(buf)` sends bytes to the viewer (through the link). Feed it the
 * viewer's bytes with `receive(buf)` and every new screen with `frame(f)`, where
 * f = { width, height, bgra, jpeg(x, y, w, h) -> Buffer }.
 */
class RfbSession {
  /** onInput, when given (taking control), gets ('key', down, keysym) and ('pointer', mask, x, y, width, height). */
  constructor(write, name = 'PC', onInput = null) {
    this.write = write;
    this.name = name;
    this.onInput = onInput;
    this.buf = Buffer.alloc(0);
    this.stage = 'version';
    this.encodings = [];
    this.pixel = { bpp: 32, bigEndian: false, rShift: 16, gShift: 8, bShift: 0 };
    this.want = null; // { incremental }
    this.sent = null; // the frame the viewer has
    this.size = null;
    this.latest = null;
    this.closed = false;
  }

  start(frame) {
    this.latest = frame;
    this.size = { width: frame.width, height: frame.height };
    this.write(Buffer.from('RFB 003.008\n'));
  }

  receive(data) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const b = this.buf;
      if (this.stage === 'version') {
        if (b.length < 12) return;
        this.buf = b.subarray(12);
        this.write(Buffer.from([1, 1])); // one security type: None (the link itself is authenticated)
        this.stage = 'security';
      } else if (this.stage === 'security') {
        if (b.length < 1) return;
        this.buf = b.subarray(1);
        this.write(u32(0));
        this.stage = 'init';
      } else if (this.stage === 'init') {
        if (b.length < 1) return;
        this.buf = b.subarray(1);
        const name = Buffer.from(this.name);
        const pf = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
        this.write(Buffer.concat([u16(this.size.width), u16(this.size.height), pf, u32(name.length), name]));
        this.stage = 'normal';
      } else {
        if (!b.length) return;
        const t = b[0];
        let len;
        if (t === 0) len = 20;
        else if (t === 2) len = b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2);
        else if (t === 3) len = 10;
        else if (t === 4) len = 8;
        else if (t === 5) len = 6;
        else if (t === 6) len = b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4));
        else if (t === 150) len = 10;
        else if (t === 248) len = b.length < 4 ? 0 : 4 + b.readUInt16BE(2); // QEMU / fence-like extensions: skip
        else { this.buf = Buffer.alloc(0); return; } // unknown: drop what we have
        if (!len || b.length < len) return;
        const msg = b.subarray(0, len);
        this.buf = b.subarray(len);
        if (t === 0) this.pixel = { bpp: msg[4], bigEndian: msg[6] !== 0, rShift: msg[14], gShift: msg[15], bShift: msg[16] };
        else if (t === 2) { this.encodings = []; for (let i = 0; i < msg.readUInt16BE(2); i++) this.encodings.push(msg.readInt32BE(4 + 4 * i)); }
        else if (t === 3) { this.want = { incremental: msg[1] !== 0 }; this.pump(); }
        else if (t === 4 && this.onInput) this.onInput('key', msg[1] !== 0, msg.readUInt32BE(4));
        else if (t === 5 && this.onInput) this.onInput('pointer', msg[1], msg.readUInt16BE(2), msg.readUInt16BE(4), this.size.width, this.size.height);
        // Input without control, and the clipboard (6) always, are ignored; the server drops them too.
      }
    }
  }

  frame(f) {
    this.latest = f;
    this.pump();
  }

  pump() {
    if (this.closed || !this.want || !this.latest || this.stage !== 'normal') return;
    const f = this.latest;
    const rects = [];
    if (f.width !== this.size.width || f.height !== this.size.height) {
      if (!this.encodings.includes(DESKTOP_SIZE)) return; // keep showing the old size until it changes back
      this.size = { width: f.width, height: f.height };
      rects.push(Buffer.concat([u16(0), u16(0), u16(f.width), u16(f.height), i32(DESKTOP_SIZE)]));
      this.sent = null;
    }
    const tiles = this.want.incremental && this.sent ? changedTiles(this.sent.bgra, f.bgra, f.width, f.height) : changedTiles(null, f.bgra, f.width, f.height);
    if (!tiles.length && !rects.length) return; // nothing new: answer when something changes
    const tight = this.encodings.includes(TIGHT) && this.pixel.bpp === 32;
    for (const t of tiles) rects.push(tight ? this.tightRect(f, t) : this.rawRect(f, t));
    this.want = null;
    this.sent = f;
    this.write(Buffer.concat([Buffer.from([0, 0]), u16(rects.length), ...rects]));
  }

  tightRect(f, t) {
    const jpeg = f.jpeg(t.x, t.y, t.w, t.h);
    return Buffer.concat([u16(t.x), u16(t.y), u16(t.w), u16(t.h), i32(TIGHT), Buffer.from([0x90]), compactLength(jpeg.length), jpeg]);
  }

  rawRect(f, t) {
    const bytes = this.pixel.bpp / 8;
    const out = Buffer.alloc(t.w * t.h * bytes);
    let o = 0;
    for (let y = t.y; y < t.y + t.h; y++) {
      for (let x = t.x; x < t.x + t.w; x++) {
        const i = (y * f.width + x) * 4;
        const v = (f.bgra[i + 2] << this.pixel.rShift) | (f.bgra[i + 1] << this.pixel.gShift) | (f.bgra[i] << this.pixel.bShift);
        if (bytes === 4) { if (this.pixel.bigEndian) out.writeUInt32BE(v >>> 0, o); else out.writeUInt32LE(v >>> 0, o); }
        else if (bytes === 2) { if (this.pixel.bigEndian) out.writeUInt16BE(v & 0xffff, o); else out.writeUInt16LE(v & 0xffff, o); }
        else out[o] = v & 0xff;
        o += bytes;
      }
    }
    return Buffer.concat([u16(t.x), u16(t.y), u16(t.w), u16(t.h), i32(RAW), out]);
  }

  close() { this.closed = true; }
}

module.exports = { handleClip, MAX_CLIP, canonical, approvalDigest, UsedApprovals, resolveInside, makeExecutor, RfbSession, changedTiles, compactLength, DEFAULT_BLOCKED, CHANGES };
