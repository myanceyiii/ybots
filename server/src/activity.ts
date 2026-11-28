import { Hono } from 'hono';
import { db, now } from './db.js';
import { currentSession, displayName, requireUser, type AuthVars } from './lib/auth.js';
import { redact } from './lib/redact.js';
import { firstNameOf, scopedPersonName } from './people.js';

/**
 * One activity trail (Settings > Activity on every app): every action a bot was allowed, refused or failed
 * to do, one row each, naming who it was for and what started it.
 *
 * Design borrowed from OpenBot's "What started a run" (CopilotKit/OpenBot docs/architecture.md, MIT; its
 * server is not published, so this is written from the description). A row's owner is always a person, so
 * that alone cannot say whether anybody was there. Each row also names what caused it (`by_kind`):
 *
 *   person   somebody sent the message or pressed the button (the default for a person's turn)
 *   script   a script signed in as the owner (an agent session, auth.ts) sent the message
 *   routine  one of the bot's routines fired, with nobody there
 *   goal     a scheduled check-in (proactive.ts) fired, with nobody there
 *   memory   a memory import read an app, with nobody there (no turn does this today; kept for it)
 *   handoff  another bot (or an outside member through Slack) asked for it
 *   self     the bot's engine ran a tool while the app had no turn for it (its own scheduled job)
 *   system   the app itself: a notice after a person's action, or a boundary held with no turn at all
 *   earlier  copied from a log kept before this list existed, where the cause was not recorded
 *
 * "Nobody watching" is routine + goal + memory + handoff + script + self: what ran on someone's
 * authority while they were away. `system` and `earlier` are outside it so the column never overclaims.
 *
 * Writers: the approval gate for Hermes' own tools and the app's /mcp tools (mcp.ts), approval cards
 * (agent/loop.ts), the browser guard, send_to_bot and the Slack link (agent/tools.ts, agent/loop.ts),
 * plugin and connection changes (plugins/registry.ts, connector-admin.ts) and paired PCs (machines.ts).
 * A blocked send to or from a walled bot (Sheldon) is a refused row.
 *
 * What a row keeps is short and redacted: the tool, a plain title, how it was decided and a reason. Never
 * a message body, a file's contents or a secret. Kept 180 days and at most 100,000 rows.
 *
 * The CSV export is itself written to the trail (tool `activity_export`), with who took it, how many rows
 * and under which filter. A cell that starts with = + - or @ is prefixed with ' so a spreadsheet reads
 * it as text, never as a formula.
 */

export type StarterKind = 'person' | 'script' | 'routine' | 'goal' | 'memory' | 'handoff' | 'self' | 'system' | 'earlier';
export interface Starter { kind: StarterKind; id?: string | null; name?: string | null }
export type ActivityOutcome = 'allowed' | 'refused' | 'failed';
/** Where the row was written: shown as "via …" and filterable. */
export type ActivitySource = 'gate' | 'tool' | 'card' | 'browser' | 'handoff' | 'pc' | 'plugin' | 'connection' | 'export';

export const STARTER_KINDS: StarterKind[] = ['person', 'script', 'routine', 'goal', 'memory', 'handoff', 'self', 'system', 'earlier'];
export const UNWATCHED: StarterKind[] = ['routine', 'goal', 'memory', 'handoff', 'script', 'self'];
const OUTCOMES: ActivityOutcome[] = ['allowed', 'refused', 'failed'];

db.exec(`
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  bot_id TEXT,
  bot_name TEXT,
  chat_id TEXT,
  for_name TEXT,
  by_kind TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT,
  source TEXT NOT NULL,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  how TEXT,
  detail TEXT,
  looks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_user_at ON activity(user_id, at);
CREATE INDEX IF NOT EXISTS activity_bot_at ON activity(bot_id, at);
`);

// ---------- what started the work in a chat ----------

/** Set by the agent loop (it knows each chat's running turn); kept as a hook so this file imports nothing of it. */
let lookup: (chatId: string) => Starter | null = () => null;
export function setStarterLookup(fn: (chatId: string) => Starter | null) { lookup = fn; }
/** What started the turn running in this chat now, or `self` when no turn of the app's is running there. */
export const starterFor = (chatId: string | null | undefined): Starter => (chatId ? lookup(chatId) : null) ?? { kind: 'self', name: null };

