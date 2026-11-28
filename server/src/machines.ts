import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { currentSession } from './lib/auth.js';
import { isSilo } from './silo.js';
import { isOutside } from './outside.js';
import { getBotRow } from './store.js';
import { runStages, stricter, type Decision } from './plugins/policy.js';
import { noteRuleUse } from './allow-rules.js';
import { standingAllow } from './conversation-allows.js';
import type { Machine, MachineLogEntry } from './types.js';
import { checkPaste, ClipboardError, cutUtf8 } from './clipboard.js';

/**
 * PCs paired through the Windows app (docs/remote-pc.md).
 *
 * A PC is paired once, by QR code, approved from a signed-in device; the server keeps its Ed25519
 * public key. The PC then keeps ONE outbound WebSocket to /api/machines/link and proves on every
 * connect that it holds the key. Nothing on the PC listens for connections.
 *
 * Over that link the server sends tool calls (`call`) and opens screen channels (`screen-open`);
 * and asks for copy and paste (`clip`, see machineClipboard); the PC answers (`result`) and streams RFB bytes for each open channel as binary frames
 * ([1 byte sid length][sid][payload]). The screen is relayed to viewers by vnc.ts, watch only.
 *
 * Who may use a PC:
 *   - People: the account that paired it, and when the pairing session knew who was signed in
 *     (`person`), only that person's sessions.
 *   - Bots: the PC's `bots` list, minus any bot that can never use a PC: siloed and outside bots,
 *     and every name in PC_BLOCKED_BOTS. The PC keeps its own block list too.
 *   - Every call that changes something on the PC needs an approval card, sent along as
 *     {id, digest}; the PC checks the digest and runs each approval once.
 */

const LINK_PATH = '/api/machines/link';
const AUTH_TIMEOUT_MS = 10_000;
const PING_MS = 25_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RUN_SECONDS = 600;
const SIGN_PREFIX = 'cleft-machine-link:v1:';

interface PcState { folders: { name: string; path: string }[]; commands: boolean; screen: boolean; control: boolean; clipboard: boolean; blocked: string[]; version: string | null }
interface Pending { resolve: (r: CallReply) => void; timer: NodeJS.Timeout }
export interface CallReply { ok: boolean; output: string }
interface ScreenSink { onData: (b: Buffer) => void; onClose: (why: string) => void }

class Link {
  pending = new Map<string, Pending>();
  screens = new Map<string, ScreenSink>();
  /** Screen channels opened to take control; copy and paste works only while one is open. */
  controlling = new Set<string>();
  state: PcState = { folders: [], commands: false, screen: false, control: false, clipboard: false, blocked: [], version: null };
  alive = true;
  constructor(public ws: WebSocket, public machineId: string, public userId: string) {}
}

const links = new Map<string, Link>();

// ---------- who may use what ----------

export function machineRow(id: string): any {
  return db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').get(id);
}

function botIds(row: any): string[] {
  try { return (JSON.parse(row.bots ?? '[]') as unknown[]).filter((b): b is string => typeof b === 'string'); } catch { return []; }
}

/** Whether a bot may ever use a PC: not siloed, not outside, not a group, and not on the block list. */
export function botMayUsePcs(botId: string | null | undefined): boolean {
  if (!botId) return false;
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return false;
  if (isSilo(botId) || isOutside(botId)) return false;
  // Blocked by id once seen under a blocked name (or listed by id), so renaming the bot never unblocks it.
  if (db.prepare('SELECT 1 FROM pc_blocked_bots WHERE bot_id=?').get(botId) || env.pcBlockedBots.includes(botId.toLowerCase())) return false;
  if (env.pcBlockedBots.includes(String(bot.name ?? '').trim().toLowerCase())) {
    db.prepare('INSERT OR IGNORE INTO pc_blocked_bots(bot_id, name, at) VALUES (?,?,?)').run(botId, String(bot.name ?? ''), Date.now());
    return false;
  }
  return true;
}

