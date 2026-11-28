import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Hono, type MiddlewareHandler } from 'hono';
import { db, now } from './db.js';
import { env, compatEnv } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { hub } from './lib/hub.js';
import { redact } from './lib/redact.js';
import { isOwner } from './plugins/owner.js';
import { dbHealth, snapshotNow, type DbHealth } from './db-care.js';
import { engineHealth } from './engine.js';
import { getLive, toRoutine } from './store.js';
import { isOutside } from './outside.js';
import { linkError, linkStatus } from './slack-link.js';
import { buildInfo } from './build-info.js';
import { clearSystem, notifySystem } from './notify.js';

/**
 * The server's own health, for the owner's System page (web, Windows, Android) and for the deploy tool:
 * what is running, what is not, and the last things that went wrong, in one answer.
 *
 * Nothing here changes how the server works. The log ring holds the newest warnings and errors this
 * process printed (addresses and anything key-shaped masked), so a problem can be read in the app instead
 * of over SSH.
 */

// ---------- the newest warnings and errors ----------

/** `before`: from before the server last started (read back from the file). */
export interface Problem { at: number; level: 'warn' | 'error'; text: string; count: number; before?: boolean }
const RING = 200;
const problems: Problem[] = [];
let warnTotal = 0;
let errorTotal = 0;

function line(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack?.split('\n').slice(0, 3).join(' | ') ?? a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/**
 * The list is also kept in a small file beside the database, so what went wrong just before a crash or a
 * restart can still be read afterwards (already redacted; written at most every few seconds).
 */
const problemsFile = () => path.join(path.dirname(env.dbPath), 'problems.json');
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveProblems() {
  try { fs.writeFileSync(problemsFile(), JSON.stringify(problems.slice(-RING)), { mode: 0o600 }); } catch { /* a read-only folder: the list stays in memory */ }
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveProblems(); }, 3000);
  saveTimer.unref();
}
function loadProblems() {
  try {
    const old = JSON.parse(fs.readFileSync(problemsFile(), 'utf8')) as Problem[];
    const cut = now() - 7 * 86_400_000;
    for (const p of old) if (p && typeof p.text === 'string' && typeof p.at === 'number' && p.at > cut && (p.level === 'warn' || p.level === 'error')) problems.push({ at: p.at, level: p.level, text: p.text, count: Number(p.count) || 1, before: true });
  } catch { /* none kept yet */ }
}

export function noteProblem(level: 'warn' | 'error', args: unknown[]) {
  if (level === 'warn') warnTotal++; else errorTotal++;
  const text = redact(line(args), 600);
  // The same line again within a few minutes is counted, not repeated, also when other lines came between
  // (two problems taking turns used to push everything else off the list).
  for (let i = problems.length - 1; i >= Math.max(0, problems.length - 12); i--) {
    const p = problems[i];
    if (p.before || p.text !== text || p.level !== level || now() - p.at > 5 * 60_000) continue;
    p.count++; p.at = now();
    if (i !== problems.length - 1) { problems.splice(i, 1); problems.push(p); }
    saveSoon();
    return;
  }
  problems.push({ at: now(), level, text, count: 1 });
  if (problems.length > RING) problems.splice(0, problems.length - RING);
  // An error is written at once: the next thing to happen may be the process ending.
  if (level === 'error') saveProblems(); else saveSoon();
}

let installed = false;
/** Keep what console.warn and console.error print, as well as printing it. Called once, first thing (index.ts). */
export function installProblemLog() {
  if (installed) return;
  installed = true;
  loadProblems();
  for (const level of ['warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try { noteProblem(level, args); } catch { /* the log must never break the caller */ }
      orig(...args);
    };
  }
  // A promise nobody handled or an exception nobody caught is logged in full instead of vanishing (or, for
  // an exception, killing the process without a trace of why). The server keeps running: one bad turn or
  // timer must not take every chat down with it.
  process.on('unhandledRejection', (e) => { console.error('[cleftbot] unhandled rejection', e); });
  process.on('uncaughtException', (e) => {
    console.error('[cleftbot] uncaught exception', e);
    // While starting, an exception means the server never came up properly (a port in use, a broken build):
    // stop, so the service manager and the deploy tool see it failed instead of a process that only looks alive.
    if (process.uptime() < 30) process.exit(1);
  });
}

export const recentProblems = (limit = 50) => problems.slice(-limit).reverse();

/** Empty the list (the owner has read it). The totals since start stay. */
export function clearProblems(): number {
  const n = problems.length;
  problems.length = 0;
  saveProblems();
  return n;
}