/** A plain name for a starter, as every app shows it. */
export function starterText(s: Pick<Starter, 'kind' | 'name'>): string {
  const n = s.name ? String(s.name) : '';
  switch (s.kind) {
    case 'person': return n || 'A person';
    case 'script': return n ? `A script (${n})` : 'A script';
    case 'routine': return n ? `Routine · ${n}` : 'A routine';
    case 'goal': return n || 'A check-in';
    case 'memory': return n ? `Memory import · ${n}` : 'A memory import';
    case 'handoff': return n ? `Asked by ${n}` : 'Another bot';
    case 'self': return 'On its own';
    case 'system': return n || 'The app';
    case 'earlier': return 'Not recorded';
  }
}

/** The same, as it reads inside a sentence: "asked by Robin", "started by routine "Night watch"". */
export function starterPhrase(s: Pick<Starter, 'kind' | 'name'>): string {
  const n = s.name ? String(s.name) : '';
  switch (s.kind) {
    case 'person': return n ? `started by ${n}` : 'started by a person';
    case 'script': return n ? `started by a script (${n})` : 'started by a script';
    case 'routine': return n ? `started by routine "${n}"` : 'started by a routine';
    case 'goal': return n ? `started by ${n.charAt(0).toLowerCase()}${n.slice(1)}` : 'started by a check-in';
    case 'memory': return n ? `started by a memory import (${n})` : 'started by a memory import';
    case 'handoff': return n ? `asked by ${n}` : 'asked by another bot';
    case 'self': return 'started on its own';
    case 'system': return n ? `started by ${n}` : 'started by the app';
    case 'earlier': return 'start not recorded';
  }
}

// ---------- writing ----------

/** Look-only steps: reading, listing, showing. They can be hidden on the screen; they are still kept. */
const LOOKS = /^(list|get|read|search|find|show|view|check|describe|fetch|lookup|query)[_-]|^(stay_silent|offer_choices|update_view|show_view|react|todo_list|clarify|session_search|skills_list|skill_view|tool_search|tool_describe|vision_analyze|video_analyze|read_terminal|show_tip|web_search|web_extract|x_search|page_info|capture_screenshot|browser_snapshot|browser_get_images|browser_vision|browser_console)$/i;
export const isLookTool = (tool: string) => LOOKS.test(tool.replace(/^(hermes__|mcp__[^_]+__|[a-z0-9]+__)/i, ''));

export interface ActivityInput {
  /** Who the row belongs to (the bot's owner account). Looked up from the bot when left out. */
  userId?: string;
  botId: string | null;
  /** The chat the work happened in (a side chat, or the bot itself). Used to find what started it. */
  chatId?: string | null;
  tool: string;
  title?: string;
  outcome: ActivityOutcome;
  source: ActivitySource;
  /** How it was decided: "Asked on its card, answered by Alex (phone app)", "Always allow". */
  how?: string | null;
  /** Why it was refused or how it failed. Redacted and cut short. */
  detail?: string | null;
  /** What started it, when the caller knows better than the chat's running turn. */
  starter?: Starter;
  looks?: boolean;
}

