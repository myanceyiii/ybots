// A bot's colour in chats: the name, side bar and bubble tint on messages it posts in another bot's
// chat or in a group, so Leonard's words never look like Howard's. Shared by the server, the web app
// and the phone (mobile/src/chatColors.ts is an identical copy; tests/chat-colors.mjs checks that).
//
// The idea (a small fixed palette, one stable colour per sender, separate light and dark values) follows
// Element's sender colours (element-hq/element-web, FormattingUtils.ts); no code is taken from it.
// Values were made from each bot colour's fill: `ink` is darkened (light) or lightened (dark) until it
// reads at 4.5:1 or better on `tint`, and `bar` reaches 3:1 on the page. tests/chat-colors.mjs checks both.

export type ChatColor = 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta';

/** Colours for one theme: the sender's name, the bar beside its bubble, and the bubble's tint. */
export interface ChatInk { ink: string; bar: string; tint: string }

export const CHAT_COLORS: Record<ChatColor, { light: ChatInk; dark: ChatInk }> = {
  brown: { light: { ink: '#83582F', bar: '#A06B39', tint: '#E7E1DB' }, dark: { ink: '#BE9A78', bar: '#A06B39', tint: '#3E342A' } },
  red: { light: { ink: '#BA202E', bar: '#FB2B3E', tint: '#F2D9DC' }, dark: { ink: '#FC6F7C', bar: '#FB2B3E', tint: '#51272B' } },
  orange: { light: { ink: '#A7450A', bar: '#F8670F', tint: '#F2E1D6' }, dark: { ink: '#FD843A', bar: '#FD690F', tint: '#513321' } },
  yellow: { light: { ink: '#93580B', bar: '#D37E0F', tint: '#F1E6D6' }, dark: { ink: '#F59517', bar: '#F59312', tint: '#4F3C22' } },
  green: { light: { ink: '#0C7443', bar: '#12AA62', tint: '#D6EBE1' }, dark: { ink: '#1DC375', bar: '#14C16F', tint: '#224535' } },
  cyan: { light: { ink: '#0C7164', bar: '#11A592', tint: '#D6EAE8' }, dark: { ink: '#2BBEAB', bar: '#13B7A2', tint: '#22433F' } },
  blue: { light: { ink: '#1663BA', bar: '#1E86FC', tint: '#D8E4F2' }, dark: { ink: '#58A5FD', bar: '#1E86FC', tint: '#243951' } },
  violet: { light: { ink: '#7247C7', bar: '#8F59F9', tint: '#E5DFF2' }, dark: { ink: '#B38EFB', bar: '#8F59F9', tint: '#3B3050' } },
  magenta: { light: { ink: '#B3256D', bar: '#F93498', tint: '#F2DAE6' }, dark: { ink: '#FB6DB5', bar: '#F93498', tint: '#50293D' } },
};

/** Swatch order in settings. */
export const CHAT_COLOR_ORDER: ChatColor[] = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'brown'];

/** Colours handed out to bots whose picture colour is black or gray, in this order, skipping ones in use. */
const SPARE: ChatColor[] = ['blue', 'violet', 'magenta', 'cyan', 'orange', 'brown', 'red', 'green', 'yellow'];

export const isChatColor = (c: unknown): c is ChatColor => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CHAT_COLORS, c);

/**
 * Every bot's chat colour for one account. A colour set in settings wins; otherwise a bot keeps its
 * picture colour when that is a real colour; black and gray bots get the first spare colour no other
 * bot uses (oldest bot first), so the defaults stay apart and do not move around.
 */
export function assignChatColors(bots: { id: string; chatColor?: string | null; avatarColor?: string | null; createdAt?: number }[]): Record<string, ChatColor> {
  const out: Record<string, ChatColor> = {};
  const used = new Set<ChatColor>();
  for (const b of bots) {
    const c = isChatColor(b.chatColor) ? b.chatColor : isChatColor(b.avatarColor) ? b.avatarColor : null;
    if (c) { out[b.id] = c; used.add(c); }
  }
  const rest = bots.filter((b) => !out[b.id]).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
  let i = 0;
  for (const b of rest) {
    const free = SPARE.find((c) => !used.has(c));
    const c = free ?? SPARE[i++ % SPARE.length];
    out[b.id] = c; used.add(c);
  }
  return out;
}

/** A colour for a bot this app can't see (a scoped sign-in sees only its own bot): steady per bot id. */
export function chatColorForUnseen(id: string): ChatColor {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHAT_COLOR_ORDER[h % CHAT_COLOR_ORDER.length];
}

/** The colours to draw with, for a bot's chat colour (anything unknown falls back to blue). */
export function chatInk(c: string | null | undefined, scheme: 'light' | 'dark'): ChatInk {
  return (isChatColor(c) ? CHAT_COLORS[c] : CHAT_COLORS.blue)[scheme];
}
