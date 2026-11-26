import { db } from './db.js';

/**
 * Schema additions for bot settings, memory over time and hibernation.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('skills', 'updated_at', 'INTEGER');
/** 'chat' = saved by the bot's remember tool, 'learned' = extracted by consolidation. */
addColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'chat'");
/** 1 = the owner let this bot save its own Hermes skills without an approval card (plugins/hermes-gate.ts). */
addColumn('bots', 'auto_save_skills', 'INTEGER NOT NULL DEFAULT 0');
/**
 * 1 = the maintainer bot (Howard) runs every terminal command without a card ("free-run", Alex
 * 2026-11-24). Only matters for maintainer bots (maintainer-guard.ts); on by default, the owner turns it off.
 */
addColumn('bots', 'free_terminal', 'INTEGER NOT NULL DEFAULT 1');

db.exec(`
-- When the person last looked at each of a bot's Hermes skills (engine-skills.ts, the New marker).
-- name '*' is the bot's starting point: changes from before it was first listed are not New.
CREATE TABLE IF NOT EXISTS skill_reviews (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, name)
);
CREATE TABLE IF NOT EXISTS memory_jobs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_consolidated_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  method TEXT NOT NULL,
  items_before INTEGER NOT NULL,
  items_after INTEGER NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export const configSchemaReady = true;
