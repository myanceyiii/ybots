/**
 * The bot list's width can be dragged (web and Windows; the Android split view does the same, see
 * mobile/src/screens/Home.tsx fitFor). As it narrows, things leave in order, each fading over its own band of
 * widths so a drag never jumps: the header buttons and each row's time first, then the message, then the names;
 * only then do the pictures shrink (72 to 56), which at RAIL leaves them centred in a column of pictures.
 * Below TEXT_FIXED_AT the words keep their width and slide under the edge rather than re-wrapping.
 */
import { CHAT_MIN } from './paneWidths';

export const RAIL = 88;
export const LIST_DEFAULT = 350;
export const LIST_MAX = 560;
export const SNAP_TO_RAIL_BELOW = 200;
const TEXT_FIXED_AT = 330;
const PICTURE_SHRINK_FROM = 170;

const band = (w: number, gone: number, full: number) => Math.min(1, Math.max(0, (w - gone) / (full - gone)));

export type SidebarFit = {
  avatar: number; pad: number; textWidth: number | null; rowHeight: number | null;
  meta: number; preview: number; name: number; tools: number; account: number; rail: boolean;
  /** The titlebar's left padding and the footer's right padding: the toggle (24) and Connections (36) end centred over the pictures. */
  headerLeft: number; footerRight: number;
};

export function sidebarFit(w: number): SidebarFit {
  const pic = band(w, RAIL, PICTURE_SHRINK_FROM);
  const avatar = Math.round(56 + 16 * pic);
  const pad = 4 + 6 * pic; // 12 (scroll) + 4 + 56 + 4 + 12 = 88: centred at RAIL
  const name = band(w, PICTURE_SHRINK_FROM, 260);
  return {
    avatar, pad,
    // 12 + 10 + 72 + 12 on the left, 10 + 12 on the right: the text column at TEXT_FIXED_AT.
    textWidth: w < TEXT_FIXED_AT ? TEXT_FIXED_AT - 128 : null,
    // Beside the chat every row keeps one height (88 for the words, shrinking away with the names), so a
    // narrowing list never reflows: the text can't push a row taller.
    rowHeight: avatar + 2 * pad + 16 * name,
    meta: band(w, 250, TEXT_FIXED_AT),
    preview: band(w, 200, 300),
    name,
    tools: band(w, 200, 250),
    account: band(w, 150, 220),
    rail: w < 150,
    headerLeft: 32 - 22 * pic,
    footerRight: 26 - 10 * pic,
  };
}

/**
 * Where a released drag settles: the picture column, or where it was let go. A drag never hides the list:
 * the narrowest it goes is the column of pictures. Only the chat's Full screen button (or Shift+Cmd/Ctrl+F)
 * takes the list away.
 */
export function snapSidebar(w: number, max: number): number {
  if (w < SNAP_TO_RAIL_BELOW) return RAIL;
  return Math.min(Math.max(w, SNAP_TO_RAIL_BELOW), max);
}

/** `windowWidth` less the side panel when it sits beside the chat (a wide window). */
export const sidebarMax = (windowWidth: number) => Math.max(SNAP_TO_RAIL_BELOW, Math.min(LIST_MAX, windowWidth - CHAT_MIN));
