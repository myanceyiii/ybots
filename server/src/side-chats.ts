import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { chatOwner, getBotRow, getLive, onSideChatChange, previewOf } from './store.js';
import { isOutside } from './outside.js';
import { isSilo } from './silo.js';
import type { RowBody, SideChat } from './types.js';

/**
 * Side chats: more than one conversation with the same bot at once, beside its main chat (as Muse
 * does it: "Main chat" plus a list of side chats with a + button).
 *
 * A side chat is a hidden row in `bots` with `side_of` set to the bot it belongs to. Because it has its
 * own id it gets, with no special code, everything a chat has: its own rows and "New conversation",
 * its own model history and Hermes session (`hq-<side chat id>-g<n>`), its own queue (so it runs at
 * the same time as the main chat and other side chats), its own live state, Stop button, unread count
 * and approval cards. Everything that makes it the bot (name, look, instructions, model, engine,
 * computer, files, Hermes memory and skills) is borrowed from the bot (store.ts getBotRow, engine
 * and computer calls go through chatOwner), so a side chat is the same bot, not a copy of it.
 *
 * Groups, outside members (Slack link) and walled-off bots have no side chats.
 */

/** Most side chats one bot keeps; old ones can be deleted to make room. */
export const MAX_SIDE_CHATS = 30;
/** How long a deleted side chat can be brought back with Undo before it is gone for good. */
export const SIDE_UNDO_MS = 10 * 60_000;
/** Most of one bot's chats (main chat included) working at the same moment; more wait their turn. */
export const MAX_RUNNING_PER_BOT = 4;

const TITLE_MAX = 60;