/** Bots on the PC block list remembered by id, at startup and whenever one is seen (botMayUsePcs). */
export function rememberBlockedBots() {
  db.exec('CREATE TABLE IF NOT EXISTS pc_blocked_bots (bot_id TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)');
  const ins = db.prepare('INSERT OR IGNORE INTO pc_blocked_bots(bot_id, name, at) VALUES (?,?,?)');
  let bots: { id: string; name: string }[] = [];
  try { bots = db.prepare("SELECT id, name FROM bots WHERE COALESCE(kind,'agent')<>'room'").all() as { id: string; name: string }[]; } catch { /* a brand-new database: no bots yet */ }
  for (const b of bots) if (env.pcBlockedBots.includes(String(b.name ?? '').trim().toLowerCase())) ins.run(b.id, b.name, Date.now());
}
rememberBlockedBots();

/** Whether a signed-in session may see and manage a PC. */
function visibleTo(row: any, userId: string, person: string | null): boolean {
  if (!row || row.user_id !== userId) return false;
  return !row.person || row.person === (person ?? '').toLowerCase();
}

/** The PCs a bot may use right now (paired, listed for it, and the bot not blocked). */
export function machinesForBot(botId: string): any[] {
  if (!botMayUsePcs(botId)) return [];
  const bot = getBotRow(botId);
  return (db.prepare('SELECT * FROM machines WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at').all(bot.user_id) as any[])
    .filter((m) => botIds(m).includes(botId));
}

function describe(row: any): Machine {
  const link = links.get(row.id);
  const blocked = (db.prepare('SELECT id, name FROM bots WHERE user_id=?').all(row.user_id) as any[]).filter((b) => !botMayUsePcs(b.id)).map((b) => b.id as string);
  return {
    id: row.id,
    name: row.name,
    online: !!link,
    lastSeenAt: link ? now() : row.last_seen_at ?? null,
    createdAt: row.created_at,
    folders: link?.state.folders ?? [],
    commands: !!link?.state.commands,
    screen: !!link?.state.screen,
    control: !!link?.state.control,
    clipboard: !!link?.state.clipboard,
    bots: botIds(row).filter((b) => !blocked.includes(b)),
    blockedBots: blocked,
    pcBlocked: link?.state.blocked ?? [],
    version: link?.state.version ?? null,
  };
}

const emit = (userId: string) => hub.emit(userId, { type: 'machines' });

export function logMachine(machineId: string, botId: string | null, tool: string, approvalId: string | null, outcome: string, detail?: string) {
  db.prepare('INSERT INTO machine_log(machine_id,bot_id,tool,approval_id,outcome,detail,at) VALUES (?,?,?,?,?,?,?)')
    .run(machineId, botId, tool, approvalId, outcome, detail ? detail.slice(0, 500) : null, now());
}

// ---------- pairing ----------

/** The PC's public key as given at pairing, if it is a real Ed25519 key; null otherwise. */
export function parsePublicKey(b64: unknown): string | null {
  if (typeof b64 !== 'string' || b64.length > 200) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key.export({ format: 'der', type: 'spki' }).toString('base64') : null;
  } catch {
    return null;
  }
}

/** Called when a signed-in person allows a PC's pairing code. New PCs get every bot that may use PCs (Howard, Leonard), never a blocked one. */
export function createMachine(userId: string, person: string | null, name: string, publicKey: string): string {
  const id = newId('pc');
  const bots = (db.prepare("SELECT id FROM bots WHERE user_id=? ORDER BY created_at").all(userId) as any[]).map((b) => b.id as string).filter((b) => botMayUsePcs(b));
  db.prepare('INSERT INTO machines(id,user_id,person,name,public_key,bots,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, userId, person ? person.toLowerCase() : null, name, publicKey, JSON.stringify(bots), now());
  logMachine(id, null, 'pair', null, 'paired', person ?? undefined);
  emit(userId);
  return id;
}

// ---------- the link ----------

function send(link: Link, msg: object) {
  if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(msg));
}

function dropLink(link: Link, why: string) {
  if (links.get(link.machineId) === link) links.delete(link.machineId);
  for (const [, p] of link.pending) { clearTimeout(p.timer); p.resolve({ ok: false, output: `The connection to the PC was lost (${why}). Whether it finished is unknown; check before trying again.` }); }
  link.pending.clear();
  for (const [, s] of link.screens) s.onClose(why);
  link.screens.clear();
  db.prepare('UPDATE machines SET last_seen_at=? WHERE id=?').run(now(), link.machineId);
  emit(link.userId);
}

