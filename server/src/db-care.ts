import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { env } from './env.js';
import { onShutdown } from './shutdown.js';

/**
 * Looking after the database while the server runs:
 *  - a check at start that the file is sound (quick_check), reported on the status page;
 *  - a snapshot once a day into data/snapshots (a consistent copy made with SQLite's own backup, checked
 *    after it is written), the newest DB_SNAPSHOTS_KEEP kept (default 14; 0 = off);
 *  - housekeeping once a day: rows whose bot is gone, the write-ahead log folded back in, statistics.
 *
 * Snapshots are a quick way back after a mistake on this machine. They are not the off-site backup
 * (deploy/backup), which leaves this folder out.
 */

const DAY = 86_400_000;
const snapshotsKeep = (() => {
  const n = Number(process.env.DB_SNAPSHOTS_KEEP ?? 14);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 365) : 14;
})();
export const snapshotDir = () => process.env.DB_SNAPSHOTS_DIR || path.join(path.dirname(env.dbPath), 'snapshots');
const baseName = () => path.basename(env.dbPath).replace(/\.db$/i, '');

export interface SnapshotInfo { name: string; bytes: number; at: number }
export interface DbHealth {
  path: string; bytes: number; walBytes: number;
  /** quick_check at start: 'ok', the first problems SQLite named, or null when it has not run yet. */
  integrity: string | null; integrityAt: number | null;
  snapshots: SnapshotInfo[]; snapshotsKeep: number; lastSnapshotError: string | null;
  lastMaintenanceAt: number | null; lastMaintenance: string | null;
}

let integrity: string | null = null;
let integrityAt: number | null = null;
let lastSnapshotError: string | null = null;
let lastMaintenanceAt: number | null = null;
let lastMaintenance: string | null = null;

/** SQLite's own soundness check. Fast on a database this size; a problem is logged loudly and shown on the status page. */
export function checkIntegrity(): string {
  try {
    const rows = db.pragma('quick_check') as { quick_check: string }[];
    integrity = rows.map((r) => r.quick_check).slice(0, 5).join('; ') || 'ok';
  } catch (e) {
    integrity = `could not be checked: ${(e as Error).message}`;
  }
  integrityAt = now();
  if (integrity !== 'ok') console.error(`[db] INTEGRITY PROBLEM in ${env.dbPath}: ${integrity}. Restore from a snapshot (${snapshotDir()}) or the weekly backup.`);
  return integrity;
}

export function listSnapshots(): SnapshotInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(snapshotDir()); } catch { return []; }
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(`${baseName()}-`) || !name.endsWith('.sqlite')) continue;
    try { const st = fs.statSync(path.join(snapshotDir(), name)); out.push({ name, bytes: st.size, at: st.mtimeMs }); } catch { /* gone meanwhile */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
let snapshotting: Promise<SnapshotInfo | null> | null = null;

/**
 * Write a snapshot now. The copy is consistent even while the server writes (SQLite's online backup), is
 * checked before it counts, and is named `.sqlite` so nothing mistakes it for a live database.
 */
export function snapshotNow(reason = 'daily'): Promise<SnapshotInfo | null> {
  if (snapshotting) return snapshotting;
  snapshotting = (async () => {
    if (!snapshotsKeep) return null;
    const dir = snapshotDir();
    const tag = reason.replace(/[^a-z0-9]+/gi, '').slice(0, 20) || 'manual';
    const name = `${baseName()}-${stamp(now())}-${tag}.sqlite`;
    const file = path.join(dir, name);
    const tmp = `${file}.part`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A copy is never allowed to fill the disk the live database is written to.
      try {
        const fsStat = fs.statfsSync(dir);
        const free = Number(fsStat.bavail) * Number(fsStat.bsize);
        const need = fs.statSync(env.dbPath).size * 2 + 200 * 1_048_576;
        if (free < need) throw new Error(`not enough free disk space for a copy (${Math.round(free / 1_048_576)} MB free, ${Math.round(need / 1_048_576)} MB wanted)`);
      } catch (e) { if (/free disk space/.test((e as Error).message)) throw e; /* a filesystem that cannot say: go on */ }
      await db.backup(tmp);
      const copy = new Database(tmp, { readonly: true });
      try {
        const check = (copy.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check;
        if (check !== 'ok') throw new Error(`the copy failed its check: ${check}`);
      } finally { copy.close(); }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      lastSnapshotError = null;
      pruneSnapshots();
      const st = fs.statSync(file);
      console.log(`[db] snapshot ${name} (${Math.round(st.size / 1024)} KB, ${reason})`);
      return { name, bytes: st.size, at: st.mtimeMs };
    } catch (e) {
      lastSnapshotError = (e as Error).message;
      console.warn(`[db] snapshot failed: ${lastSnapshotError}`);
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* nothing left */ } }
      return null;
    }
  })();
  const done = snapshotting;
  void done.finally(() => { if (snapshotting === done) snapshotting = null; });
  return done;
}