// ---------- how quickly the server gets round to things ----------

/**
 * The longest the server kept everything waiting in the last minute (one long piece of work holds up every
 * chat, since the server does one thing at a time). Measured by Node itself; the worst of each minute kept.
 */
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let stallMs = 0;
setInterval(() => { stallMs = Math.round(loop.max / 1e6); loop.reset(); }, 60_000).unref();

/** Other database files in the live one's folder: harmless until a setting points the server at one of them. */
export function strayDatabases(): string[] {
  const dir = path.dirname(env.dbPath);
  const live = path.basename(env.dbPath);
  try { return fs.readdirSync(dir).filter((n) => /\.db$/i.test(n) && n !== live).sort(); } catch { return []; }
}

// ---------- requests ----------

const meter = { total: 0, errors: 0, slow: 0, lastErrorAt: 0 as number, slowest: [] as { path: string; ms: number; at: number }[] };
const STREAMS = /^\/api\/(events|notify\/stream)$|^\/mcp|\/voice\/|\/attachments$|\/avatar\/generate/;

/** Counts requests, server errors and slow answers (streams and long jobs aside). */
export const requestMeter: MiddlewareHandler = async (c, next) => {
  const t0 = Date.now();
  try { await next(); } finally {
    meter.total++;
    if (c.res.status >= 500) { meter.errors++; meter.lastErrorAt = Date.now(); }
    const ms = Date.now() - t0;
    const p = c.req.path;
    if (ms > 3000 && !STREAMS.test(p)) {
      meter.slow++;
      if (ms > 10_000) console.warn(`[http] slow answer: ${c.req.method} ${p.replace(/\/(bot|usr|apr|rtn|tsk|mem|skl|mch|con|plg|pg|vw)_[A-Za-z0-9_-]+/g, '/:id')} took ${Math.round(ms / 1000)} s`);
      // Ids are left out, so the list groups by what was asked for, not for whom.
      meter.slowest.push({ path: `${c.req.method} ${p.replace(/\/(bot|usr|apr|rtn|tsk|mem|skl|mch|con|plg|pg|vw)_[A-Za-z0-9_-]+/g, '/:id')}`, ms, at: Date.now() });
      if (meter.slowest.length > 20) meter.slowest.shift();
    }
  }
};

// ---------- the answer ----------

export type CheckState = 'ok' | 'warn' | 'bad';
export interface StatusCheck { id: string; label: string; state: CheckState; detail: string }
export interface BotStatus { id: string; name: string; engine: string | null; state: string; error: string | null; busy: boolean; awaiting: boolean; model: string | null; provider: string | null }
export interface ServerStatus {
  at: number;
  server: { version: string; commit: string | null; startedAt: number; uptimeSec: number; node: string; host: string; memoryMb: number; load: number; cpus: number };
  db: DbHealth;
  disk: { freeBytes: number; totalBytes: number } | null;
  bots: BotStatus[];
  scheduler: { on: boolean; routines: number; nextRunAt: number | null; nextName: string | null };
  apps: { listening: number };
  /** Sign-ins that still work: people's devices, and helper programs'. */
  sessions: { people: number; scripts: number };
  /** The longest stall in the last minute, in ms. */
  stallMs: number;
  backup: { tag: string; at: number | null; ok: boolean } | null;
  /** The last update or rollback made with cleft-ops: when, by whom, how it ended, and the commit it left running. */
  deploy: { at: number | null; by: string; action: 'deploy' | 'rollback'; result: string; to: string } | null;
  requests: { total: number; errors: number; slow: number; lastErrorAt: number | null; slowest: { path: string; ms: number; at: number }[] };
  problems: Problem[];
  problemTotals: { warn: number; error: number };
  checks: StatusCheck[];
}

const startedAt = Date.now();
const DAY = 86_400_000;

/** The newest finished update in the maintainer's audit log (cleft-ops), when this server can read it. */
function lastDeploy(): ServerStatus['deploy'] {
  const file = process.env.CLEFT_AUDIT_LOG ?? '/var/log/cleft-maintainer.log';
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, 16_384));
    try { fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length)); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.trim().split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((f) => f.length >= 5 && (f[2] === 'deploy' || f[2] === 'rollback'));
  const f = lines.pop();
  if (!f) return null;
  const at = Date.parse(f[0]);
  return { at: Number.isFinite(at) ? at : null, by: f[1].slice(0, 80), action: f[2] as 'deploy' | 'rollback', result: f[3].slice(0, 120), to: (f[4].split('->').pop() ?? '').trim().slice(0, 7) };
}

