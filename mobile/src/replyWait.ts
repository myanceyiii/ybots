/**
 * What the app shows under the person's newest message while a reply is due (Android's Working bubble,
 * mobile/src/screens/Chat.tsx). Copied verbatim to mobile/src/replyWait.ts; tests/reply-wait.mjs checks both.
 *
 * Alex's rule (2026-11-25): "waiting on you" and "no answer yet" never show together. While a card waits
 * on the person (an approval, a secure input, a purchase, help on screen, a question, a connect card), the bot
 * is not late, so there is no "No answer yet" card and no "Taking a while" line, however long the card waits.
 */

/** Only the parts of a chat row this rule reads. */
export interface WaitRow { seq: number; createdAt: number; body: { type?: string; status?: string } & Record<string, unknown> }
/** Only the parts of the bot's live state this rule reads (store.ts BotLive). */
export interface WaitLive { isRunning?: boolean; awaiting?: unknown; activity?: { kind?: string } | null }

export const REPLY_WAIT = {
  /** Quiet this long after the last thing in the chat, with nothing running and nothing waiting: "No answer yet". */
  stallMs: 45_000,
  /** Running this long: a small "Taking a while" line. */
  slowMs: 120_000,
  /** After this long without anything new, the bubble goes away. */
  giveUpMs: 30 * 60_000,
  /** A card left pending longer than this no longer counts as the bot waiting (an abandoned card). */
  pendingCardMs: 24 * 60 * 60_000,
};

/** A card in the chat still waiting on the person's answer. */
export function isPendingCard(r: WaitRow): boolean {
  return r.body?.type === 'card' && r.body.status === 'pending';
}

/** The newest card still waiting on the person, if any (abandoned ones older than a day don't count). */
export function pendingCard(rows: WaitRow[], now: number): WaitRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (isPendingCard(r) && now - r.createdAt < REPLY_WAIT.pendingCardMs) return r;
  }
  return null;
}

export type ReplyWait =
  /** Nothing to show. */
  | { state: 'none' }
  /** The bot waits on the person: a calm "Waiting for you" note, never "too long". */
  | { state: 'waiting'; since: number }
  /** The bot is working; `slow` adds the "Taking a while" line. */
  | { state: 'working'; since: number; slow: boolean }
  /** The message is on its way and nothing has come back yet. */
  | { state: 'sending'; since: number }
  /** Nothing running, nothing waiting, nothing new for a while: offer Check again / Send again. */
  | { state: 'stalled'; since: number };

/**
 * `asked` is the person's newest message still owed a reply (null when the newest message is the bot's).
 * `startedAt` is when the current turn started (live.startedAt), if one is running. `touchedAt` is the last
 * time the app saw something change that rows don't date, such as a card being answered or a turn ending.
 */
export function replyWait(o: { live?: WaitLive | null; rows: WaitRow[]; asked: WaitRow | null; startedAt?: number | null; touchedAt?: number | null; now: number }): ReplyWait {
  const { live, rows, asked, now } = o;
  const running = !!live?.isRunning;
  const card = pendingCard(rows, now);
  if (live?.awaiting || live?.activity?.kind === 'waiting_for_you' || card) {
    // Only while there is something to point at: a turn, or a message owed a reply.
    if (!running && !asked && !live?.awaiting) return { state: 'none' };
    const awaitingSince = typeof (live?.awaiting as { since?: unknown } | null)?.since === 'number' ? (live!.awaiting as { since: number }).since : null;
    return { state: 'waiting', since: awaitingSince ?? card?.createdAt ?? asked?.createdAt ?? now };
  }
  if (running) {
    const since = o.startedAt ?? asked?.createdAt ?? now;
    return { state: 'working', since, slow: now - since > REPLY_WAIT.slowMs };
  }
  if (!asked) return { state: 'none' };
  // Measured from the last thing in the chat since the message (a card answered, a tool step), not from
  // the message itself: a bot that waited 10 minutes on a card is not late the moment the card is answered.
  let last = asked.createdAt;
  for (const r of rows) if (r.seq > asked.seq && r.createdAt > last) last = r.createdAt;
  if (o.touchedAt && o.touchedAt > last) last = o.touchedAt;
  const quiet = now - last;
  if (quiet >= REPLY_WAIT.giveUpMs) return { state: 'none' };
  return quiet > REPLY_WAIT.stallMs ? { state: 'stalled', since: last } : { state: 'sending', since: asked.createdAt };
}
