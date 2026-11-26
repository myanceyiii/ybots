import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Checked before the database is opened (db.ts), so a wrong file is never created or filled with tables.
 *
 * On 2026-11-23 an empty database file appeared beside the real one and the next restart opened it: the
 * app came up with one default bot and every chat seemed gone. A server that is about to start on a
 * database with no accounts, while a database with accounts sits in the same folder, is almost certainly
 * pointed at the wrong file, so it refuses to start and says which file has the data.
 *
 * ALLOW_EMPTY_DB=1 starts anyway (a deliberate fresh start beside an old database).
 */

export interface DbFileInfo { file: string; bytes: number; users: number; bots: number }

/** Accounts and bots in a database file, read without changing it. -1 when the file cannot be read as one. */
export function peekDb(file: string): DbFileInfo {
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { return { file, bytes: 0, users: 0, bots: 0 }; }
  if (!bytes) return { file, bytes, users: 0, bots: 0 };
  let d: Database.Database | null = null;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const has = (t: string) => !!d!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const count = (t: string) => (has(t) ? (d!.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n : 0);
    return { file, bytes, users: count('users'), bots: count('bots') };
  } catch {
    return { file, bytes, users: -1, bots: -1 };
  } finally {
    try { d?.close(); } catch { /* nothing to close */ }
  }
}

/** Other database files in the same folder that hold accounts. Snapshots and backups live elsewhere and are not looked at. */
export function populatedSiblings(dbPath: string): DbFileInfo[] {
  const dir = path.dirname(dbPath);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const self = path.resolve(dbPath);
  return names
    .filter((n) => n.endsWith('.db') && path.resolve(dir, n) !== self)
    .map((n) => peekDb(path.join(dir, n)))
    .filter((i) => i.users > 0)
    .sort((a, b) => b.bots - a.bots || b.bytes - a.bytes);
}

/** Why the server must not start on this database file, or null when it may. */
export function emptyDbRefusal(dbPath: string, allowEmpty = process.env.ALLOW_EMPTY_DB === '1'): string | null {
  if (allowEmpty) return null;
  const mine = peekDb(dbPath);
  if (mine.users !== 0) return null; // it has accounts, or it is not readable here and opening it will say why
  const others = populatedSiblings(dbPath);
  if (!others.length) return null; // a first start: nothing to lose
  const best = others[0];
  return [
    `Refusing to start: the database ${dbPath} has no accounts, but ${best.file} beside it has ${best.users} account${best.users === 1 ? '' : 's'} and ${best.bots} bot${best.bots === 1 ? '' : 's'}.`,
    'Starting now would show an empty app and hide every chat.',
    `Set DB_PATH=${best.file} in .env to use the database with the data, or set ALLOW_EMPTY_DB=1 to really start fresh.`,
  ].join(' ');
}
