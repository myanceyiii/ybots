import { db, now } from './db.js';
import { appendRow, emitBot } from './store.js';
import { isMaintainer } from './maintainer-guard.js';
import { boardState } from './board-pin.js';

/**
 * A fresh engine session for the maintainer (Howard) between jobs, like a new Hermes dashboard chat.
 *
 * His main chat used to be one Hermes session for days (2026-11-25: 2,452 messages, ~300K tokens re-read
 * on every model call), and he stalled in it where fresh sessions finished the same job. Alex agreed
 * on 2026-11-25 to a new session after a quiet spell, as long as a job he left halfway, waiting on Alex,
 * is not forgotten. So:
 *  - the session turns over only on Alex's own message, after 2 hours with nothing from the bot when
 *    the last job ended cleanly, and after 24 hours when something is still open (a question or
 *    checkpoint in the bot's last message, a card waiting on Alex, an open task, a pinned progress board);
 *  - the new session starts with a handoff: the latest checkpoint, the last 20 messages word for word,
 *    the message Alex is quoting, open tasks, boards and cards;
 *  - a notice in the chat says so. The person's chat itself never changes; only the engine's thread does.
 *
 * The app's conversation (generation) is unchanged; each generation has its own segment number, so
 * reopening an earlier conversation continues that conversation's latest session.
 */

db.exec(`CREATE TABLE IF NOT EXISTS engine_segments (
  bot_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation)
)`);

const HOUR = 3_600_000;
const minutes = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : dflt;
};
/** Quiet time before a new session when nothing is open (MAINTAINER_FRESH_AFTER_MIN, 0 turns it off). */
export const cleanIdleMs = () => minutes(process.env.MAINTAINER_FRESH_AFTER_MIN, 2 * HOUR);
/** Quiet time before a new session when something is still waiting on the owner. */
export const openIdleMs = () => minutes(process.env.MAINTAINER_FRESH_OPEN_MIN, 24 * HOUR);
const TASK_FRESH_MS = 7 * 24 * HOUR;
const LAST_N = 20;
const MSG_MAX = 1500;
const HANDOFF_MAX = 24_000;

export function segmentOf(botId: string, generation: number): number {
  const r = db.prepare('SELECT segment FROM engine_segments WHERE bot_id=? AND generation=?').get(botId, generation) as any;
  return Number(r?.segment ?? 0);
}

/** The engine's thread for this conversation: unchanged until the first turnover, so live sessions carry on. */
export function conversationKey(botId: string, generation: number): string {
  const s = segmentOf(botId, generation);
  return s ? `hq-${botId}-g${generation}-s${s}` : `hq-${botId}-g${generation}`;
}

type MsgRow = { seq: number; created_at: number; body: any };

