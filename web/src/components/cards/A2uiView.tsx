import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import {
  A2UI_LIMITS, buttonAction, childrenOf, evalText, evaluate, failedChecks, getAt, inputValue, safeMediaUrl, setAt, sliderMax, sliderMin, valuePath,
  type A2uiComponent, type A2uiCtx, type A2uiSurface,
} from '@shared/a2ui';
import { A2UI_ICON_PATHS } from '@shared/a2ui-icons';
import { loadsOnItsOwn } from '@shared/safe-url';
import { Markdown } from '../Markdown';

/**
 * An A2UI 1.0 interface in an answer view (server/src/a2ui.ts): the bot's Basic catalog components drawn with
 * this app's own pieces. All the reading of bindings, functions and checks is the shared engine's; this file
 * only draws. Typing and picking save on the card (a2ui-set); a Button sends a chat message as you plus the
 * standard A2UI action for the bot (a2ui-action), never an approval. Pictures and media from other sites wait
 * for a tap, as in messages. Android draws the same thing: mobile/src/components/A2uiView.tsx.
 */

type Change = Record<string, unknown> & { op: string; block: string };
type Edit = { component: string; scope: string; value: unknown };
const JUSTIFY: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', spaceBetween: 'space-between', spaceAround: 'space-around', spaceEvenly: 'space-evenly', stretch: 'stretch' };
const ALIGN: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
const keyOf = (c: A2uiComponent, ctx: A2uiCtx) => `${c.id}@${ctx.scope}`;

