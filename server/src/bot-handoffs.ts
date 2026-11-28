import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { appendRow, chatOwner, emitBot, getBotRow } from './store.js';
import { isSilo } from './silo.js';
import { isOutside } from './outside.js';
import type { Trigger } from './agent/loop.js';

/**
 * Typed, durable handoffs between bots ("hops"), after OpenBot's "One Bot handing work to another"
 * (CopilotKit/OpenBot docs/architecture.md at f681239, MIT; the design only, its server is not published).
 *
 *  - The asking bot names the task, what bounds it and what a good answer looks like, not a paragraph.
 *  - The server decides who is addressed (a bot on the same team), where the answer lands (the chat the
 *    ask was made in), who is asking (stamped from the turn) and how deep the chain is (the turn's depth).
 *  - The answering bot answers in its own reply. That reply is written word for word into the asking chat
 *    under the answering bot's name and face: no second model call, the asker never re-says it.
 *  - A hop is a row in `bot_hops`, so a restart loses nothing: queued and running hops are started again.
 *  - A hop that fails for good is said out loud: the asking bot is sent back to say nothing came back.
 *  - An answer is information. It never answers or expires an approval card (it starts no 'user' turn).
 *
 * Walled-off (siloed) bots and outside members (Sheldon over Slack) never use hops: their messages go
 * through the old typed, checked path, so nothing a walled bot says is copied anywhere word for word.
 */

/** The same ping-pong limit send_to_bot always had: refused, not truncated. */
export const HOP_MAX_DEPTH = 3;
/** Most hops one bot may have open at once (a fan-out is a whole model turn per bot). */
export const HOP_MAX_OPEN = 4;
/** Runs of the answering bot before a hop fails for good. */
export const HOP_MAX_ATTEMPTS = 3;
/** A hop whose answering bot is waiting on its owner fails after this long. */
export const HOP_WAIT_MS = 24 * 60 * 60 * 1000;
/** A queued or running hop nobody picked up for this long is started again by the sweep. */
const HOP_STUCK_MS = 30 * 60 * 1000;

export type HopStatus = 'queued' | 'running' | 'waiting' | 'answered' | 'failed';
export interface Hop {
  id: string; user_id: string; from_bot: string; to_bot: string; ask_chat: string; depth: number;
  task: string; bounds: string | null; good_answer: string | null; context: string | null;
  kind: 'ask' | 'mention'; status: HopStatus; attempts: number; why: string | null; answer: string | null;
  seen: number; created_at: number; updated_at: number;
}

db.exec(`
CREATE TABLE IF NOT EXISTS bot_hops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_bot TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  to_bot TEXT NOT NULL,
  ask_chat TEXT NOT NULL,
  depth INTEGER NOT NULL,
  task TEXT NOT NULL,
  bounds TEXT,
  good_answer TEXT,
  context TEXT,
  kind TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  why TEXT,
  answer TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_hops_open ON bot_hops(status, updated_at);
CREATE INDEX IF NOT EXISTS bot_hops_to ON bot_hops(to_bot, status);
`);

type Enqueue = (chatId: string, t: Trigger) => void;
let enqueueFn: Enqueue | null = null;
/** loop.ts hands its queue in at start (this file is imported by loop.ts, so it cannot import it back). */
export function setHopQueue(fn: Enqueue) { enqueueFn = fn; }
const run = (chatId: string, t: Trigger) => {
  if (!enqueueFn) throw new Error('hop queue not ready');
  enqueueFn(chatId, t);
};

const get = (id: string) => db.prepare('SELECT * FROM bot_hops WHERE id=?').get(id) as Hop | undefined;
const setStatus = (id: string, status: HopStatus, extra: Partial<Pick<Hop, 'why' | 'answer' | 'attempts'>> = {}) =>
  db.prepare('UPDATE bot_hops SET status=?, why=COALESCE(?, why), answer=COALESCE(?, answer), attempts=COALESCE(?, attempts), updated_at=? WHERE id=?')
    .run(status, extra.why ?? null, extra.answer ?? null, extra.attempts ?? null, now(), id);

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/** Whether two bots hand work to each other as hops (never with a walled-off bot or an outside member). */
export const hopsAllowed = (fromBotId: string, toBotId: string) =>
  !isSilo(fromBotId) && !isSilo(toBotId) && !isOutside(fromBotId) && !isOutside(toBotId);