function onConnection(ws: WebSocket) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  let link: Link | null = null;
  const authTimer = setTimeout(() => { if (!link) ws.close(4001, 'no hello'); }, AUTH_TIMEOUT_MS);
  ws.send(JSON.stringify({ t: 'challenge', nonce }));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!link) {
      if (isBinary) return ws.close(4002, 'hello first');
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(4002, 'bad hello'); }
      if (msg?.t !== 'hello' || typeof msg.machineId !== 'string' || typeof msg.sig !== 'string') return ws.close(4002, 'bad hello');
      const row = machineRow(msg.machineId);
      let ok = false;
      if (row) {
        try {
          const key = crypto.createPublicKey({ key: Buffer.from(row.public_key, 'base64'), format: 'der', type: 'spki' });
          ok = crypto.verify(null, Buffer.from(SIGN_PREFIX + msg.machineId + ':' + nonce), key, Buffer.from(msg.sig, 'base64'));
        } catch { ok = false; }
      }
      if (!ok) {
        clearTimeout(authTimer);
        console.warn(`[machines] refused a link for ${String(msg.machineId).slice(0, 40)}: ${row ? 'bad signature' : 'unknown or removed PC'}`);
        // 4403 tells the PC it was removed (or never paired), so it stops retrying.
        return ws.close(4403, row ? 'bad signature' : 'removed');
      }
      clearTimeout(authTimer);
      const old = links.get(row.id);
      if (old) { old.ws.close(4000, 'replaced'); dropLink(old, 'replaced'); }
      link = new Link(ws, row.id, row.user_id);
      links.set(row.id, link);
      applyState(link, msg.state);
      db.prepare('UPDATE machines SET last_seen_at=? WHERE id=?').run(now(), row.id);
      send(link, { t: 'ready', name: row.name });
      emit(row.user_id);
      return;
    }
    if (isBinary) {
      const sidLen = data[0];
      const sid = data.subarray(1, 1 + sidLen).toString();
      link.screens.get(sid)?.onData(Buffer.from(data.subarray(1 + sidLen)));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg?.t) {
      case 'state': applyState(link, msg.state); emit(link.userId); break;
      case 'result': {
        const p = link.pending.get(String(msg.id));
        if (!p) break;
        clearTimeout(p.timer);
        link.pending.delete(String(msg.id));
        p.resolve({ ok: msg.ok === true, output: String(msg.output ?? '').slice(0, 200_000) });
        break;
      }
      case 'screen-closed': {
        const s = link.screens.get(String(msg.sid));
        link.screens.delete(String(msg.sid));
        s?.onClose(String(msg.reason ?? 'closed on the PC'));
        break;
      }
      case 'ping': send(link, { t: 'pong' }); break;
      default: break;
    }
  });
  ws.on('pong', () => { if (link) link.alive = true; });
  ws.on('close', () => { clearTimeout(authTimer); if (link) dropLink(link, 'closed'); });
  ws.on('error', () => { /* close follows */ });
}

function applyState(link: Link, s: any) {
  if (!s || typeof s !== 'object') return;
  const folders = Array.isArray(s.folders) ? s.folders.slice(0, 20).filter((f: any) => f && typeof f.path === 'string').map((f: any) => ({ name: String(f.name ?? f.path).slice(0, 80), path: String(f.path).slice(0, 300) })) : [];
  const blocked = Array.isArray(s.blocked) ? s.blocked.slice(0, 20).map((b: any) => String(b).slice(0, 40)) : [];
  const control = s.screen === true && s.control === true;
  link.state = { folders, commands: s.commands === true, screen: s.screen === true, control, clipboard: control && s.clipboard === true, blocked, version: typeof s.version === 'string' ? s.version.slice(0, 20) : null };
}

export function attachMachineLink(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== LINK_PATH) return; // not ours
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
    } catch (e) {
      // A malformed handshake must never reach the process-wide exception handler.
      console.warn('[machines] bad upgrade', String((e as Error)?.message ?? e).slice(0, 200));
      socket.destroy();
    }
  });
  setInterval(() => {
    for (const link of links.values()) {
      if (!link.alive) { link.ws.terminate(); dropLink(link, 'no answer to pings'); continue; }
      link.alive = false;
      try { link.ws.ping(); } catch { /* close follows */ }
    }
  }, PING_MS).unref();
}

