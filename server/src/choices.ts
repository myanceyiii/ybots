import { makeView, postView } from './views.js';
import { detectChoices, type ChoiceSpec } from './choice-detect.js';
import type { CardBody } from './types.js';

export { checkChoices, choicesFor, detectChoices, CHOICE_LIMITS, type ChoiceSpec } from './choice-detect.js';

/**
 * Choice buttons: tappable answers under a bot's reply, for a question with a small set of answers (yes or
 * no, this or that, up to four options), the way ChatGPT and Duet show quick replies.
 *
 * They are an answer view (views.ts) with one choice block and `quick: true`, so every app draws them with
 * the view code it already has, as a row of buttons with no card around them. Tapping one posts the option
 * as the person's own chat message (in a group, @mentioning the bot that asked) and the row then shows what
 * was picked and by whom, and can't be pressed again. A tap is a chat reply only: it carries no approval id
 * or digest, so it can never approve anything; a privileged action the bot takes next still meets its card.
 *
 * Two ways in:
 *  - the bot calls `offer_choices` (or passes `choices` to post_to_group). In the bot's own chat the row is
 *    held until the turn ends, so it sits under the reply text however the bot ordered its calls;
 *  - a fallback: when a reply ends with an obvious yes/no or "this or that" question, or tells the person to
 *    reply with a set phrase ('Reply "approve all" or tell me which to change'), and the bot offered no
 *    buttons, asking view or ask_user card this turn, `detectChoices` adds them (marked `auto`).
 */

type Card = Extract<CardBody, { card: 'view' }>;

/** The view card for a set of choices. */
export function choicesCard(c: ChoiceSpec, auto = false): Card {
  const { card } = makeView('', [{ id: 'c', type: 'choice', question: c.question, options: c.options, ...(c.other ? { other: true } : {}) }]);
  const b = card.blocks[0] as any;
  if (c.other) b.other = true;
  return { ...card, quick: true, ...(auto ? { auto: true } : {}) };
}

// ---------------- holding a bot's buttons until its reply is written ----------------

const running = new Set<string>();
const held = new Map<string, { card: Card; from: { id: string; name: string } }[]>();
/** Chats whose current turn already showed choices, a view or a question, so the fallback stays out. */
const offered = new Set<string>();

/** The agent loop marks a chat's turn as started (agent/loop.ts). */
export function choiceTurnStart(chatId: string) {
  running.add(chatId);
  held.delete(chatId);
  offered.delete(chatId);
}

/**
 * Something in this turn already asks the person (a view with a choice, form, button or calculator, or
 * ask_user): no guessed buttons for it. A view that only shows numbers (stats, tables, charts) asks nothing,
 * so it does not count: Leonard's morning briefing card must not hide the 'Reply "approve all"' buttons.
 */
export function markOffered(chatId: string) { offered.add(chatId); }

/**
 * Show a bot's buttons in a chat: right away when no turn is running there, else when the turn ends
 * (choiceTurnEnd), so they sit under the reply text.
 */
export function offerChoices(chatId: string, card: Card, from: { id: string; name: string }) {
  offered.add(chatId);
  if (!running.has(chatId)) { postView(chatId, card, from, false); return 'shown'; }
  const list = held.get(chatId) ?? [];
  if (list.length >= 3) return 'too many';
  list.push({ card, from });
  held.set(chatId, list);
  return 'held';
}

/**
 * The turn ended: post the held buttons, or, when the reply ended with an obvious question and nothing
 * else asked it, the guessed ones. A stopped or failed turn posts nothing.
 */
export function choiceTurnEnd(chatId: string, opts: { ok: boolean; lastText: string; from: { id: string; name: string } }) {
  const list = held.get(chatId) ?? [];
  const already = offered.has(chatId);
  running.delete(chatId);
  held.delete(chatId);
  offered.delete(chatId);
  if (!opts.ok) return;
  for (const h of list) postView(chatId, h.card, h.from, false);
  if (already || !opts.lastText.trim()) return;
  for (const c of detectChoices(opts.lastText)) postView(chatId, choicesCard(c, true), opts.from, false);
}

