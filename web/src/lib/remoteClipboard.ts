import { useCallback, useEffect, useRef, useState } from 'react';
import type RFBType from '@novnc/novnc';

/**
 * Copy and paste between this device and a bot's screen or a paired PC (docs/remote-pc.md, "Copy and paste").
 *
 *   Paste: this device's clipboard goes onto the remote clipboard, then Ctrl+V is pressed there.
 *   Copy:  the remote clipboard comes onto this device's clipboard.
 *
 * Text only, and only when the person presses the button or the shortcut while driving (Ctrl/Cmd+V to paste,
 * Ctrl/Cmd+C to copy what they just copied there). Nothing is synced in the background. When the browser
 * won't read or write the clipboard (no permission, or not a secure page), a small box takes the text by
 * hand instead.
 */

export type ClipTarget = { kind: 'bot' | 'pc'; id: string };

const MAX_BYTES = 256 * 1024;
const CTRL: [number, string] = [0xffe3, 'ControlLeft'];

async function call(target: ClipTarget, method: 'GET' | 'PUT', text?: string): Promise<{ text?: string; cut?: boolean }> {
  const base = target.kind === 'bot' ? `/api/bots/${encodeURIComponent(target.id)}` : `/api/machines/${encodeURIComponent(target.id)}`;
  const res = await fetch(`${base}/clipboard`, {
    method,
    credentials: 'include',
    headers: method === 'PUT' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PUT' ? JSON.stringify({ text }) : undefined,
  });
  const body = await res.json().catch(() => ({} as { error?: string }));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Copy and paste failed (${res.status}).`);
  return body as { text?: string; cut?: boolean };
}

/** Press Ctrl + one letter on the remote screen. */
export function pressCtrl(rfb: RFBType | null, letter: 'c' | 'v') {
  if (!rfb) return;
  rfb.sendKey(CTRL[0], CTRL[1], true);
  rfb.sendKey(letter.charCodeAt(0), `Key${letter.toUpperCase()}`);
  rfb.sendKey(CTRL[0], CTRL[1], false);
}

export interface ManualBox { mode: 'paste' | 'copy'; text: string }

export interface RemoteClipboard {
  paste: () => void;
  copy: () => void;
  busy: boolean;
  note: string | null;
  /** The fallback box, when the browser won't touch the clipboard itself. */
  manual: ManualBox | null;
  setManualText: (text: string) => void;
  sendManual: () => void;
  closeManual: () => void;
}

/**
 * `enabled`: the person is driving (paste needs the keyboard and mouse to be theirs).
 * `scope`: the element whose focus means "this screen", for the keyboard shortcuts; none, no shortcuts.
 */
export function useRemoteClipboard(target: ClipTarget, rfb: () => RFBType | null, name: string, enabled: boolean, scope?: React.RefObject<HTMLElement | null>): RemoteClipboard {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualBox | null>(null);
  const lastSeen = useRef<string | null>(null);
  const targetKey = `${target.kind}:${target.id}`;

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);
  useEffect(() => { setManual(null); lastSeen.current = null; }, [targetKey, enabled]);

  const sendText = useCallback(async (text: string) => {
    if (!text) { setNote('Nothing to paste: this device’s clipboard is empty.'); return; }
    if (new Blob([text]).size > MAX_BYTES) { setNote('That is too much to paste at once (256 KB at most).'); return; }
    await call(target, 'PUT', text);
    lastSeen.current = text;
    pressCtrl(rfb(), 'v');
    setNote(`Pasted on ${name}’s screen`);
  }, [target.kind, target.id, rfb, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const paste = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      let text: string | null = null;
      try { text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : null; } catch { text = null; }
      if (text === null) { setManual({ mode: 'paste', text: '' }); return; }
      await sendText(text);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      rfb()?.focus();
    }
  }, [enabled, busy, sendText, rfb]);

  /** `quiet`: after a Ctrl+C there, only bring it over if it changed (Ctrl+C in a terminal copies nothing). */
  const fetchCopy = useCallback(async (quiet: boolean) => {
    const r = await call(target, 'GET');
    const text = r.text ?? '';
    if (quiet && (!text || text === lastSeen.current)) return;
    lastSeen.current = text;
    if (!text) { setNote(`Nothing is copied on ${name}’s screen yet. Select something there and press Ctrl+C first.`); return; }
    try {
      await navigator.clipboard.writeText(text);
      setNote(`Copied ${text.length.toLocaleString()} character${text.length === 1 ? '' : 's'} to this device${r.cut ? ' (cut at 256 KB)' : ''}`);
    } catch {
      setManual({ mode: 'copy', text });
    }
  }, [target.kind, target.id, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await fetchCopy(false); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }, [busy, fetchCopy]);

  // Shortcuts while driving and the screen has focus: Ctrl/Cmd+V pastes from this device; Ctrl/Cmd+C copies
  // there, then brings it here. Cmd becomes Ctrl, since the bots' screens and PCs use Ctrl.
  useEffect(() => {
    if (!enabled || !scope) return;
    const onKey = (e: KeyboardEvent) => {
      const el = scope.current;
      if (!el || !el.contains(document.activeElement)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k !== 'v' && k !== 'c') return;
      // On a Mac the screen already got Cmd as the Super key; let it go there first, so Ctrl+V/C lands alone.
      if (e.metaKey) { const r = rfb(); r?.sendKey(0xffeb, 'MetaLeft', false); r?.sendKey(0xffe7, 'MetaLeft', false); }
      if (k === 'v') {
        e.preventDefault(); e.stopPropagation();
        paste();
      } else if (k === 'c') {
        if (e.metaKey) { e.preventDefault(); e.stopPropagation(); pressCtrl(rfb(), 'c'); }
        // Ctrl+C itself goes on to the screen; give it a moment to land, then bring it over.
        setTimeout(() => { fetchCopy(true).catch(() => {}); }, 400);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, scope, paste, fetchCopy, rfb]);

  const sendManual = useCallback(async () => {
    if (!manual || manual.mode !== 'paste') { setManual(null); return; }
    setBusy(true);
    try { await sendText(manual.text); setManual(null); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); rfb()?.focus(); }
  }, [manual, sendText, rfb]);

  return {
    paste: () => { void paste(); },
    copy: () => { void copy(); },
    busy,
    note,
    manual,
    setManualText: (text) => setManual((m) => (m ? { ...m, text } : m)),
    sendManual: () => { void sendManual(); },
    closeManual: () => { setManual(null); rfb()?.focus(); },
  };
}