/** The last line of the off-site backup's history ("<tag> <time> ok"), when this server can read it. */
function lastBackup(): ServerStatus['backup'] {
  const file = process.env.BACKUP_HISTORY_FILE ?? '/etc/cleft-bot/backup/history.log';
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const last = text.trim().split('\n').pop()?.trim();
  if (!last) return null;
  const [tag, when, result] = last.split(/\s+/);
  const at = Date.parse(when ?? '');
  return { tag: tag ?? '', at: Number.isFinite(at) ? at : null, ok: result === 'ok' };
}

function disk(): ServerStatus['disk'] {
  try {
    const s = fs.statfsSync(path.dirname(env.dbPath));
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

const mb = (n: number) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0)} MB`);
const gb = (n: number) => `${(n / 1_073_741_824).toFixed(1)} GB`;
const ago = (t: number) => {
  const m = Math.max(0, Math.round((now() - t) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const until = (t: number) => {
  const m = Math.max(0, Math.round((t - now()) / 60_000));
  return m < 1 ? 'in under a minute' : m < 60 ? `in ${m} min` : m < 48 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`;
};

export async function collectStatus(userId: string): Promise<ServerStatus> {
  const build = buildInfo();
  const rows = db.prepare("SELECT id, name, model, provider FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND side_of IS NULL AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at").all(userId) as { id: string; name: string; model: string | null; provider: string | null }[];
  const bots: BotStatus[] = await Promise.all(rows.map(async (b) => {
    if (isOutside(b.id)) return { id: b.id, name: b.name, engine: 'outside', state: 'outside', error: null, busy: false, awaiting: false, model: null, provider: null };
    const h = await engineHealth(b.id).catch((e) => ({ kind: null, state: 'error' as const, error: String(e?.message ?? e), version: null }));
    const live = getLive(b.id);
    return { id: b.id, name: b.name, engine: h.kind, state: h.state, error: h.error ? redact(h.error, 300) : null, busy: live.isRunning, awaiting: !!live.awaiting, model: b.model, provider: b.provider };
  }));

  const schedulerOn = compatEnv('NO_SCHEDULER') !== '1';
  const routines = (db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.enabled=1').all(userId) as any[]).map(toRoutine);
  const next = routines.filter((r) => r.nextRunAt).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];

  const d = dbHealth();
  const dk = disk();
  const backup = lastBackup();
  const mem = process.memoryUsage().rss;

  const checks: StatusCheck[] = [];
  checks.push({ id: 'server', label: 'Server', state: 'ok', detail: `${build.version !== '0' ? `Version ${build.version}${build.commit ? ` (${build.commit})` : ''}` : build.commit ? `Build ${build.commit}` : 'Running'}, up ${ago(startedAt).replace(' ago', '')}` });
  checks.push({
    id: 'db', label: 'Database',
    state: d.integrity && d.integrity !== 'ok' ? 'bad' : 'ok',
    detail: d.integrity && d.integrity !== 'ok' ? `Problem found: ${d.integrity}` : `Sound, ${mb(d.bytes)}`,
  });
  // Shown only when there is something to say: a log that is not being folded back in, or other database
  // files lying beside the live one (the mix-up of 23 November started with one of those).
  if (d.walBytes > 256 * 1_048_576) checks.push({ id: 'wal', label: 'Database log', state: 'warn', detail: `The write-ahead log has grown to ${mb(d.walBytes)}. It is folded back in once a day; if it stays this large, restart the server at a quiet moment` });
  const stray = strayDatabases();
  if (stray.length) checks.push({ id: 'stray-db', label: 'Other database files', state: 'warn', detail: `${stray.length === 1 ? 'There is another database file' : `There are ${stray.length} other database files`} beside the live one (${stray.slice(0, 4).map((n) => n || '(no name)').join(', ')}${stray.length > 4 ? ', …' : ''}). The server uses ${path.basename(env.dbPath)}${process.env.DB_PATH ? '' : ', but DB_PATH is not set, so pin it'}. Move the others away so nothing opens them by mistake` });
  const newest = d.snapshots[0];
  checks.push({
    id: 'snapshots', label: 'Daily snapshots',
    state: !d.snapshotsKeep ? 'warn' : d.lastSnapshotError ? 'bad' : !newest ? (now() - startedAt > 10 * 60_000 ? 'warn' : 'ok') : now() - newest.at > 2 * DAY ? 'warn' : 'ok',
    detail: !d.snapshotsKeep ? 'Switched off (DB_SNAPSHOTS_KEEP=0)' : d.lastSnapshotError ? `The last one failed: ${d.lastSnapshotError}` : newest ? `${d.snapshots.length} kept, newest ${ago(newest.at)}` : 'The first one is made a few minutes after start',
  });
  if (backup) checks.push({ id: 'backup', label: 'Off-site backup', state: !backup.ok || (backup.at && now() - backup.at > 16 * DAY) ? 'bad' : backup.at && now() - backup.at > 9 * DAY ? 'warn' : 'ok', detail: `${backup.ok ? 'Last run worked' : 'Last run failed'}${backup.at ? `, ${ago(backup.at)}` : ''}${backup.ok && backup.at && now() - backup.at > 9 * DAY ? '. It runs weekly, so one has been missed' : ''}` });
  if (dk) {
    const pct = dk.totalBytes ? dk.freeBytes / dk.totalBytes : 1;
    checks.push({ id: 'disk', label: 'Disk space', state: dk.freeBytes < 2 * 1_073_741_824 || pct < 0.03 ? 'bad' : dk.freeBytes < 10 * 1_073_741_824 || pct < 0.1 ? 'warn' : 'ok', detail: `${gb(dk.freeBytes)} free of ${gb(dk.totalBytes)}` });
  }
  for (const b of bots) {
    if (b.state === 'outside') {
      // A member reached over a link (Sheldon, in Slack): the link is the thing that can be down.
      const link = linkStatus(b.id);
      const fresh = now() - startedAt < 3 * 60_000;
      checks.push({
        id: `link:${b.id}`, label: `${b.name}'s link`,
        state: link === 'ready' || link === 'paused' ? 'ok' : link === 'offline' && !fresh ? 'bad' : 'warn',
        detail: link === 'ready' ? 'Connected' : link === 'paused' ? 'Paused by you' : link === 'not-set-up' ? 'Not set up on this server' : fresh ? 'Connecting' : `Not connected${linkError() ? `: ${redact(String(linkError()), 200)}` : ''}`,
      });
      continue;
    }
    checks.push({
      id: `bot:${b.id}`, label: `${b.name}'s agent`,
      state: b.state === 'error' ? 'bad' : b.state === 'starting' ? 'warn' : 'ok',
      detail: b.state === 'error' ? b.error ?? 'Not answering' : b.state === 'starting' ? 'Starting' : b.state === 'stopped' ? 'Asleep; starts with the next message' : b.awaiting ? 'Waiting for you' : b.busy ? 'Working' : 'Ready',
    });
  }
  checks.push({ id: 'scheduler', label: 'Routines', state: schedulerOn ? 'ok' : 'warn', detail: !schedulerOn ? 'The scheduler is switched off on this server' : next ? `${routines.length} on, next: ${next.name} ${until(next.nextRunAt!)}` : routines.length ? `${routines.length} on` : 'None scheduled' });
  const recentErrors = problems.filter((p) => p.level === 'error' && now() - p.at < 3600_000).reduce((n, p) => n + p.count, 0);
  const latestError = [...problems].reverse().find((p) => p.level === 'error' && now() - p.at < 3600_000);
  checks.push({ id: 'errors', label: 'Errors in the last hour', state: recentErrors > 20 ? 'bad' : recentErrors > 0 ? 'warn' : 'ok', detail: recentErrors ? `${recentErrors} logged. The latest: ${latestError ? latestError.text.split(' | ')[0].slice(0, 140) : 'see below'}` : 'None' });
  // One long piece of work holds everything else up; a server short of memory is about to be slow or stopped.
  const memMb = Math.round(mem / 1_048_576);
  const totalMb = Math.round(os.totalmem() / 1_048_576);
  const memHigh = memMb > 2048 || (totalMb > 0 && memMb / totalMb > 0.5);
  if (stallMs > 1500 || memHigh) checks.push({ id: 'load', label: 'Server load', state: 'warn', detail: [stallMs > 1500 ? `Everything waited ${(stallMs / 1000).toFixed(1)} s on one piece of work in the last minute` : '', memHigh ? `The server is using ${memMb} MB of memory` : ''].filter(Boolean).join('. ') });
  const sess = db.prepare('SELECT SUM(CASE WHEN agent IS NULL THEN 1 ELSE 0 END) people, SUM(CASE WHEN agent IS NOT NULL THEN 1 ELSE 0 END) scripts FROM auth_sessions WHERE user_id=? AND expires_at>?').get(userId, now()) as { people: number | null; scripts: number | null };

  return {
    at: now(),
    server: { version: build.version, commit: build.commit, startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version, host: os.hostname(), memoryMb: Math.round(mem / 1_048_576), load: Math.round(os.loadavg()[0] * 100) / 100, cpus: os.cpus().length },
    db: d, disk: dk, bots,
    scheduler: { on: schedulerOn, routines: routines.length, nextRunAt: next?.nextRunAt ?? null, nextName: next?.name ?? null },
    apps: { listening: hub.listenerCount() },
    sessions: { people: sess.people ?? 0, scripts: sess.scripts ?? 0 }, stallMs,
    backup, deploy: lastDeploy(),
    requests: { total: meter.total, errors: meter.errors, slow: meter.slow, lastErrorAt: meter.lastErrorAt || null, slowest: [...meter.slowest].reverse() },
    problems: recentProblems(60),
    problemTotals: { warn: warnTotal, error: errorTotal },
    checks,
  };
}

