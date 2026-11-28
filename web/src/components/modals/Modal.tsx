import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Open dialogs, newest last. Only the topmost one answers Escape and keeps Tab inside itself, so one
// Escape closes one layer, and focus never wanders to the page behind.
const stack: symbol[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 50% black scrim + centered dialog. Escape and scrim click close; Tab stays inside; focus returns to what opened it. */
export function Modal({ onClose, children, className, label, top }: { onClose: () => void; children: ReactNode; className?: string; label: string; top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const id = Symbol('modal');
    stack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k, true);
    const t = setTimeout(() => {
      // A field that took focus on its own (React's autoFocus sets no attribute) keeps it; otherwise the
      // first field, and the close button only when there is nothing else.
      if (ref.current?.contains(document.activeElement)) return;
      const el = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
        ?? ref.current?.querySelector<HTMLElement>('button:not(.modal__close):not([disabled])')
        ?? ref.current?.querySelector<HTMLElement>('button');
      el?.focus();
    });
    return () => {
      window.removeEventListener('keydown', k, true);
      clearTimeout(t);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, []);
  return createPortal(
    <div className="modal-root">
      <div className="modal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} style={top !== undefined ? { marginTop: top } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