export function A2uiView({ b, change }: { b: { id: string; surface: A2uiSurface; sent?: { component: string; at: number } }; change: (c: Change) => Promise<boolean> }) {
  const surface = b.surface;
  const [data, setData] = useState<any>(surface.data);
  // Inputs whose value is a literal, not bound to the data: they only live here.
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const pending = useRef(new Map<string, Edit>());
  const timer = useRef<number | undefined>(undefined);
  // A newer copy from the server (the bot updated the view) wins unless you are mid-change.
  useEffect(() => { if (!pending.current.size) setData(surface.data); }, [surface]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const list = [...pending.current.values()];
    pending.current.clear();
    for (const e of list) await change({ op: 'a2ui-set', block: b.id, ...e });
  };
  const readValue = (c: A2uiComponent, ctx: A2uiCtx) => {
    const p = valuePath(c, ctx);
    return p ? getAt(data, p) : keyOf(c, ctx) in local ? local[keyOf(c, ctx)] : evaluate(c.value, ctx);
  };
  const setValue = (c: A2uiComponent, ctx: A2uiCtx, raw: unknown, soon = false) => {
    const v = inputValue(c, ctx, raw);
    if (v === null) return;
    setTouched((t) => new Set(t).add(keyOf(c, ctx)));
    const p = valuePath(c, ctx);
    if (!p) { setLocal((o) => ({ ...o, [keyOf(c, ctx)]: v })); return; }
    setData((d: any) => setAt(d, p, v));
    pending.current.set(keyOf(c, ctx), { component: c.id, scope: ctx.scope, value: v });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, soon ? 0 : 600);
  };
  const press = async (c: A2uiComponent, ctx: A2uiCtx) => {
    const act = buttonAction({ ...surface, data }, c, ctx);
    if (!act) return;
    if (act.kind === 'open') { if (act.url) window.open(act.url, '_blank', 'noopener,noreferrer'); return; }
    window.clearTimeout(timer.current);
    const edits = [...pending.current.values()];
    pending.current.clear();
    setBusy(keyOf(c, ctx));
    const ok = await change({ op: 'a2ui-action', block: b.id, component: c.id, scope: ctx.scope, ...(ctx.index !== undefined ? { index: ctx.index } : {}), edits });
    setBusy(null);
    if (ok) { setSent(keyOf(c, ctx)); window.setTimeout(() => setSent(null), 2500); }
  };

  const hosts = useMemo(() => mediaHosts(surface), [surface]);
  const root: A2uiCtx = { data, scope: '' };

  const draw = (id: string, ctx: A2uiCtx, depth: number, opts?: { trigger?: () => void; inSlot?: boolean }): ReactNode => {
    const c = surface.components[id];
    if (!c || depth > A2UI_LIMITS.depth || c['@accessibility']?.hidden) return null;
    const k = `${id}@${ctx.scope}`;
    const t = (v: unknown) => evalText(v, ctx);
    // Inside a Row or Column the slot around a component takes its weight, so the component itself just fills it.
    const grow: CSSProperties | undefined = !opts?.inSlot && c.weight ? { flex: `${c.weight} 1 0`, minWidth: 0 } : undefined;
    const aria = c['@accessibility']?.label !== undefined ? t(c['@accessibility'].label) : undefined;
    const kids = () => childrenOf(c, ctx).map((x) => <div key={x.key} className="a2ui-slot" style={slotStyle(surface.components[x.id])}>{draw(x.id, x.ctx, depth + 1, { inSlot: true })}</div>);
    const checks = (c['@checks'] ? failedChecks(c, { data, scope: ctx.scope, index: ctx.index }) : []);
    const problem = touched.has(k) && checks.length ? <div className="a2ui-check">{checks[0]}</div> : null;
    switch (c.component) {
      case 'Text': {
        const text = t(c.text);
        return c.variant === 'caption' ? <div className="a2ui-caption" style={grow}>{text}</div> : <div className="a2ui-text" style={grow}><Markdown text={text} /></div>;
      }
      case 'Image': {
        const url = safeMediaUrl(t(c.url), true);
        const alt = c.description !== undefined ? t(c.description) : '';
        const cls = `a2ui-img is-${c.variant ?? 'mediumFeature'}`;
        if (!url) return alt ? <div className="a2ui-caption">{alt}</div> : null;
        if (!showMedia && !loadsOnItsOwn(url)) return <button type="button" className={`${cls} a2ui-media-ask`} onClick={() => setShowMedia(true)} title={url}>{alt || 'Picture'}</button>;
        return <img className={cls} style={{ objectFit: (c.fit === 'scaleDown' ? 'scale-down' : c.fit ?? 'fill') as CSSProperties['objectFit'], ...grow }} src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
      }
      case 'Icon': return <A2uiIcon name={typeof c.name === 'string' ? c.name : evaluate(c.name, ctx)} label={aria} />;
      case 'Video': case 'AudioPlayer': {
        const url = safeMediaUrl(t(c.url));
        const label = c.description !== undefined ? t(c.description) : c.component === 'Video' ? 'Video' : 'Audio';
        if (!url) return null;
        if (!showMedia) return <button type="button" className="a2ui-media-ask" onClick={() => setShowMedia(true)} title={url}>▶ {label} from {new URL(url).hostname}</button>;
        return c.component === 'Video'
          ? <video className="a2ui-video" src={url} poster={safeMediaUrl(t(c.posterUrl), true) ?? undefined} controls preload="none" />
          : <div className="a2ui-audio">{c.description !== undefined && <div className="a2ui-caption">{label}</div>}<audio src={url} controls preload="none" /></div>;
      }
      case 'Row': case 'Column': case 'List': {
        const row = c.component === 'Row' || (c.component === 'List' && c.direction === 'horizontal');
        return (
          <div className={`a2ui-${row ? 'row' : 'col'}${c.component === 'List' ? ' is-list' : ''}`} style={{ justifyContent: JUSTIFY[c.justify ?? 'start'], alignItems: ALIGN[c.align ?? 'stretch'], ...grow }} aria-label={aria}>
            {kids()}
          </div>
        );
      }
      case 'Card': return <div className="a2ui-card" style={grow}>{draw(c.child, ctx, depth + 1)}</div>;
      case 'Divider': return <div className={c.axis === 'vertical' ? 'a2ui-vr' : 'a2ui-hr'} role="separator" />;
      case 'Tabs': {
        const on = Math.min(Number(ui[k] ?? 0), c.tabs.length - 1);
        return (
          <div className="a2ui-tabs" style={grow}>
            <div className="a2ui-tabs__bar" role="tablist">
              {c.tabs.map((tab: any, i: number) => <button key={i} type="button" role="tab" aria-selected={i === on} className={`a2ui-tab${i === on ? ' is-on' : ''}`} onClick={() => setUi((u) => ({ ...u, [k]: i }))}>{t(tab.title)}</button>)}
            </div>
            <div className="a2ui-tabs__body">{draw(c.tabs[on].child, ctx, depth + 1)}</div>
          </div>
        );
      }
      case 'Modal': {
        const open = !!ui[k];
        return (
          <>
            {draw(c.trigger, ctx, depth + 1, { trigger: () => setUi((u) => ({ ...u, [k]: true })) })}
            {open && createPortal(
              <div className="a2ui-modal" role="dialog" aria-modal="true" onClick={() => setUi((u) => ({ ...u, [k]: false }))}>
                <div className="a2ui-modal__box" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="a2ui-modal__close" aria-label="Close" onClick={() => setUi((u) => ({ ...u, [k]: false }))}><X size={16} aria-hidden /></button>
                  {draw(c.content, ctx, depth + 1)}
                </div>
              </div>,
              document.body,
            )}
          </>
        );
      }
      case 'Button': {
        const blocked = checks.length > 0;
        const isSent = sent === k;
        return (
          <button type="button" className={`a2ui-btn is-${c.variant ?? 'default'}`} style={grow} aria-label={aria}
            disabled={(!opts?.trigger && blocked) || busy !== null} title={!opts?.trigger && blocked ? checks[0] : undefined}
            onClick={() => (opts?.trigger ? opts.trigger() : press(c, ctx))}>
            {isSent ? <><Check size={14} aria-hidden /> Sent</> : busy === k ? 'Sending…' : draw(c.child, ctx, depth + 1)}
          </button>
        );
      }
      case 'TextField': {
        const v = readValue(c, ctx);
        const val = v == null ? '' : String(v);
        const common = { className: 'page-input', value: val, placeholder: c.placeholder !== undefined ? t(c.placeholder) : undefined, onChange: (e: { target: { value: string } }) => setValue(c, ctx, e.target.value), onBlur: () => { setTouched((x) => new Set(x).add(k)); void flush(); }, 'aria-invalid': !!problem };
        return (
          <label className="a2ui-field" style={grow}>
            <span className="a2ui-label">{t(c.label)}</span>
            {c.variant === 'longText' ? <textarea {...common} rows={3} className="page-input page-input--area" /> : <input {...common} type={c.variant === 'obscured' ? 'password' : c.variant === 'number' ? 'number' : 'text'} inputMode={c.variant === 'number' ? 'decimal' : undefined} />}
            {problem}
          </label>
        );
      }
      case 'CheckBox': return (
        <div style={grow}>
          <label className="page-check"><input type="checkbox" checked={!!readValue(c, ctx)} onChange={(e) => setValue(c, ctx, e.target.checked, true)} /><span>{t(c.label)}</span></label>
          {problem}
        </div>
      );
      case 'ChoicePicker': return <Picker c={c} ctx={ctx} value={readValue(c, ctx)} onChange={(v) => setValue(c, ctx, v, true)} problem={problem} style={grow} />;
      case 'Slider': {
        const lo = sliderMin(c), hi = sliderMax(c);
        const v = Number(readValue(c, ctx) ?? lo);
        return (
          <label className="view-calc__field a2ui-field" style={grow}>
            <span className="view-calc__label"><span>{c.label !== undefined ? t(c.label) : ''}</span><strong>{+v.toFixed(2)}</strong></span>
            <input type="range" min={lo} max={hi} step={Number.isInteger(c.steps) && c.steps > 0 ? (hi - lo) / c.steps : 'any'} value={v} onChange={(e) => setValue(c, ctx, Number(e.target.value))} aria-label={c.label !== undefined ? t(c.label) : 'Value'} />
            {problem}
          </label>
        );
      }
      case 'DateTimeInput': {
        const kind = c.enableTime && c.enableDate ? 'datetime-local' : c.enableTime ? 'time' : 'date';
        const raw = String(readValue(c, ctx) ?? '');
        const shown = kind === 'datetime-local' ? raw.slice(0, 16) : kind === 'date' ? raw.slice(0, 10) : raw.replace(/^.*T/, '').slice(0, 5);
        return (
          <label className="a2ui-field" style={grow}>
            {c.label !== undefined && <span className="a2ui-label">{t(c.label)}</span>}
            <input className="page-input" type={kind} value={shown} min={c.min !== undefined ? t(c.min) : undefined} max={c.max !== undefined ? t(c.max) : undefined} onChange={(e) => setValue(c, ctx, e.target.value)} onBlur={() => void flush()} />
            {problem}
          </label>
        );
      }
    }
    return null;
  };

  return (
    <div className="a2ui" data-surface={surface.surfaceId}>
      {hosts.length > 0 && !showMedia && (
        <button type="button" className="link-btn link-btn--small a2ui-media-all" onClick={() => setShowMedia(true)}>Show pictures from {hosts.slice(0, 2).join(', ')}{hosts.length > 2 ? ` and ${hosts.length - 2} more` : ''}</button>
      )}
      {draw('root', root, 0)}
    </div>
  );
}

