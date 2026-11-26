import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { Icon } from './Icon';

/** A picture opened large over the app. Escape, the X or a click beside it closes; Download saves it. */
export function Lightbox() {
  const pic = useStore((s) => s.lightbox);
  useEffect(() => {
    if (!pic) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); useStore.getState().set({ lightbox: null }); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [pic]);
  if (!pic) return null;
  const close = () => useStore.getState().set({ lightbox: null });
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={pic.name} onClick={close}>
      <div className="lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox__name">{pic.name}</span>
        <a className="lightbox__btn" href={pic.download ?? pic.src} download={pic.name} title="Download" aria-label="Download"><Icon name="download" size={18} /></a>
        <button type="button" className="lightbox__btn" onClick={close} aria-label="Close" title="Close (Esc)" autoFocus><Icon name="close" size={18} /></button>
      </div>
      <img src={pic.src} alt={pic.name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
