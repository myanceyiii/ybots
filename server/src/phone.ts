import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { appendRow, getBotRow } from './store.js';
import { isSilo } from './silo.js';
import { isOutside } from './outside.js';

/**
 * Timers and alarms on the phone (Alex, 2026-11-26: "Can I give it the ability to control my phone by
 * setting timers and alarms, etc?").
 *
 * Phone actions (`phone_action`): a bot asks the YBots Android app to set a timer or alarm in the phone's
 * own Clock app. The command goes down the phone's always-on notification link (GET /api/notify/stream,
 * only to apps that say `caps=phone1`), the app fires Android's standard AlarmClock intent
 * (ACTION_SET_TIMER / ACTION_SET_ALARM with EXTRA_SKIP_UI, ...) and reports back here
 * (POST /api/phone/actions/:id/result). When Android does not let the app open the Clock app from the
 * background, the app shows a notification instead and the person taps it to set it ("needs_tap").
 * Timers and alarms are low-risk: they run with no card, and the chat gets a line saying what was set.
 * Only bots the owner switched on (bots.phone_actions; Leonard by default) see the tool.
 *
 * The web and Windows stand-in for a phone timer is a one-time app reminder (create_routine once: true,
 * reminders.ts), which notifies every app at its time.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS phone_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  action TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// ---------- which bots ----------

/** Whether this bot may set timers and alarms on the phone: bots.phone_actions 1 = on, 0 = off, NULL = on for Leonard only. */
export function phoneActionsOn(botId: string | null): boolean {
  if (!botId) return false;
  const r = db.prepare('SELECT name, phone_actions, side_of FROM bots WHERE id=?').get(botId) as { name: string; phone_actions: number | null; side_of: string | null } | undefined;
  if (!r) return false;
  if (r.side_of) return phoneActionsOn(r.side_of);
  if (isSilo(botId) || isOutside(botId)) return false;
  if (r.phone_actions === 1) return true;
  if (r.phone_actions === 0) return false;
  return r.name.trim().toLowerCase() === 'leonard';
}

/** The phone a bot's commands go to: the YBots app. */
export function profileFor(_userId: string, _botId: string): 'main' {
  return 'main';
}

// ---------- phones that are connected right now ----------

type Sink = { profile: string; send: (data: string) => void };
const links = new Map<string, Set<Sink>>();

/** A phone app that can run actions opened its link (routes.ts /notify/stream with caps=phone1). Returns the goodbye. */
export function addPhoneLink(userId: string, profile: string, send: (data: string) => void): () => void {
  const s: Sink = { profile, send };
  let set = links.get(userId);
  if (!set) links.set(userId, (set = new Set()));
  set.add(s);
  return () => { set!.delete(s); if (!set!.size) links.delete(userId); };
}

const phonesFor = (userId: string, profile: string) => [...(links.get(userId) ?? [])].filter((s) => s.profile === profile);

// ---------- phone actions ----------

export const PHONE_ACTIONS = ['set_timer', 'set_alarm', 'cancel_alarm', 'show_alarms', 'show_timers'] as const;
export type PhoneActionName = (typeof PHONE_ACTIONS)[number];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface PhoneCommand {
  action: PhoneActionName;
  seconds?: number;
  hour?: number;
  minute?: number;
  /** 1 = Sunday ... 7 = Saturday (java.util.Calendar), for a repeating alarm. */
  days?: number[];
  label?: string;
  vibrate?: boolean;
}

/** The arguments a bot sent, checked and made into what the phone runs, or a message saying what is wrong. */
export function cleanCommand(a: any): PhoneCommand | string {
  const action = String(a?.action ?? '') as PhoneActionName;
  if (!PHONE_ACTIONS.includes(action)) return `action must be one of: ${PHONE_ACTIONS.join(', ')}.`;
  const label = typeof a?.label === 'string' ? a.label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (action === 'set_timer') {
    const secs = Math.round(Number(a?.seconds ?? 0) + Number(a?.minutes ?? 0) * 60 + Number(a?.hours ?? 0) * 3600);
    // AlarmClock.EXTRA_LENGTH: 1 to 86400 seconds.
    if (!Number.isFinite(secs) || secs < 1 || secs > 86400) return 'A timer needs a length from 1 second to 24 hours (seconds, minutes or hours).';
    return { action, seconds: secs, ...(label ? { label } : {}) };
  }
  if (action === 'set_alarm') {
    const hour = Number(a?.hour), minute = Number(a?.minute ?? 0);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return 'An alarm needs hour (0-23, 24-hour clock) and minute (0-59) in the phone\'s own time.';
    let days: number[] | undefined;
    if (Array.isArray(a?.days) && a.days.length) {
      days = [];
      for (const d of a.days) {
        const i = DAYS.indexOf(String(d).trim().toLowerCase().slice(0, 3));
        if (i < 0) return 'days are names like "mon", "tue" ... "sun".';
        if (!days.includes(i + 1)) days.push(i + 1);
      }
      days.sort();
    }
    return { action, hour, minute, ...(days ? { days } : {}), label: label || 'YBots', ...(a?.vibrate === false ? { vibrate: false } : {}) };
  }
  if (action === 'cancel_alarm') return { action, ...(label ? { label } : {}) };
  return { action };
}