function messages(botId: string, generation: number, limit: number): MsgRow[] {
  return (db.prepare("SELECT seq, created_at, body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT ?")
    .all(botId, generation, limit) as any[])
    .map((r) => ({ seq: r.seq, created_at: r.created_at, body: safeJson(r.body) }))
    .filter((r) => r.body && typeof r.body.text === 'string' && !r.body.streaming)
    .reverse();
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/** When the bot last did anything in this conversation (its messages, steps, cards, notices). */
function lastBotActivity(botId: string, generation: number): number | null {
  const r = db.prepare(`SELECT MAX(created_at) AS t FROM rows WHERE bot_id=? AND generation=?
    AND NOT (kind='message' AND body LIKE '%"role":"user"%')`).get(botId, generation) as any;
  return r?.t ?? null;
}

const CHECKPOINT = /(^|\n)\s*(#+\s*|\*\*)?checkpoint\b/i;
/** The bot's last message ends on a question, or carries a checkpoint: it is waiting on the owner. */
export function awaitsOwner(text: string): boolean {
  const t = text.trim();
  if (CHECKPOINT.test(t)) return true;
  const tail = t.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
  return /\?\s*\**\s*$/.test(tail) || /\?\s*["')\]]?\s*$/.test(t);
}

export interface OpenWork { question: boolean; cards: string[]; tasks: string[]; boards: string[] }

export function openWork(botId: string, generation: number, at = now()): OpenWork {
  const lastBot = messages(botId, generation, 40).filter((m) => m.body.role === 'assistant').pop();
  const cards = (db.prepare("SELECT tool FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[]).map((r) => String(r.tool));
  const tasks = (db.prepare("SELECT title, state FROM tasks WHERE bot_id=? AND state IN ('working','needs_input') AND updated_at > ?")
    .all(botId, at - TASK_FRESH_MS) as any[]).map((r) => `${r.title} (${r.state === 'needs_input' ? 'needs your input' : 'in progress'})`);
  const boards: string[] = [];
  for (const r of db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND body LIKE '%\"pin\":%' ORDER BY seq DESC LIMIT 20").all(botId, generation) as any[]) {
    const c = safeJson(r.body);
    if (!c || c.card !== 'view') continue;
    const st = boardState(c, r.created_at, at);
    if (st && st !== 'done') boards.push(`${c.title || 'Progress'} (${st})`);
  }
  return { question: !!lastBot && awaitsOwner(lastBot.body.text), cards, tasks, boards };
}

const isOpen = (w: OpenWork) => w.question || w.cards.length > 0 || w.tasks.length > 0 || w.boards.length > 0;

export interface RotationPlan { rotate: boolean; reason: string; idleMs: number; open: OpenWork | null }

/** Whether this turn starts a fresh engine session. Only the maintainer, only on the owner's own message. */
export function planRotation(bot: { id: string; generation: number; side_of?: string | null }, trigger: { type: string }, at = now()): RotationPlan {
  const none = (reason: string, idleMs = 0, open: OpenWork | null = null): RotationPlan => ({ rotate: false, reason, idleMs, open });
  if (bot.side_of || !isMaintainer(bot.id)) return none('not the maintainer');
  if (trigger.type !== 'user') return none('not the owner\'s message');
  const clean = cleanIdleMs();
  if (!clean) return none('turned off');
  const last = lastBotActivity(bot.id, bot.generation);
  if (last === null) return none('nothing yet');
  const idle = at - last;
  if (idle < clean) return none('recent', idle);
  const open = openWork(bot.id, bot.generation, at);
  if (isOpen(open)) {
    return idle >= Math.max(openIdleMs(), clean)
      ? { rotate: true, reason: 'quiet for a day with work still open', idleMs: idle, open }
      : none('work still open', idle, open);
  }
  return { rotate: true, reason: 'quiet after a finished job', idleMs: idle, open };
}

const who = (m: MsgRow, owner: string, bot: string) => (m.body.role === 'assistant' ? bot : m.body.from?.name ?? owner);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** The earlier message the owner is quoting ("> ..." lines, as the apps' Reply puts them), with its neighbours. */
function quoted(botId: string, generation: number, text: string, shown: Set<number>): MsgRow[] {
  const q = text.split('\n').filter((l) => /^\s*>/.test(l)).map((l) => l.replace(/^\s*>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
  if (q.length < 12) return [];
  const needle = q.slice(0, 80);
  const all = messages(botId, generation, 500);
  const i = all.findIndex((m) => !shown.has(m.seq) && m.body.text.replace(/\s+/g, ' ').includes(needle));
  return i < 0 ? [] : all.slice(Math.max(0, i - 2), i + 3).filter((m) => !shown.has(m.seq));
}

/** What the new session is told about the conversation so far. */
export function buildHandoff(botId: string, generation: number, opts: { owner: string; botName: string; text: string; plan: RotationPlan }): string {
  const { owner, botName, plan } = opts;
  // The owner's new message (already in the chat) is the turn itself, so it is not repeated here.
  const recent = messages(botId, generation, LAST_N + 1);
  const last = recent[recent.length - 1];
  if (last && last.body.role === 'user' && last.body.text.trim() === opts.text.trim()) recent.pop();
  while (recent.length > LAST_N) recent.shift();
  const shown = new Set(recent.map((m) => m.seq));
  const checkpoint = messages(botId, generation, 200).filter((m) => m.body.role === 'assistant' && CHECKPOINT.test(m.body.text)).pop();
  const quote = quoted(botId, generation, opts.text, shown);
  const open = plan.open ?? openWork(botId, generation);
  const hours = Math.round(plan.idleMs / HOUR);

  const parts: string[] = [
    `[New session. The app started a fresh working session for you because the chat was quiet for ${hours >= 1 ? `about ${hours} hour${hours === 1 ? '' : 's'}` : 'a while'} (${plan.reason}). ${owner} still sees the whole chat. Below is a handoff from your earlier session: pick up from it, and treat ${owner}'s message after it as the next turn of the same conversation. Your memory and past sessions (session_search) are still there for anything older.]`,
  ];
  if (checkpoint) parts.push(`## Your latest checkpoint (${when(checkpoint.created_at)})\n${clip(checkpoint.body.text, 4000)}`);
  if (open.cards.length) parts.push(`## Cards still waiting on ${owner}\n${open.cards.map((c) => `- ${c}`).join('\n')}`);
  if (open.tasks.length) parts.push(`## Open tasks\n${open.tasks.map((t) => `- ${t}`).join('\n')}`);
  if (open.boards.length) parts.push(`## Pinned progress boards\n${open.boards.map((b) => `- ${b}`).join('\n')}`);
  if (quote.length) parts.push(`## The earlier message ${owner} is replying to, with its neighbours\n${quote.map((m) => `${who(m, owner, botName)} (${when(m.created_at)}): ${clip(m.body.text, MSG_MAX)}`).join('\n\n')}`);
  if (recent.length) parts.push(`## The last ${recent.length} messages, oldest first\n${recent.map((m) => `${who(m, owner, botName)} (${when(m.created_at)}): ${clip(m.body.text, MSG_MAX)}`).join('\n\n')}`);
  parts.push('[End of handoff.]');
  let out = parts.join('\n\n');
  if (out.length > HANDOFF_MAX) out = `${out.slice(0, HANDOFF_MAX - 40)}\n…\n[End of handoff.]`;
  return out;
}

/**
 * Start the new session: bump the segment, put a notice in the chat and return the handoff to send
 * ahead of the owner's message. Returns null when this turn keeps the current session.
 */
export function rotateIfDue(bot: { id: string; generation: number; side_of?: string | null; name: string }, trigger: { type: string; text?: string }, owner: string, at = now()): { handoff: string; plan: RotationPlan } | null {
  const plan = planRotation(bot, trigger, at);
  if (!plan.rotate) return null;
  const handoff = buildHandoff(bot.id, bot.generation, { owner, botName: bot.name, text: trigger.text ?? '', plan });
  const next = segmentOf(bot.id, bot.generation) + 1;
  db.prepare(`INSERT INTO engine_segments(bot_id, generation, segment, started_at) VALUES (?,?,?,?)
    ON CONFLICT(bot_id, generation) DO UPDATE SET segment=excluded.segment, started_at=excluded.started_at`).run(bot.id, bot.generation, next, at);
  const bits = ['the last messages', plan.open?.question ? 'the open question' : '', plan.open?.cards.length ? `${plan.open.cards.length} waiting card${plan.open.cards.length === 1 ? '' : 's'}` : '',
    plan.open?.tasks.length ? `${plan.open.tasks.length} open task${plan.open.tasks.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  const hasCheckpoint = handoff.includes('## Your latest checkpoint');
  appendRow(bot.id, 'notice', { type: 'notice', tone: 'info',
    text: `New session started, handoff loaded: ${hasCheckpoint ? 'the latest checkpoint, ' : ''}${bits.join(', ')}. ${bot.name} starts fresh after a quiet spell; this chat is unchanged.` });
  emitBot(bot.id);
  console.log(`[session] ${bot.name}: new engine session ${next} for generation ${bot.generation} (${plan.reason}, idle ${Math.round(plan.idleMs / 60000)} min)`);
  return { handoff, plan };
}
