import { db, now } from './db.js';

/**
 * Settings and saved lines for the chat list's AI summaries (list-summary.ts makes them). Only the database
 * here, so store.ts can read a saved summary for each row without loading the summarizer.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS list_summary_prefs (
  user_id TEXT PRIMARY KEY,
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS list_summaries (
  bot_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  upto_seq INTEGER NOT NULL,
  text TEXT,
  model TEXT,
  made_at INTEGER NOT NULL,
  failed_at INTEGER,
  error TEXT
);
`);

export interface SummaryPrefs {
  /** Off by default: summaries cost model calls. */
  on: boolean;
  /** null = the cheapest model Hermes lists for its signed-in account (list-summary.ts picks it). */
  provider: string | null;
  model: string | null;
}

const DEFAULTS: SummaryPrefs = { on: false, provider: null, model: null };
const ID = /^[\w.:/@+-]{1,120}$/;

export function getSummaryPrefs(userId: string): SummaryPrefs {
  const r = db.prepare('SELECT prefs FROM list_summary_prefs WHERE user_id=?').get(userId) as { prefs: string } | undefined;
  if (!r) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(r.prefs) }; } catch { return { ...DEFAULTS }; }
}

/** Merge a change. Malformed fields are ignored; `model: null` goes back to the automatic choice. */
export function setSummaryPrefs(userId: string, patch: any): SummaryPrefs {
  const next = getSummaryPrefs(userId);
  if (patch && typeof patch === 'object') {
    if (typeof patch.on === 'boolean') next.on = patch.on;
    if (patch.model === null) { next.model = null; next.provider = null; }
    else if (typeof patch.model === 'string' && ID.test(patch.model)) {
      next.model = patch.model;
      next.provider = typeof patch.provider === 'string' && ID.test(patch.provider) ? patch.provider : null;
    }
  }
  db.prepare('INSERT INTO list_summary_prefs(user_id,prefs,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at')
    .run(userId, JSON.stringify(next), now());
  return next;
}

/** The saved summary for this conversation, or null. A slightly older one still describes the work, so it stays until a new one is made. */
export function savedSummary(botId: string, generation: number): string | null {
  const r = db.prepare('SELECT generation, text FROM list_summaries WHERE bot_id=?').get(botId) as { generation: number; text: string | null } | undefined;
  return r && r.generation === generation && r.text ? r.text : null;
}

export function summaryState(botId: string): { generation: number; uptoSeq: number; failedAt: number | null } | null {
  const r = db.prepare('SELECT generation, upto_seq, failed_at FROM list_summaries WHERE bot_id=?').get(botId) as any;
  return r ? { generation: r.generation, uptoSeq: r.upto_seq, failedAt: r.failed_at ?? null } : null;
}

export function saveSummary(botId: string, generation: number, uptoSeq: number, text: string, model: string | null) {
  db.prepare(`INSERT INTO list_summaries(bot_id,generation,upto_seq,text,model,made_at,failed_at,error) VALUES (?,?,?,?,?,?,NULL,NULL)
    ON CONFLICT(bot_id) DO UPDATE SET generation=excluded.generation, upto_seq=excluded.upto_seq, text=excluded.text, model=excluded.model, made_at=excluded.made_at, failed_at=NULL, error=NULL`)
    .run(botId, generation, uptoSeq, text, model, now());
}

/** A failed try keeps the old line and waits before trying again. */
export function noteSummaryFailure(botId: string, generation: number, error: string) {
  db.prepare(`INSERT INTO list_summaries(bot_id,generation,upto_seq,text,model,made_at,failed_at,error) VALUES (?,?,0,NULL,NULL,?,?,?)
    ON CONFLICT(bot_id) DO UPDATE SET failed_at=excluded.failed_at, error=excluded.error`)
    .run(botId, generation, now(), now(), error.slice(0, 300));
}

export function lastSummaryError(userId: string): { at: number; error: string } | null {
  const r = db.prepare(`SELECT s.failed_at AS at, s.error FROM list_summaries s JOIN bots b ON b.id=s.bot_id
    WHERE b.user_id=? AND s.failed_at IS NOT NULL ORDER BY s.failed_at DESC LIMIT 1`).get(userId) as any;
  return r ? { at: r.at, error: r.error } : null;
}
