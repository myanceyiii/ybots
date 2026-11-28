/**
 * The small line under a handoff message (server/src/bot-handoffs.ts). Must say the same words as
 * server/src/handoff-label.ts, which the web app uses.
 */
export interface HandoffMark { id: string; role: 'ask' | 'answer'; askedBy?: string; kind?: 'ask' | 'mention' }

export function handoffLabel(h: HandoffMark | undefined | null): string | null {
  if (!h) return null;
  if (h.role === 'ask') return 'Handoff · the answer goes back word for word';
  return h.kind === 'mention' ? 'Answer to your @mention' : `Answer to ${h.askedBy ?? 'a'}${h.askedBy ? "'s" : ''} handoff`;
}

export const HANDOFF_HINT = 'Passed on by the app word for word, with no second model call. Information only: it never approves anything.';
