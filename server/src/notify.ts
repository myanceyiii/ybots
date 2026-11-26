import { CHAT_COLORS, assignChatColors } from './chat-colors.js';
import { CARD_ICONS, cardIconId } from './card-icon.js';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import type { Notice, NoticeFace, Row, ServerEvent } from './types.js';

/**
 * Notifications for the apps (Android, web, Windows), worked out once here so every app agrees.
 *
 *  - Messages: a bot's finished reply, and messages posted in a group.
 *  - Approvals: a card waiting on the person ("Leonard is waiting on you"). Only a low-risk card
 *    (`lowRisk === true`, set from allow-rules.ts) carries Allow/Deny buttons; the answer goes
 *    through POST /api/approvals/:id with the card's digest like any phone answer, never "Always allow".
 *  - Jobs: new looks ready, pictures done, a bot's document updated.
 *
 * Every notice is kept for a day in `notices`, so an app that was away (the phone's link dropped)
 * catches up with `after=<last id>`. Mutes, quiet hours and channels are settings per profile:
 * "main" (the YBots app, web and Windows). They are applied when a notice is sent, not when it is made.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  tag TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, id);
CREATE TABLE IF NOT EXISTS notice_clears (
  user_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE TABLE IF NOT EXISTS notice_sent (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_prefs (
  user_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile)
);
`);

const KEEP_MS = 24 * 3600_000;
/** A bot editing the same document again within this time does not notify again. */
const PAGE_QUIET_MS = 15 * 60_000;

export type Channel = Notice['channel'];
export type Profile = 'main';

export interface NotifyPrefs {
  channels: Record<Channel, boolean>;
  /** Bot or group id -> muted until (ms), or 0 for "until I turn it back on". */
  muted: Record<string, number>;
  /** Do not disturb until this time (ms); 0 is off. */
  dndUntil: number;
  /** Every day, notices between start and end ("22:00", "07:00", the person's time zone) come silently. */
  quiet: { on: boolean; start: string; end: string; tz: string; approvalsRing: boolean };
  /** Show what a message says in the notification. Off: "New message from Leonard". */
  preview: boolean;
}

export const defaultPrefs = (): NotifyPrefs => ({
  channels: { messages: true, approvals: true, jobs: true },
  muted: {},
  dndUntil: 0,
  quiet: { on: false, start: '22:00', end: '07:00', tz: 'America/Chicago', approvalsRing: false },
  preview: true,
});

const isProfile = (p: unknown): p is Profile => p === 'main';
export const profileOf = (p: unknown): Profile => (isProfile(p) ? p : 'main');

export function getPrefs(userId: string, profile: Profile): NotifyPrefs {
  const r = db.prepare('SELECT prefs FROM notify_prefs WHERE user_id=? AND profile=?').get(userId, profile) as { prefs: string } | undefined;
  const d = defaultPrefs();
  if (!r) return d;
  try {
    const p = JSON.parse(r.prefs) as Partial<NotifyPrefs>;
    return { ...d, ...p, channels: { ...d.channels, ...p.channels }, quiet: { ...d.quiet, ...p.quiet }, muted: { ...p.muted } };
  } catch { return d; }
}