/** Ask the PC to run one tool. `approval` is sent for anything that changes the PC. */
export function callMachine(machineId: string, tool: string, args: unknown, bot: { id: string; name: string }, approval: { id: string; digest: string; rule?: string; expiresAt?: number } | null, timeoutMs = CALL_TIMEOUT_MS): Promise<CallReply> {
  const link = links.get(machineId);
  if (!link) return Promise.resolve({ ok: false, output: 'That PC is offline.' });
  const id = crypto.randomBytes(9).toString('base64url');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { link.pending.delete(id); resolve({ ok: false, output: 'The PC did not answer in time. Whether it finished is unknown.' }); }, timeoutMs);
    link.pending.set(id, { resolve, timer });
    // The PC may refuse a grant after `expiresAt` (the call's own deadline), and keep its replay record until then.
    send(link, { t: 'call', id, tool, args, bot, approval: approval ? { ...approval, expiresAt: approval.expiresAt ?? Date.now() + timeoutMs } : null });
  });
}

/** A screen channel on a PC, for vnc.ts. Watch only; vnc.ts drops input. */
/**
 * A screen channel to a PC. `control` (a person taking over, never a bot) also needs the PC's own
 * "take control" switch, which the PC checks again; input then flows to it, the clipboard never does.
 */
export async function openMachineScreen(machineId: string, onData: (b: Buffer) => void, onClose: (why: string) => void, control = false): Promise<{ send(b: Buffer): void; close(): void; readonly open: boolean }> {
  const link = links.get(machineId);
  if (!link) throw new Error('That PC is offline.');
  if (!link.state.screen) throw new Error('Screen viewing is off on that PC. Turn it on in the YBots app on the PC.');
  if (control && !link.state.control) throw new Error('Taking control is off on that PC. Turn it on in the YBots app on the PC.');
  const sid = crypto.randomBytes(6).toString('base64url');
  let open = true;
  if (control) link.controlling.add(sid);
  link.screens.set(sid, { onData, onClose: (why) => { open = false; link.controlling.delete(sid); onClose(why); } });
  send(link, { t: 'screen-open', sid, control });
  logMachine(machineId, null, 'screen', null, control ? 'took control' : 'opened');
  const head = Buffer.concat([Buffer.from([sid.length]), Buffer.from(sid)]);
  return {
    send: (b) => { if (open && link.ws.readyState === WebSocket.OPEN) link.ws.send(Buffer.concat([head, b])); },
    close: () => { if (!open) return; open = false; link.screens.delete(sid); link.controlling.delete(sid); send(link, { t: 'screen-close', sid }); },
    get open() { return open; },
  };
}

/**
 * Copy and paste with a PC (docs/remote-pc.md, "Copy and paste"): only while someone has taken control
 * of it, only with the PC's own "copy and paste" switch on (off by default, and the PC checks again),
 * and only when the person presses Copy or Paste. Text only, never in the background. The log says that
 * it happened, never what was copied.
 */
export async function machineClipboard(machineId: string, op: 'get' | 'set', text?: string): Promise<{ text?: string; cut?: boolean }> {
  const link = links.get(machineId);
  if (!link) throw new ClipboardError('That PC is offline.', 409);
  if (!link.state.clipboard) throw new ClipboardError('Copy and paste is off on that PC. Turn it on in the YBots app on the PC.', 409);
  if (!link.controlling.size) throw new ClipboardError('Take control of that PC first; copy and paste works only while you have it.', 409);
  const id = crypto.randomBytes(9).toString('base64url');
  const reply = await new Promise<CallReply>((resolve) => {
    const timer = setTimeout(() => { link.pending.delete(id); resolve({ ok: false, output: 'The PC did not answer in time.' }); }, 10_000);
    link.pending.set(id, { resolve, timer });
    send(link, { t: 'clip', id, op, ...(op === 'set' ? { text } : {}) });
  });
  logMachine(machineId, null, 'clipboard', null, reply.ok ? (op === 'set' ? 'pasted to the PC' : 'copied from the PC') : 'refused', reply.ok ? undefined : reply.output);
  if (!reply.ok) throw new ClipboardError(reply.output || 'The PC refused.', 409);
  return op === 'get' ? cutUtf8(reply.output) : {};
}

/** For vnc.ts: may this session watch this PC? */
export function machineViewable(machineId: string, userId: string, person: string | null): boolean {
  return visibleTo(machineRow(machineId), userId, person);
}

// ---------- tools for bots (served through /mcp, see mcp.ts) ----------

