import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Clock, FileDown, Plus, RotateCcw, Send, Trash, Undo2 } from 'lucide-react';
import type { Bot, Page, PageBlock, PageOp, PageVersionInfo } from '@shared/types';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '@shared/page-chart';
import { useIsDark } from '../../configStore';
import { api } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { downloadBotFile, openFile } from './FilePane';
import { ViewCalc, type Change } from '../cards/ViewCard';
import { calcMessage } from '@shared/calc-block';

/**
 * A Page in the file pane: blocks the bot writes and you edit alongside it (server/src/pages.ts).
 * Every edit goes to the server as a small change; the server numbers it, keeps the history and tells every
 * open copy, so the bot's changes appear here as it writes them. A bot edit lands with a short highlight.
 * Buttons and forms only send a chat message as you. The Android app has the same screen (mobile/src/screens/PageScreen.tsx).
 */

type B = PageBlock & Record<string, any>;

const EXPORTS: { format: string; label: string; table?: boolean }[] = [
  { format: 'md', label: 'Markdown (.md)' },
  { format: 'docx', label: 'Word (.docx)' },
  { format: 'pdf', label: 'PDF' },
  { format: 'html', label: 'Web page (.html)' },
  { format: 'odt', label: 'OpenDocument (.odt)' },
  { format: 'txt', label: 'Plain text (.txt)' },
  { format: 'csv', label: 'Table as CSV', table: true },
  { format: 'xlsx', label: 'Table as Excel (.xlsx)', table: true },
];

export const NEW_BLOCKS: { type: string; label: string; block: Record<string, unknown> }[] = [
  { type: 'text', label: 'Text', block: { type: 'text', md: '' } },
  { type: 'heading', label: 'Heading', block: { type: 'heading', text: 'Heading', level: 2 } },
  { type: 'checklist', label: 'Checklist', block: { type: 'checklist', items: [{ text: '', done: false }] } },
  { type: 'table', label: 'Table', block: { type: 'table', columns: ['Item', 'Amount'], rows: [['', '']] } },
  { type: 'callout', label: 'Note', block: { type: 'callout', tone: 'info', md: '' } },
  { type: 'choice', label: 'Choice', block: { type: 'choice', question: 'Which one?', options: ['Option 1', 'Option 2'] } },
  { type: 'toggle', label: 'Collapsible', block: { type: 'toggle', title: 'More', md: '' } },
  { type: 'code', label: 'Code', block: { type: 'code', lang: '', code: '' } },
  { type: 'divider', label: 'Divider', block: { type: 'divider' } },
];