function pruneSnapshots() {
  const all = listSnapshots();
  for (const s of all.slice(snapshotsKeep)) { try { fs.rmSync(path.join(snapshotDir(), s.name), { force: true }); } catch { /* next time */ } }
  // Half-written copies from a run that was cut off.
  try { for (const n of fs.readdirSync(snapshotDir())) if (/\.part(-wal|-shm)?$/.test(n)) fs.rmSync(path.join(snapshotDir(), n), { force: true }); } catch { /* no folder yet */ }
}

/** Tables that name a bot without a foreign key: their rows outlive a deleted bot unless swept here. */
const BOT_TABLES = ['screens', 'list_summaries', 'view_cards', 'page_shelf', 'page_reads', 'page_paths', 'page_versions', 'avatar_candidates', 'avatar_poses', 'picture_runs', 'skill_reviews'];

const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

/** Once a day: drop what belongs to bots that no longer exist, fold the write-ahead log back in, refresh statistics. */
export function runMaintenance(): string {
  const notes: string[] = [];
  try {
    let orphans = 0;
    db.transaction(() => {
      for (const t of BOT_TABLES) {
        if (!hasTable(t) || !hasColumn(t, 'bot_id')) continue;
        orphans += db.prepare(`DELETE FROM ${t} WHERE bot_id IS NOT NULL AND bot_id NOT IN (SELECT id FROM bots)`).run().changes;
      }
      // The record of each turn behind Settings > Usage is kept 90 days. A bot clears its own when it next
      // answers; one that has gone quiet (or is gone) is cleared here.
      if (hasTable('model_turns') && hasColumn('model_turns', 'at')) orphans += db.prepare('DELETE FROM model_turns WHERE at < ?').run(now() - 90 * DAY).changes;
      // Sign-in attempts from the upstream Google flow this fork does not use.
      orphans += db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(now() - DAY).changes;
    })();
    if (orphans) notes.push(`${orphans} leftover row${orphans === 1 ? '' : 's'} removed`);
  } catch (e) { notes.push(`cleanup failed: ${(e as Error).message}`); }
  try {
    const r = (db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0];
    notes.push(r?.busy ? 'log not folded in (busy)' : 'log folded in');
  } catch (e) { notes.push(`checkpoint failed: ${(e as Error).message}`); }
  try { db.pragma('optimize'); } catch { /* statistics are optional */ }
  lastMaintenanceAt = now();
  lastMaintenance = notes.join(', ');
  console.log(`[db] maintenance: ${lastMaintenance}`);
  return lastMaintenance;
}

export function dbHealth(): DbHealth {
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
  return {
    path: env.dbPath, bytes: size(env.dbPath), walBytes: size(`${env.dbPath}-wal`),
    integrity, integrityAt, snapshots: listSnapshots().slice(0, 30), snapshotsKeep, lastSnapshotError, lastMaintenanceAt, lastMaintenance,
  };
}

let started = false;
/**
 * Start the daily care. `scheduled` false (a dev or test server sharing a database copy) only runs the check
 * at start: no snapshots, no cleanup.
 */
export function startDbCare(scheduled: boolean) {
  if (started) return;
  started = true;
  checkIntegrity();
  // Stopping: the write-ahead log is folded back in and the file closed, so what is on disk is one whole
  // file (a copy made right after a stop is complete, and the next start has nothing to recover).
  onShutdown('database', () => { try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ } }, 4000);
  if (!scheduled) return;
  const due = () => {
    const newest = listSnapshots()[0]?.at ?? 0;
    if (snapshotsKeep && now() - newest > DAY - 3600_000) void snapshotNow('daily');
    if (!lastMaintenanceAt || now() - lastMaintenanceAt > DAY) { try { runMaintenance(); } catch (e) { console.warn('[db] maintenance failed', e); } }
  };
  // A little after start, so a restart loop never spends its time copying the database.
  setTimeout(due, 90_000).unref();
  setInterval(due, 3600_000).unref();
}
