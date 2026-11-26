import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, CheckSquare, ChartColumn, FileText, ListChecks, Pencil, Pin, PinOff, Search, Table2, Trash } from 'lucide-react';
import type { Bot, PageShelfItem } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { openFile } from '../files/FilePane';

/**
 * The Pages tab: the bot's Pages (server/src/page-shelf.ts), the living documents and calculators it made or
 * you saved from a chat answer. Tap one to use it in the file pane; it keeps working there (ticks, forms,
 * calculators, buttons that send into the chat it came from). Pin, rename, search, and delete with Undo.
 * The Library tab keeps the bot's other files. Android has the same list (mobile/src/screens/Pages.tsx).
 */

const KIND: Record<PageShelfItem['kind'], { icon: typeof FileText; label: string }> = {
  calculator: { icon: Calculator, label: 'Calculator' },
  chart: { icon: ChartColumn, label: 'Chart' },
  form: { icon: CheckSquare, label: 'Form' },
  checklist: { icon: ListChecks, label: 'Checklist' },
  table: { icon: Table2, label: 'Table' },
  doc: { icon: FileText, label: 'Page' },
};

export const originText = (p: PageShelfItem) =>
  !p.origin ? '' : p.origin.kind === 'view' ? `saved from ${p.origin.chatTitle}` : p.origin.kind === 'person' ? `made by you in ${p.origin.chatTitle}` : `made in ${p.origin.chatTitle}`;

export function PagesTab({ bot }: { bot: Bot }) {
  const [pages, setPages] = useState<PageShelfItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  const openPath = useStore((s) => (s.filesOpen ? s.filesPath : null));

  const load = useCallback(async () => {
    try { setPages((await configApi.pageList(bot.id)).pages); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [bot.id]);
  useEffect(() => { setPages(null); setQ(''); setUndo(null); load(); }, [load]);
  useEffect(() => {
    let t: number | undefined;
    const on = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if ((ev?.type === 'pages' || ev?.type === 'page') && ev.botId === bot.id) { window.clearTimeout(t); t = window.setTimeout(load, 400); }
    };
    window.addEventListener('cleftbot:event', on);
    return () => { window.removeEventListener('cleftbot:event', on); window.clearTimeout(t); };
  }, [bot.id, load]);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!pages || !words.length) return pages ?? [];
    return pages.filter((p) => { const hay = `${p.title} ${p.snippet} ${KIND[p.kind].label}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [pages, q]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  const pin = (p: PageShelfItem) => {
    setPages((l) => l && l.map((x) => (x.path === p.path ? { ...x, pinned: !p.pinned } : x)));
    act(() => configApi.pagePin(bot.id, p.path, !p.pinned));
  };
  const remove = (p: PageShelfItem) => {
    setPages((l) => l && l.filter((x) => x.path !== p.path));
    act(async () => {
      const r = await configApi.pageDelete(bot.id, p.path);
      if (openPath === p.path) useStore.getState().set({ filesPath: null });
      setUndo({ id: r.id, title: p.title });
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 10_000);
    });
  };
  const undoDelete = () => {
    if (!undo) return;
    const id = undo.id;
    setUndo(null);
    act(() => configApi.pageUndelete(bot.id, id));
  };
  const rename = (p: PageShelfItem, title: string) => {
    setRenaming(null);
    const t = title.trim();
    if (!t || t === p.title) return;
    setPages((l) => l && l.map((x) => (x.path === p.path ? { ...x, title: t } : x)));
    act(() => configApi.pageRename(bot.id, p.path, t));
  };

  return (
    <div className="details__sections">
      <section>
        {undo && (
          <div className="pages-undo" role="status">
            <span>Deleted “{undo.title}”</span>
            <button type="button" className="link-btn link-btn--small" onClick={undoDelete}>Undo</button>
          </div>
        )}
        {!!pages?.length && pages.length > 3 && (
          <label className="pages-search">
            <Search size={14} aria-hidden />
            <input type="search" placeholder="Search Pages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Pages" />
          </label>
        )}
        <div className="panel-card">
          {!pages && !error ? (
            <div className="panel-empty">Looking for Pages…</div>
          ) : !pages?.length ? (
            <div className="panel-empty panel-empty--center">
              Interactive pages {bot.name} makes, like calculators, checklists and plans, are kept here. Use “Save to Pages” under an answer to keep one.
            </div>
          ) : !shown.length ? (
            <div className="panel-empty panel-empty--center">No Page matches “{q}”.</div>
          ) : shown.map((p) => {
            const K = KIND[p.kind];
            const Ico = K.icon;
            return (
              <div key={p.path} className={`lib-row pages-row${openPath === p.path ? ' is-open' : ''}`}>
                {renaming === p.path ? (
                  <form className="pages-rename" onSubmit={(e) => { e.preventDefault(); rename(p, (e.currentTarget.elements.namedItem('t') as HTMLInputElement).value); }}>
                    <input name="t" className="page-input" defaultValue={p.title} autoFocus onBlur={(e) => rename(p, e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }} aria-label="Page name" />
                  </form>
                ) : (
                  <button type="button" className="lib-row__main" onClick={() => openFile(p.path, 'all')} title={p.snippet || `Open ${p.title}`}>
                    <span className="lib-row__icon"><Ico size={16} strokeWidth={1.8} aria-hidden /></span>
                    <span className="panel-row__text">
                      <span className="panel-row__title">{p.pinned && <Pin size={11} aria-label="Pinned" className="pages-row__pin" />}{p.title}</span>
                      <span className="panel-row__meta">{K.label} · {relativeShort(p.updatedAt) === 'now' ? 'just now' : relativeShort(p.updatedAt)}{p.origin ? ` · ${originText(p)}` : ''}</span>
                    </span>
                  </button>
                )}
                <span className="pages-row__tools">
                  <button type="button" className="cfg-icon-btn" onClick={() => pin(p)} aria-label={p.pinned ? `Unpin ${p.title}` : `Pin ${p.title}`} title={p.pinned ? 'Unpin' : 'Pin to the top'}>
                    {p.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
                  </button>
                  <button type="button" className="cfg-icon-btn" onClick={() => setRenaming(p.path)} aria-label={`Rename ${p.title}`} title="Rename"><Pencil size={14} aria-hidden /></button>
                  <button type="button" className="cfg-icon-btn" onClick={() => remove(p)} aria-label={`Delete ${p.title}`} title="Delete"><Trash size={14} aria-hidden /></button>
                </span>
              </div>
            );
          })}
        </div>
        {error && <div className="cfg-error cfg-error--small">{error}</div>}
      </section>
    </div>
  );
}