const two = (n: number) => String(n).padStart(2, '0');
export function lengthText(secs: number): string {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  const parts = [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean);
  return parts.join(' ') || '0 s';
}
export function clockText(hour: number, minute: number): string {
  return `${hour % 12 || 12}:${two(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}
/** "a 10 min timer (pasta)" / "an alarm for 6:30 AM on Mon, Wed" — what the chat line and the bot say. */
export function describe(c: PhoneCommand): string {
  const tag = c.label && c.label !== 'YBots' ? ` (${c.label})` : '';
  switch (c.action) {
    case 'set_timer': return `a ${lengthText(c.seconds!)} timer${tag}`;
    case 'set_alarm': return `an alarm for ${clockText(c.hour!, c.minute!)}${c.days?.length ? ` on ${c.days.map((d) => DAYS[d - 1][0].toUpperCase() + DAYS[d - 1].slice(1)).join(', ')}` : ''}${tag}`;
    case 'cancel_alarm': return c.label ? `turning off the "${c.label}" alarm` : 'the alarm list to turn one off';
    case 'show_alarms': return 'your alarms';
    case 'show_timers': return 'your timers';
  }
}

type Result = { state: 'done' | 'needs_tap' | 'failed'; detail?: string };
const waiting = new Map<string, (r: Result) => void>();
/** How long a bot waits for the phone to say it ran the command. */
export const ANSWER_MS = 20_000;

/** The phone's answer (POST /api/phone/actions/:id/result). False when there is no such action of this person's. */
export function phoneResult(userId: string, id: string, body: any): boolean {
  const state = ['done', 'needs_tap', 'failed'].includes(body?.state) ? body.state as Result['state'] : null;
  if (!state) return false;
  const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 300) : undefined;
  const r = db.prepare("UPDATE phone_actions SET state=?, detail=?, updated_at=? WHERE id=? AND user_id=? AND state IN ('sent','needs_tap','late')").run(state, detail ?? null, now(), id, userId);
  if (!r.changes) return false;
  waiting.get(id)?.({ state, detail });
  return true;
}

/** Run one phone command for a bot: send it to the phone, wait for its answer, put a line in the chat. */
export async function runPhoneAction(ctx: { userId: string; botId: string; chatId?: string }, args: any, wait = ANSWER_MS): Promise<{ output: string; summary: string }> {
  if (!phoneActionsOn(ctx.botId)) return { output: 'Phone actions are off for you. The person can turn them on in your settings (Phone timers and alarms).', summary: 'failed' };
  const cmd = cleanCommand(args);
  if (typeof cmd === 'string') return { output: cmd, summary: 'failed' };
  const profile = profileFor(ctx.userId, ctx.botId);
  const chat = ctx.chatId ?? ctx.botId;
  const what = describe(cmd);
  const phones = phonesFor(ctx.userId, profile);
  if (!phones.length) {
    return {
      output: `The phone is not connected right now, so nothing was set. The YBots app on the phone needs its background link on (Settings > Background and notifications) and an update that can take timers and alarms. ` +
        (cmd.action === 'set_timer' || cmd.action === 'set_alarm' ? 'Offer a one-time app reminder instead (create_routine once: true): it notifies every app.' : ''),
      summary: 'failed',
    };
  }
  const id = newId('pha');
  const t = now();
  db.prepare('INSERT INTO phone_actions(id,user_id,bot_id,chat_id,profile,action,args,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, ctx.userId, ctx.botId, chat, profile, cmd.action, JSON.stringify(cmd), 'sent', t, t);
  const bot = getBotRow(getBotRow(ctx.botId)?.side_of ?? ctx.botId);
  const answer = new Promise<Result | null>((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, wait);
    waiting.set(id, (r) => { clearTimeout(timer); waiting.delete(id); resolve(r); });
  });
  const data = JSON.stringify({ type: 'phone-action', a: { id, ...cmd, title: describe(cmd), by: bot?.name ?? 'A bot' } });
  for (const p of phones) { try { p.send(data); } catch { /* that link just dropped */ } }
  const r = await answer;
  if (!r) {
    db.prepare("UPDATE phone_actions SET state='late', updated_at=? WHERE id=? AND state='sent'").run(now(), id);
    appendRow(chat, 'notice', { type: 'notice', text: `📱 Sent ${what} to your phone, but it has not answered yet.`, tone: 'warn' });
    return { output: `Sent to the phone but it did not answer within ${Math.round(wait / 1000)} s (it may be asleep or offline). It may still run when the phone wakes. Tell the person plainly; do not send it again unless they ask.`, summary: 'failed' };
  }
  const setting = cmd.action === 'set_timer' || cmd.action === 'set_alarm';
  if (r.state === 'done') {
    appendRow(chat, 'notice', { type: 'notice', text: setting ? `⏰ Set ${what} on your phone.` : `📱 Opened ${what} on your phone.`, tone: 'info' });
    const undo = cmd.action === 'set_alarm' ? ' To undo, call phone_action cancel_alarm with the same label.' : cmd.action === 'set_timer' ? ' To stop it early, call phone_action show_timers (it opens the Clock app\'s timers, where the person cancels it).' : '';
    return { output: `Done: the phone's Clock app ${setting ? 'set' : 'opened'} ${what}.${undo}`, summary: 'done' };
  }
  if (r.state === 'needs_tap') {
    appendRow(chat, 'notice', { type: 'notice', text: `📱 Your phone needs a tap: open the "${bot?.name ?? 'Bot'}: ${what}" notification to finish.`, tone: 'warn' });
    return { output: `Android would not let the app open the Clock app from the background, so the phone shows a notification; ${what} is set when the person taps it. Say so in one line. (They can let it happen without a tap: Settings > Phone timers and alarms > Allow without a tap.)`, summary: 'needs tap' };
  }
  appendRow(chat, 'notice', { type: 'notice', text: `📱 Could not set ${what} on your phone${r.detail ? `: ${r.detail}` : '.'}`, tone: 'error' });
  return { output: `The phone could not do it${r.detail ? `: ${r.detail}` : ''}. Tell the person; offer a one-time app reminder (create_routine once: true) instead.`, summary: 'failed' };
}
