import { useEffect, useRef, useState } from 'react';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { SIDE_DEFAULT, SIDE_MIN, sideMax, snapSide, type SideKind } from '../lib/paneWidths';
import { useLayout, type Layout } from '../lib/useLayout';

export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => { const r = () => setW(window.innerWidth); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  return w;
}

/** The side panel showing on the right (null when none), and its saved width. */
export function useSidePanel(): { kind: SideKind; saved: number } | null {
  const filesOpen = useStore((s) => s.filesOpen);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const chatFull = useStore((s) => s.chatFull);
  const inChat = useConfigUI((s) => s.view === 'chat');
  const detailsWidth = useStore((s) => s.detailsWidth);
  const filesWidth = useStore((s) => s.filesWidth);
  if (!hasBot || !inChat || chatFull || !(filesOpen || detailsOpen)) return null;
  return filesOpen ? { kind: 'files', saved: filesWidth } : { kind: 'details', saved: detailsWidth };
}

/** The list's drawn width, read off the page (it tweens, so the store's saved width can be ahead of it). */
const listWidthNow = () => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0;

/** How wide the side panel shows in this window: its saved width, narrowed so the chat keeps CHAT_MIN. */
export function sideShown(layout: Layout, windowWidth: number, saved: number, listWidth: number): number {
  return Math.min(saved, sideMax(layout, windowWidth, listWidth));
}

/**
 * The edge between the chat and the side panel (details or files). Drag it like the list's edge: wider to
 * the left, narrower to the right; let go near the right edge and the panel closes (its width is kept for
 * next time, and the file pane keeps its tab and open file). Double-click or Enter puts it back to its
 * usual width; arrow keys move it, Home and End go to the narrowest and widest.
 *
 * While dragging, only the CSS variable on the app changes (no React render per frame); the width is
 * saved when the drag ends.
 */
export function SideResizer({ kind, width }: { kind: SideKind; width: number }) {
  const layout = useLayout();
  const winW = useWindowWidth();
  const set = useStore((s) => s.set);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const max = () => sideMax(layout, winW, listWidthNow());
  const field = kind === 'files' ? 'filesWidth' : 'detailsWidth';
  const save = (v: number) => {
    const t = snapSide(v, max());
    if (t === 0) set(kind === 'files' ? { filesOpen: false } : { detailsOpen: false });
    else set({ [field]: t });
  };
  const show = (v: number) => {
    document.querySelector<HTMLElement>('.app')?.style.setProperty('--side-w', `${Math.round(v)}px`);
    if (ref.current) ref.current.style.right = `${Math.max(0, v - 5)}px`;
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = width, hi = max();
    let last = w0, moved = false, raf = 0;
    setDragging(true);
    document.body.classList.add('is-resizing-sidebar');
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      last = Math.min(Math.max(w0 - (ev.clientX - x0), 0), hi);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; show(last); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      document.body.classList.remove('is-resizing-sidebar');
      setDragging(false);
      // Put the drawn width back to what React knows, then save: the saved width re-renders it in place.
      show(width);
      if (moved) save(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const reset = () => set({ [field]: SIDE_DEFAULT[kind] });
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === 'ArrowLeft') set({ [field]: Math.min(width + step, max()) });
    else if (e.key === 'ArrowRight') { if (width - step < SIDE_MIN) save(0); else set({ [field]: width - step }); }
    else if (e.key === 'Home') set({ [field]: Math.min(SIDE_MIN, max()) });
    else if (e.key === 'End') set({ [field]: max() });
    else if (e.key === 'Enter') reset();
    else return;
    e.preventDefault();
  };
  return (
    <div ref={ref} className={`side-resizer${dragging ? ' is-dragging' : ''}`} style={{ right: Math.max(0, width - 5) }}
      role="separator" aria-orientation="vertical" aria-label={kind === 'files' ? 'Resize the files panel' : 'Resize the details panel'}
      aria-valuemin={SIDE_MIN} aria-valuemax={Math.round(max())} aria-valuenow={Math.round(width)} tabIndex={0}
      title="Drag to resize. Double-click for the usual width." onPointerDown={onDown} onDoubleClick={reset} onKeyDown={onKey}>
      <span className="sidebar__grip" />
    </div>
  );
}
