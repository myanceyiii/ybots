/**
 * What the app showed last, kept on the phone per account: the bot list and the newest messages of the
 * chats used most recently. A cold start draws from it at once (no blank list while the server answers),
 * and with no connection the chats can still be read. The server stays the truth: whatever it sends
 * replaces this. Stored in the app's own private storage and deleted on sign-out.
 */
import type { Bot, Row } from './api';
import { accountKey, readJson, removeFile, writeJsonSoon } from './disk';

export interface ChatCache { generation: number; rows: Row[] }
export interface AppCache { v: 1; savedAt: number; bots: Bot[]; chats: Record<string, ChatCache> }

/** How much is kept: enough to read back a screen or two of each recent chat, small enough to load fast. */
const MAX_CHATS = 12;
const MAX_ROWS = 40;
const MAX_ROW_CHARS = 24_000;
const MAX_TOTAL_CHARS = 1_500_000;

const file = (account: string) => `cache-${accountKey(account)}.json`;

/** A row without what is too big to keep (a step's screenshot, a huge tool result); never a row still being written. */
function slim(row: Row): Row | null {
  const b = row.body;
  if (!b || b.streaming) return null;
  let body = b;
  if (typeof b.screenshot === 'string') body = { ...b, screenshot: undefined };
  try { if (JSON.stringify(body).length > MAX_ROW_CHARS) return null; } catch { return null; }
  return body === b ? row : { ...row, body };
}

/** The snapshot to save: the bots, and the newest rows of the chats that were active most recently. */
export function snapshot(bots: Bot[], rows: Record<string, Row[]>, generations: Record<string, number>): AppCache {
  const recency = new Map(bots.map((b) => [b.id, b.lastActivityAt]));
  const ids = Object.keys(rows)
    .filter((id) => rows[id]?.length && generations[id] !== undefined)
    .sort((a, b) => (rows[b][rows[b].length - 1]?.createdAt ?? recency.get(b) ?? 0) - (rows[a][rows[a].length - 1]?.createdAt ?? recency.get(a) ?? 0))
    .slice(0, MAX_CHATS);
  const chats: Record<string, ChatCache> = {};
  let total = 0;
  for (const id of ids) {
    const kept = rows[id].slice(-MAX_ROWS).map(slim).filter((r): r is Row => !!r);
    if (!kept.length) continue;
    let size = 0;
    try { size = JSON.stringify(kept).length; } catch { continue; }
    if (total + size > MAX_TOTAL_CHARS) break;
    total += size;
    chats[id] = { generation: generations[id], rows: kept };
  }
  return { v: 1, savedAt: Date.now(), bots, chats };
}

export async function loadCache(account: string): Promise<AppCache | null> {
  const c = await readJson<AppCache | null>(file(account), null);
  if (!c || c.v !== 1 || !Array.isArray(c.bots) || typeof c.chats !== 'object' || !c.chats) return null;
  // Older than two weeks says little about now: start clean.
  if (Date.now() - (c.savedAt ?? 0) > 14 * 86_400_000) return null;
  const bots = c.bots.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string');
  const chats: Record<string, ChatCache> = {};
  for (const [id, ch] of Object.entries(c.chats)) {
    if (!ch || typeof ch.generation !== 'number' || !Array.isArray(ch.rows)) continue;
    const rows = ch.rows.filter((r) => r && typeof r.seq === 'number' && r.body && typeof r.body === 'object');
    if (rows.length) chats[id] = { generation: ch.generation, rows };
  }
  return { v: 1, savedAt: c.savedAt, bots, chats };
}

/** Saved a moment after things settle, so a streaming reply does not write on every word. */
export function saveCacheSoon(account: string, make: () => AppCache) {
  if (account) writeJsonSoon(file(account), make, 2500);
}

/** Signing out takes the saved chats off the phone. */
export function clearCache(account: string) {
  if (account) removeFile(file(account));
}
