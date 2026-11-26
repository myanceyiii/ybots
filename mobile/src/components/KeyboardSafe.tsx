import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Keyboard, View, type ViewStyle } from 'react-native';

/**
 * How far the phone keyboard reaches into a view. Android draws the app edge to edge, so the window does
 * not always shrink when the keyboard opens and a screen has to make room itself. Measuring the view
 * against the keyboard's top works either way: if Android already shrank the window, the overlap is 0.
 */
export function useKeyboardInset() {
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  const [inset, setInset] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setOpen(true);
      ref.current?.measureInWindow((_x, y, _w, h) => setInset(Math.max(0, Math.round(y + h - e.endCoordinates.screenY))));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => { setOpen(false); setInset(0); });
    return () => { show.remove(); hide.remove(); };
  }, []);
  return { ref, inset, open };
}

/** A screen that keeps its bottom (a composer, a bar) above the phone keyboard. */
export function KeyboardSafe({ style, children, onKeyboard }: { style?: ViewStyle; children: React.ReactNode; onKeyboard?: (open: boolean) => void }) {
  const { ref, inset, open } = useKeyboardInset();
  useEffect(() => { onKeyboard?.(open); }, [open, onKeyboard]);
  return <View ref={ref} style={[{ flex: 1 }, style, { paddingBottom: inset }]}>{children}</View>;
}

/**
 * A text field inside a chat card (a secure input, a form, a skill to edit) calls this when it gets focus, so the
 * chat scrolls the field and the buttons under it above the keyboard. The keyboard may already be open (moving
 * from the message box to a card), when no keyboard event comes, so focus is the signal. Outside a chat: nothing.
 */
export const RevealFocused = createContext<() => void>(() => {});
export const useRevealOnFocus = () => useContext(RevealFocused);
