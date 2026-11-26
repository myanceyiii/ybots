import { Cron } from 'croner';
import { db, now } from './db.js';
import { appendRow } from './store.js';
import type { Routine } from './types.js';
import { isEventSchedule, setEventRoutineEnabled } from './triggers.js';

const jobs = new Map<string, Cron>();
let enqueueFn: ((botId: string, t: any) => void) | null = null;

// When the routine was last switched on, made or changed (scheduleRoutine): a run is only "missed" after that.
try { db.exec('ALTER TABLE routines ADD COLUMN armed_at INTEGER'); } catch { /* already there */ }
// A one-time reminder (create_routine once: true) switches itself off after it runs.
try { db.exec('ALTER TABLE routines ADD COLUMN run_once INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }

const CATCH_UP_WITHIN = 6 * 3600_000;
const REMINDER_WITHIN = 7 * 86_400_000;

/**
 * A run that fell due while the server was not running (a restart for an update at 7:59:58 used to swallow
 * the 8:00 brief): the newest time the schedule named, when nothing has run since and the routine was
 * already switched on then. Not for schedules that come round again within half an hour (the next run is
 * close anyway), and not for runs more than six hours late (a one-time reminder: a week), which would
 * arrive out of context.
 */
export function missedRun(r: { schedule: string; timezone?: string | null; last_run_at?: number | null; created_at: number; armed_at?: number | null; run_once?: number | null }, t = now()): number | null {
  if (isEventSchedule(r.schedule)) return null;
  try {
    const probe = new Cron(r.schedule, { timezone: r.timezone || 'UTC', paused: true });
    const prev = probe.previousRuns(1, new Date(t))[0]?.getTime();
    const next = probe.nextRun(new Date(t))?.getTime();
    probe.stop();
    if (!prev) return null;
    if (next && next - prev < 30 * 60_000) return null;
    if (t - prev > (r.run_once ? REMINDER_WITHIN : CATCH_UP_WITHIN)) return null;
    return prev > Math.max(r.last_run_at ?? 0, r.created_at, r.armed_at ?? 0) ? prev : null;
  } catch { return null; }
}

export function initRoutines(enqueue: (botId: string, t: any) => void) {
  enqueueFn = enqueue;
  const all = db.prepare("SELECT * FROM routines WHERE enabled=1 AND schedule NOT LIKE 'event:%'").all() as any[];
  for (const r of all) arm({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone } as Routine);
  console.log(`[routines] scheduled ${jobs.size}`);
  // Runs that fell due while the server was down, a little after start and one at a time.
  const missed = all.map((r) => ({ r, at: missedRun(r) })).filter((m) => m.at !== null);
  const wait = Math.max(0, Number(process.env.ROUTINE_CATCHUP_DELAY_MS ?? 20_000) || 0);
  missed.forEach((m, i) => setTimeout(() => {
    // Still due? It may have been run by hand, switched off or deleted in the meantime.
    const cur = db.prepare('SELECT * FROM routines WHERE id=? AND enabled=1').get(m.r.id) as any;
    if (!cur || missedRun(cur) === null) return;
    const when = new Date(m.at!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: cur.timezone || 'UTC' });
    console.log(`[routines] catching up ${cur.id} (${cur.name}), due ${new Date(m.at!).toISOString()}`);
    runRoutine(cur.id, `was due at ${when} while the server was restarting`);
  }, wait + i * 5000).unref());
}

/** Switch a routine on (made, changed or enabled): from now on its schedule counts. */
export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  try { db.prepare('UPDATE routines SET armed_at=? WHERE id=?').run(now(), r.id); } catch { /* a routine not stored yet */ }
  arm(r);
}

function arm(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  if (isEventSchedule(r.schedule)) { void setEventRoutineEnabled(r.id, true); return; }
  unscheduleRoutine(r.id);
  try {
    const job = new Cron(r.schedule, { timezone: r.timezone || 'UTC', protect: true }, () => runRoutine(r.id));
    jobs.set(r.id, job);
  } catch (e) {
    console.warn('[routines] bad schedule', r.id, r.schedule, (e as Error).message);
  }
}

export function unscheduleRoutine(id: string) {
  const row = db.prepare('SELECT schedule FROM routines WHERE id=?').get(id) as any;
  if (row && isEventSchedule(row.schedule)) void setEventRoutineEnabled(id, false);
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/**
 * A routine whose prompt is filled in at the moment it runs (the morning brief carries that
 * morning's reminders and lists). Returns the prompt to send, or null to send the stored one.
 */
let promptAtRun: ((row: any) => string | null) | null = null;
export function setRoutinePromptAtRun(fn: (row: any) => string | null) { promptAtRun = fn; }

export function runRoutine(id: string, why?: string) {
  const r = db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;
  if (!r || !enqueueFn) return;
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), id);
  // A one-time reminder runs once: it is switched off here and stays listed as done.
  if (r.run_once) { db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(id); jobs.get(id)?.stop(); jobs.delete(id); }
  const run = appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: String(r.prompt ?? '').startsWith('[reminder]') ? `Reminder: ${r.name}` : String(r.prompt ?? '').startsWith('[brief]') ? r.name : why ? `Running routine: ${r.name} (${why})` : `Running routine: ${r.name}`, ref: id });
  let prompt = r.prompt;
  try { prompt = promptAtRun?.(r) ?? r.prompt; } catch { /* the stored prompt still works */ }
  enqueueFn(r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt, quiet: r.quiet === undefined ? true : !!r.quiet, runSeq: run.seq });
}