function slotStyle(c: A2uiComponent | undefined): CSSProperties | undefined {
  return c?.weight ? { flex: `${c.weight} 1 0`, minWidth: 0 } : undefined;
}

function Picker({ c, ctx, value, onChange, problem, style }: { c: A2uiComponent; ctx: A2uiCtx; value: unknown; onChange: (v: string[]) => void; problem: ReactNode; style?: CSSProperties }) {
  const [filter, setFilter] = useState('');
  const picked = new Set(Array.isArray(value) ? (value as string[]) : []);
  const multi = c.variant === 'multipleSelection';
  const options = (c.options as { label: unknown; value: string }[]).map((o) => ({ label: evalText(o.label, ctx), value: o.value }))
    .filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (v: string) => onChange(multi ? (picked.has(v) ? [...picked].filter((x) => x !== v) : [...picked, v]) : [v]);
  return (
    <div className="a2ui-picker" style={style} role={multi ? 'group' : 'radiogroup'}>
      {c.label !== undefined && <div className="page-choice__q">{evalText(c.label, ctx)}</div>}
      {c.filterable && <input className="page-input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {c.displayStyle === 'chips'
        ? <div className="a2ui-chips">{options.map((o) => <button key={o.value} type="button" className={`quick-choice${picked.has(o.value) ? ' is-chosen' : ''}`} aria-pressed={picked.has(o.value)} onClick={() => toggle(o.value)}>{picked.has(o.value) && <Check size={12} aria-hidden />} {o.label}</button>)}</div>
        : options.map((o) => (
          <label key={o.value} className="page-check">
            <input type={multi ? 'checkbox' : 'radio'} checked={picked.has(o.value)} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      {problem}
    </div>
  );
}

export function A2uiIcon({ name, label, size = 20 }: { name: unknown; label?: string; size?: number }) {
  const custom = name && typeof name === 'object' && typeof (name as any).svgPath === 'string' ? [(name as any).svgPath as string] : null;
  const paths = custom ?? A2UI_ICON_PATHS[typeof name === 'string' ? name : ''] ?? A2UI_ICON_PATHS.help;
  return (
    <svg className="a2ui-icon" width={size} height={size} viewBox="0 0 24 24" fill={custom ? 'currentColor' : 'none'} stroke={custom ? 'none' : 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** The other sites a surface would load pictures or media from, so one tap can show them all. */
function mediaHosts(s: A2uiSurface): string[] {
  const out = new Set<string>();
  const ctx = { data: s.data, scope: '' };
  let bound = false;
  for (const c of Object.values(s.components)) {
    if (c.component !== 'Image' && c.component !== 'Video' && c.component !== 'AudioPlayer') continue;
    const u = safeMediaUrl(evalText(c.url, ctx), true);
    if (u && !loadsOnItsOwn(u)) out.add(new URL(u).hostname);
    else if (c.url && typeof c.url === 'object') bound = true;
  }
  // Templated pictures differ per item; the data's own https addresses stand in for them.
  if (bound) for (const m of JSON.stringify(s.data).matchAll(/"(https:\/\/[^"\s/]+)[^"]*"/g)) { try { out.add(new URL(m[1]).hostname); } catch { /* not a link */ } }
  return [...out];
}

