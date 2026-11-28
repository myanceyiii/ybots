import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Check, Copy, ExternalLink, Eye, FileText, Pin, PinOff, Send } from 'lucide-react';
import type { CardBody, Row, ViewBlock } from '@shared/types';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '@shared/page-chart';
import { useConfigUI, useIsDark } from '../../configStore';
import { formatCalc, runCalc, type CalcInput, type CalcOutput } from '@shared/calc';
import { openFile } from '../files/FilePane';
import { safeUrl } from '@shared/plugins/ui-schema';
import { api } from '../../lib/api';
import { Markdown } from '../Markdown';
import { A2uiView } from './A2uiView';

/**
 * An answer view in the chat (server/src/views.ts): tables, charts, stats, checklists, picks, forms and
 * buttons a bot puts under its reply. Plain data drawn with fixed components; nothing in it runs.
 * Ticking, picking and typing save on the card; Send (or a single pick) posts a chat message as you.
 * The Android app draws the same card (mobile/src/components/ViewCard.tsx). Windows loads this web UI.
 */

type Card = Extract<CardBody, { card: 'view' }>;
type B = ViewBlock & Record<string, any>;
export type Change = Record<string, unknown> & { op: string; block: string };

/** `docked`: drawn inside the pinned-board dock above the message box (BoardDock), without its own title and buttons. */
export function ViewCard({ row, body, docked }: { row: Row; body: Card; docked?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saved, setSaved] = useState(false);
  // Settings › General › Answer visuals: Simple shows the text copy; each card can still show its visuals.
  const simple = useConfigUI((s) => s.answerVisuals) === 'simple';
  const [showVisuals, setShowVisuals] = useState(false);
  const change = async (c: Change) => {
    setError(null);
    try { await api.viewChange(row.botId, row, c); return true; } catch (e) { setError((e as Error).message || 'That didn’t go through'); return false; }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(body.text); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };
  const asPage = async () => {
    setError(null); setOpening(true);
    try { const r = await api.viewPage(row.botId, row); openFile(r.path); } catch (e) { setError((e as Error).message || 'Couldn’t make the Page'); } finally { setOpening(false); }
  };
  // Save to Pages: the same Page as Open as Page, kept in the bot's Pages tab without opening it now.
  const savePage = async () => {
    setError(null); setOpening(true);
    try { await api.viewPage(row.botId, row); setSaved(true); } catch (e) { setError((e as Error).message || 'Couldn’t save the Page'); } finally { setOpening(false); }
  };
  // Simple (Settings) starts as text; each card can still be switched either way, as on Android.
  const asText = simple !== showVisuals;
  // Pinned boards (server/src/board-pin.ts): pin any view to keep it above the message box, or unpin it.
  const pinned = !!body.pin?.on;
  const togglePin = async () => {
    setError(null);
    try { await api.pinBoard(row.botId, row, !pinned); } catch (e) { setError((e as Error).message || 'That didn’t go through'); }
  };
  if (docked) {
    return (
      <div className="view-card is-docked">
        <div className="view-card__body">
          {asText ? <Markdown text={body.text} /> : body.blocks.map((b) => <ViewBlockView key={b.id} b={b as B} all={body.blocks} change={change} />)}
        </div>
        {error && <div className="view-card__foot"><span className="view-card__error">{error}</span></div>}
      </div>
    );
  }
  // Check-in offer (server/src/checkin-offer.ts): the same buttons with a heading; a tap makes the check-in.
  if (body.quick && body.checkin && body.blocks[0]?.type === 'choice') return <CheckInOffer body={body} b={body.blocks[0] as B} change={change} error={error} />;
  if (body.quick && body.blocks[0]?.type === 'choice') return <QuickChoices b={body.blocks[0] as B} group={!!body.from} change={change} error={error} />;
  return (
    <div className={`card view-card${pinned ? ' is-pinned' : ''}`} data-seq={row.seq}>
      {(body.title || body.from || pinned) && (
        <div className="view-card__head">
          {body.from && <div className="card__eyebrow">{body.from.name}</div>}
          {body.title && <div className="card__title">{body.title}</div>}
          {pinned && <span className="view-card__pinned" title="Kept above the message box until it is done"><Pin size={11} aria-hidden /> Pinned</span>}
        </div>
      )}
      <div className="view-card__body">
        {asText
          ? <Markdown text={body.text.replace(/^\*\*[^\n]*\*\*\n\n/, body.title ? '' : '$&')} />
          : body.blocks.map((b) => <ViewBlockView key={b.id} b={b as B} all={body.blocks} change={change} />)}
      </div>
      <div className="view-card__foot">
        {error && <span className="view-card__error">{error}</span>}
        {body.updatedAt && <span className="view-card__note">Updated {new Date(body.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        <button type="button" className="link-btn link-btn--small" onClick={() => setShowVisuals(!showVisuals)}>{asText ? 'Show visuals' : 'Show as text'}</button>
        {!body.from && !body.pagePath && !saved && (
          <button type="button" className="link-btn link-btn--small" onClick={savePage} disabled={opening} title="Keep this in the Pages tab, still working, to use again later">
            <Bookmark size={12} aria-hidden /> Save to Pages
          </button>
        )}
        {!body.from && (body.pagePath || saved) && <span className="view-card__note"><Check size={11} aria-hidden /> In Pages</span>}
        {!body.from && (
          <button type="button" className="link-btn link-btn--small" onClick={asPage} disabled={opening} title={body.pagePath ? 'Open the Page made from this' : 'Keep this as a Page you can edit with the bot'}>
            <FileText size={12} aria-hidden /> {body.pagePath ? 'Open Page' : opening ? 'Making…' : 'Open as Page'}
          </button>
        )}
        <button type="button" className="link-btn link-btn--small" onClick={togglePin} title={pinned ? 'Stop keeping this above the message box' : 'Keep this above the message box while the chat moves on'}>
          {pinned ? <><PinOff size={12} aria-hidden /> Unpin</> : <><Pin size={12} aria-hidden /> Pin</>}
        </button>
        <button type="button" className="link-btn link-btn--small" onClick={copy} title="Copy as text">
          {copied ? <><Check size={12} aria-hidden /> Copied</> : <><Copy size={12} aria-hidden /> Copy</>}
        </button>
      </div>
    </div>
  );
}

function ViewBlockView({ b, all, change }: { b: B; all: ViewBlock[]; change: (c: Change) => Promise<boolean> }) {
  switch (b.type) {
    case 'heading': return <div className="view-card__heading">{b.text}</div>;
    case 'text': return <Markdown text={b.md} />;
    case 'callout': return <div className={`page-callout is-${b.tone}`}><Markdown text={b.md} /></div>;
    case 'table': return <ViewTable b={b} />;
    case 'chart': return <ViewChart b={b} all={all} />;
    case 'stats': return (
      <div className="view-stats">
        {b.title && <div className="page-choice__q">{b.title}</div>}
        <div className="view-stats__grid">
          {b.items.map((x: any, i: number) => (
            <div key={i} className={`view-stat${x.tone ? ` is-${x.tone}` : ''}`}>
              <div className="view-stat__value">{x.value}</div>
              <div className="view-stat__label">{x.label}</div>
              {x.note && <div className="view-stat__note">{x.note}</div>}
            </div>
          ))}
        </div>
      </div>
    );
    case 'progress': return (
      <div className="view-progress">
        <div className="view-progress__top"><span>{b.label}</span><span>{Math.round((b.value / b.max) * 100)}%</span></div>
        <div className="view-progress__bar" role="progressbar" aria-valuenow={b.value} aria-valuemax={b.max} aria-label={b.label}><span style={{ width: `${Math.min(100, (b.value / b.max) * 100)}%` }} /></div>
        {b.note && <div className="view-stat__note">{b.note}</div>}
      </div>
    );
    case 'checklist': {
      const done = b.items.filter((i: any) => i.done).length;
      return (
        <div className="page-checklist">
          {b.title && <div className="page-choice__q">{b.title}</div>}
          {b.items.map((it: any) => (
            <label key={it.id} className={`page-check${it.done ? ' is-done' : ''}`}>
              <input type="checkbox" checked={it.done} onChange={(e) => change({ op: 'check', block: b.id, item: it.id, done: e.target.checked })} />
              <span className="page-check__text">{it.text}</span>
            </label>
          ))}
          {b.items.length > 1 && <div className="file-row__meta">{done} of {b.items.length} done</div>}
        </div>
      );
    }
    case 'choice': return <ViewChoice b={b} change={change} />;
    case 'form': return <ViewForm b={b} change={change} />;
    case 'button': return <ViewButton b={b} change={change} />;
    case 'link': {
      const u = safeUrl(b.url);
      return u ? <a className="view-card__link" href={u} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={13} aria-hidden /> {b.label}</a> : null;
    }
    case 'code': return <pre className="files-text is-code">{b.code}</pre>;
    case 'calc': return <ViewCalc b={b} change={change} />;
    case 'divider': return <hr className="page-hr" />;
    case 'a2ui': return <A2uiView b={b as any} change={change} />;
    default: return null;
  }
}

function ViewTable({ b }: { b: B }) {
  const width = Math.max(b.columns.length, ...b.rows.map((r: string[]) => r.length), 1);
  const cols = Array.from({ length: width }, (_, i) => i);
  const total = useMemo(() => (b.total ? cols.map((i) => {
    if (i === 0) return 'Total';
    const nums = b.rows.map((r: string[]) => String(r[i] ?? '').replace(/[$,\s]/g, '')).filter((v: string) => v !== '' && Number.isFinite(Number(v))).map(Number);
    return nums.length ? String(+nums.reduce((a: number, c: number) => a + c, 0).toFixed(2)) : '';
  }) : null), [b.rows, b.total, width]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page-table">
      {b.title && <div className="page-choice__q">{b.title}</div>}
      <div className="files-table-wrap">
        <table className="files-table page-table__t">
          {b.columns.length > 0 && <thead><tr>{cols.map((i) => <th key={i}>{b.columns[i] ?? ''}</th>)}</tr></thead>}
          <tbody>
            {b.rows.map((r: string[], ri: number) => <tr key={ri}>{cols.map((ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>)}
            {total && <tr className="page-table__total">{total.map((v, i) => <th key={i}>{v}</th>)}</tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ViewChart({ b, all }: { b: B; all: ViewBlock[] }) {
  // The same picture Pages and exports use (server/src/page-chart.ts); every bit of text in it is escaped there.
  const dark = useIsDark();
  const svg = useMemo(() => chartSvg(b, { blocks: all }, 480, 280, dark ? CHART_DARK : CHART_LIGHT), [b, all, dark]);
  return <div className="page-chart" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ViewChoice({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const sent = !!b.sentAt;
  const [busy, setBusy] = useState(false);
  const pick = async (picked: number[]) => { setBusy(true); await change({ op: 'pick', block: b.id, picked }); setBusy(false); };
  if (!b.multi) {
    return (
      <div className="page-choice">
        <div className="page-choice__q">{b.question}</div>
        <div className="view-choice__options">
          {b.options.map((o: string, i: number) => {
            const on = b.picked.includes(i);
            return (
              <button key={i} type="button" className={`question-option${on ? ' is-chosen' : ''}`} disabled={sent || busy} onClick={() => pick([i])}>
                <span className="question-option__label">{o}</span>
                {on && <Check size={13} aria-hidden style={{ marginLeft: 'auto' }} />}
              </button>
            );
          })}
        </div>
        {sent && <div className="file-row__meta">Sent</div>}
      </div>
    );
  }
  return (
    <div className="page-choice">
      <div className="page-choice__q">{b.question}</div>
      {b.options.map((o: string, i: number) => (
        <label key={i} className="page-check">
          <input type="checkbox" disabled={sent || busy} checked={b.picked.includes(i)}
            onChange={(e) => pick(e.target.checked ? [...b.picked, i] : b.picked.filter((x: number) => x !== i))} />
          <span>{o}</span>
        </label>
      ))}
      <div className="page-form__send">
        <button type="button" className="btn btn--sm btn--primary" disabled={sent || busy || !b.picked.length} onClick={() => change({ op: 'send', block: b.id })}>
          <Send size={13} aria-hidden /> {sent ? 'Sent' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ViewForm({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const sent = !!b.sentAt;
  const [sending, setSending] = useState(false);
  // What is in the boxes now; it goes with Send, and each box also saves when you leave it.
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(b.fields.map((f: any) => [f.id, f.value ?? ''])));
  const set = (id: string, v: string) => setVals((o) => ({ ...o, [id]: v }));
  return (
    <div className="page-form">
      {b.title && <div className="page-choice__q">{b.title}</div>}
      {b.fields.map((f: any) => (
        <label key={f.id} className="page-form__field">
          <span>{f.label}</span>
          {f.kind === 'choice'
            ? <select value={vals[f.id] ?? ''} disabled={sent} onChange={(e) => { set(f.id, e.target.value); change({ op: 'field', block: b.id, field: f.id, value: e.target.value }); }}><option value="" />{(f.options ?? []).map((o: string) => <option key={o}>{o}</option>)}</select>
            : <FieldInput kind={f.kind} value={vals[f.id] ?? ''} disabled={sent} onChange={(v) => set(f.id, v)} onSave={() => { if ((vals[f.id] ?? '') !== (f.value ?? '')) change({ op: 'field', block: b.id, field: f.id, value: vals[f.id] ?? '' }); }} />}
        </label>
      ))}
      <div className="page-form__send">
        <button type="button" className="btn btn--sm btn--primary" disabled={sent || sending}
          onClick={async () => { setSending(true); await change({ op: 'send', block: b.id, values: vals }); setSending(false); }}>
          <Send size={13} aria-hidden /> {sent ? 'Sent' : sending ? 'Sending…' : b.submitLabel || 'Send'}
        </button>
      </div>
    </div>
  );
}

function FieldInput({ kind, value, disabled, onChange, onSave }: { kind: string; value: string; disabled: boolean; onChange: (v: string) => void; onSave: () => void }) {
  if (kind === 'longtext') return <textarea className="page-input page-input--area" rows={3} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} onBlur={onSave} />;
  return <input className="page-input" type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'} value={value} disabled={disabled}
    onChange={(e) => onChange(e.target.value)} onBlur={onSave} />;
}

function ViewButton({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  return (
    <button type="button" className="btn btn--sm btn--secondary page-button" disabled={state === 'busy'}
      onClick={async () => { setState('busy'); setState((await change({ op: 'send', block: b.id })) ? 'sent' : 'idle'); window.setTimeout(() => setState('idle'), 2500); }}>
      {state === 'sent' ? <><Check size={13} aria-hidden /> Sent</> : b.label}
    </button>
  );
}

/**
 * A calculator (server/src/calc.ts): the outputs are worked out here as you drag or type, with the same
 * code the server uses. Your values are saved on the card a moment after you stop; Send gives the bot the
 * numbers as they are.
 */
export function ViewCalc({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const inputs = b.inputs as CalcInput[];
  const outputs = b.outputs as CalcOutput[];
  const start = () => Object.fromEntries(inputs.map((i) => [i.id, Number.isFinite(b.values?.[i.id]) ? b.values[i.id] : i.value]));
  const [vals, setVals] = useState<Record<string, number>>(start);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  // A newer copy from the server (the bot changed the view) wins unless you are mid-change.
  useEffect(() => { if (!dirty.current) setVals(start()); }, [b]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const set = (id: string, v: number) => {
    const next = { ...vals, [id]: v };
    setVals(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => { await change({ op: 'calc', block: b.id, values: next }); dirty.current = false; }, 700);
  };
  const results = useMemo(() => runCalc(inputs, outputs, vals), [inputs, outputs, vals]);
  return (
    <div className="view-calc">
      {b.title && <div className="page-choice__q">{b.title}</div>}
      <div className="view-calc__inputs">
        {inputs.map((i) => <CalcField key={i.id} i={i} value={vals[i.id]} onChange={(v) => set(i.id, v)} />)}
      </div>
      <div className="view-calc__outputs" aria-live="polite">
        {results.map((r, k) => (
          <div key={r.id} className={`view-stat${outputs[k].big ? ' is-big' : ''}`}>
            <div className="view-stat__value">{r.text}</div>
            <div className="view-stat__label">{r.label}</div>
          </div>
        ))}
      </div>
      <div className="page-form__send">
        <button type="button" className="btn btn--sm btn--secondary" disabled={sending}
          onClick={async () => { setSending(true); window.clearTimeout(timer.current); const ok = await change({ op: 'send', block: b.id, values: vals }); dirty.current = false; setSending(false); if (ok) { setSent(true); window.setTimeout(() => setSent(false), 2500); } }}>
          {sent ? <><Check size={13} aria-hidden /> Sent</> : <><Send size={13} aria-hidden /> {b.sendLabel || 'Send these numbers'}</>}
        </button>
      </div>
    </div>
  );
}

function CalcField({ i, value, onChange }: { i: CalcInput; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = formatCalc(value, { decimals: i.step && i.step < 1 ? String(i.step).split('.')[1]?.length ?? 2 : 0, prefix: i.prefix ?? '', unit: i.unit });
  switch (i.kind) {
    case 'slider':
      return (
        <label className="view-calc__field">
          <span className="view-calc__label"><span>{i.label}</span><strong>{shown}</strong></span>
          <input type="range" min={i.min} max={i.max} step={i.step ?? 'any'} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={i.label} />
        </label>
      );
    case 'choice':
      return (
        <label className="view-calc__field">
          <span className="view-calc__label"><span>{i.label}</span></span>
          <select value={value} onChange={(e) => onChange(Number(e.target.value))}>{(i.options ?? []).map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}</select>
        </label>
      );
    case 'toggle':
      return (
        <label className="page-check view-calc__toggle">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
          <span>{i.label}</span>
        </label>
      );
    default:
      return (
        <label className="view-calc__field">
          <span className="view-calc__label"><span>{i.label}</span></span>
          <span className="view-calc__num">
            {i.prefix && <span>{i.prefix}</span>}
            <input className="page-input" type="number" inputMode="decimal" min={i.min} max={i.max} step={i.step ?? 'any'} value={text}
              onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(i.min !== undefined || i.max !== undefined ? Math.min(i.max ?? n, Math.max(i.min ?? n, n)) : n); }} />
            {i.unit && <span>{i.unit}</span>}
          </span>
        </label>
      );
  }
}

/**
 * Choice buttons (server/src/choices.ts): a row of answers under the bot's reply, no card around them.
 * A tap sends that answer as your message, and the chat then hides the row (Transcript / Chat answeredChoice),
 * so the answer shows once. The picked state below is only a fallback for other places a card is drawn. "Other" opens a box for your own words. Never an approval: it's a chat reply.
 */
/**
 * "Keep an eye on X?" (server/src/checkin-offer.ts): how often, or Not now. A tap only makes a check-in that
 * reads and posts when something needs you; it posts no message and approves nothing. Android draws the same
 * card (mobile/src/components/ViewCard.tsx).
 */
function CheckInOffer({ body, b, change, error }: { body: Card; b: B; change: (c: Change) => Promise<boolean>; error: string | null }) {
  const o = body.checkin!;
  const who = body.from?.name ?? 'Your Bot';
  return (
    <div className="checkin-offer" data-checkin-offer>
      <div className="checkin-offer__head">
        <span className="checkin-offer__icon" aria-hidden><Eye size={16} /></span>
        <div className="checkin-offer__text">
          <div className="checkin-offer__title">{b.question}</div>
          <div className="checkin-offer__sub">
            {body.from ? `${who} reads` : 'Reads'} it on a schedule and tells you when something there needs you. It only reads, never changes anything.
            {o.link && safeUrl(o.link) && <> <a href={safeUrl(o.link)!} target="_blank" rel="noreferrer">Open <ExternalLink size={11} aria-hidden /></a></>}
          </div>
        </div>
      </div>
      <QuickChoices b={b} group={!!body.from} change={change} error={error} />
    </div>
  );
}

function QuickChoices({ b, group, change, error }: { b: B; group: boolean; change: (c: Change) => Promise<boolean>; error: string | null }) {
  const sent = !!b.sentAt;
  const [busy, setBusy] = useState<number | 'other' | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const pick = async (c: Change, which: number | 'other') => { setBusy(which); await change(c); setBusy(null); };
  if (sent) {
    const answer = b.otherText ?? b.options[b.picked?.[0]] ?? '';
    return (
      <div className="quick-choices is-sent" aria-label={`Answered: ${answer}`}>
        <span className="quick-choice is-chosen" aria-disabled><Check size={13} aria-hidden /> {answer}</span>
        {group && b.pickedBy && <span className="quick-choices__by">{b.pickedBy}</span>}
      </div>
    );
  }
  return (
    <div className="quick-choices" role="group" aria-label={b.question}>
      {b.options.map((o: string, i: number) => (
        <button key={i} type="button" className="quick-choice" disabled={busy !== null} onClick={() => pick({ op: 'pick', block: b.id, picked: [i] }, i)}>
          {busy === i ? 'Sending…' : o}
        </button>
      ))}
      {b.other && !typing && <button type="button" className="quick-choice quick-choice--other" disabled={busy !== null} onClick={() => setTyping(true)}>Other…</button>}
      {b.other && typing && (
        <form className="quick-choices__other" onSubmit={(e) => { e.preventDefault(); if (text.trim()) pick({ op: 'pick', block: b.id, text: text.trim() }, 'other'); }}>
          <input autoFocus value={text} maxLength={500} placeholder="Your answer" onChange={(e) => setText(e.target.value)} disabled={busy !== null} />
          <button type="submit" className="quick-choice" disabled={busy !== null || !text.trim()}><Send size={13} aria-hidden /> Send</button>
        </form>
      )}
      {error && <span className="view-card__error">{error}</span>}
    </div>
  );
}
