import { useEffect, useRef, type ReactNode } from 'react';

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hint?: string; /** A thin line above this item. */ divider?: boolean }

/**
 * Small popover menu anchored by its parent (position: relative). Closes on outside click / Escape.
 * The arrow keys, Home and End move through the items; focus starts on the first one and goes back
 * to whatever opened the menu when it closes.
 */
export function Menu({ items, onClose, align = 'left', placement = 'below', children }: { items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' | 'center'; placement?: 'below' | 'above'; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The caller's onClose is a new function on each of its renders; keeping the newest in a ref lets the
  // listeners (and the first-item focus) be set up once per open.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onClose = () => closeRef.current();
    const opener = document.activeElement as HTMLElement | null;
    const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu__item') ?? [])];
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); opener?.focus?.(); return; }
      const list = buttons();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
      else if (e.key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      else if (e.key === 'Tab') { onClose(); return; }
      if (next >= 0) { e.preventDefault(); e.stopPropagation(); list[next].focus(); }
    };
    const t = setTimeout(() => { document.addEventListener('mousedown', down); buttons()[0]?.focus({ preventScroll: true }); });
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, []);
  return (
    <div ref={ref} className={`menu is-${align} is-${placement}`} role="menu">
      {children}
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" className={`menu__item${it.danger ? ' is-danger' : ''}${it.divider ? ' has-divider' : ''}`} onClick={() => { onClose(); it.onSelect(); }}>
          <span>{it.label}</span>
          {it.hint && <span className="menu__hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
