/**
 * Small taps you can feel: a message sent, a long press that opened a menu, a card answered, a switch
 * flipped. One place so the whole app feels the same, with a switch on this phone to turn them off
 * (This phone › Appearance). Never throws: a phone without a vibration motor just stays still.
 */
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

const KEY = 'cleftbot.haptics';
let on = (() => { try { return SecureStore.getItem(KEY) !== 'off'; } catch { return true; } })();
const listeners = new Set<(v: boolean) => void>();

export function setHaptics(v: boolean) {
  on = v;
  SecureStore.setItemAsync(KEY, v ? 'on' : 'off').catch(() => {});
  for (const fn of listeners) fn(v);
  if (v) tap('select');
}
export function useHaptics(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => { listeners.add(setV); return () => { listeners.delete(setV); }; }, []);
  return v;
}

export type Tap = 'select' | 'light' | 'medium' | 'success' | 'warning' | 'error';

/**
 * select: a choice changed (a chip, a switch). light: a button that did something small (copy, react).
 * medium: a long press opened a menu, a message was sent. success / warning / error: how an answer landed.
 */
export function tap(kind: Tap = 'light') {
  if (!on || Platform.OS === 'web') return;
  try {
    const p = kind === 'select' ? Haptics.selectionAsync()
      : kind === 'light' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : kind === 'medium' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      : Haptics.notificationAsync(kind === 'success' ? Haptics.NotificationFeedbackType.Success : kind === 'warning' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error);
    void p.catch(() => {});
  } catch { /* no motor, or the module is missing in this build */ }
}
