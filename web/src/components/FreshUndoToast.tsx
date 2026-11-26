import { useEffect, useState } from 'react';
import { useStore } from '../store';

/**
 * "New conversation" starts at once, without a confirm step, and this toast offers Undo for a few seconds
 * (the same pattern as the plugin switches). Undo brings the earlier chat back; the server refuses once
 * something has been said in the new one.
 */
export function FreshUndoToast() {
  const undo = useStore((s) => s.freshUndo);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    setError(null);
    const t = setTimeout(() => { if (useStore.getState().freshUndo === undo) useStore.getState().set({ freshUndo: null }); }, Math.max(0, undo.until - Date.now()));
    return () => clearTimeout(t);
  }, [undo]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);
  if (!undo && !error) return null;
  return (
    <div className="undo-toast undo-toast--above-composer" role="status" aria-live="polite">
      <span>{error ?? `New conversation. Cleared ${undo!.name}.`}</span>
      {!error && <button type="button" className="undo-toast__btn" onClick={() => { useStore.getState().undoFresh().catch((e) => setError((e as Error).message)); }}>Undo</button>}
    </div>
  );
}