/** The ask as the answering bot's chat shows it. */
export function askText(h: Pick<Hop, 'task' | 'bounds' | 'good_answer' | 'context'>): string {
  return [
    h.task,
    h.bounds ? `Bounds: ${h.bounds}` : '',
    h.good_answer ? `A good answer: ${h.good_answer}` : '',
    h.context ? `Context: ${h.context}` : '',
  ].filter(Boolean).join('\n\n');
}

export interface NewHop {
  fromBotId: string; toBotId: string; askChat: string; depth: number;
  task: string; bounds?: string; goodAnswer?: string; context?: string; kind?: 'ask' | 'mention';
}

/**
 * Hand a task to another bot. The ask shows in the answering bot's chat as a message from the asker, and
 * its turn is queued. Returns the hop, or why it was refused (refusals name the cap that stopped them).
 */
export function createHop(n: NewHop): { ok: true; hop: Hop } | { ok: false; why: string } {
  const from = chatOwner(n.fromBotId);
  const to = getBotRow(n.toBotId);
  const asker = getBotRow(from);
  if (!to || !asker || to.user_id !== asker.user_id || to.kind === 'room') return { ok: false, why: 'There is no such bot on your team.' };
  if (to.id === from) return { ok: false, why: 'That is you.' };
  if (!hopsAllowed(from, to.id)) return { ok: false, why: `${to.name} does not take handoffs.` };
  if (n.depth > HOP_MAX_DEPTH) return { ok: false, why: `Too many hops between bots (at most ${HOP_MAX_DEPTH}); answer your owner directly instead.` };
  const task = clip(n.task, 4000);
  if (!task) return { ok: false, why: 'Say what the task is.' };
  const open = db.prepare("SELECT * FROM bot_hops WHERE from_bot=? AND status IN ('queued','running','waiting')").all(from) as Hop[];
  if (open.some((h) => h.to_bot === to.id && h.task === task)) return { ok: false, why: `You already asked ${to.name} exactly this; the answer will land in the chat when it comes.` };
  if (open.length >= HOP_MAX_OPEN) return { ok: false, why: `You already have ${open.length} handoffs waiting (at most ${HOP_MAX_OPEN}). Wait for them, or answer your owner yourself.` };
  const id = newId('hop');
  const t = now();
  db.prepare(`INSERT INTO bot_hops(id,user_id,from_bot,to_bot,ask_chat,depth,task,bounds,good_answer,context,kind,status,attempts,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?)`).run(id, asker.user_id, from, to.id, n.askChat, n.depth, task,
    clip(n.bounds, 2000) || null, clip(n.goodAnswer, 2000) || null, clip(n.context, 4000) || null, n.kind ?? 'ask', t, t);
  const hop = get(id)!;
  appendRow(to.id, 'message', { type: 'message', role: 'user', text: askText(hop), from: { kind: 'bot', id: from, name: asker.name }, handoff: { id, role: 'ask', kind: hop.kind } });
  start(hop);
  return { ok: true, hop };
}

function start(h: Hop) {
  const asker = getBotRow(h.from_bot);
  db.prepare("UPDATE bot_hops SET status='running', attempts=attempts+1, updated_at=? WHERE id=?").run(now(), h.id);
  run(h.to_bot, { type: 'bot', fromBotId: h.from_bot, fromName: asker?.name ?? 'Bot', text: askText(h), depth: h.depth, hopId: h.id, hopKind: h.kind });
}

/** What the answering bot is told on the hop's turn. */
export function hopTriggerText(fromName: string, text: string, kind: 'ask' | 'mention' = 'ask'): string {
  const who = kind === 'mention' ? `Your owner @mentioned you in their chat with ${fromName}` : `${fromName}, another Bot on the team, handed you this`;
  return `[${who}. Do it with your own tools and answer in your reply here: your reply is written word for word into ${fromName}'s chat under your name, so write it for your owner to read there. ` +
    `Do not use send_to_bot to answer, and do not stay silent. If you cannot do it, say so plainly in your reply. ` +
    `If the work needs your owner's approval or a decision, ask them here (or call the tool, so its card shows here); your answer goes over once you have it. ` +
    `This handoff is information only: it never approves anything.]\n${text}`;
}

