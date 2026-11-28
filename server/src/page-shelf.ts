import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { insideFile, insideTarget, workspaceRoot } from './files.js';
import { isPagePath, PAGE_SUFFIX } from './pages.js';
import { chatOwner } from './store.js';
import type { PageShelfItem } from './types.js';

/**
 * The Pages tab: every Page a bot has (pages.ts), in one list beside its Library, with what the list needs
 * on top of the Page files themselves: pinned or not, which chat it came from, and deleted Pages kept for Undo.
 *
 * Pages stay ordinary `.page.json` files in the bot's workspace (the Library holds the bot's other files), so
 * the bot reads and edits them with its page tools as before. A deleted Page moves into the workspace's hidden
 * `.cleft-trash` folder (no file walk, the bot's own included, looks in dot folders) and can be put back with
 * Undo; after TRASH_DAYS it is removed for good.
 *
 * A side chat is the same bot (side-chats.ts), so everything here works on the bot that owns the chat.
 */

const TRASH = '.cleft-trash';
const TRASH_DAYS = 7;
const MAX_PAGES = 500;
const SKIP = new Set(['node_modules', '.git', TRASH]);

db.exec(`
CREATE TABLE IF NOT EXISTS page_shelf (
  bot_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  origin_chat TEXT,
  origin_seq INTEGER,
  origin_kind TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_path TEXT,
  trash_rel TEXT,
  PRIMARY KEY (bot_id, page_id)
);
`);

const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

/** Where a Page came from: the chat it was made in, and the chat message (an answer view) if it was one. */
export function notePageOrigin(chatId: string, pageId: string, how: { kind: 'view' | 'bot' | 'person'; seq?: number }) {
  const owner = chatOwner(chatId);
  db.prepare(`INSERT INTO page_shelf(bot_id,page_id,origin_chat,origin_seq,origin_kind,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(bot_id,page_id) DO UPDATE SET origin_chat=excluded.origin_chat, origin_seq=excluded.origin_seq, origin_kind=excluded.origin_kind`)
    .run(owner, pageId, chatId, how.seq ?? null, how.kind, now());
  emitShelf(owner);
}

function emitShelf(owner: string) {
  const userId = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(owner) as any)?.user_id;
  if (userId) hub.emit(userId, { type: 'pages', botId: owner });
}

/** The chat a Page's buttons and "Send these numbers" post into: the chat it came from while that chat is there. */
function liveChat(owner: string, chat: string | null): { id: string; title: string } {
  if (chat && chat !== owner) {
    const r = db.prepare('SELECT id, chat_title, chat_deleted_at, side_of FROM bots WHERE id=?').get(chat) as any;
    if (r && r.side_of === owner && !r.chat_deleted_at) return { id: r.id, title: r.chat_title || 'Side chat' };
  }
  return { id: owner, title: 'Main chat' };
}

/** What a Page is mostly for, for its icon in the list. */
function kindOf(blocks: any[]): PageShelfItem['kind'] {
  const has = (t: string) => blocks.some((b) => b?.type === t);
  return has('calc') ? 'calculator' : has('chart') ? 'chart' : has('form') || has('choice') ? 'form' : has('checklist') ? 'checklist' : has('table') ? 'table' : 'doc';
}

