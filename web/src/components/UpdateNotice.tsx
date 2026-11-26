import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useOutbox } from '../lib/outbox';
import { useVoice } from '../voice/call';

/** Is something going on that a reload would interrupt: a voice call, a message on its way, text being typed? */
const busyTyping = () => {
  if (useVoice.getState().status !== 'idle' || document.querySelector('.modal-root, .app-settings, .viewer, .lightbox')) return true;
  const el = document.activeElement as HTMLElement | null;
  const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) && !!((el as HTMLTextAreaElement).value ?? el.textContent ?? '').trim();
  return typing || useOutbox.getState().items.some((p) => p.state !== 'failed');
};

/**
 * "A new version is ready" after the server was updated under an open page (web and the Windows app, which
 * shows this same page). Nothing reloads while you are typing or a message is on its way; a page left in
 * the background reloads by itself, so the next look at it is already the new version.
 */
export function UpdateNotice() {
  const ready = useStore((s) => s.updateReady);
  const [later, setLater] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const quiet = () => { if (document.visibilityState === 'hidden' && !busyTyping()) window.location.reload(); };
    document.addEventListener('visibilitychange', quiet);
    return () => document.removeEventListener('visibilitychange', quiet);
  }, [ready]);
  if (!ready || later) return null;
  return (
    <div className="update-notice" role="status">
      <span>YBots was updated.</span>
      <button type="button" className="update-notice__go" onClick={() => window.location.reload()}>Reload</button>
      <button type="button" className="update-notice__later" onClick={() => setLater(true)} aria-label="Later" title="Later">×</button>
    </div>
  );
}
