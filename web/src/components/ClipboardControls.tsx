import { useEffect, useRef } from 'react';
import type { RemoteClipboard } from '../lib/remoteClipboard';
import { Icon } from './Icon';

/** Paste and Copy buttons for the bar under a screen being driven with a mouse and keyboard. */
export function ClipButtons({ clip, name, className = 'screen__chin-icon', withText = false }: { clip: RemoteClipboard; name: string; className?: string; withText?: boolean }) {
  return (
    <>
      <button type="button" className={className} onClick={clip.paste} disabled={clip.busy} aria-label={`Paste from this device onto ${name}’s screen`} title="Paste from this device (Ctrl+V)">
        <Icon name="paste" size={15} />{withText && <span>Paste here</span>}
      </button>
      <button type="button" className={className} onClick={clip.copy} disabled={clip.busy} aria-label={`Copy from ${name}’s screen to this device`} title="Copy to this device (Ctrl+C there)">
        <Icon name="copy" size={15} />{withText && <span>Copy to this device</span>}
      </button>
    </>
  );
}

/**
 * The fallback when the browser won't read or write the clipboard: a box to paste into by hand
 * (then Send), or the copied text, selected, to copy by hand. Plus the short note after each action.
 */
export function ClipOverlay({ clip, name }: { clip: RemoteClipboard; name: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const m = clip.manual;
  useEffect(() => {
    if (!m) return;
    ref.current?.focus();
    if (m.mode === 'copy') ref.current?.select();
  }, [m?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return clip.note ? <div className="clip-note" role="status">{clip.note}</div> : null;
  return (
    <div className="clip-box" role="dialog" aria-label={m.mode === 'paste' ? `Paste onto ${name}’s screen` : `Copied from ${name}’s screen`}>
      <div className="clip-box__title">{m.mode === 'paste' ? `Paste here, then Send to ${name}` : `Copied from ${name}. Copy it from here`}</div>
      <textarea
        ref={ref}
        className="clip-box__text"
        value={m.text}
        readOnly={m.mode === 'copy'}
        onChange={(e) => clip.setManualText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') clip.closeManual(); if (m.mode === 'paste' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) clip.sendManual(); }}
        placeholder={m.mode === 'paste' ? 'Paste text here' : undefined}
        rows={4}
      />
      <div className="clip-box__actions">
        <button type="button" className="clip-box__btn" onClick={clip.closeManual}>{m.mode === 'paste' ? 'Cancel' : 'Done'}</button>
        {m.mode === 'paste' && <button type="button" className="clip-box__btn is-primary" onClick={clip.sendManual} disabled={clip.busy || !m.text}>Send</button>}
      </div>
    </div>
  );
}
