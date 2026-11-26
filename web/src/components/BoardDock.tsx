import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { CardBody, Row } from '@shared/types';
import { BOARD_TIMES, boardLine, boardState, stoppedBar, type BoardState } from '@shared/board-pin';
import { useStore } from '../store';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { ViewCard } from './cards/ViewCard';

/**
 * Pinned boards (server/src/board-pin.ts): a bot's progress or checklist view kept in reach just above the
 * message box, however far the chat has moved on. One line when closed (title, step, bar, %); open, it is
 * the live card itself, so ticks and updates are the same as in the chat. The original card stays where it
 * was. Several boards show as tabs, each with its bot's face (groups). Sam's view keeps it to one board
 * with only Hide. Windows loads this web UI; Android has the same dock (mobile/src/components/BoardDock.tsx).
 * The title and step are whole-phrase summaries (boardLine), allowed to wrap, never cut mid-word; the full
 * words are in the tooltip and the open board. A stopped board says so, has a Dismiss button and lets go
 * by itself after an hour.
 */

type Card = Extract<CardBody, { card: 'view' }>;
export type Board = { row: Row; body: Card; state: BoardState };

/** The pinned boards in a chat, newest change first. */
export function pinnedBoards(rows: Row[], now: number): Board[] {
  const out: Board[] = [];
  for (const row of rows) {
    const b = row.body;
    if (b.type !== 'card' || b.card !== 'view' || !b.pin?.on) continue;
    const state = boardState(b as any, row.createdAt, now);
    if (state) out.push({ row, body: b, state });
  }
  // Work still going first, then finished, then stopped; newest change first within each.
  const rank = (x: Board) => (x.state === 'stopped' ? 2 : x.state === 'done' ? 1 : 0);
  const last = (x: Board) => Math.max(x.body.updatedAt ?? 0, x.row.createdAt, x.body.pin?.at ?? 0);
  return out.sort((a, b) => rank(a) - rank(b) || last(b) - last(a));
}

/** What the strip says: whole-phrase title and step, and how far along (0 to 100). */
export const boardSummary = (body: Card, o?: { title?: number; step?: number }) => boardLine(body as any, o);

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