export function cleanTitle(t: unknown): string {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/**
 * A title from the first thing said in a side chat: its first line, cut at a word near 48 characters.
 * Made here rather than by the model, so naming a chat costs no tokens. The person can rename it.
 */
export function titleFrom(text: string): string {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const plain = line.replace(/[*_`#>~[\]]+/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= 48) return plain || 'New chat';
  const cut = plain.slice(0, 48);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 24 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** Whether this bot can have side chats, and why not when it cannot. */
export function sideChatsAllowed(bot: any): string | null {
  if (!bot) return 'not found';
  if (bot.side_of) return 'A side chat cannot have side chats of its own.';
  if (bot.kind === 'room') return 'Group chats have no side chats.';
  if (isOutside(bot.id)) return 'This bot lives outside the app, so it has no side chats here.';
  if (isSilo(bot.id)) return 'This bot is walled off and has no side chats.';
  return null;
}

function toSideChat(r: any): SideChat {
  const recent = db
    .prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') ORDER BY seq DESC LIMIT 4")
    .all(r.id, r.generation) as { body: string; created_at: number }[];
  let lastPreview: string | null = null;
  for (const row of recent) {
    lastPreview = previewOf(JSON.parse(row.body) as RowBody);
    if (lastPreview) break;
  }
  return {
    id: r.id,
    botId: r.side_of,
    title: r.chat_title || 'New chat',
    createdAt: r.created_at,
    lastActivityAt: recent[0]?.created_at ?? r.updated_at,
    lastPreview: lastPreview ? lastPreview.slice(0, 140) : null,
    unread: r.unread,
    generation: r.generation,
    live: getLive(r.id),
  };
}

/** A bot's side chats, most recently used first. */
export function listSideChats(botId: string): SideChat[] {
  const rows = db.prepare('SELECT * FROM bots WHERE side_of=? AND chat_deleted_at IS NULL').all(botId) as any[];
  return rows.map(toSideChat).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** The ids of a bot's chats: its main chat and its side chats (deleted ones still waiting for Undo included). */
export function chatsOf(botId: string): string[] {
  const owner = chatOwner(botId);
  return [owner, ...(db.prepare('SELECT id FROM bots WHERE side_of=?').all(owner) as { id: string }[]).map((r) => r.id)];
}

export function emitSideChats(botId: string) {
  const b = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
  if (b) hub.emit(b.user_id, { type: 'side-chats', botId, chats: listSideChats(botId) });
}
onSideChatChange(emitSideChats);

export function createSideChat(botId: string, title?: unknown): SideChat | { error: string; status: 400 | 404 | 409 } {
  const owner = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
  const why = sideChatsAllowed(owner);
  if (why) return { error: why, status: why === 'not found' ? 404 : 400 };
  const n = (db.prepare('SELECT COUNT(*) n FROM bots WHERE side_of=? AND chat_deleted_at IS NULL').get(botId) as any).n as number;
  if (n >= MAX_SIDE_CHATS) return { error: `${owner.name} already has ${MAX_SIDE_CHATS} side chats. Delete one you no longer need first.`, status: 409 };
  const id = newId('side');
  const t = now();
  const named = cleanTitle(title);
  // Only the columns a side chat keeps of its own matter (store.ts SIDE_OWN); the rest are copied so the
  // row is valid on its own, but they are never read: getBotRow takes them from the bot.
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,effort,hidden,side_of,chat_title,chat_titled,created_at,updated_at,kind)
     VALUES (?,?,?,?,?,'',?,?,?,0,?,1,?,?,?,?,?,'agent')`,
  ).run(id, owner.user_id, owner.name, owner.label ?? '', `Side chat of ${owner.name}`, owner.avatar_shape, owner.avatar_color, owner.mode, owner.effort ?? 'medium', botId, named || 'New chat', named ? 1 : 0, t, t);
  emitSideChats(botId);
  return toSideChat(db.prepare('SELECT * FROM bots WHERE id=?').get(id));
}

/** A side chat of this person's, deleted ones included when `deleted` is set. */
export function ownSideChat(userId: string, id: string, deleted = false): any | null {
  const r = db.prepare('SELECT * FROM bots WHERE id=? AND side_of IS NOT NULL').get(id) as any;
  if (!r || r.user_id !== userId) return null;
  if (r.chat_deleted_at && !deleted) return null;
  return r;
}

export function renameSideChat(id: string, title: unknown): string | null {
  const t = cleanTitle(title);
  if (!t) return 'Give the chat a name.';
  const r = db.prepare('SELECT side_of FROM bots WHERE id=?').get(id) as any;
  db.prepare('UPDATE bots SET chat_title=?, chat_titled=1, updated_at=? WHERE id=?').run(t, now(), id);
  emitSideChats(r.side_of);
  return null;
}

/** Name an untitled side chat from the person's first message in it. */
export function autoTitle(id: string, text: string) {
  const r = db.prepare('SELECT side_of, chat_titled FROM bots WHERE id=?').get(id) as any;
  if (!r?.side_of || r.chat_titled) return;
  db.prepare('UPDATE bots SET chat_title=?, chat_titled=1 WHERE id=?').run(titleFrom(text), id);
  emitSideChats(r.side_of);
}

/** Delete a side chat: it leaves the list at once and can be brought back for SIDE_UNDO_MS. */
export function deleteSideChat(id: string) {
  const r = db.prepare('SELECT side_of FROM bots WHERE id=?').get(id) as any;
  db.prepare('UPDATE bots SET chat_deleted_at=? WHERE id=?').run(now(), id);
  emitSideChats(r.side_of);
}

export function restoreSideChat(id: string): string | null {
  const r = db.prepare('SELECT side_of, chat_deleted_at FROM bots WHERE id=?').get(id) as any;
  if (!r?.chat_deleted_at) return 'That chat was not deleted.';
  if (now() - r.chat_deleted_at > SIDE_UNDO_MS) return 'Too late to undo: that was more than 10 minutes ago.';
  db.prepare('UPDATE bots SET chat_deleted_at=NULL WHERE id=?').run(id);
  emitSideChats(r.side_of);
  return null;
}

/** Remove side chats deleted more than SIDE_UNDO_MS ago (rows and history go with them: ON DELETE CASCADE). */
export function purgeDeletedSideChats(t = now()) {
  const gone = db.prepare('SELECT id FROM bots WHERE side_of IS NOT NULL AND chat_deleted_at IS NOT NULL AND chat_deleted_at < ?').all(t - SIDE_UNDO_MS) as { id: string }[];
  for (const g of gone) removeSideChatRow(g.id);
  return gone.length;
}

/** All of a bot's side chats, when the bot itself is deleted. */
export function removeSideChatsOf(botId: string) {
  for (const r of db.prepare('SELECT id FROM bots WHERE side_of=?').all(botId) as { id: string }[]) removeSideChatRow(r.id);
}

function removeSideChatRow(id: string) {
  db.prepare('DELETE FROM notices WHERE bot_id=?').run(id);
  db.prepare('DELETE FROM bots WHERE id=?').run(id);
}

/** What a side chat's turns are told, after the bot's own instructions. */
export function sideChatNote(chatId: string): string {
  const r = getBotRow(chatId);
  if (!r?.side_of) return '';
  return `\n\n## This conversation\nThis is a side chat titled "${r.chat_title || 'New chat'}": a separate conversation your owner opened with you beside your main chat. ` +
    'Your other chats can be running at the same time; you do not see their messages here, but your memory, skills, files and computer are shared between all of them. ' +
    'Keep to what was asked in this chat. If you need something from another chat, ask your owner or look in your memory or files.';
}

let started = false;
export function startSideChats() {
  if (started) return;
  started = true;
  purgeDeletedSideChats();
  setInterval(() => { try { purgeDeletedSideChats(); } catch (e) { console.warn('[side-chats] purge failed', e); } }, 60_000).unref();
}

// ---------- one bot's chats working at once ----------

const running = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

/**
 * Wait for a free place among the bot's running chats (MAX_RUNNING_PER_BOT), then hold it until
 * `release` is called. A bot's Hermes refuses runs past its own cap (gateway.api_server.max_concurrent_runs,
 * 10 by default, shared with its other front-ends), so the app keeps well under it.
 */
export async function takeRunSlot(chatId: string, signal?: AbortSignal): Promise<() => void> {
  const owner = chatOwner(chatId);
  while ((running.get(owner) ?? 0) >= MAX_RUNNING_PER_BOT) {
    if (signal?.aborted) throw new Error('interrupted');
    await new Promise<void>((resolve) => {
      const list = waiting.get(owner) ?? [];
      list.push(resolve);
      waiting.set(owner, list);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  running.set(owner, (running.get(owner) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running.set(owner, Math.max(0, (running.get(owner) ?? 1) - 1));
    const next = waiting.get(owner)?.shift();
    if (next) next();
  };
}
