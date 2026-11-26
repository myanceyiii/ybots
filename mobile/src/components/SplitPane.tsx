import { useEffect, useRef, useState } from 'react';
import { PanResponder, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { color } from '../theme';

/**
 * The bot list and the open chat side by side on a wide screen (an unfolded phone, a tablet), with a divider
 * you drag. Dragging left narrows the list smoothly down to a column of pictures (Home fades the words out
 * first, then shrinks the pictures); a drag stops at the pictures and never hides the list. Only the chat's
 * full-screen button slides the list away (dragging the divider then brings it back). The width you leave it
 * at is kept on this phone.
 */
export const RAIL = 96;
export const LIST_DEFAULT = 390;
const CHAT_MIN = 360;
const SNAP_TO_RAIL_BELOW = 210;
const KEY = 'cleftbot.splitWidth';

function readSaved(): number {
  try {
    const v = Number(SecureStore.getItem(KEY));
    return Number.isFinite(v) && v >= RAIL ? v : LIST_DEFAULT;
  } catch { return LIST_DEFAULT; }
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Where a released drag settles: the picture column, or where it was let go (a drag never hides the list). */
export function snapWidth(w: number, max: number): number {
  if (w < SNAP_TO_RAIL_BELOW) return RAIL;
  return Math.min(Math.max(w, SNAP_TO_RAIL_BELOW), max);
}

export function SplitPane({ total, list, chat, full, onFull, initialWidth }: {
  /** The window width. */
  total: number;
  /** Draws the list at the given width (Home, which fades its words as it narrows). */
  list: (width: number) => React.ReactNode;
  chat: React.ReactNode;
  /** The chat fills the screen (the list is slid away). */
  full: boolean;
  onFull: (full: boolean) => void;
  /** The preview's starting width (the app uses the one kept on the phone). */
  initialWidth?: number;
}) {
  const max = Math.max(RAIL, total - CHAT_MIN);
  const saved = useRef(initialWidth ?? readSaved());
  const [w, setW] = useState(() => (full ? 0 : Math.min(saved.current, max)));
  const wRef = useRef(w);
  wRef.current = w;
  const [dragging, setDragging] = useState(false);
  const anim = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  const stop = () => { if (anim.current != null) cancelAnimationFrame(anim.current); anim.current = null; };
  const animateTo = (target: number, ms = 240) => {
    stop();
    const from = wRef.current;
    if (Math.abs(from - target) < 1) { setW(target); return; }
    const t0 = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - t0) / ms);
      setW(from + (target - from) * ease(t));
      anim.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  };

  // The full-screen button (and leaving full screen) slides the list away or back to where it was.
  const lastFull = useRef(full);
  useEffect(() => {
    if (lastFull.current === full) return;
    lastFull.current = full;
    animateTo(full ? 0 : Math.min(saved.current, max));
  }, [full]);

  // Turning the phone or folding it part way keeps the chat at least CHAT_MIN wide.
  useEffect(() => { if (wRef.current > max) setW(max); }, [max]);
  useEffect(() => () => { stop(); if (frame.current != null) cancelAnimationFrame(frame.current); }, []);

  const start = useRef(0);
  const pending = useRef<number | null>(null);
  const maxRef = useRef(max);
  maxRef.current = max;
  const fullRef = useRef(full);
  fullRef.current = full;
  const onFullRef = useRef(onFull);
  onFullRef.current = onFull;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { stop(); start.current = wRef.current; setDragging(true); },
    onPanResponderMove: (_e, g) => {
      // One width per frame, however fast the touch events come.
      pending.current = Math.min(Math.max(start.current + g.dx, RAIL), maxRef.current);
      if (frame.current == null) frame.current = requestAnimationFrame(() => { frame.current = null; if (pending.current != null) setW(pending.current); });
    },
    onPanResponderRelease: (_e, g) => {
      setDragging(false);
      const raw = Math.min(Math.max(start.current + g.dx, RAIL), maxRef.current);
      // A tap on the divider (no drag) toggles between the pictures and the full list.
      const target = Math.abs(g.dx) < 4 && Math.abs(g.dy) < 4
        ? (start.current <= RAIL + 1 ? Math.max(saved.current > SNAP_TO_RAIL_BELOW ? saved.current : LIST_DEFAULT, SNAP_TO_RAIL_BELOW) : RAIL)
        : snapWidth(raw, maxRef.current);
      const t = Math.min(target, maxRef.current);
      animateTo(t, 200);
      if (t > 0) {
        saved.current = t;
        SecureStore.setItemAsync(KEY, String(Math.round(t))).catch(() => {});
        if (fullRef.current) onFullRef.current(false);
      } else if (!fullRef.current) onFullRef.current(true);
      lastFull.current = t === 0;
    },
    onPanResponderTerminate: () => { setDragging(false); animateTo(fullRef.current && wRef.current === 0 ? 0 : snapWidth(wRef.current, maxRef.current), 200); },
  })).current;

  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: w, overflow: 'hidden', borderRightWidth: w > 0 ? 1 : 0, borderRightColor: color.hairline }}>
        {w > 0 && list(w)}
      </View>
      <View style={{ flex: 1 }}>{chat}</View>
      {/* The divider: a wide invisible touch strip with a small grip, sitting on the line between the panes. */}
      <View {...pan.panHandlers} accessibilityRole="adjustable" accessibilityLabel="Resize the bot list"
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const cur = wRef.current;
          const next = e.nativeEvent.actionName === 'increment' ? (cur === 0 ? RAIL : cur <= RAIL ? Math.max(saved.current, SNAP_TO_RAIL_BELOW) : max) : RAIL;
          animateTo(next);
          if (next > RAIL) saved.current = next;
          if (fullRef.current) onFull(false);
          lastFull.current = false;
        }}
        style={{ position: 'absolute', top: 0, bottom: 0, left: Math.max(0, w - 14), width: 28, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: dragging ? 6 : 4, height: dragging ? 56 : 40, borderRadius: 3, backgroundColor: dragging ? color.link : color.inkMuted, opacity: dragging ? 0.9 : 0.35 }} />
      </View>
    </View>
  );
}