const hhmm = (s: unknown, fallback: string) => (typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : fallback);
const validTz = (tz: unknown) => {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/** Merge a change into the stored settings. Anything malformed is left as it was. */
export function setPrefs(userId: string, profile: Profile, patch: any): NotifyPrefs {
  const cur = getPrefs(userId, profile);
  const next: NotifyPrefs = { ...cur, channels: { ...cur.channels }, quiet: { ...cur.quiet }, muted: { ...cur.muted } };
  if (patch && typeof patch === 'object') {
    for (const ch of ['messages', 'approvals', 'jobs'] as Channel[]) if (typeof patch.channels?.[ch] === 'boolean') next.channels[ch] = patch.channels[ch];
    if (typeof patch.dndUntil === 'number' && patch.dndUntil >= 0) next.dndUntil = Math.floor(patch.dndUntil);
    if (typeof patch.preview === 'boolean') next.preview = patch.preview;
    const q = patch.quiet;
    if (q && typeof q === 'object') {
      if (typeof q.on === 'boolean') next.quiet.on = q.on;
      if (typeof q.approvalsRing === 'boolean') next.quiet.approvalsRing = q.approvalsRing;
      next.quiet.start = hhmm(q.start, next.quiet.start);
      next.quiet.end = hhmm(q.end, next.quiet.end);
      if (validTz(q.tz)) next.quiet.tz = q.tz;
    }
    // `mute: { botId, until }` (until 0 = until turned back on), `unmute: botId`.
    if (patch.mute && typeof patch.mute.botId === 'string' && typeof patch.mute.until === 'number') {
      const own = db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(patch.mute.botId, userId);
      if (own) next.muted[patch.mute.botId] = Math.max(0, Math.floor(patch.mute.until));
    }
    if (typeof patch.unmute === 'string') delete next.muted[patch.unmute];
  }
  // Drop mutes that have run out.
  const t = now();
  for (const [k, v] of Object.entries(next.muted)) if (v && v <= t) delete next.muted[k];
  db.prepare('INSERT INTO notify_prefs(user_id,profile,prefs,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,profile) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at')
    .run(userId, profile, JSON.stringify(next), t);
  return next;
}

/** Minutes since midnight at `t` in `tz`. */
function minutesIn(tz: string, t: number) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch { return -1; }
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function inQuietHours(q: NotifyPrefs['quiet'], t = now()) {
  if (!q.on) return false;
  const m = minutesIn(q.tz, t);
  if (m < 0) return false;
  const a = toMin(q.start), b = toMin(q.end);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Whether the owner hid this bot or group from their own view (PATCH /api/bots/:id { ownerHidden }). */
export const ownerHidden = (botId: string) => !!db.prepare('SELECT 1 FROM bots WHERE id=? AND owner_hidden=1').get(botId);

/**
 * The notice as a profile gets it, or null when it should not be shown: its channel is off, its bot
 * or group is muted or hidden from the owner's view, or do-not-disturb is on. Quiet hours deliver it silently instead (approvals still
 * ring there if the person chose so).
 */
export function deliverable(n: Notice, userId: string, profile: Profile, prefs = getPrefs(userId, profile), t = now(), scoped = false): Notice | null {
  // A bot the owner hid from their own view sends nothing to the main profile. Not to a scoped sign-in
  // (Sam sees only their own bot, on the same account): it keeps hearing from it.
  if (profile === 'main' && !scoped && ownerHidden(n.botId)) return null;
  if (!prefs.channels[n.channel]) return null;
  const m = prefs.muted[n.botId];
  if (m !== undefined && (m === 0 || m > t)) return null;
  if (prefs.dndUntil > t) return null;
  const silent = inQuietHours(prefs.quiet, t) && !(n.channel === 'approvals' && prefs.quiet.approvalsRing);
  let out: Notice = silent ? { ...n, silent: true } : n;
  if (!prefs.preview && out.channel === 'messages') out = { ...out, body: out.group ? 'New message in the group' : 'New message' };
  return out;
}

/** Notices since `after` (the last id an app has), newest last; at most a day back. */
export function noticesAfter(userId: string, after: number, limit = 50): Notice[] {
  // A notice taken down since (the card answered, the chat read) is not sent again to an app catching up.
  const rows = db.prepare(`SELECT n.id, n.body FROM notices n LEFT JOIN notice_clears c ON c.user_id=n.user_id AND c.tag=n.tag
    WHERE n.user_id=? AND n.id>? AND n.created_at>? AND (c.at IS NULL OR c.at < n.created_at) ORDER BY n.id DESC LIMIT ?`).all(userId, after, now() - KEEP_MS, limit) as { id: number; body: string }[];
  return rows.reverse().map((r) => ({ ...(JSON.parse(r.body) as Omit<Notice, 'id'>), id: r.id }));
}

export function lastNoticeId(userId: string): number {
  return (db.prepare('SELECT MAX(id) AS id FROM notices WHERE user_id=?').get(userId) as any)?.id ?? 0;
}

/** Make a notice once per `key` (a reply is updated many times while it streams). */
function make(userId: string, key: string, n: Omit<Notice, 'id' | 'createdAt'>) {
  const t = now();
  const fresh = db.prepare('INSERT OR IGNORE INTO notice_sent(key, at) VALUES (?, ?)').run(key, t).changes > 0;
  if (!fresh) return;
  const body = { ...n, createdAt: t };
  const id = Number(db.prepare('INSERT INTO notices(user_id,bot_id,channel,tag,body,created_at) VALUES (?,?,?,?,?,?)').run(userId, n.botId, n.channel, n.tag, JSON.stringify(body), t).lastInsertRowid);
  hub.emit(userId, { type: 'notify', n: { ...body, id } });
}

/** Take notices down on every app now, and remember it for apps that were offline (noticesAfter). */
const clear = (userId: string, tags: string[]) => {
  const t = now();
  const up = db.prepare('INSERT INTO notice_clears(user_id,tag,at) VALUES (?,?,?) ON CONFLICT(user_id,tag) DO UPDATE SET at=excluded.at');
  for (const tag of tags) up.run(userId, tag, t);
  hub.emit(userId, { type: 'notify-clear', tags });
};
/**
 * A notice about the server itself (status.ts: the database, the disk, an agent that will not start). It is
 * shown as coming from `botId` (the owner's main bot, which looks after the server), once per `key`.
 */
export function notifySystem(userId: string, botId: string, key: string, tag: string, title: string, body: string) {
  make(userId, key, { channel: 'jobs', tag, botId, ...faces(botId, false), title, body: plain(body) });
}
/** Take a server notice down again (the problem is over). */
export const clearSystem = (userId: string, tag: string) => clear(userId, [tag]);

/** Chats with a message notice out, so reading one clears it once rather than on every bot update. */
const openChats = new Set<string>();

/**
 * A bot as a notification shows it: its face-centred picture (the same ?crop=head the chat uses; a group's
 * picture whole), whose address carries the bot's updated_at, so a new look is a new address and apps
 * fetch it again instead of keeping the old face. No picture: its initial on its chat colour.
 */
export function faceOf(botId: string): NoticeFace | undefined {
  const r = db.prepare('SELECT id, name, kind, side_of, avatar_image IS NOT NULL AS pic, updated_at, user_id, chat_color, avatar_color, created_at FROM bots WHERE id=?').get(botId) as any;
  if (!r) return undefined;
  const room = r.kind === 'room';
  let color = CHAT_COLORS.blue.light.bar;
  if (!room) {
    const all = db.prepare("SELECT id, chat_color, avatar_color, created_at FROM bots WHERE user_id=? AND side_of IS NULL AND COALESCE(kind,'agent')<>'room'").all(r.user_id) as any[];
    const picked = assignChatColors(all.map((b) => ({ id: b.id, chatColor: b.chat_color, avatarColor: b.avatar_color, createdAt: b.created_at })))[r.id];
    if (picked) color = CHAT_COLORS[picked].light.bar;
  }
  const face = r.pic ? `/api/bots/${r.id}/avatar?v=${r.updated_at}${room ? '&g=1' : '&crop=head'}` : null;
  return { id: r.id, name: r.name, face, color };
}

const botInfo = (botId: string) => db.prepare('SELECT id, name, kind FROM bots WHERE id=?').get(botId) as { id: string; name: string; kind: string | null } | undefined;

/**
 * Who a chat's notices are about. A side chat's (side-chats.ts) are its bot's, so mutes
 * see the bot, with the side chat named and carried along so a tap opens that side chat.
 */
function chatInfo(chatId: string): { bot: { id: string; name: string; kind: string | null }; side?: { chatId: string; chatTitle: string } } | undefined {
  const r = db.prepare('SELECT side_of, chat_title FROM bots WHERE id=?').get(chatId) as { side_of: string | null; chat_title: string | null } | undefined;
  if (!r) return undefined;
  if (!r.side_of) { const bot = botInfo(chatId); return bot && { bot }; }
  const bot = botInfo(r.side_of);
  return bot && { bot, side: { chatId, chatTitle: r.chat_title || 'Side chat' } };
}

/**
 * The faces on a notice: the bot that wrote it (another bot posting here, a group member, or the chat's
 * own bot) and, in a group, the group. A routine or voice row is the chat's own bot speaking.
 */
function faces(chatBotId: string, group: boolean, from?: { kind?: string; id?: string } | null): Pick<Notice, 'sender' | 'room'> {
  const senderId = from?.kind === 'bot' && from.id ? from.id : chatBotId;
  const sender = group && senderId === chatBotId ? undefined : faceOf(senderId);
  const room = group ? faceOf(chatBotId) : undefined;
  return { ...(sender ? { sender } : {}), ...(room ? { room } : {}) };
}

/** ' · Actual Budget' or ' · Runs a command' for an approval notice; nothing when the card says no more than "a tool". */
function aboutLine(b: any): string {
  const id = cardIconId(b);
  const what = b.toolkitName || (id === 'tool' || id === 'unknown' ? '' : CARD_ICONS[id]?.label);
  return what ? ` · ${what}` : '';
}

/** A message as one notification line: plain text, no Markdown marks, short. */
export function plain(text: string, max = 180) {
  const s = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [picture] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function onRows(userId: string, chatId: string, rows: Row[]) {
  const info = chatInfo(chatId);
  if (!info) return;
  const { bot, side } = info;
  // Notices name the bot (botId) and, for a side chat, the chat too; tags and keys stay per chat.
  const botId = chatId;
  const about = side ? { botId: bot.id, ...side } : { botId };
  const where = side ? ` · ${side.chatTitle}` : '';
  const group = bot.kind === 'room';
  for (const r of rows) {
    const b = r.body;
    if (b.type === 'message') {
      if (b.role !== 'assistant' || b.streaming || !b.text?.trim()) continue;
      // A reply that arrived while nobody looked. A message the person sent never notifies.
      const who = b.from?.kind === 'bot' ? b.from.name : bot.name;
      openChats.add(botId);
      make(userId, `msg:${botId}:${r.generation}:${r.seq}`, {
        channel: 'messages', tag: `chat:${botId}`, ...about, seq: r.seq, group, ...faces(bot.id, group, b.from),
        title: group ? bot.name : `${who}${where}`,
        body: group ? `${who}: ${plain(b.text)}` : plain(b.text),
      });
    } else if (b.type === 'card' && b.card === 'approval') {
      if (b.status === 'pending') {
        const low = (b as any).lowRisk === true && typeof b.digest === 'string';
        make(userId, `apr:${b.approvalId}`, {
          channel: 'approvals', tag: `apr:${b.approvalId}`, ...about, seq: r.seq, ...faces(bot.id, group, (b as any).from),
          // Name the app or the kind of action (card-icon.ts), the way the card's logo does in the chat.
          title: `${bot.name} is waiting on you${where}${aboutLine(b)}`,
          // Browser cards (secure input, purchase) never carry a value and are answered only in the app.
          body: (b as any).secret || (b as any).purchase || (b as any).screenHelp || (b as any).postingPlan ? plain(`${b.title}. Open the app to answer.`, 200) : plain(b.title.replace(/\?$/, '') + (b.detail ? `: ${b.detail}` : ''), 200),
          ...(low ? { approval: { id: b.approvalId, digest: b.digest! } } : {}),
        });
      } else {
        clear(userId, [`apr:${b.approvalId}`]);
      }
    } else if (b.type === 'card' && b.card === 'look' && b.status === 'pending' && b.candidates?.length) {
      make(userId, `look:${botId}:${r.generation}:${r.seq}`, {
        channel: 'jobs', tag: `look:${botId}:${r.seq}`, ...about, seq: r.seq, ...faces(bot.id, false),
        title: `New looks for ${bot.name}`, body: 'Pick the one you like.',
      });
    } else if (b.type === 'card' && b.card === 'view' && b.quick) {
      // Choice buttons: the chat's notice again (same tag, so it replaces the reply's), with the answers as
      // buttons when there are three or fewer. Once answered, the notice comes down.
      const c = b.blocks[0] as any;
      if (!c || c.type !== 'choice') continue;
      if (c.sentAt) { clear(userId, [`chat:${botId}`]); continue; }
      const who = b.from?.name ?? bot.name;
      openChats.add(botId);
      make(userId, `qc:${botId}:${r.generation}:${r.seq}`, {
        channel: 'messages', tag: `chat:${botId}`, ...about, seq: r.seq, group, ...faces(bot.id, group, b.from),
        title: group ? bot.name : `${who}${where}`,
        body: group ? `${who}: ${plain(c.question, 200)}` : plain(c.question, 200),
        ...(c.options.length <= 3 ? { choices: { seq: r.seq, generation: r.generation, block: c.id, options: c.options } } : {}),
      });
    } else if (b.type === 'card' && b.card === 'question' && b.status === 'pending') {
      make(userId, `q:${botId}:${r.generation}:${r.seq}`, {
        channel: 'approvals', tag: `q:${botId}:${r.seq}`, ...about, seq: r.seq, ...faces(bot.id, group, (b as any).from),
        title: `${bot.name} has a question${where}`, body: plain(b.question, 200),
      });
    } else if (b.type === 'card' && b.card === 'question') {
      clear(userId, [`q:${botId}:${r.seq}`]);
    }
  }
}

function onEvent(userId: string, ev: ServerEvent) {
  if (ev.type === 'rows') onRows(userId, ev.botId, ev.rows);
  else if (ev.type === 'look-run') {
    const bot = botInfo(ev.botId);
    if (!bot) return;
    make(userId, `run:${ev.run}`, {
      channel: 'jobs', tag: `run:${ev.run}`, botId: ev.botId, ...faces(ev.botId, false),
      title: ev.state === 'done' ? `${bot.name}'s pictures are ready` : `${bot.name}'s pictures could not be drawn`,
      body: ev.state === 'done' ? 'Open the Look tab to pick one.' : 'Open the Look tab to try again.',
    });
  } else if (ev.type === 'page' && ev.byKind === 'bot') {
    const bot = botInfo(ev.botId);
    if (!bot) return;
    const slot = Math.floor(now() / PAGE_QUIET_MS);
    const name = ev.path.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') || ev.path;
    make(userId, `page:${ev.botId}:${ev.path}:${slot}`, {
      channel: 'jobs', tag: `page:${ev.botId}:${ev.path}`, botId: ev.botId, ...faces(ev.botId, false),
      title: `${ev.by} updated ${name}`, body: `Version ${ev.version}. Tap to open the chat.`,
    });
  } else if (ev.type === 'bot' && ev.bot.unread === 0 && openChats.delete(ev.bot.id)) {
    // Read on any app: take that chat's message notifications down everywhere.
    clear(userId, [`chat:${ev.bot.id}`]);
  } else if (ev.type === 'side-chats') {
    for (const sc of ev.chats) if (sc.unread === 0 && openChats.delete(sc.id)) clear(userId, [`chat:${sc.id}`]);
  }
}

let started = false;
export function startNotify() {
  if (started) return;
  started = true;
  hub.tap(onEvent);
  const prune = () => {
    const cut = now() - KEEP_MS;
    db.prepare('DELETE FROM notices WHERE created_at<?').run(cut);
    db.prepare('DELETE FROM notice_clears WHERE at<?').run(cut);
    db.prepare('DELETE FROM notice_sent WHERE at<?').run(cut - KEEP_MS);
  };
  prune();
  setInterval(prune, 3600_000).unref();
}
