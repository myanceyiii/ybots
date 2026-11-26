import { useEffect, useRef, useState } from 'react';
import type { LiveModel } from '@shared/types';
import { useStore } from '../store';

const EFFORT_LEVEL: Record<LiveModel['effort'], number> = { low: 1, medium: 2, high: 3, xhigh: 4 };
const EFFORT_WORD: Record<LiveModel['effort'], string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
const TIER_WORD: Record<NonNullable<LiveModel['tier']>, string> = { light: 'light', standard: 'standard', heavy: 'heavy' };

/** One sentence with everything the badge stands for, for the tooltip, the popover and screen readers. */
export function modelSummary(m: LiveModel): string {
  const how = m.mode === 'auto' ? `Auto picked the ${m.tier ? TIER_WORD[m.tier] : ''} tier`.replace('  ', ' ') : 'Chosen in settings';
  return `${m.name} · ${EFFORT_WORD[m.effort]} effort · ${m.fallback ? 'switched to this fallback model mid-task' : how}`;
}

/** The model a bot is answering with right now, or null when it is idle. */
export function useLiveModel(botId: string | undefined): LiveModel | null {
  return useStore((s) => {
    const l = botId ? s.live[botId] : undefined;
    return l?.isRunning && l.model ? l.model : null;
  });
}

/** Up to four small dots: how hard the model is asked to think (low, medium, high, extra high). */
export function EffortDots({ effort }: { effort: LiveModel['effort'] }) {
  const n = EFFORT_LEVEL[effort] ?? 2;
  return (
    <span className="model-badge__dots" aria-hidden>
      {[1, 2, 3, 4].map((i) => <span key={i} className={`model-badge__dot${i <= n ? ' is-on' : ''}`} />)}
    </span>
  );
}

/**
 * A small chip on a working bot's picture: the model's short name and effort dots. Hover shows the full
 * name; a click or tap opens a small card with the details (and does not open the chat or menu under it).
 * `inline` draws it in the text flow (group rows) instead of hanging off the picture.
 */
export function ModelBadge({ model, size, inline }: { model: LiveModel; size: number; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key); };
  }, [open]);
  const summary = modelSummary(model);
  // Small pictures (the thinking mascot, group rows) get the compact chip; list and header sizes the roomy one.
  const scale = inline ? 'is-inline' : size >= 44 ? 'is-roomy' : 'is-compact';
  const toggle = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); };
  return (
    <span ref={ref} className={`model-badge ${scale}${model.fallback ? ' is-fallback' : ''}`} role="button" tabIndex={0}
      title={open ? undefined : summary} aria-label={`Using ${summary}`} aria-expanded={open}
      onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); }}
      onContextMenu={(e) => e.stopPropagation()}>
      {model.fallback && <span className="model-badge__fallback" aria-hidden>↺</span>}
      <span className="model-badge__name">{model.short}</span>
      <EffortDots effort={model.effort} />
      {open && (
        <span className="model-badge__pop" role="dialog" aria-label="Model in use">
          <span className="model-badge__pop-name">{model.name}</span>
          <span className="model-badge__pop-row">Effort <b>{EFFORT_WORD[model.effort]}</b> <EffortDots effort={model.effort} /></span>
          <span className="model-badge__pop-row">{model.fallback ? 'Fallback: the first model failed, so this one took over mid-task' : model.mode === 'auto' ? `Auto: ${model.tier ? `${TIER_WORD[model.tier]} tier` : 'picked'} for this task` : 'Manual: the model set in settings'}</span>
        </span>
      )}
    </span>
  );
}
