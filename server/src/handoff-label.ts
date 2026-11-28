import type { MessageBody } from './types.js';

/**
 * The small line under a handoff message (bot-handoffs.ts), the same on every app: web imports this
 * file, and mobile/src/handoffLabel.ts must say the same words.
 */
export function handoffLabel(h: MessageBody['handoff']): string | null {
  if (!h) return null;
  if (h.role === 'ask') return 'Handoff · the answer goes back word for word';
  return h.kind === 'mention' ? 'Answer to your @mention' : `Answer to ${h.askedBy ?? 'a'}${h.askedBy ? "'s" : ''} handoff`;
}

/** Why the line is there, for a tooltip or screen reader. */
export const HANDOFF_HINT = 'Passed on by the app word for word, with no second model call. Information only: it never approves anything.';