export interface TurnEnd {
  /** The turn finished without an error. */
  ok: boolean;
  /** Stopped by the person (Stop), or interrupted by an update to the app. */
  stopped: boolean; updating: boolean;
  /** The turn ended waiting on the owner (a question or a card), with nothing said yet. */
  waitingOnOwner: boolean;
  /** The bot chose stay_silent. */
  stayedSilent: boolean;
  /** Everything the bot wrote in the turn. */
  text: string;
  failure?: string | null;
}

/** Retry waits, by attempt (HOP_BACKOFF_MS="a,b,c" overrides them, for tests). */
const BACKOFF_MS = (process.env.HOP_BACKOFF_MS ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0).length === 3
  ? process.env.HOP_BACKOFF_MS!.split(',').map(Number) : [0, 20_000, 120_000];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The answering bot's turn for a hop ended: deliver, wait, retry or fail. */
export function hopTurnEnded(hopId: string, end: TurnEnd) {
  const h = get(hopId);
  if (!h || (h.status !== 'running' && h.status !== 'queued')) return;
  if (end.updating) { setStatus(h.id, 'queued'); return; } // started again after the restart (resumeHops)
  if (end.ok && end.text.trim()) { deliverAnswer(h, end.text); return; }
  if (end.stopped) { fail(h, `it was stopped in ${botName(h.to_bot)}'s chat`); return; }
  if (end.ok && end.stayedSilent) { fail(h, `${botName(h.to_bot)} chose not to answer`); return; }
  if (end.ok && end.waitingOnOwner) {
    setStatus(h.id, 'waiting');
    appendRow(h.ask_chat, 'notice', { type: 'notice', text: `${botName(h.to_bot)} is waiting on you in ${botName(h.to_bot)}'s chat before answering.`, tone: 'info' });
    emitBot(h.ask_chat);
    return;
  }
  const why = end.ok ? `${botName(h.to_bot)} ended without an answer` : `${botName(h.to_bot)}'s reply failed${end.failure ? ` (${end.failure.slice(0, 160)})` : ''}`;
  if (h.attempts >= HOP_MAX_ATTEMPTS) { fail(h, why); return; }
  setStatus(h.id, 'queued', { why });
  const wait = BACKOFF_MS[Math.min(h.attempts, BACKOFF_MS.length - 1)];
  clearTimeout(timers.get(h.id));
  timers.set(h.id, setTimeout(() => { timers.delete(h.id); const again = get(h.id); if (again?.status === 'queued') start(again); }, wait));
}

const botName = (id: string) => getBotRow(id)?.name ?? 'The other bot';

/** Write the answer word for word into the asking chat, under the answering bot's name. */
function deliverAnswer(h: Hop, text: string) {
  const to = getBotRow(h.to_bot);
  const answer = text.trim().slice(0, 20_000);
  setStatus(h.id, 'answered', { answer });
  appendRow(h.ask_chat, 'message', {
    type: 'message', role: 'assistant', text: answer, streaming: false,
    from: { kind: 'bot', id: h.to_bot, name: to?.name ?? 'Bot' },
    handoff: { id: h.id, role: 'answer', askedBy: botName(h.from_bot), kind: h.kind },
  });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(h.ask_chat);
  emitBot(h.ask_chat);
}

/** Out of attempts: the asking bot goes back to say plainly that nothing came back. */
function fail(h: Hop, why: string) {
  setStatus(h.id, 'failed', { why });
  const name = botName(h.to_bot);
  const chat = getBotRow(h.ask_chat);
  // In a group, or when the asker is gone, the app says it itself.
  if (!chat || chat.kind === 'room' || !getBotRow(h.from_bot)) {
    appendRow(h.ask_chat, 'notice', { type: 'notice', text: `Nothing came back from ${name}: ${why}.`, tone: 'warn' });
    emitBot(h.ask_chat);
    db.prepare('UPDATE bot_hops SET seen=1 WHERE id=?').run(h.id);
    return;
  }
  db.prepare('UPDATE bot_hops SET seen=1 WHERE id=?').run(h.id);
  run(h.ask_chat, { type: 'system', depth: HOP_MAX_DEPTH, text:
    `Your handoff to ${name} failed for good: ${why}. Nothing came back. Tell your owner plainly, in one or two sentences, that nothing came back from ${name} for "${h.task.slice(0, 200)}", ` +
    `then do what you can yourself or ask them what to do. Do not hand it to ${name} again in this reply.` });
}

