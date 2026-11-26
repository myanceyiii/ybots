import { lsGet, lsSet } from './storage';
import { currentLayout, type Layout } from './useLayout';

/**
 * The three main panes' widths (web and Windows): the bot list on the left (lib/sidebarFit.ts), the chat
 * in the middle, and the side panel on the right (the agent's details panel, or the file pane in its place).
 * Both edges are dragged; the chat takes what is left and never gets narrower than CHAT_MIN.
 *
 * Widths are kept in this browser per account and per window size (wide: three columns side by side;
 * medium: the side panel slides over the chat), so a laptop window and a full monitor each keep their own.
 */
export type SideKind = 'details' | 'files';

export const SIDE_DEFAULT: Record<SideKind, number> = { details: 360, files: 480 };
export const SIDE_MIN = 300;
export const SIDE_MAX = 960;
/** Let go narrower than this and the side panel closes (its width is kept for when it opens again). */
export const SIDE_CLOSE_BELOW = 200;
/** The chat never gets narrower than this while either edge is dragged. */
export const CHAT_MIN = 420;
/** In a medium window the panel slides over the chat; this much of the chat always shows beside it. */
const OVERLAY_GAP = 56;

const key = (uid: string | undefined, layout: Layout, what: string) => `paneWidth:${uid ?? 'anon'}:${layout}:${what}`;
const num = (v: string | null, lo: number, hi: number) => { const n = Number(v); return v != null && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

/** The saved widths for this account and window size (the list falls back to the width saved before widths were per account). */
export function loadPaneWidths(uid: string | undefined, layout: Layout = currentLayout()) {
  return {
    sidebarWidth: num(lsGet(key(uid, layout, 'list')), 200, 800) ?? num(lsGet('sidebarWidth'), 200, 800) ?? 350,
    detailsWidth: num(lsGet(key(uid, layout, 'details')), SIDE_MIN, SIDE_MAX) ?? SIDE_DEFAULT.details,
    filesWidth: num(lsGet(key(uid, layout, 'files')), SIDE_MIN, SIDE_MAX) ?? SIDE_DEFAULT.files,
  };
}

export function savePaneWidth(uid: string | undefined, what: 'list' | SideKind, w: number) {
  lsSet(key(uid, currentLayout(), what), String(Math.round(w)));
}

/** The widest the side panel can be: beside the list and a CHAT_MIN chat (wide), or over most of the chat (medium). */
export function sideMax(layout: Layout, windowWidth: number, listWidth: number): number {
  const room = layout === 'wide' ? windowWidth - listWidth - CHAT_MIN : windowWidth - listWidth - OVERLAY_GAP;
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, room));
}

/** Where a released drag settles: closed, or between the minimum and the maximum. */
export function snapSide(w: number, max: number): number {
  if (w < SIDE_CLOSE_BELOW) return 0;
  return Math.min(Math.max(w, SIDE_MIN), max);
}