interface PcTool { name: string; description: string; inputSchema: object; changes: boolean; verb: string }
const pcArg = { type: 'string', description: 'Which PC: its name or id, from pc_list.' };
const pathArg = { type: 'string', description: 'A path inside one of the PC\'s shared folders, e.g. "C:\\\\Users\\\\me\\\\Documents\\\\Cleft\\\\notes.txt".' };

export const PC_TOOLS: PcTool[] = [
  { name: 'pc_list', changes: false, verb: 'list PCs', description: 'List the PCs you may use, whether each is online, its shared folders and whether it allows commands.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pc_list_files', changes: false, verb: 'list files', description: 'List the files and folders in a folder on a PC. Only inside the PC\'s shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, path: pathArg }, required: ['pc', 'path'] } },
  { name: 'pc_read_file', changes: false, verb: 'read a file', description: 'Read a text file on a PC (up to 256 KB). Only inside the PC\'s shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, path: pathArg }, required: ['pc', 'path'] } },
  { name: 'pc_write_file', changes: true, verb: 'write a file', description: 'Write a text file on a PC, replacing it if it exists. The user must approve it on a card. Only inside shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, path: pathArg, content: { type: 'string' } }, required: ['pc', 'path', 'content'] } },
  { name: 'pc_make_folder', changes: true, verb: 'make a folder', description: 'Make a folder on a PC. The user must approve it on a card. Only inside shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, path: pathArg }, required: ['pc', 'path'] } },
  { name: 'pc_move', changes: true, verb: 'move a file', description: 'Move or rename a file or folder on a PC. The user must approve it on a card. Both paths inside shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, from: pathArg, to: pathArg }, required: ['pc', 'from', 'to'] } },
  { name: 'pc_delete', changes: true, verb: 'delete a file', description: 'Delete a file or an empty folder on a PC. The user must approve it on a card. Only inside shared folders.', inputSchema: { type: 'object', properties: { pc: pcArg, path: pathArg }, required: ['pc', 'path'] } },
  { name: 'pc_run', changes: true, verb: 'run a command', description: 'Run one PowerShell command on a PC and get its output. The user must approve the exact command on a card, every time. Works only if the PC allows commands; it runs in a shared folder.', inputSchema: { type: 'object', properties: { pc: pcArg, command: { type: 'string' }, cwd: { type: 'string', description: 'Folder to run in, inside a shared folder. Default: the first shared folder.' }, timeoutSeconds: { type: 'number', description: `Default 60, at most ${MAX_RUN_SECONDS}.` } }, required: ['pc', 'command'] } },
];
const pcToolMap = new Map(PC_TOOLS.map((t) => [t.name, t]));

export const isPcTool = (name: string) => pcToolMap.has(name.toLowerCase());

/** The "Always allow" key for one action on one PC: a rule never covers another PC or another action. */
export const pcRuleKey = (tool: string, machineId: string) => `pc__${tool}__${machineId}`;

/** JSON with keys sorted at every level; the same as canonical() in agent/loop.ts and desktop/src/remote-core.js. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
}
/** What the PC checks before it changes anything: approval id + tool + exact arguments (tools is always []). */
const pcDigest = (approvalId: string, tool: string, args: unknown) =>
  crypto.createHash('sha256').update(canonicalJson({ approvalId, tool, tools: [], args })).digest('hex');

/** The PC tools a bot is offered: none unless at least one PC lists it. */
export function pcToolsFor(botId: string | null) {
  if (!botId || !machinesForBot(botId).length) return [];
  return PC_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export interface PcCallDeps {
  /** Shows an approval card and waits; fills `meta` with the card's id and digest. */
  requestApproval: (pol: { decision: Decision; key: string; title: string; asks: string[]; ruleLabel?: string }, args: any, meta: { approvalId?: string; digest?: string }) => Promise<'allow' | 'deny' | 'expired' | 'superseded' | string>;
  /** The chat making the call, whose "Allow for this conversation" answers count. */
  chatId?: string;
}

const BLOCKED = 'This bot may not use PCs. Do not try again.';

/** Run a pc_* tool for a bot. Returns the text the bot gets. */
export async function runPcTool(userId: string, botId: string, rawName: string, args: any, deps: PcCallDeps): Promise<{ output: string; status: 'done' | 'denied' | 'error' }> {
  const tool = pcToolMap.get(rawName.toLowerCase())!;
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || !botMayUsePcs(botId)) return { output: BLOCKED, status: 'denied' };
  const mine = machinesForBot(botId);
  if (tool.name === 'pc_list') {
    if (!mine.length) return { output: 'No PC is set up for you.', status: 'done' };
    return { output: JSON.stringify(mine.map((m) => { const d = describe(m); return { pc: d.name, id: d.id, online: d.online, sharedFolders: d.folders.map((f) => f.path), commandsAllowed: d.commands }; }), null, 2), status: 'done' };
  }
  const want = String(args?.pc ?? '').trim().toLowerCase();
  const row = mine.find((m) => m.id.toLowerCase() === want) ?? mine.find((m) => String(m.name).toLowerCase() === want) ?? (mine.length === 1 && !want ? mine[0] : undefined);
  if (!row) return { output: `No PC named "${args?.pc ?? ''}" that you may use. Call pc_list.`, status: 'error' };
  if (!links.has(row.id)) return { output: `${row.name} is offline.`, status: 'error' };
  // Asking for a card the PC will refuse anyway helps nobody: say so first (the PC checks again).
  if (tool.name === 'pc_run' && !links.get(row.id)!.state.commands) return { output: `Commands are turned off on ${row.name}. Only the person at that PC can turn them on.`, status: 'error' };

  // Reading inside shared folders runs; anything that changes the PC asks, unless the owner chose
  // "Always allow" on a card for this bot, this action and this PC (allow-rules.ts key pc__<tool>__<pc id>).
  // Plugin stages may only make it stricter, and a stage's ask beats a rule.
  const base: Decision = tool.changes ? 'ask' : 'allow';
  const staged = runStages({ userId, botId, name: `pc__${tool.name}`, appId: 'pc', tool: tool.name, args });
  const decision = stricter(base, staged.decision);
  if (decision === 'block') { logMachine(row.id, botId, tool.name, null, 'blocked by a rule'); return { output: 'A rule refuses this on that PC. Do not retry it.', status: 'denied' }; }
  const ruleKey = pcRuleKey(tool.name, row.id);
  const ruleLabel = `PC: ${tool.verb} on ${row.name}`;
  let approval: { id: string; digest: string; rule?: string } | null = null;
  const ruleId = decision === 'ask' && staged.decision === 'allow' ? standingAllow(botId, deps.chatId, ruleKey) : null;
  if (ruleId) {
    // The PC still gets a one-time approval bound to this exact call, marked as coming from a rule.
    const id = newId('apr');
    approval = { id, digest: pcDigest(id, tool.name, args), rule: ruleLabel };
    noteRuleUse(ruleId, botId, ruleKey, args, ruleLabel);
  } else if (decision === 'ask') {
    const meta: { approvalId?: string; digest?: string } = {};
    const asks = staged.decision === 'allow' ? [ruleKey] : [];
    const answer = await deps.requestApproval({ decision: 'ask', key: tool.name, title: ruleLabel, asks, ruleLabel }, args, meta);
    if (answer !== 'allow' || !meta.approvalId || !meta.digest) {
      logMachine(row.id, botId, tool.name, meta.approvalId ?? null, answer === 'deny' ? 'declined' : 'not answered');
      return { output: answer === 'deny' ? 'The user declined this action. Do not retry it.' : 'Skipped: the user did not approve this. Do not retry unless they ask.', status: 'denied' };
    }
    // The PC checks a digest of the card's id, the tool and the exact arguments (desktop/src/remote-core.js).
    approval = { id: meta.approvalId, digest: pcDigest(meta.approvalId, tool.name, args) };
  }
  const seconds = Math.min(MAX_RUN_SECONDS, Math.max(1, Number(args?.timeoutSeconds) || 60));
  const reply = await callMachine(row.id, tool.name, args, { id: botId, name: bot.name }, approval, tool.name === 'pc_run' ? (seconds + 20) * 1000 : CALL_TIMEOUT_MS);
  logMachine(row.id, botId, tool.name, approval?.id ?? null, (reply.ok ? 'done' : 'failed') + (approval?.rule ? ' (always allowed)' : ''), reply.ok ? undefined : reply.output);
  return { output: reply.ok ? reply.output || '(no output)' : `On ${row.name}: ${reply.output}`, status: reply.ok ? 'done' : 'error' };
}

// ---------- routes for the apps ----------

export function machineRoutes(api: Hono<any>) {
  const mineFor = (c: any) => {
    const s = currentSession(c);
    return s ? (db.prepare('SELECT * FROM machines WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at').all(s.user.id) as any[]).filter((m) => visibleTo(m, s.user.id, s.person)) : [];
  };
  const one = (c: any) => mineFor(c).find((m) => m.id === c.req.param('id'));
  // Which bots may use a PC, removing it and its clipboard are a person's: a script session never reaches them.
  const personOnly = (c: any) => (c.get('agent') ? c.json({ error: 'Only a person can do this on a PC.' }, 403) : null);

  api.get('/machines', (c) => c.json({ machines: mineFor(c).map(describe) }));

  // Which bots may use a PC. A bot that can never use PCs (blocked, walled off or outside bots) is refused.
  api.patch('/machines/:id', async (c) => {
    const refused = personOnly(c);
    if (refused) return refused;
    const row = one(c);
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{ bots?: unknown; name?: unknown }>().catch(() => ({}) as any);
    if (body.bots !== undefined) {
      if (!Array.isArray(body.bots) || body.bots.some((b: unknown) => typeof b !== 'string')) return c.json({ error: 'bots must be a list of bot ids' }, 400);
      const ids = [...new Set(body.bots as string[])];
      for (const id of ids) {
        const b = getBotRow(id);
        if (!b || b.user_id !== row.user_id) return c.json({ error: `No bot ${id}.` }, 400);
        if (!botMayUsePcs(id)) return c.json({ error: `${b.name} can never use a PC.` }, 409);
      }
      db.prepare('UPDATE machines SET bots=? WHERE id=?').run(JSON.stringify(ids), row.id);
      logMachine(row.id, null, 'settings', null, 'bots changed', ids.map((i) => getBotRow(i)?.name ?? i).join(', ') || 'none');
    }
    if (typeof body.name === 'string' && body.name.trim()) db.prepare('UPDATE machines SET name=? WHERE id=?').run(body.name.replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || row.name, row.id);
    emit(row.user_id);
    return c.json({ machine: describe(machineRow(row.id)) });
  });

  // Remove: the PC's key stops working at once and its link is closed.
  api.delete('/machines/:id', (c) => {
    const refused = personOnly(c);
    if (refused) return refused;
    const row = one(c);
    if (!row) return c.json({ error: 'not found' }, 404);
    db.prepare('UPDATE machines SET revoked_at=? WHERE id=?').run(now(), row.id);
    logMachine(row.id, null, 'remove', null, 'removed');
    const link = links.get(row.id);
    if (link) { link.ws.close(4403, 'removed'); dropLink(link, 'removed'); }
    emit(row.user_id);
    return c.json({ ok: true });
  });

  // Copy and paste while taking control (machineClipboard above).
  api.get('/machines/:id/clipboard', async (c) => {
    const refused = personOnly(c);
    if (refused) return refused;
    const row = one(c);
    if (!row) return c.json({ error: 'not found' }, 404);
    try { c.header('Cache-Control', 'no-store'); return c.json(await machineClipboard(row.id, 'get')); }
    catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 300) }, e instanceof ClipboardError ? (e.status as any) : 502); }
  });
  api.put('/machines/:id/clipboard', async (c) => {
    const refused = personOnly(c);
    if (refused) return refused;
    const row = one(c);
    if (!row) return c.json({ error: 'not found' }, 404);
    try {
      const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
      await machineClipboard(row.id, 'set', checkPaste(body.text));
      return c.json({ ok: true });
    } catch (e: any) { return c.json({ error: String(e?.message ?? e).slice(0, 300) }, e instanceof ClipboardError ? (e.status as any) : 502); }
  });

  api.get('/machines/:id/log', (c) => {
    const row = one(c);
    if (!row) return c.json({ error: 'not found' }, 404);
    const log = (db.prepare('SELECT l.*, b.name AS bot_name FROM machine_log l LEFT JOIN bots b ON b.id=l.bot_id WHERE l.machine_id=? ORDER BY l.id DESC LIMIT 100').all(row.id) as any[])
      .map((l): MachineLogEntry => ({ id: l.id, botId: l.bot_id, botName: l.bot_name ?? null, tool: l.tool, outcome: l.outcome, detail: l.detail, at: l.at }));
    return c.json({ log });
  });
}