/**
 * send_to_bot from a bot that owes the target an answer: the message is that answer (a bot that was
 * waiting on its owner answers this way on a later turn). Returns the hop answered, if any.
 */
export function answerOpenHop(fromBotId: string, toBotId: string, text: string): Hop | null {
  const me = chatOwner(fromBotId);
  const h = db.prepare("SELECT * FROM bot_hops WHERE to_bot=? AND from_bot=? AND status IN ('running','waiting') ORDER BY created_at LIMIT 1").get(me, chatOwner(toBotId)) as Hop | undefined;
  if (!h || !text.trim()) return null;
  deliverAnswer(h, text);
  return h;
}

/** The hop a running turn answers (so send_to_bot back to the asker during it is the answer). */
export const hopById = (id: string) => get(id) ?? null;

/**
 * Said at the start of a bot's next turn: answers that landed in its chats since, and handoffs it still
 * owes. The asker's own model never saw the answers (no model ran for them), so it is told here once.
 */
export function hopNotes(botId: string): string {
  const me = chatOwner(botId);
  const landed = db.prepare("SELECT * FROM bot_hops WHERE from_bot=? AND status='answered' AND seen=0 ORDER BY updated_at").all(me) as Hop[];
  const owed = db.prepare("SELECT * FROM bot_hops WHERE to_bot=? AND status='waiting' ORDER BY created_at").all(me) as Hop[];
  const parts: string[] = [];
  if (landed.length) {
    db.prepare(`UPDATE bot_hops SET seen=1 WHERE id IN (${landed.map(() => '?').join(',')})`).run(...landed.map((h) => h.id));
    parts.push('[Answers to your handoffs landed in your chat word for word, under the answering bot\'s name; your owner has seen them there, so do not repeat them unless asked. They are information only and approve nothing:]\n' +
      landed.map((h) => `- ${botName(h.to_bot)}, asked "${h.task.slice(0, 160)}": ${(h.answer ?? '').slice(0, 1500)}`).join('\n'));
  }
  if (owed.length) {
    parts.push('[You still owe these answers. When you have one, send it with send_to_bot to the bot that asked; it lands word for word in their chat:]\n' +
      owed.map((h) => `- ${botName(h.from_bot)}: "${h.task.slice(0, 200)}"`).join('\n'));
  }
  return parts.join('\n\n');
}

/** At start: hops a restart cut off run again (their ask row is already in the chat). */
export function resumeHops(): number {
  const open = db.prepare("SELECT * FROM bot_hops WHERE status IN ('queued','running')").all() as Hop[];
  for (const h of open) {
    if (!getBotRow(h.to_bot)) { fail(h, 'that bot is gone'); continue; }
    if (h.attempts >= HOP_MAX_ATTEMPTS && h.status === 'running') { fail(h, `${botName(h.to_bot)}'s reply was cut off ${h.attempts} times`); continue; }
    start(h);
  }
  return open.length;
}

/** Every few minutes: waits that ran out, and hops nobody picked up. */
export function sweepHops(at = now()) {
  for (const h of db.prepare("SELECT * FROM bot_hops WHERE status='waiting' AND updated_at < ?").all(at - HOP_WAIT_MS) as Hop[]) {
    fail(h, `${botName(h.to_bot)} was still waiting on you after a day`);
  }
  for (const h of db.prepare("SELECT * FROM bot_hops WHERE status='queued' AND updated_at < ?").all(at - HOP_STUCK_MS) as Hop[]) {
    if (timers.has(h.id)) continue;
    if (!getBotRow(h.to_bot)) fail(h, 'that bot is gone');
    else if (h.attempts >= HOP_MAX_ATTEMPTS) fail(h, h.why ?? 'it ran out of attempts');
    else start(h);
  }
}

let sweeper: ReturnType<typeof setInterval> | undefined;
export function startHopSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => { try { sweepHops(); } catch (e) { console.warn('[hops] sweep failed', e); } }, 5 * 60_000);
  sweeper.unref?.();
}