export function PageViewer({ bot, path, onBack, onClose }: { bot: Bot; path: string; onBack: () => void; onClose: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [dest, setDest] = useState<{ sendTo?: string; sendToTitle?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [menu, setMenu] = useState<'export' | 'add' | null>(null);
  const [history, setHistory] = useState<PageVersionInfo[] | null>(null);
  const [peek, setPeek] = useState<Page | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const lastVersion = useRef(0);
  const [restoring, setRestoring] = useState(false);

  /** Apply a Page snapshot only if it is not older than what is shown (answers can arrive out of order). */
  const accept = useCallback((p: Page) => {
    if (p.version < lastVersion.current) return false;
    lastVersion.current = p.version;
    setPage(p);
    return true;
  }, []);

  const load = useCallback(async () => {
    try {
      const p = await configApi.page(bot.id, path);
      setDest({ sendTo: p.sendTo, sendToTitle: p.sendToTitle });
      if (p.version < lastVersion.current) return; // a newer change already arrived
      setPage((old) => {
        // Blocks the bot just changed get a short highlight, so you can see where it is working.
        if (old) {
          const changed = p.blocks.filter((b) => b.byKind === 'bot' && b.rev > old.version).map((b) => b.id);
          if (changed.length) {
            setFresh(new Set(changed));
            window.setTimeout(() => setFresh(new Set()), 4000);
          }
        }
        return p;
      });
      lastVersion.current = p.version;
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [bot.id, path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = (e: Event) => {
      const ev = (e as CustomEvent).detail;
      if (ev?.type === 'page' && ev.botId === bot.id && ev.path === path && ev.version > lastVersion.current) load();
    };
    window.addEventListener('cleftbot:event', on);
    return () => window.removeEventListener('cleftbot:event', on);
  }, [bot.id, path, load]);

  const ops = useCallback(async (list: PageOp[]) => {
    try {
      const r = await configApi.pageOps(bot.id, path, list);
      accept(r.page);
      const bad = r.results.find((x) => !x.ok && !x.conflict);
      if (bad) setNote({ text: bad.error ?? 'That change didn’t go in.', error: true });
      else if (r.results.some((x) => x.conflict)) setNote({ text: `${bot.name} changed that part just before you. Pick which version to keep on the block.` });
      return r;
    } catch (e) { setNote({ text: (e as Error).message, error: true }); return null; }
  }, [bot.id, path, bot.name, accept]);

  // Buttons and calculators send into the chat the Page came from (a side chat while it is there), else the main chat.
  const { sendTo, sendToTitle } = dest;
  const say = useCallback(async (text: string) => {
    try {
      await api.send(sendTo || bot.id, text);
      setNote({ text: `Sent to ${bot.name}${sendTo && sendTo !== bot.id && sendToTitle ? ` in “${sendToTitle}”` : ''}` });
      return true;
    }
    catch (e) { setNote({ text: `Couldn’t send it: ${(e as Error).message}`, error: true }); return false; }
  }, [bot.id, bot.name, sendTo, sendToTitle]);

  const doExport = async (format: string) => {
    setMenu(null);
    setNote({ text: 'Making the file…' });
    try {
      const f = await configApi.pageExport(bot.id, path, format);
      await downloadBotFile(bot.id, f.path, f.name);
      setNote({ text: `Downloaded ${f.name} (a copy is also saved beside the Page).` });
    } catch (e) { setNote({ text: `Couldn’t download it: ${(e as Error).message}`, error: true }); }
  };

  const undo = async () => {
    if (peek) return; // Undo works on the live Page, not on a version being looked at
    try { const p = await configApi.pageRestore(bot.id, path, 'undo'); accept(p); setNote({ text: 'Undone' }); }
    catch (e) { setNote({ text: (e as Error).message, error: true }); }
  };

  const pick = async (version: number) => {
    if (peek?.version === version) { setPeek(null); return; }
    try { setPeek(await configApi.pageVersion(bot.id, path, version)); }
    catch (e) { setNote({ text: `Couldn’t open version ${version}: ${(e as Error).message}`, error: true }); }
  };
  const restore = async (version: number) => {
    if (restoring) return;
    setRestoring(true);
    try {
      const p = await configApi.pageRestore(bot.id, path, version);
      accept(p); setPeek(null); setHistory(null); setNote({ text: `Restored version ${version}` });
    } catch (e) { setNote({ text: `Couldn’t restore version ${version}: ${(e as Error).message}`, error: true }); }
    finally { setRestoring(false); }
  };

  const showHistory = async () => {
    if (history) { setHistory(null); setPeek(null); return; }
    try { setHistory((await configApi.pageHistory(bot.id, path)).versions); } catch (e) { setNote({ text: (e as Error).message, error: true }); }
  };

  const hasTable = page?.blocks.some((b) => b.type === 'table');
  const shown = peek ?? page;

  return (
    <>
      <div className="files-pane__top files-pane__top--file">
        <button type="button" className="icon-btn icon-btn--plain" onClick={onBack} aria-label="Back" title="Back"><Icon name="chev_left" opacity={0.8} /></button>
        <div className="files-pane__name" title={path}>
          {peek ? <span>{peek.title}</span> : page ? <TitleEdit title={page.title} onSave={(title) => ops([{ op: 'title', title }])} /> : <span>{path.split('/').pop()}</span>}
        </div>
        <button type="button" className="icon-btn icon-btn--bordered" onClick={onClose} aria-label="Close files"><Icon name="close" opacity={0.92} /></button>
      </div>
      <div className="files-pane__actions page-actions">
        {page && <span className="file-row__meta">Page · v{page.version} · {relativeShort(page.updatedAt)}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--sm btn--secondary" onClick={undo} disabled={!!peek} title={peek ? 'Close the version you are looking at to undo' : 'Undo your last change'}><Undo2 aria-hidden size={13} strokeWidth={2} /> Undo</button>
        <button type="button" className={`btn btn--sm btn--secondary${history ? ' is-on' : ''}`} onClick={showHistory}><Clock aria-hidden size={13} strokeWidth={2} /> History</button>
        <span className="page-menu">
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'}><FileDown aria-hidden size={13} strokeWidth={2} /> Download as <ChevronDown aria-hidden size={12} /></button>
          {menu === 'export' && (
            <div className="page-menu__list" role="menu">
              {EXPORTS.filter((x) => !x.table || hasTable).map((x) => <button key={x.format} type="button" role="menuitem" onClick={() => doExport(x.format)}>{x.label}</button>)}
            </div>
          )}
        </span>
      </div>
      {note && <div className={`files-pane__note${note.error ? ' is-error' : ''}`} onClick={() => setNote(null)}>{note.text}</div>}
      {history && (
        <div className="page-history">
          {history.map((v) => (
            <div key={v.version} className={`page-history__row${peek?.version === v.version ? ' is-on' : ''}`}>
              <button type="button" className="page-history__pick" onClick={() => pick(v.version)}>
                <span className="page-history__who">{v.by}</span> {v.summary}
                <span className="file-row__meta"> · v{v.version} · {relativeShort(v.at)}</span>
              </button>
              {peek?.version === v.version && v.version !== page?.version && (
                <button type="button" className="btn btn--sm btn--secondary" disabled={restoring} onClick={() => restore(v.version)}>
                  <RotateCcw aria-hidden size={12} /> {restoring ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="details__scroll files-pane__body page-body">
        {error ? <div className="panel-empty">Couldn’t open it: {error}</div>
          : !shown ? <div className="panel-empty">Opening…</div>
          : (
            <>
              {peek && <div className="page-peek">Looking at version {peek.version}. Nothing here can be edited; pick Restore to bring it back.</div>}
              {!shown.blocks.length && <div className="files-empty">This Page is empty. Add a block below, or ask {bot.name} to fill it in.</div>}
              {shown.blocks.map((b, i) => (
                <BlockShell key={b.id} b={b as B} fresh={fresh.has(b.id)} readOnly={!!peek} first={i === 0} last={i === shown.blocks.length - 1}
                  onMove={(dir) => ops([{ op: 'move', id: b.id, after: dir < 0 ? (i <= 1 ? 'start' : shown.blocks[i - 2].id) : shown.blocks[i + 1].id }])}
                  onDelete={() => ops([{ op: 'delete', id: b.id }])}
                  onAddBelow={(block) => ops([{ op: 'insert', after: b.id, block }])}
                  onResolve={(keep) => ops([{ op: 'resolve', id: b.id, keep }])}>
                  <BlockBody b={b as B} page={shown} bot={bot} readOnly={!!peek} ops={ops} say={say} />
                </BlockShell>
              ))}
              {!peek && (
                <div className="page-add">
                  <button type="button" className="link-btn link-btn--small" onClick={() => setMenu(menu === 'add' ? null : 'add')}><Plus aria-hidden size={13} /> Add a block</button>
                  {menu === 'add' && <AddMenu onPick={(block) => { setMenu(null); ops([{ op: 'insert', after: 'end', block }]); }} />}
                </div>
              )}
            </>
          )}
      </div>
    </>
  );
}

function AddMenu({ onPick }: { onPick: (block: Record<string, unknown>) => void }) {
  return (
    <div className="page-addmenu" role="menu">
      {NEW_BLOCKS.map((x) => <button key={x.type} type="button" role="menuitem" onClick={() => onPick(x.block)}>{x.label}</button>)}
    </div>
  );
}

function TitleEdit({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [v, setV] = useState<string | null>(null);
  if (v === null) return <button type="button" className="page-title" onClick={() => setV(title)} title="Rename">{title}</button>;
  const done = () => { if (v.trim() && v !== title) onSave(v.trim()); setV(null); };
  return <input className="page-title-input" value={v} autoFocus onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setV(null); }} />;
}

function BlockShell({ b, fresh, readOnly, first, last, onMove, onDelete, onAddBelow, onResolve, children }: {
  b: B; fresh: boolean; readOnly: boolean; first: boolean; last: boolean;
  onMove: (dir: -1 | 1) => void; onDelete: () => void; onAddBelow: (block: Record<string, unknown>) => void; onResolve: (keep: 'mine' | 'theirs') => void; children: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className={`page-block page-block--${b.type}${fresh ? ' is-fresh' : ''}`} data-by={b.by}>
      {b.alt && !readOnly && (
        <div className="page-clash">
          <div>{b.by} changed this just before {b.alt.by}’s edit arrived. {b.alt.by}’s version:</div>
          <div className="page-clash__alt">{altPreview(b)}</div>
          <div className="page-clash__btns">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onResolve('mine')}>Keep {b.alt.by}’s</button>
            <button type="button" className="btn btn--sm btn--secondary" onClick={() => onResolve('theirs')}>Keep {b.by}’s</button>
          </div>
        </div>
      )}
      {children}
      {!readOnly && (
        <div className="page-block__tools" aria-label="Block tools">
          <button type="button" title="Move up" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}><ArrowUp size={13} /></button>
          <button type="button" title="Move down" aria-label="Move down" disabled={last} onClick={() => onMove(1)}><ArrowDown size={13} /></button>
          <button type="button" title="Add a block below" aria-label="Add a block below" onClick={() => setAdding(!adding)}><Plus size={13} /></button>
          <button type="button" title="Delete block" aria-label="Delete block" onClick={onDelete}><Trash size={13} /></button>
        </div>
      )}
      {adding && <AddMenu onPick={(block) => { setAdding(false); onAddBelow(block); }} />}
    </div>
  );
}

const altPreview = (b: B) => {
  const f: any = b.alt?.fields ?? {};
  return String(f.md ?? f.text ?? f.code ?? f.question ?? f.title ?? JSON.stringify(f)).slice(0, 400);
};

/** Text that turns into a box when clicked, and saves when you click away. */
function EditableText({ value, onSave, readOnly, multiline = true, placeholder, render }: { value: string; onSave: (v: string) => void; readOnly?: boolean; multiline?: boolean; placeholder?: string; render?: (v: string) => ReactNode }) {
  const [v, setV] = useState<string | null>(null);
  if (v === null || readOnly) {
    return (
      <div className={`page-editable${value ? '' : ' is-empty'}`} onClick={() => !readOnly && setV(value)} role={readOnly ? undefined : 'button'} tabIndex={readOnly ? undefined : 0}
        onKeyDown={(e) => { if (!readOnly && e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); setV(value); } }}>
        {value ? (render ? render(value) : value) : <span className="page-placeholder">{placeholder ?? 'Click to write'}</span>}
      </div>
    );
  }
  const done = () => { if (v !== value) onSave(v); setV(null); };
  return multiline
    ? <textarea className="page-input page-input--area" value={v} autoFocus onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Escape') setV(null); }} rows={Math.min(20, Math.max(3, v.split('\n').length + 1))} />
    : <input className="page-input" value={v} autoFocus onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setV(null); }} />;
}

/** A cell or field that saves when you leave it. */
function Cell({ value, onSave, readOnly, className, type = 'text' }: { value: string; onSave: (v: string) => void; readOnly?: boolean; className?: string; type?: string }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  return <input className={className ?? 'page-cell'} type={type} value={v} readOnly={readOnly}
    onFocus={() => { focused.current = true; }} onChange={(e) => setV(e.target.value)}
    onBlur={() => { focused.current = false; if (v !== value) onSave(v); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

function BlockBody({ b, page, bot, readOnly, ops, say }: { b: B; page: Page; bot: Bot; readOnly: boolean; ops: (l: PageOp[]) => Promise<unknown>; say: (t: string) => Promise<boolean> }) {
  const update = (set: Record<string, unknown>) => ops([{ op: 'update', id: b.id, base: b.rev, set }]);
  switch (b.type) {
    case 'text':
      return <EditableText value={b.md} readOnly={readOnly} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} />;
    case 'heading': {
      const H = (`h${Math.min(4, (b.level ?? 2) + 1)}`) as 'h2' | 'h3' | 'h4';
      return <H className="page-h"><EditableText value={b.text} readOnly={readOnly} multiline={false} onSave={(text) => update({ text })} /></H>;
    }
    case 'checklist':
      return <Checklist b={b} readOnly={readOnly} ops={ops} update={update} />;
    case 'table':
      return <Table b={b} readOnly={readOnly} ops={ops} update={update} />;
    case 'form':
      return <Form b={b} page={page} readOnly={readOnly} ops={ops} say={say} />;
    case 'choice':
      return (
        <div className="page-choice">
          <div className="page-choice__q">{b.question}</div>
          {b.options.map((o: string, i: number) => (
            <label key={i} className="page-check">
              <input type={b.multi ? 'checkbox' : 'radio'} name={b.id} disabled={readOnly} checked={b.picked.includes(i)}
                onChange={(e) => ops([{ op: 'pick', id: b.id, picked: b.multi ? (e.target.checked ? [...b.picked, i] : b.picked.filter((x: number) => x !== i)) : [i] }])} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      );
    case 'chart':
      return <Chart b={b} page={page} />;
    case 'callout':
      return <div className={`page-callout is-${b.tone}`}><EditableText value={b.md} readOnly={readOnly} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} /></div>;
    case 'button':
      return <PageButton label={b.label} disabled={readOnly} onPress={() => say(b.message || b.label)} />;
    case 'file':
      return /\.(png|jpe?g|gif|webp|bmp)$/i.test(b.path)
        ? <figure className="page-figure"><img src={configApi.fileRawUrl(bot.id, b.path)} alt={b.caption ?? ''} />{b.caption && <figcaption>{b.caption}</figcaption>}</figure>
        : <button type="button" className="page-filechip" onClick={() => openFile(b.path)}>{b.caption || b.path.split('/').pop()}</button>;
    case 'code':
      return <EditableText value={b.code} readOnly={readOnly} onSave={(code) => update({ code })} render={(v) => <pre className="files-text is-code">{v}</pre>} />;
    case 'toggle':
      return (
        <details className="page-toggle" open={b.open}>
          <summary>{b.title}</summary>
          <EditableText value={b.md} readOnly={readOnly} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} />
        </details>
      );
    case 'divider':
      return <hr className="page-hr" />;
    case 'calc':
      // The same calculator as in the chat (ViewCard): numbers save on the Page, Send posts them as you.
      return <ViewCalc b={b as any} change={async (c: Change) => {
        if (readOnly) return false;
        const values = c.values as Record<string, number> | undefined;
        if (c.op === 'calc') return !!(await ops([{ op: 'calc', id: b.id, values }]));
        if (c.op === 'send') {
          if (values) await ops([{ op: 'calc', id: b.id, values }]);
          return say(calcMessage({ ...b, values: values ?? b.values }, page.title && page.title !== b.title ? ` ("${page.title}")` : ''));
        }
        return false;
      }} />;
    default:
      return null;
  }
}

function Checklist({ b, readOnly, ops, update }: { b: B; readOnly: boolean; ops: (l: PageOp[]) => Promise<unknown>; update: (s: Record<string, unknown>) => unknown }) {
  const [adding, setAdding] = useState('');
  const done = b.items.filter((i: any) => i.done).length;
  return (
    <div className="page-checklist">
      {b.title !== undefined && <div className="page-choice__q"><EditableText value={b.title ?? ''} readOnly={readOnly} multiline={false} onSave={(title) => update({ title })} /></div>}
      {b.items.map((it: any) => (
        <div key={it.id} className={`page-check${it.done ? ' is-done' : ''}`}>
          <input type="checkbox" checked={it.done} disabled={readOnly} onChange={(e) => ops([{ op: 'check', id: b.id, item: it.id, done: e.target.checked }])} aria-label={it.text || 'item'} />
          <Cell value={it.text} readOnly={readOnly} className="page-check__text" onSave={(text) => (text ? ops([{ op: 'check', id: b.id, item: it.id, text }]) : ops([{ op: 'remove_item', id: b.id, item: it.id }]))} />
        </div>
      ))}
      {!readOnly && (
        <form className="page-check page-check--new" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) { ops([{ op: 'add_item', id: b.id, text: adding.trim() }]); setAdding(''); } }}>
          <Plus size={14} aria-hidden style={{ opacity: 0.5 }} />
          <input className="page-check__text" placeholder="Add an item" value={adding} onChange={(e) => setAdding(e.target.value)} />
        </form>
      )}
      {b.items.length > 1 && <div className="file-row__meta">{done} of {b.items.length} done</div>}
    </div>
  );
}

function Table({ b, readOnly, ops, update }: { b: B; readOnly: boolean; ops: (l: PageOp[]) => Promise<unknown>; update: (s: Record<string, unknown>) => unknown }) {
  const width = Math.max(b.columns.length, ...b.rows.map((r: string[]) => r.length), 1);
  const cols = Array.from({ length: width }, (_, i) => i);
  const total = useMemo(() => (b.total ? cols.map((i) => {
    if (i === 0) return 'Total';
    const nums = b.rows.map((r: string[]) => r[i]).filter((v: string) => v !== undefined && v !== '' && Number.isFinite(Number(String(v).replace(/[$,\s]/g, '')))).map((v: string) => Number(String(v).replace(/[$,\s]/g, '')));
    return nums.length ? String(+nums.reduce((a: number, c: number) => a + c, 0).toFixed(2)) : '';
  }) : null), [b.rows, b.total, width]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page-table">
      {b.title && <div className="page-choice__q">{b.title}</div>}
      <div className="files-table-wrap">
        <table className="files-table page-table__t">
          <thead><tr>{cols.map((i) => <th key={i}><Cell value={b.columns[i] ?? ''} readOnly={readOnly} onSave={(v) => { const c = [...b.columns]; while (c.length <= i) c.push(''); c[i] = v; update({ columns: c }); }} /></th>)}{!readOnly && <th className="page-table__x" />}</tr></thead>
          <tbody>
            {b.rows.map((r: string[], ri: number) => (
              <tr key={ri}>
                {cols.map((ci) => <td key={ci}><Cell value={r[ci] ?? ''} readOnly={readOnly} onSave={(value) => ops([{ op: 'cell', id: b.id, row: ri, col: ci, value }])} /></td>)}
                {!readOnly && <td className="page-table__x"><button type="button" aria-label="Remove row" title="Remove row" onClick={() => ops([{ op: 'remove_row', id: b.id, at: ri }])}>×</button></td>}
              </tr>
            ))}
            {total && <tr className="page-table__total">{total.map((v, i) => <th key={i}>{v}</th>)}{!readOnly && <td />}</tr>}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="page-table__more">
          <button type="button" className="link-btn link-btn--small" onClick={() => ops([{ op: 'add_row', id: b.id, values: [] }])}><Plus size={12} aria-hidden /> Row</button>
          <button type="button" className="link-btn link-btn--small" onClick={() => update({ columns: [...b.columns, `Column ${width + 1}`] })}><Plus size={12} aria-hidden /> Column</button>
          <label className="page-check page-check--inline"><input type="checkbox" checked={!!b.total} onChange={(e) => update({ total: e.target.checked })} /> Total row</label>
        </div>
      )}
    </div>
  );
}

function Form({ b, page, readOnly, ops, say }: { b: B; page: Page; readOnly: boolean; ops: (l: PageOp[]) => Promise<unknown>; say: (t: string) => Promise<boolean> }) {
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    const lines = b.fields.map((f: any) => `- ${f.label}: ${f.value || '(blank)'}`).join('\n');
    if (await say(`Form${b.title ? ` "${b.title}"` : ''} on the Page "${page.title}":\n${lines}`)) await ops([{ op: 'submitted', id: b.id }]);
    setSending(false);
  };
  return (
    <div className="page-form">
      {b.title && <div className="page-choice__q">{b.title}</div>}
      {b.fields.map((f: any) => (
        <label key={f.id} className="page-form__field">
          <span>{f.label}</span>
          {f.kind === 'choice'
            ? <select value={f.value} disabled={readOnly} onChange={(e) => ops([{ op: 'field', id: b.id, field: f.id, value: e.target.value }])}><option value="" />{(f.options ?? []).map((o: string) => <option key={o}>{o}</option>)}</select>
            : f.kind === 'longtext'
              ? <LongField value={f.value} readOnly={readOnly} onSave={(value) => ops([{ op: 'field', id: b.id, field: f.id, value }])} />
              : <Cell className="page-input" type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'} value={f.value} readOnly={readOnly} onSave={(value) => ops([{ op: 'field', id: b.id, field: f.id, value }])} />}
        </label>
      ))}
      <div className="page-form__send">
        <button type="button" className="btn btn--sm btn--primary" disabled={readOnly || sending} onClick={submit}><Send size={13} aria-hidden /> {sending ? 'Sending…' : b.submitLabel || 'Send'}</button>
        {b.submittedAt && <span className="file-row__meta">Sent {relativeShort(b.submittedAt)}</span>}
      </div>
    </div>
  );
}

function LongField({ value, onSave, readOnly }: { value: string; onSave: (v: string) => void; readOnly: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <textarea className="page-input page-input--area" rows={3} value={v} readOnly={readOnly} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />;
}

function PageButton({ label, onPress, disabled }: { label: string; onPress: () => Promise<boolean>; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  return (
    <button type="button" className="btn btn--sm btn--secondary page-button" disabled={disabled || state === 'busy'}
      onClick={async () => { setState('busy'); setState((await onPress()) ? 'sent' : 'idle'); window.setTimeout(() => setState('idle'), 2500); }}>
      {state === 'sent' ? <><Check size={13} aria-hidden /> Sent</> : label}
    </button>
  );
}

function Chart({ b, page }: { b: B; page: Page }) {
  // The same picture the exports use (server/src/page-chart.ts); every bit of text in it is escaped there.
  const dark = useIsDark();
  const svg = useMemo(() => chartSvg(b, page, 480, 280, dark ? CHART_DARK : CHART_LIGHT), [b, page, dark]);
  return <div className="page-chart" dangerouslySetInnerHTML={{ __html: svg }} />;
}