/** Whether the database answers, for the health check a deploy waits on. */
export function dbAnswers(): boolean {
  try { return (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1; } catch { return false; }
}

// ---------- telling the owner ----------

/**
 * Watches the checks and tells the owner when one turns bad: a notification on every app, once a day per
 * problem, taken down when the problem is over. A check must be bad on two looks in a row (five minutes
 * apart), so an agent that is restarting or a blip says nothing. Shown as coming from the owner's main bot.
 */
const badRuns = new Map<string, number>();
const told = new Set<string>();
export async function healthWatchOnce(): Promise<string[]> {
  const owner = env.ownerEmail ? (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(env.ownerEmail) as { id: string } | undefined) : undefined;
  if (!owner) return [];
  const main = db.prepare("SELECT id FROM bots WHERE user_id=? AND side_of IS NULL ORDER BY is_primary DESC, created_at LIMIT 1").get(owner.id) as { id: string } | undefined;
  if (!main) return [];
  const st = await collectStatus(owner.id);
  const sent: string[] = [];
  for (const c of st.checks) {
    const tag = `sys:${c.id}`;
    if (c.state === 'bad') {
      const n = (badRuns.get(c.id) ?? 0) + 1;
      badRuns.set(c.id, n);
      if (n < 2) continue;
      told.add(c.id);
      notifySystem(owner.id, main.id, `${tag}:${Math.floor(now() / DAY)}`, tag, `Server: ${c.label} needs attention`, `${c.detail}. Open Settings, System for the details.`);
      sent.push(c.id);
    } else {
      badRuns.delete(c.id);
      if (told.delete(c.id)) clearSystem(owner.id, tag);
    }
  }
  return sent;
}

export function startHealthWatch() {
  const look = () => { healthWatchOnce().catch((e) => console.warn('[status] health watch failed', e)); };
  // STATUS_WATCH_MS shortens the wait for tests.
  const every = Math.max(200, Number(process.env.STATUS_WATCH_MS) || 5 * 60_000);
  setTimeout(look, Math.min(4 * 60_000, every)).unref();
  setInterval(look, every).unref();
}

export const statusApi = new Hono<AuthVars>();
statusApi.use('/status', requireUser);
statusApi.use('/status/*', requireUser);

// The owner's System page. Other accounts on the server have no business reading its log.
statusApi.get('/status', async (c) => {
  const user = c.get('user');
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can see its status.' }, 403);
  return c.json(await collectStatus(user.id));
});

// "Snapshot now": a checked copy of the database into data/snapshots, as the daily one makes.
const lastManual = { at: 0 };
statusApi.post('/status/snapshot', async (c) => {
  const user = c.get('user');
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can do this.' }, 403);
  if (Date.now() - lastManual.at < 30_000) return c.json({ error: 'A snapshot was made a moment ago. Try again in half a minute.' }, 429);
  lastManual.at = Date.now();
  const made = await snapshotNow('manual');
  if (!made) return c.json({ error: dbHealth().lastSnapshotError ?? 'Snapshots are switched off on this server.' }, 500);
  return c.json({ ok: true, snapshot: made, db: dbHealth() });
});

// "Clear the list" on the System page, once its lines have been read. Only a person: a script must not tidy
// away what went wrong.
statusApi.post('/status/problems/clear', (c) => {
  const user = c.get('user');
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can do this.' }, 403);
  if (c.get('agent')) return c.json({ error: 'Only a person can clear the list.' }, 403);
  const n = clearProblems();
  console.log(`[status] account ${user.id} cleared ${n} line(s) from the problem list`);
  return c.json({ ok: true, cleared: n });
});
