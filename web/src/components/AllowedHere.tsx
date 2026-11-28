import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Row } from '@shared/types';
import { allowedHere, allowedHereLine } from '@shared/allowed-here';
import { api } from '../lib/api';

/**
 * "Allow for this conversation" (server/src/conversation-allows.ts): one quiet line above the message box
 * saying what this conversation allows without asking, with Turn off. It ends by itself with a new
 * conversation. Windows loads this web UI; Android has the same line (mobile/src/components/AllowedHere.tsx).
 */
export function AllowedHere({ rows, chatId }: { rows: Row[]; chatId: string }) {
  const list = useMemo(() => allowedHere(rows), [rows]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!list.length) return null;
  const all = [...new Set(list.map((a) => a.label))].join('\n');
  const off = async () => {
    setBusy(true); setError(null);
    try { await api.turnOffAllowedHere(chatId); }
    catch (e) { setError((e as Error).message || 'That didn’t go through'); }
    finally { setBusy(false); }
  };
  return (
    <div className="allowed-here" role="status">
      <div className="allowed-here__line" title={all}>
        <ShieldCheck size={14} aria-hidden />
        <span className="allowed-here__text">{allowedHereLine(list)}</span>
        <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={off}>Turn off</button>
      </div>
      {error && <div className="board-dock__error">{error}</div>}
    </div>
  );
}