export function BoardDock({ rows, chatId, simple }: { rows: Row[]; chatId: string; simple?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const boards = useMemo(() => pinnedBoards(rows, now), [rows, now]);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [undo, setUndo] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bots = useStore((s) => s.bots);
  const chat = bots.find((b) => b.id === chatId);

  useEffect(() => { if (!undo) return; const t = window.setTimeout(() => setUndo(null), 6000); return () => window.clearTimeout(t); }, [undo]);
  useEffect(() => { setOpen(false); setPick(null); setUndo(null); }, [chatId]);

  const pin = async (row: Row, on: boolean) => {
    setError(null);
    try { await api.pinBoard(chatId, row, on); if (!on) setUndo(row); else setUndo(null); }
    catch (e) { setError((e as Error).message || 'That didn’t go through'); }
  };

  if (!boards.length) {
    if (!undo) return null;
    return (
      <div className="board-dock">
        <div className="board-strip is-undo" role="status">
          <span className="board-strip__title">Unpinned {(undo.body as Card).title || 'the board'}</span>
          <span className="board-strip__spacer" />
          <button type="button" className="link-btn link-btn--small" onClick={() => pin(undo, true)}>Undo</button>
        </div>
      </div>
    );
  }

  const list = simple ? boards.slice(0, 1) : boards;
  const current = list.find((b) => b.row.seq === pick) ?? list[0];
  const who = (b: Board) => (b.body.from ? bots.find((x) => x.id === b.body.from!.id) : chat) ?? chat;
  const face = (b: Board, size: number) => { const w = who(b); return w ? <BotAvatarFor bot={w} size={size} still /> : null; };
  const sum = boardSummary(current.body);
  const narrow = boardSummary(current.body, { title: 48 });
  const since = ago(now - Math.max(current.body.updatedAt ?? 0, current.row.createdAt));
  const stop = stoppedBar(current.body.blocks as any);
  const leftMin = stop ? Math.max(1, Math.ceil((BOARD_TIMES.stoppedMs - (now - Math.max(stop.stopped!.at, current.body.pin?.at ?? 0))) / 60_000)) : 0;
  const stateText = current.state === 'done' ? 'Done' : current.state === 'stopped' ? `Stopped ${since}` : current.state === 'paused' ? `Paused · no update ${since}` : `Updated ${since}`;
  const stepText = current.state === 'done' ? 'All done' : sum.step;
  const tip = [sum.fullTitle, sum.fullStep].filter(Boolean).join('\n');
  const pctText = current.state === 'done' ? 'Done' : `${sum.pct}%`;
  // Wide panes put the bar beside the words; a narrow pane (phone-width window or a squeezed split) puts it under them.
  const meter = (where: string) => (
    <span className={`board-strip__meter ${where}`}>
      <span className="board-bar" aria-hidden><span style={{ width: `${sum.pct}%` }} /></span>
      {!simple && <span className="board-strip__pct">{pctText}</span>}
    </span>
  );
  const jump = () => { setOpen(false); useStore.getState().focusMessage(chatId, current.row.seq); };

  if (!open) {
    return (
      <div className={`board-dock${simple ? ' is-simple' : ''}`}>
        <div className={`board-strip is-${current.state}`} style={botVars(who(current)?.avatarColor)}>
          <button type="button" className="board-strip__main" onClick={() => setOpen(true)} aria-expanded={false} title={tip}>
            <span className="board-strip__face">{face(current, simple ? 28 : 22)}</span>
            {!simple && <span className={`board-dot is-${current.state}`} aria-hidden />}
            <span className="board-strip__text">
              <span className="board-strip__title"><span className="is-wide">{sum.title}</span><span className="is-narrow">{narrow.title}</span></span>
              {stepText && <span className="board-strip__step">{stepText}</span>}
              {sum.pct !== null && meter('is-narrow')}
            </span>
            {sum.pct !== null && meter('is-wide')}
          </button>
          {!simple && list.length > 1 && <button type="button" className="board-more" onClick={() => setOpen(true)} aria-label={`${list.length - 1} more boards`}>+{list.length - 1}<span className="is-wide"> more</span></button>}
          {simple || current.state === 'stopped'
            ? <button type="button" className="board-hide" onClick={() => pin(current.row, false)} title={current.state === 'stopped' ? `Goes away by itself in ${leftMin} min` : undefined}>{simple ? 'Hide' : 'Dismiss'}</button>
            : <>
              <button type="button" className="board-ibtn is-wide" onClick={() => setOpen(true)} aria-label="Open the board" title="Open"><ChevronUp size={15} /></button>
              <button type="button" className="board-ibtn" onClick={() => pin(current.row, false)} aria-label="Unpin" title="Unpin"><X size={15} /></button>
            </>}
        </div>
        {error && <div className="board-dock__error">{error}</div>}
      </div>
    );
  }

  return (
    <div className={`board-dock is-open${simple ? ' is-simple' : ''}`}>
      <div className="board-panel" style={botVars(who(current)?.avatarColor)}>
        {list.length > 1 && (
          <div className="board-tabs" role="tablist">
            {list.map((b) => {
              const s = boardSummary(b.body, { title: 28 });
              return (
                <button key={b.row.seq} type="button" role="tab" aria-selected={b === current} className={`board-tab${b === current ? ' is-on' : ''}`} onClick={() => setPick(b.row.seq)} title={s.fullTitle}>
                  {face(b, 20)}<span>{s.title}{s.pct !== null ? ` · ${b.state === 'done' ? 'Done' : b.state === 'stopped' ? 'Stopped' : `${s.pct}%`}` : ''}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="board-panel__head">
          {face(current, 22)}
          <span className="board-panel__title">{sum.fullTitle}</span>
          <span className={`board-dot is-${current.state}`} aria-hidden />
          <span className="board-panel__state">{stateText}</span>
          <span className="board-strip__spacer" />
          <button type="button" className="board-ibtn" onClick={() => setOpen(false)} aria-label="Close the board" title="Close"><ChevronDown size={15} /></button>
        </div>
        <div className="board-panel__body">
          <ViewCard row={current.row} body={current.body} docked />
        </div>
        <div className="board-panel__foot">
          <button type="button" className="link-btn link-btn--small" onClick={jump}><ArrowUp size={12} aria-hidden /> Jump to message</button>
          <span className="board-strip__spacer" />
          <span className="board-panel__note">{current.state === 'done' ? 'Unpins itself in a few minutes' : current.state === 'stopped' ? `Goes away by itself in ${leftMin} min` : 'Stays here until every step is done'}</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => pin(current.row, false)}>{simple ? 'Hide' : current.state === 'stopped' ? 'Dismiss' : 'Unpin'}</button>
        </div>
        {error && <div className="board-dock__error">{error}</div>}
      </div>
    </div>
  );
}
