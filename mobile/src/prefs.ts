// Settings that belong to this phone: the size of the words in chats. Kept on the phone only, like the theme.
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';

export type TextSize = 'small' | 'default' | 'large' | 'xl';
export const TEXT_SIZES: { id: TextSize; label: string; scale: number }[] = [
  { id: 'small', label: 'Small', scale: 0.9 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.15 },
  { id: 'xl', label: 'Extra large', scale: 1.3 },
];
const KEY = 'cleftbot.textSize';
let size: TextSize = (() => { try { const v = SecureStore.getItem(KEY); return TEXT_SIZES.some((t) => t.id === v) ? (v as TextSize) : 'default'; } catch { return 'default'; } })();
const listeners = new Set<(t: TextSize) => void>();

export const textSize = () => size;
/** Multiply a chat font size or line height by this. */
export const textScale = () => TEXT_SIZES.find((t) => t.id === size)?.scale ?? 1;
/** A chat font size (or line height) at the chosen text size. */
export const sized = (n: number) => Math.round(n * textScale() * 2) / 2;
export function setTextSize(t: TextSize) {
  size = t;
  SecureStore.setItemAsync(KEY, t).catch(() => {});
  for (const fn of listeners) fn(t);
}
/** Re-renders the caller when the text size changes. */
export function useTextSize(): TextSize {
  const [t, setT] = useState<TextSize>(size);
  useEffect(() => { listeners.add(setT); return () => { listeners.delete(setT); }; }, []);
  return t;
}