const botInfo = db.prepare("SELECT b.id, b.name, b.user_id, b.side_of, o.name AS owner_name FROM bots b LEFT JOIN bots o ON o.id=b.side_of WHERE b.id=?");
const userName = db.prepare('SELECT name, email FROM users WHERE id=?');
const insert = db.prepare(`INSERT INTO activity(at,user_id,bot_id,bot_name,chat_id,for_name,by_kind,by_id,by_name,source,tool,title,outcome,how,detail,looks)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/** Who the work was for: the person whose own sign-in sees this bot (a scoped person), else the account's owner. */
function forName(userId: string, botName: string | null): string | null {
  const scoped = botName ? scopedPersonName(botName, '') : '';
  if (scoped) return scoped;
  const u = userName.get(userId) as { name: string | null; email: string } | undefined;
  return u ? firstNameOf(displayName({ email: u.email, name: u.name ?? '' })) ?? u.name ?? null : null;
}

let writes = 0;
const short = (s: unknown, n: number) => (s === undefined || s === null || s === '' ? null : redact(String(s).replace(/\s+/g, ' ').trim(), n));

/** Write one row. Never throws: the trail must never stop the work it records. Returns the row id, or 0. */
export function logActivity(a: ActivityInput): number {
  try {
    const bot = a.botId ? botInfo.get(a.botId) as { id: string; name: string; user_id: string; side_of: string | null; owner_name: string | null } | undefined : undefined;
    const userId = a.userId ?? bot?.user_id;
    if (!userId) return 0;
    // A side chat or helper is shown as the bot it belongs to.
    const botId = bot?.side_of ?? bot?.id ?? a.botId;
    const botName = bot ? bot.owner_name ?? bot.name : null;
    const s = a.starter ?? starterFor(a.chatId ?? a.botId);
    const kind = STARTER_KINDS.includes(s.kind) ? s.kind : 'person';
    const tool = String(a.tool || 'unknown').slice(0, 160);
    const r = insert.run(now(), userId, botId, botName, a.chatId ?? a.botId, forName(userId, botName), kind, short(s.id, 120), short(s.name, 120),
      a.source, tool, short(a.title, 200) ?? tool, a.outcome, short(a.how, 200), short(a.detail, 300), (a.looks ?? isLookTool(tool)) ? 1 : 0);
    if (++writes % 500 === 0) pruneActivity();
    return Number(r.lastInsertRowid);
  } catch (e) {
    console.warn('[activity] could not write a row', e);
    return 0;
  }
}

/** A row written as allowed whose tool then failed (the engine said so in its result). */
export function markActivityFailed(id: number, why?: string | null) {
  if (!id) return;
  try { db.prepare("UPDATE activity SET outcome='failed', detail=COALESCE(?, detail) WHERE id=? AND outcome='allowed'").run(short(why, 300), id); } catch { /* best effort */ }
}

// The gate decides before Hermes runs its tool; the result comes later in the turn's stream (agent/loop.ts).
// The last gate row per chat and tool waits here, so a failure updates that row instead of adding a second.
const waiting = new Map<string, { id: number; at: number }>();
export function awaitResult(chatId: string, tool: string, id: number) {
  if (!id) return;
  waiting.set(`${chatId}\n${tool.toLowerCase()}`, { id, at: Date.now() });
  if (waiting.size > 500) for (const [k, v] of waiting) if (Date.now() - v.at > 30 * 60_000) waiting.delete(k);
}
/** The engine reported this tool's result: a failure marks the waiting row failed. */
export function noteResult(chatId: string, tool: string, failed: boolean, why?: string | null) {
  const k = `${chatId}\n${tool.toLowerCase()}`;
  const w = waiting.get(k);
  if (!w) return false;
  waiting.delete(k);
  if (failed) markActivityFailed(w.id, why);
  return true;
}

const KEEP_MS = 180 * 86_400_000;
const KEEP_ROWS = 100_000;
export function pruneActivity() {
  try {
    db.prepare('DELETE FROM activity WHERE at < ?').run(now() - KEEP_MS);
    db.prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?)').run(KEEP_ROWS);
  } catch (e) { console.warn('[activity] prune failed', e); }
}

// ---------- reading ----------

export interface ActivityFilter {
  botId?: string;
  outcome?: ActivityOutcome;
  /** One starter kind, or `unwatched` for Nobody watching. */
  by?: StarterKind | 'unwatched';
  /** Include look-only steps. Off by default on the screens. */
  looks?: boolean;
  q?: string;
  from?: number;
  to?: number;
  /** Rows older than this id (paging, newest first). */
  before?: number;
}

export interface ActivityRow {
  id: number; at: number; botId: string | null; botName: string | null; forName: string | null;
  by: { kind: StarterKind; id: string | null; name: string | null; text: string; phrase: string; unwatched: boolean };
  source: ActivitySource; tool: string; title: string; outcome: ActivityOutcome; how: string | null; detail: string | null; looks: boolean;
}

/** A filter from query parameters, with anything unknown dropped. */
export function parseFilter(q: (k: string) => string | undefined): ActivityFilter {
  const num = (k: string) => { const n = Number(q(k)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; };
  const by = q('by');
  const outcome = q('outcome');
  return {
    botId: q('botId') || undefined,
    outcome: OUTCOMES.includes(outcome as ActivityOutcome) ? outcome as ActivityOutcome : undefined,
    by: by === 'unwatched' || STARTER_KINDS.includes(by as StarterKind) ? by as StarterKind | 'unwatched' : undefined,
    looks: q('looks') === '1' || q('looks') === 'true',
    q: (q('q') ?? '').trim().slice(0, 100) || undefined,
    from: num('from'), to: num('to'), before: num('before'),
  };
}

function where(userId: string, f: ActivityFilter): { sql: string; args: unknown[] } {
  const parts = ['user_id=?'];
  const args: unknown[] = [userId];
  if (f.botId) { parts.push('bot_id=?'); args.push(f.botId); }
  if (f.outcome) { parts.push('outcome=?'); args.push(f.outcome); }
  if (f.by === 'unwatched') { parts.push(`by_kind IN (${UNWATCHED.map(() => '?').join(',')})`); args.push(...UNWATCHED); } else if (f.by) { parts.push('by_kind=?'); args.push(f.by); }
  // Refusals and failures always show, look-only or not: those are what the trail is for.
  if (!f.looks) parts.push("(looks=0 OR outcome<>'allowed')");
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    parts.push("(title LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR by_name LIKE ? ESCAPE '\\' OR bot_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like);
  }
  if (f.from) { parts.push('at>=?'); args.push(f.from); }
  if (f.to) { parts.push('at<=?'); args.push(f.to); }
  return { sql: parts.join(' AND '), args };
}

const shape = (r: any): ActivityRow => ({
  id: r.id, at: r.at, botId: r.bot_id, botName: r.bot_name, forName: r.for_name,
  by: { kind: r.by_kind, id: r.by_id, name: r.by_name, text: starterText({ kind: r.by_kind, name: r.by_name }), phrase: starterPhrase({ kind: r.by_kind, name: r.by_name }), unwatched: UNWATCHED.includes(r.by_kind) },
  source: r.source, tool: r.tool, title: r.title, outcome: r.outcome, how: r.how, detail: r.detail, looks: !!r.looks,
});

export function listActivity(userId: string, f: ActivityFilter, limit = 100): { rows: ActivityRow[]; more: boolean; counts: { allowed: number; refused: number; failed: number; unwatched: number } } {
  const w = where(userId, { ...f, before: undefined });
  const page = f.before ? `${w.sql} AND id<?` : w.sql;
  const rows = db.prepare(`SELECT * FROM activity WHERE ${page} ORDER BY id DESC LIMIT ?`).all(...w.args, ...(f.before ? [f.before] : []), limit + 1) as any[];
  // The counts are for the filter without its outcome and starter, so the chips can show what each would give.
  const base = where(userId, { ...f, outcome: undefined, by: undefined, before: undefined });
  const c = db.prepare(`SELECT
      SUM(CASE WHEN outcome='allowed' THEN 1 ELSE 0 END) a, SUM(CASE WHEN outcome='refused' THEN 1 ELSE 0 END) r,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) f, SUM(CASE WHEN by_kind IN (${UNWATCHED.map(() => '?').join(',')}) THEN 1 ELSE 0 END) u
    FROM activity WHERE ${base.sql}`).get(...UNWATCHED, ...base.args) as any;
  return { rows: rows.slice(0, limit).map(shape), more: rows.length > limit, counts: { allowed: c?.a ?? 0, refused: c?.r ?? 0, failed: c?.f ?? 0, unwatched: c?.u ?? 0 } };
}

export const EXPORT_CAP = 5000;

/** A spreadsheet cell: quoted, and a leading = + - @ (or tab/CR) made text so it is never run as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEAD = ['Time (UTC)', 'Bot', 'For', 'Started by', 'Nobody watching', 'Outcome', 'What', 'Tool', 'How', 'Detail', 'Via'];

/** The filtered trail as RFC 4180 CSV, newest first, at most EXPORT_CAP rows. */
export function activityCsv(userId: string, f: ActivityFilter): { csv: string; rows: number; truncated: boolean } {
  const w = where(userId, { ...f, before: undefined });
  const rows = (db.prepare(`SELECT * FROM activity WHERE ${w.sql} ORDER BY id DESC LIMIT ?`).all(...w.args, EXPORT_CAP + 1) as any[]).map(shape);
  const truncated = rows.length > EXPORT_CAP;
  const lines = [HEAD.join(','), ...rows.slice(0, EXPORT_CAP).map((r) => [
    new Date(r.at).toISOString(), r.botName ?? '', r.forName ?? '', r.by.text, r.by.unwatched ? 'yes' : '', r.outcome, r.title, r.tool, r.how ?? '', r.detail ?? '', r.source,
  ].map(csvCell).join(','))];
  return { csv: `${lines.join('\r\n')}\r\n`, rows: Math.min(rows.length, EXPORT_CAP), truncated };
}

/** The filter in words, for the export's own row. */
export function filterText(f: ActivityFilter): string {
  const bits: string[] = [];
  if (f.botId) bits.push(`bot ${(botInfo.get(f.botId) as any)?.name ?? f.botId}`);
  if (f.outcome) bits.push(f.outcome);
  if (f.by) bits.push(f.by === 'unwatched' ? 'nobody watching' : `started by ${f.by}`);
  if (f.looks) bits.push('look-only steps included');
  if (f.q) bits.push(`search "${f.q}"`);
  if (f.from || f.to) bits.push(`${f.from ? new Date(f.from).toISOString().slice(0, 10) : '…'} to ${f.to ? new Date(f.to).toISOString().slice(0, 10) : 'now'}`);
  return bits.length ? bits.join(', ') : 'everything';
}

// ---------- the logs kept before this one ----------

/**
 * Once, when the trail is new: copy the last 30 days of the older logs (cards answered, Always-allow uses,
 * PC calls, plugin and connection changes) so the screen is not empty on day one. What started those is
 * not known, so they say so (`earlier`). Marked done in a one-row table so it never runs twice.
 */
export function backfillActivity() {
  db.exec('CREATE TABLE IF NOT EXISTS activity_meta (k TEXT PRIMARY KEY, v TEXT)');
  if (db.prepare("SELECT 1 FROM activity_meta WHERE k='backfill'").get()) return;
  const since = now() - 30 * 86_400_000;
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const rows: { at: number; userId: string; botId: string | null; tool: string; title: string; outcome: ActivityOutcome; how: string | null; detail: string | null; source: ActivitySource; by?: Starter }[] = [];
  const owner = (botId: string | null) => (botId ? (botInfo.get(botId) as any)?.user_id : null) as string | null;
  try {
    for (const a of db.prepare("SELECT * FROM approvals WHERE status<>'pending' AND created_at>=?").all(since) as any[]) {
      const u = owner(a.bot_id); if (!u) continue;
      const ok = a.status === 'allowed' || a.status === 'always';
      rows.push({ at: a.resolved_at ?? a.created_at, userId: u, botId: a.bot_id, tool: a.tool, title: a.tool, outcome: ok ? 'allowed' : 'refused',
        how: a.status === 'expired' ? 'Asked on its card, nobody answered in time' : `Asked on its card${a.answered_by ? `, answered by ${a.answered_by}${a.answered_via ? ` (${a.answered_via})` : ''}` : ''}${a.status === 'always' ? ', Always allow' : ''}`, detail: null, source: 'card' });
    }
    if (has('allow_rule_log')) for (const l of db.prepare('SELECT * FROM allow_rule_log WHERE at>=?').all(since) as any[]) {
      const u = owner(l.bot_id); if (!u) continue;
      const rule = String(l.rule_id ?? '');
      rows.push({ at: l.at, userId: u, botId: l.bot_id, tool: l.tool, title: rule === 'free:terminal' ? 'Ran a terminal command' : l.tool, outcome: 'allowed',
        how: rule === 'free:terminal' ? 'Free-run' : rule.startsWith('app:') ? 'Allowed in app settings' : 'Always allow', detail: l.detail, source: 'gate' });
    }
    for (const m of db.prepare('SELECT l.*, m.user_id AS uid, m.name AS pc FROM machine_log l JOIN machines m ON m.id=l.machine_id WHERE l.at>=?').all(since) as any[]) {
      const refused = /refus|block|denied|not allowed/i.test(m.outcome);
      const failed = /fail|error/i.test(m.outcome);
      rows.push({ at: m.at, userId: m.uid, botId: m.bot_id, tool: `pc__${m.tool}`, title: `${m.tool.replace(/_/g, ' ')} on ${m.pc}`, outcome: refused ? 'refused' : failed ? 'failed' : 'allowed', how: m.outcome, detail: m.detail, source: 'pc', ...(m.bot_id ? {} : { by: { kind: 'person' } }) });
    }
    if (has('plugin_audit')) for (const p of db.prepare('SELECT * FROM plugin_audit WHERE at>=?').all(since) as any[]) {
      const u = p.user_id ?? owner(p.bot_id); if (!u) continue;
      rows.push({ at: p.at, userId: u, botId: p.bot_id, tool: `plugin.${p.action}`, title: `Plugin ${p.plugin_id}: ${String(p.action).replace(/[._]/g, ' ')}`, outcome: /refus|block|denied/i.test(p.action) ? 'refused' : 'allowed', how: null, detail: null, source: 'plugin', by: p.user_id ? { kind: 'person' } : undefined });
    }
    if (has('connector_admin_changes')) for (const ch of db.prepare('SELECT * FROM connector_admin_changes WHERE created_at>=?').all(since) as any[]) {
      rows.push({ at: ch.applied_at ?? ch.created_at, userId: ch.user_id, botId: ch.bot_id, tool: `connection.${ch.action}`, title: ch.summary, outcome: ch.status === 'applied' || ch.status === 'rolled_back' ? 'allowed' : ch.status === 'failed' ? 'failed' : 'refused',
        how: ch.approved_by ? `Asked on its card, answered by ${ch.approved_by}${ch.approved_via ? ` (${ch.approved_via})` : ''}` : ch.status, detail: ch.status === 'failed' ? ch.result : null, source: 'connection' });
    }
  } catch (e) { console.warn('[activity] could not read an older log', e); }
  rows.sort((a, b) => a.at - b.at);
  db.transaction(() => {
    for (const r of rows) {
      const bot = r.botId ? botInfo.get(r.botId) as any : undefined;
      const botName = bot ? bot.owner_name ?? bot.name : null;
      insert.run(r.at, r.userId, bot?.side_of ?? r.botId, botName, r.botId, forName(r.userId, botName), r.by?.kind ?? 'earlier', null, null, r.source, String(r.tool).slice(0, 160),
        short(r.title, 200) ?? r.tool, r.outcome, short(r.how, 200), short(r.detail, 300), isLookTool(String(r.tool)) ? 1 : 0);
    }
    db.prepare("INSERT INTO activity_meta(k,v) VALUES ('backfill', ?)").run(String(rows.length));
  })();
  if (rows.length) console.log(`[activity] copied ${rows.length} rows from the older logs`);
}

// ---------- routes ----------

/**
 * GET /api/activity?botId&outcome&by&looks&q&from&to&before — newest first, 100 a page.
 * POST /api/activity/export {same filter} — the CSV, and a row in the trail saying who took it.
 * A scoped sign-in (a scoped person) is refused by scopeGate: this is the owner's view of every bot.
 */
export const activityApi = new Hono<AuthVars>();
activityApi.use('/activity', requireUser);
activityApi.use('/activity/*', requireUser);

const ownsBot = (userId: string, botId: string) => !!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId, userId);

activityApi.get('/activity', (c) => {
  const f = parseFilter((k) => c.req.query(k));
  if (f.botId && !ownsBot(c.get('user').id, f.botId)) return c.json({ error: 'not found' }, 404);
  const bots = db.prepare("SELECT DISTINCT bot_id AS id, bot_name AS name FROM activity WHERE user_id=? AND bot_id IS NOT NULL ORDER BY bot_name COLLATE NOCASE").all(c.get('user').id) as { id: string; name: string }[];
  return c.json({ ...listActivity(c.get('user').id, f), bots });
});

activityApi.post('/activity/export', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* an empty filter */ }
  const f = parseFilter((k) => (body[k] === undefined || body[k] === null ? undefined : String(body[k])));
  const user = c.get('user');
  if (f.botId && !ownsBot(user.id, f.botId)) return c.json({ error: 'not found' }, 404);
  const out = activityCsv(user.id, f);
  const s = currentSession(c);
  const who = s?.agent ? { kind: 'script' as const, name: s.agent } : { kind: 'person' as const, name: firstNameOf(displayName(user, s?.person)) ?? displayName(user, s?.person) };
  const via = c.get('client') === 'bearer' ? 'phone app' : /Electron|CleftBot/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web';
  logActivity({ userId: user.id, botId: null, tool: 'activity_export', title: `Exported ${out.rows.toLocaleString('en-US')} activity rows`, outcome: 'allowed', source: 'export',
    how: `${starterText(who)}, ${via}`, detail: `Filter: ${filterText(f)}${out.truncated ? ` · cut at the newest ${EXPORT_CAP.toLocaleString('en-US')}` : ''}`, starter: who, looks: false });
  const day = new Date().toISOString().slice(0, 10);
  return c.json({ csv: out.csv, rows: out.rows, truncated: out.truncated, filename: `ybots-activity-${day}.csv` });
});
