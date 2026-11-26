import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type RFBType from '@novnc/novnc';
import { Icon } from './Icon';
import type { RemoteClipboard } from '../lib/remoteClipboard';

/*
 * Driving a bot's screen from a phone or tablet.
 *
 * noVNC already turns touches into mouse input on the picture: tap clicks, a two-finger tap or a long press
 * right-clicks, dragging one finger drags with the left button, dragging two fingers scrolls and a pinch
 * sends Ctrl+scroll (zoom in the remote app). What a touchscreen lacks is a keyboard and a way to see small
 * text, so this adds a bar under the picture with:
 *   - Keyboard: a hidden text box that brings up the phone's keyboard and forwards what is typed.
 *   - Keys: Esc, Tab, Ctrl, Alt, arrows and the other keys a phone keyboard does not have.
 *   - Zoom: the picture at its real size, panned with one finger (taps still click).
 *   - Help: the gestures above.
 */

const COARSE = '(pointer: coarse)';
const coarseQ = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(COARSE) : null;
const subscribeCoarse = (cb: () => void) => { coarseQ?.addEventListener('change', cb); return () => coarseQ?.removeEventListener('change', cb); };

/** True on a touchscreen without a mouse: phones and tablets. */
export function useTouchScreen(): boolean {
  return useSyncExternalStore(subscribeCoarse, () => !!coarseQ?.matches, () => false);
}

/** X11 keysyms for the keys we send by name. */
const KEY = {
  Return: 0xff0d, BackSpace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Super: 0xffeb, F1: 0xffbe,
} as const;

