import { db } from './db.js';

/**
 * Event routines used to be Composio triggers. This fork has no hosted trigger service: a bot that
 * should react to new email or new filings runs a scheduled routine that checks for them (e.g.
 * every 15 minutes) through its local apps.
 *
 * Routines saved by an older version with schedule `event:<TRIGGER_SLUG>` are kept so nothing is
 * lost, but they no longer fire; the startup log says how many there are.
 */

export const isEventSchedule = (schedule: string) => schedule.startsWith('event:');

export async function initTriggers(_enqueue: (botId: string, t: any) => void) {
  const count = (db.prepare("SELECT COUNT(*) n FROM routines WHERE schedule LIKE 'event:%'").get() as any).n;
  if (count > 0) console.warn(`[triggers] ${count} event routine(s) from Composio no longer fire; replace them with scheduled routines`);
}

/** Event routines have nothing to switch on or off any more. */
export async function setEventRoutineEnabled(_routineId: string, _enabled: boolean) {}

/** Nothing outside this machine to clean up when an event routine is deleted. */
export async function deleteEventTrigger(_routineId: string) {}

export function describeEvent(schedule: string) {
  const slug = schedule.slice(6);
  const words = slug.split('_');
  const app = words.shift() ?? '';
  return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()} (inactive)`;
}
