import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { appendRow, describeCron, toRoutine } from './store.js';
import { enabledCapProblem, routineRuleProblem, scheduleRoutine } from './routines.js';
import { safeUrl } from './plugins/ui-schema.js';
import { makeView } from './views.js';
import type { CardBody } from './types.js';

/**
 * Check-in offer card: after a bot and the person looked at something together (an inbox, a page, an
 * account), the bot offers to keep an eye on it, and one tap makes a routine that reads it on a schedule and
 * posts only when something there needs the person. Idea and wording from OpenBot's check-in offer
 * (CopilotKit/OpenBot shared/check-in-offer.ts and app/src/lib/copilot/check-in-offer-tool.tsx at f681239,
 * MIT; see THIRD_PARTY_NOTICES.md).
 *
 * The card is choice buttons (choices.ts) with a `checkin` part, so every app draws it with the code it
 * already has and adds a heading. A tap only makes the check-in (a quiet routine for the bot that offered):
 * it posts no chat message and starts no turn, carries no approval id or digest, and can never approve
 * anything. The routine's prompt says it only reads; anything it would change still meets its card.
 */

export const OFFER_CHECK_IN_TOOL = 'offer_check_in';

/** What the bot passes and the card keeps: what to watch, what to look for there, and where it is. */
export type CheckInOffer = { subject: string; focus?: string; link?: string; timezone?: string };

/** The answers on the card, in order. The last one declines. */
export const CHECKIN_INTERVALS = [
  { label: 'Once a day', schedule: '0 9 * * *' },
  { label: 'Twice a day', schedule: '0 9,17 * * *' },
  { label: 'Every 4 hours', schedule: '0 8-20/4 * * *' },
] as const;
export const CHECKIN_DECLINE = 'Not now';

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);

function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** A bot's offer, checked: the offer, or why it can't be shown. */
export function checkOffer(a: any): CheckInOffer | string {
  const subject = clip(a?.subject, 80);
  if (!subject) return 'give a subject: what to keep an eye on, in a few words';
  const focus = clip(a?.focus, 300);
  const link = a?.link ? safeUrl(a.link) : null;
  if (a?.link && !link) return 'the link must be an https address';
  const tz = clip(a?.timezone, 60);
  if (tz && !validZone(tz)) return `"${tz}" is not a timezone (use one like America/Chicago)`;
  return { subject, ...(focus ? { focus } : {}), ...(link ? { link } : {}), ...(tz ? { timezone: tz } : {}) };
}

type Card = Extract<CardBody, { card: 'view' }>;

/** The card for an offer: "Keep an eye on X?" with how often, and Not now. */
export function checkinOfferCard(o: CheckInOffer): Card {
  const { card } = makeView('', [{ id: 'c', type: 'choice', question: `Keep an eye on ${o.subject.replace(/^(Your|The|My) /, (w) => w.toLowerCase())}?`, options: [...CHECKIN_INTERVALS.map((i) => i.label), CHECKIN_DECLINE] }]);
  return { ...card, quick: true, checkin: o };
}

/** The routine a check-in makes, by name: one per bot and subject. */
const routineName = (subject: string) => `Check on ${subject}`;

/** An enabled check-in this bot already has for the same subject or link. */
export function existingCheckin(botId: string, o: CheckInOffer): { id: string; name: string; schedule: string } | null {
  const rows = db.prepare("SELECT id, name, schedule, prompt FROM routines WHERE bot_id=? AND enabled=1 AND prompt LIKE '[check-in on]%'").all(botId) as any[];
  return rows.find((r) => r.name.toLowerCase() === routineName(o.subject).toLowerCase() || (o.link && String(r.prompt).includes(`\nWhere: ${o.link}\n`))) ?? null;
}

/** Why no check-in can be offered now (the person already has the most routines switched on), or null. */
export function offerProblem(userId: string): string | null { return enabledCapProblem(userId); }

/** The person's timezone as best known: the bot's offer, then their routines, then their check-in times. */
function zoneFor(userId: string, o: CheckInOffer): string {
  if (o.timezone && validZone(o.timezone)) return o.timezone;
  const r = db.prepare("SELECT r.timezone tz, COUNT(*) n FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.timezone<>'UTC' GROUP BY r.timezone ORDER BY n DESC LIMIT 1").get(userId) as any;
  if (r?.tz && validZone(r.tz)) return r.tz;
  const p = db.prepare('SELECT timezone FROM proactivity WHERE user_id=?').get(userId) as any;
  if (p?.timezone && validZone(p.timezone)) return p.timezone;
  return 'UTC';
}

function prompt(o: CheckInOffer, owner: string): string {
  return [
    `[check-in on] ${o.subject}`,
    ...(o.focus ? [`Look for: ${o.focus}`] : []),
    ...(o.link ? [`Where: ${o.link}`] : []),
    '',
    `${owner} asked you to keep an eye on this. Look at it now (with your connected apps or tools), and compare with what you remember from the last check.`,
    `Only read: never change, send, delete or buy anything during this check. If something there needs ${owner} (something new, changed, due soon or wrong), send ONE short message saying what and why it matters. If nothing does, call stay_silent.`,
  ].join('\n');
}

/**
 * The person tapped an answer on a check-in card. Makes the routine (or says the bot already has one) and
 * leaves a line in the chat where they tapped. Returns that line.
 */
export function acceptCheckinOffer(opts: { userId: string; ownerName: string; botId: string; chatId: string; offer: CheckInOffer; picked: number }): string {
  const { offer } = opts;
  const bot = db.prepare('SELECT name FROM bots WHERE id=?').get(opts.botId) as any;
  const who = bot?.name ?? 'This Bot';
  const interval = CHECKIN_INTERVALS[opts.picked];
  if (!interval) {
    const text = `No check-in on ${offer.subject}. You can ask ${who} for one any time.`;
    appendRow(opts.chatId, 'event', { type: 'event', event: 'routine-updated', text });
    return text;
  }
  const had = existingCheckin(opts.botId, offer);
  if (had) {
    const text = `${who} already checks ${offer.subject} (${describeCron(had.schedule)}).`;
    appendRow(opts.chatId, 'event', { type: 'event', event: 'routine-created', text, ref: had.id });
    return text;
  }
  const tz = zoneFor(opts.userId, offer);
  // The routine rules (routines.ts): at most 20 switched on per person, and no more often than every 15 minutes.
  const problem = routineRuleProblem({ userId: opts.userId, schedule: interval.schedule, timezone: tz });
  if (problem) {
    const text = `No check-in on ${offer.subject}: ${problem}`;
    appendRow(opts.chatId, 'event', { type: 'event', event: 'routine-updated', text });
    return text;
  }
  const id = newId('rt');
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(id, opts.botId, routineName(offer.subject), prompt(offer, opts.ownerName), interval.schedule, tz, now());
  // Posts only when something is found (routines.quiet, the default), like OpenBot's "tells you when something needs you".
  try { db.prepare('UPDATE routines SET quiet=1 WHERE id=?').run(id); } catch { /* older database without the column */ }
  scheduleRoutine(toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id)));
  const text = `Check-in on: ${offer.subject} · ${interval.label.toLowerCase()}. ${who} only reads it and tells you when something needs you.`;
  appendRow(opts.chatId, 'event', { type: 'event', event: 'routine-created', text, ref: id });
  hub.emit(opts.userId, { type: 'routines', botId: opts.botId });
  return text;
}