/** Browser `KeyboardEvent.key` → [keysym, KeyboardEvent.code] for keys that do not type a character. */
const NAMED: Record<string, [number, string]> = {
  Enter: [KEY.Return, 'Enter'], Backspace: [KEY.BackSpace, 'Backspace'], Tab: [KEY.Tab, 'Tab'], Escape: [KEY.Escape, 'Escape'],
  Delete: [KEY.Delete, 'Delete'], Home: [KEY.Home, 'Home'], End: [KEY.End, 'End'], PageUp: [KEY.PageUp, 'PageUp'], PageDown: [KEY.PageDown, 'PageDown'],
  ArrowLeft: [KEY.Left, 'ArrowLeft'], ArrowUp: [KEY.Up, 'ArrowUp'], ArrowRight: [KEY.Right, 'ArrowRight'], ArrowDown: [KEY.Down, 'ArrowDown'],
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = [KEY.F1 + i - 1, `F${i}`];

/** The keysym for one typed character: Latin-1 keysyms equal the code point, everything else uses X11's Unicode range. */
export function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

type Mod = 'ctrl' | 'alt' | 'shift' | 'super';
const MOD_KEY: Record<Mod, [number, string]> = {
  ctrl: [KEY.Control, 'ControlLeft'], alt: [KEY.Alt, 'AltLeft'], shift: [KEY.Shift, 'ShiftLeft'], super: [KEY.Super, 'MetaLeft'],
};

/*
 * The hidden text box holds a run of filler characters with the caret at the end. Comparing its text before
 * and after each change tells us what the phone keyboard did, which also covers autocorrect, swipe typing
 * and Android keyboards that report every key as "Unidentified": characters removed become Backspaces,
 * characters added are typed. The filler means Backspace still has something to delete.
 */
const FILLER = '_'.repeat(40);

interface BarProps {
  /** The live noVNC connection, if any. */
  rfb: () => RFBType | null;
  zoom: boolean;
  onZoom: (zoom: boolean) => void;
  /** Called when the phone keyboard opens or closes, so the screen stops taking focus while it is open. */
  onKeyboard: (open: boolean) => void;
  /** A note for the person, e.g. a sign-in to finish, shown above the bar. */
  hint?: string | null;
  /** Full screen and hand-back buttons, at the end of the bar. */
  trailing?: ReactNode;
  /** Copy and paste with this device (lib/remoteClipboard.ts), when the screen is connected. */
  clip?: RemoteClipboard;
}

/** The bar under a bot's screen while it is driven from a touchscreen. */
export function ScreenTouchBar({ rfb, zoom, onZoom, onKeyboard, hint, trailing, clip }: BarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const last = useRef(FILLER);
  const [kbOpen, setKbOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [mods, setMods] = useState<Record<Mod, boolean>>({ ctrl: false, alt: false, shift: false, super: false });
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const [help, setHelp] = useState(() => {
    try { return localStorage.getItem('cleft.screen.touchHelp') !== 'seen'; } catch { return true; }
  });

  const closeHelp = () => {
    setHelp(false);
    try { localStorage.setItem('cleft.screen.touchHelp', 'seen'); } catch { /* private window */ }
  };

  /** Press one key on the remote screen, holding any modifiers that are switched on, then switch them off. */
  const press = useCallback((keysym: number, code: string, extra: Partial<Record<Mod, boolean>> = {}) => {
    const r = rfb();
    if (!r) return;
    const held = (Object.keys(MOD_KEY) as Mod[]).filter((m) => modsRef.current[m] || extra[m]);
    for (const m of held) r.sendKey(MOD_KEY[m][0], MOD_KEY[m][1], true);
    r.sendKey(keysym, code);
    for (const m of held.reverse()) r.sendKey(MOD_KEY[m][0], MOD_KEY[m][1], false);
    if (held.some((m) => modsRef.current[m])) setMods({ ctrl: false, alt: false, shift: false, super: false });
  }, [rfb]);

  const typeText = useCallback((text: string) => {
    for (const ch of Array.from(text)) {
      if (ch === '\n') press(KEY.Return, 'Enter');
      else press(charKeysym(ch), '');
    }
  }, [press]);

  const reset = () => {
    const el = inputRef.current;
    if (!el) return;
    el.value = FILLER;
    last.current = FILLER;
    el.setSelectionRange(FILLER.length, FILLER.length);
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const now = el.value;
    const before = last.current;
    let same = 0;
    while (same < before.length && same < now.length && before[same] === now[same]) same++;
    const removed = before.length - same;
    for (let i = 0; i < removed; i++) press(KEY.BackSpace, 'Backspace');
    typeText(now.slice(same));
    last.current = now;
    const composing = (e.nativeEvent as InputEvent).isComposing;
    if (!composing && (now.length < 10 || now.length > 200 || now.includes('\n'))) reset();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
    const named = NAMED[e.key];
    const chord = e.ctrlKey || e.altKey || e.metaKey;
    if (named) {
      e.preventDefault();
      press(named[0], named[1], { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, super: e.metaKey });
    } else if (chord && e.key.length === 1) {
      // A hardware keyboard shortcut such as Ctrl+C.
      e.preventDefault();
      press(charKeysym(e.key), e.code, { ctrl: e.ctrlKey, alt: e.altKey, super: e.metaKey });
    }
  };

  // Tell the screen whether the keyboard is open. Focus state is the truth: the phone can close the keyboard itself.
  useEffect(() => { onKeyboard(kbOpen); }, [kbOpen, onKeyboard]);

  // A phone's own close-keyboard button (Android's down arrow or Back) hides the keyboard but leaves the text box
  // focused, so the Keyboard button would still read "on" and take two taps. The visible area grows back when that
  // happens: let go of the box then, which turns the button off. Only after the keyboard was seen to open, so a
  // computer with a real keyboard (no on-screen one) never loses focus this way.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!kbOpen || !vv) return;
    const start = vv.height;
    let low = start;
    const onResize = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return;
      low = Math.min(low, vv.height);
      if (low < start - 120 && vv.height > low + 120 && document.activeElement === inputRef.current) inputRef.current?.blur();
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [kbOpen]);

  const toggleKeyboard = () => {
    const el = inputRef.current;
    if (!el) return;
    if (document.activeElement === el) { el.blur(); return; }
    reset();
    // Must happen inside the tap itself, or iOS will not show the keyboard.
    el.focus({ preventScroll: true });
  };

  const toggleMod = (m: Mod) => setMods((s) => ({ ...s, [m]: !s[m] }));

  const keys: { label: string; aria?: string; run: () => void; mod?: Mod }[] = [
    { label: 'Esc', aria: 'Escape', run: () => press(KEY.Escape, 'Escape') },
    { label: 'Tab', run: () => press(KEY.Tab, 'Tab') },
    { label: 'Ctrl', run: () => toggleMod('ctrl'), mod: 'ctrl' },
    { label: 'Alt', run: () => toggleMod('alt'), mod: 'alt' },
    { label: 'Shift', run: () => toggleMod('shift'), mod: 'shift' },
    { label: 'Super', aria: 'Super (Windows key)', run: () => toggleMod('super'), mod: 'super' },
    { label: '←', aria: 'Left arrow', run: () => press(KEY.Left, 'ArrowLeft') },
    { label: '↑', aria: 'Up arrow', run: () => press(KEY.Up, 'ArrowUp') },
    { label: '↓', aria: 'Down arrow', run: () => press(KEY.Down, 'ArrowDown') },
    { label: '→', aria: 'Right arrow', run: () => press(KEY.Right, 'ArrowRight') },
    { label: 'Enter', run: () => press(KEY.Return, 'Enter') },
    { label: '⌫', aria: 'Backspace', run: () => press(KEY.BackSpace, 'Backspace') },
    { label: 'Del', aria: 'Delete', run: () => press(KEY.Delete, 'Delete') },
    { label: 'Home', run: () => press(KEY.Home, 'Home') },
    { label: 'End', run: () => press(KEY.End, 'End') },
    { label: 'PgUp', aria: 'Page up', run: () => press(KEY.PageUp, 'PageUp') },
    { label: 'PgDn', aria: 'Page down', run: () => press(KEY.PageDown, 'PageDown') },
    { label: 'Ctrl+C', aria: 'Copy (Ctrl+C)', run: () => press(charKeysym('c'), 'KeyC', { ctrl: true }) },
    { label: 'Ctrl+V', aria: 'Paste (Ctrl+V)', run: () => press(charKeysym('v'), 'KeyV', { ctrl: true }) },
    { label: 'Ctrl+Alt+Del', run: () => rfb()?.sendCtrlAltDel() },
  ];

  // Buttons in the bar must not take focus from the hidden text box, or the phone keyboard would close on every key.
  const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return (
    <div className="screen-touch">
      <textarea
        ref={inputRef}
        className="screen-touch__input"
        defaultValue={FILLER}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        aria-label="Type on the screen"
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={() => setKbOpen(true)}
        onBlur={() => setKbOpen(false)}
        onCompositionEnd={() => { const el = inputRef.current; if (el && el.value.length > 200) reset(); }}
      />

      {help && (
        <div className="screen-touch__help" role="note">
          <ul>
            <li><b>Tap</b> to click</li>
            <li><b>Hold</b> or <b>two-finger tap</b> to right-click</li>
            <li><b>Drag one finger</b> to drag{zoom ? ' (pans while zoomed)' : ''}</li>
            <li><b>Drag two fingers</b> to scroll</li>
            <li><b>Pinch</b> zooms inside the app on screen; the magnifier below enlarges the picture</li>
          </ul>
          <button type="button" className="screen-touch__help-ok" onClick={closeHelp}>Got it</button>
        </div>
      )}

      {keysOpen && (
        <div className="screen-touch__keys" role="toolbar" aria-label="Extra keys" onPointerDown={keepFocus} onMouseDown={keepFocus}>
          {keys.map((k) => (
            <button
              key={k.label}
              type="button"
              className={`screen-touch__key${k.mod && mods[k.mod] ? ' is-on' : ''}`}
              aria-label={k.aria}
              aria-pressed={k.mod ? mods[k.mod] : undefined}
              onClick={k.run}
            >{k.label}</button>
          ))}
        </div>
      )}

      {clipOpen && clip && (
        <div className="screen-touch__keys" role="toolbar" aria-label="Copy and paste" onPointerDown={keepFocus} onMouseDown={keepFocus}>
          <button type="button" className="screen-touch__key" disabled={clip.busy} onClick={clip.paste}>Paste from this phone</button>
          <button type="button" className="screen-touch__key" disabled={clip.busy} onClick={clip.copy}>Copy to this phone</button>
        </div>
      )}

      {hint && <div className="screen-touch__hint" role="status">{hint}</div>}

      {/* One slim row: icon buttons on the left, full screen and hand back on the right. */}
      <div className="screen-touch__bar" role="toolbar" aria-label="Touch controls" onPointerDown={keepFocus} onMouseDown={keepFocus}>
        <button type="button" className={`screen-touch__icon${kbOpen ? ' is-on' : ''}`} aria-label="Keyboard" aria-pressed={kbOpen} onClick={toggleKeyboard}>
          <Icon name="keyboard" size={18} />
        </button>
        <button type="button" className={`screen-touch__icon${keysOpen ? ' is-on' : ''}`} aria-label="Extra keys" aria-pressed={keysOpen} onClick={() => { setKeysOpen(!keysOpen); setClipOpen(false); }}>
          <Icon name="keys" size={16} />
        </button>
        {clip && (
          <button type="button" className={`screen-touch__icon${clipOpen ? ' is-on' : ''}`} aria-label="Copy and paste" aria-pressed={clipOpen} onClick={() => { setClipOpen(!clipOpen); setKeysOpen(false); }}>
            <Icon name="paste" size={16} />
          </button>
        )}
        <button type="button" className={`screen-touch__icon${zoom ? ' is-on' : ''}`} aria-label={zoom ? 'Fit the whole screen' : 'Zoom to real size'} aria-pressed={zoom} onClick={() => onZoom(!zoom)}>
          <Icon name={zoom ? 'zoom_out' : 'zoom_in'} size={17} />
        </button>
        <button type="button" className={`screen-touch__icon${help ? ' is-on' : ''}`} aria-label="Touch gestures" aria-pressed={help} onClick={() => (help ? closeHelp() : setHelp(true))}>
          <Icon name="help" size={16} />
        </button>
        <span className="screen-touch__spacer" />
        {trailing}
      </div>
    </div>
  );
}
