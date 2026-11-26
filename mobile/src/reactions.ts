// Emoji reactions on chat messages: the emoji sets the pickers offer and how a message's reactions are shown.
// Shared by the server, the web app (via @shared) and the Android app, which keeps a VERBATIM copy at
// mobile/src/reactions.ts (tests/reactions.mjs checks the copy stays identical).

/** Who reacted: a person on the account, or a Bot (by id). */
export interface Reaction {
  emoji: string;
  by: { kind: 'person' | 'bot'; id: string; name: string };
  at: number;
}

/** The row of quick reactions, Slack/iMessage style. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👎'];

/** The rest of the picker ("More"). Kept short on purpose: common, unambiguous emoji that render on every platform. */
export const MORE_REACTIONS = [
  '😀', '😊', '😍', '🤩', '😎', '🤔', '😅', '😬', '😮', '😢', '😭', '😡',
  '🙌', '👏', '💪', '👌', '✌️', '🤞', '👀', '🫡', '🤝', '🙈', '🤯', '🥳',
  '🔥', '✨', '⭐', '💯', '✅', '❌', '⚠️', '❓', '💡', '📌', '🚀', '🎯',
  '💰', '🏠', '🛒', '📅', '⏰', '☕', '🍕', '🎁', '💤', '🐢', '😴', '🤖',
];

const ALL = new Set([...QUICK_REACTIONS, ...MORE_REACTIONS]);

/** Most distinct emoji one message can carry. */
export const MAX_DISTINCT = 12;

/**
 * Whether a string is one emoji a reaction may use: anything from the pickers, or (for Bots) a single
 * pictographic emoji with optional modifiers, never text.
 */
export function isReactionEmoji(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > 16) return false;
  if (ALL.has(s)) return true;
  return /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(s);
}

export interface ReactionChip {
  emoji: string;
  count: number;
  /** A person on this account reacted with it (the chip is highlighted and a tap removes it). */
  mine: boolean;
  /** "You, Leonard" for the chip's tooltip / accessibility label. */
  names: string;
}

/** A message's reactions as chips, in the order each emoji was first used. */
export function reactionChips(list: Reaction[] | undefined): ReactionChip[] {
  const out: ReactionChip[] = [];
  for (const r of list ?? []) {
    let c = out.find((x) => x.emoji === r.emoji);
    if (!c) { c = { emoji: r.emoji, count: 0, mine: false, names: '' }; out.push(c); }
    c.count++;
    if (r.by.kind === 'person') c.mine = true;
    const who = r.by.kind === 'person' ? 'You' : r.by.name;
    c.names = c.names ? `${c.names}, ${who}` : who;
  }
  return out;
}

/**
 * Add the reaction, or take it away if this reactor already left that emoji. Returns the new list and
 * whether it was added. A person's reaction counts as the account's: any person on it can remove it.
 */
export function toggleReaction(list: Reaction[] | undefined, emoji: string, by: Reaction['by'], at: number): { list: Reaction[]; added: boolean } {
  const cur = list ?? [];
  const same = (r: Reaction) => r.emoji === emoji && r.by.kind === by.kind && (by.kind === 'person' || r.by.id === by.id);
  if (cur.some(same)) return { list: cur.filter((r) => !same(r)), added: false };
  const distinct = new Set(cur.map((r) => r.emoji));
  if (!distinct.has(emoji) && distinct.size >= MAX_DISTINCT) return { list: cur, added: false };
  return { list: [...cur, { emoji, by, at }], added: true };
}