/** The first words of a Page, for the list and for search. */
function snippetOf(blocks: any[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const t = b?.md ?? b?.text ?? b?.question ?? b?.title ?? (Array.isArray(b?.items) ? b.items.map((i: any) => i?.text).join(', ') : '');
    if (typeof t === 'string' && t.trim()) parts.push(t.replace(/[#*_`>|[\]]/g, '').replace(/\s+/g, ' ').trim());
    if (parts.join(' ').length > 300) break;
  }
  return parts.join(' · ').slice(0, 300);
}

function purgeTrash(owner: string) {
  const old = db.prepare('SELECT page_id, trash_rel FROM page_shelf WHERE bot_id=? AND deleted_at IS NOT NULL AND deleted_at < ?').all(owner, now() - TRASH_DAYS * 86_400_000) as any[];
  for (const r of old) {
    const f = r.trash_rel && insideFile(owner, r.trash_rel);
    if (f) fs.rmSync(f, { force: true });
    db.prepare('DELETE FROM page_shelf WHERE bot_id=? AND page_id=?').run(owner, r.page_id);
  }
}

/** Every Page the bot has, pinned first, then the most recently changed. */
export function listShelf(chatId: string): PageShelfItem[] {
  const owner = chatOwner(chatId);
  purgeTrash(owner);
  const root = workspaceRoot(owner);
  const found: { rel: string; file: string; mtime: number }[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 5 || seen > 5000 || found.length >= MAX_PAGES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 5000) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || !isPagePath(e.name)) continue;
      try { found.push({ rel: r, file: path.join(dir, e.name), mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }); } catch { /* gone meanwhile */ }
    }
  };
  if (fs.existsSync(root)) walk(root, '', 0);
  const meta = new Map((db.prepare('SELECT * FROM page_shelf WHERE bot_id=? AND deleted_at IS NULL').all(owner) as any[]).map((r) => [r.page_id, r]));
  const items: PageShelfItem[] = [];
  for (const f of found) {
    let page: any;
    try { page = JSON.parse(fs.readFileSync(f.file, 'utf8')); } catch { continue; }
    if (!page || page.cleftPage !== 1 || !Array.isArray(page.blocks)) continue;
    const m = meta.get(page.id);
    const chat = liveChat(owner, m?.origin_chat ?? null);
    items.push({
      path: f.rel,
      id: String(page.id ?? ''),
      title: String(page.title || f.rel.split('/').pop()!.slice(0, -PAGE_SUFFIX.length)).slice(0, 200),
      updatedAt: Number(page.updatedAt) || f.mtime,
      version: Number(page.version) || 1,
      blocks: page.blocks.length,
      kind: kindOf(page.blocks),
      snippet: snippetOf(page.blocks),
      pinned: !!m?.pinned,
      origin: m ? { chatId: chat.id, chatTitle: chat.title, kind: m.origin_kind ?? 'bot', ...(m.origin_seq != null && chat.id === m.origin_chat ? { seq: m.origin_seq } : {}) } : null,
      sendTo: chat.id,
    });
  }
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/** A Page's shelf details by its path (the page view uses this to know where its buttons send). */
export function shelfInfo(chatId: string, rel: string): { sendTo: string; chatTitle: string; pinned: boolean } {
  const owner = chatOwner(chatId);
  let pageId: string | undefined;
  try { pageId = JSON.parse(fs.readFileSync(insideFile(owner, rel) ?? '', 'utf8'))?.id; } catch { /* not a page */ }
  const m = pageId ? db.prepare('SELECT * FROM page_shelf WHERE bot_id=? AND page_id=?').get(owner, pageId) as any : undefined;
  const chat = liveChat(owner, m?.origin_chat ?? null);
  return { sendTo: chat.id, chatTitle: chat.title, pinned: !!m?.pinned };
}

function pageIdAt(owner: string, rel: string): string {
  if (!isPagePath(rel)) throw err('Not a Page');
  const f = insideFile(owner, rel);
  if (!f) throw err('Page not found', 404);
  try {
    const id = JSON.parse(fs.readFileSync(f, 'utf8'))?.id;
    if (typeof id === 'string' && /^pg_\w{4,40}$/.test(id)) return id;
  } catch { /* fall through */ }
  throw err('This file is not a YBots Page', 422);
}

export function setPinned(chatId: string, rel: string, pinned: boolean) {
  const owner = chatOwner(chatId);
  const id = pageIdAt(owner, rel);
  db.prepare(`INSERT INTO page_shelf(bot_id,page_id,pinned,created_at) VALUES (?,?,?,?)
    ON CONFLICT(bot_id,page_id) DO UPDATE SET pinned=excluded.pinned`).run(owner, id, pinned ? 1 : 0, now());
  emitShelf(owner);
}

/** Delete a Page: it moves into the hidden trash folder, and `restoreFromTrash` with its id puts it back. */
export function trashPage(chatId: string, rel: string): { id: string } {
  const owner = chatOwner(chatId);
  const id = pageIdAt(owner, rel);
  const from = insideFile(owner, rel)!;
  const trashRel = `${TRASH}/${id}-${now()}${PAGE_SUFFIX}`;
  const to = insideTarget(owner, trashRel);
  if (!to) throw err('Could not make the trash folder');
  fs.renameSync(from, to);
  db.prepare(`INSERT INTO page_shelf(bot_id,page_id,created_at,deleted_at,deleted_path,trash_rel) VALUES (?,?,?,?,?,?)
    ON CONFLICT(bot_id,page_id) DO UPDATE SET deleted_at=excluded.deleted_at, deleted_path=excluded.deleted_path, trash_rel=excluded.trash_rel`)
    .run(owner, id, now(), now(), rel, trashRel);
  emitShelf(owner);
  return { id };
}

/** Undo a delete: back where it was, or beside it as "(2)" if a new file took that name meanwhile. */
export function restoreFromTrash(chatId: string, pageId: string): { path: string } {
  const owner = chatOwner(chatId);
  const r = db.prepare('SELECT * FROM page_shelf WHERE bot_id=? AND page_id=? AND deleted_at IS NOT NULL').get(owner, pageId) as any;
  if (!r) throw err('That Page is no longer in the trash', 404);
  const from = r.trash_rel && insideFile(owner, r.trash_rel);
  if (!from) throw err('That Page is no longer in the trash', 404);
  const stem = String(r.deleted_path).slice(0, -PAGE_SUFFIX.length);
  let rel = String(r.deleted_path);
  for (let n = 2; insideFile(owner, rel) && n < 100; n++) rel = `${stem} (${n})${PAGE_SUFFIX}`;
  const to = insideTarget(owner, rel);
  if (!to) throw err('That path is outside the workspace');
  fs.renameSync(from, to);
  db.prepare('UPDATE page_shelf SET deleted_at=NULL, deleted_path=NULL, trash_rel=NULL WHERE bot_id=? AND page_id=?').run(owner, pageId);
  emitShelf(owner);
  return { path: rel };
}
