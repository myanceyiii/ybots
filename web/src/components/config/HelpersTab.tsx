import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bot } from '@shared/types';
import type { HelperRun, HelperSettings, HelperRoute } from '@shared/helpers';
import type { Effort, Tier } from '@shared/model-router';
import { configApi, type HelpersBundle } from '../../lib/configApi';
import { Field, Segmented, Switch } from './ui';

const TIER_ROWS: { id: Tier; label: string; route: string; hint: string }[] = [
  { id: 'light', label: 'Fast', route: 'fast', hint: 'Lookups, status checks, summaries, simple edits.' },
  { id: 'standard', label: 'Standard', route: 'standard', hint: 'Most jobs: multi-step checks and ordinary fixes.' },
  { id: 'heavy', label: 'Deep', route: 'deep', hint: 'Hard debugging and risky changes. Costs the most.' },
];
const RANK: Record<Tier, number> = { light: 0, standard: 1, heavy: 2 };
const EFFORTS: { value: Effort | ''; label: string }[] = [
  { value: '', label: 'Bot default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

const settingsOf = (h: HelperSettings): HelperSettings => ({
  enabled: h.enabled, maxAtOnce: h.maxAtOnce, stepLimit: h.stepLimit, maxTier: h.maxTier, defaultTier: h.defaultTier,
  routes: Object.fromEntries(Object.entries(h.routes).map(([k, r]) => [k, { model: r!.model, effort: r!.effort }])),
});

/**
 * Helpers: the sub-agents this bot's Hermes may start for a job and that report back to it. The
 * settings live in the bot's own Hermes config (server/src/helpers.ts). Only the server's owner can
 * change them; nothing here touches approvals.
 */
export function HelpersTab({ bot }: { bot: Bot }) {
  const [data, setData] = useState<HelpersBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<HelperSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(() => {
    configApi.helpers(bot.id)
      .then((d) => { setData(d); setDraft(settingsOf(d.helpers)); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, [bot.id]);
  useEffect(() => { setData(null); setDraft(null); load(); }, [load]);

  const base = useMemo(() => (data ? JSON.stringify(settingsOf(data.helpers)) : ''), [data]);
  const dirty = !!draft && JSON.stringify(draft) !== base;
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2600); };

  if (error) return <div className="cfg-page"><div className="cfg-error">{error}</div></div>;
  if (!data || !draft) return <div className="cfg-page"><div className="cfg-empty">Loading…</div></div>;

  const h = data.helpers;
  const ro = !data.canEdit;
  const put = (p: Partial<HelperSettings>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const putRoute = (t: Tier, p: Partial<HelperRoute> | null) => setDraft((d) => {
    if (!d) return d;
    const routes = { ...d.routes };
    if (p === null) delete routes[t];
    else routes[t] = { model: routes[t]?.model ?? '', effort: routes[t]?.effort ?? null, ...p };
    return { ...d, routes };
  });
  const models = [...new Set([...data.models, ...Object.values(draft.routes).map((r) => r!.model).filter(Boolean)])];
  const allowed = TIER_ROWS.filter((t) => RANK[t.id] <= RANK[draft.maxTier] && draft.routes[t.id]?.model);

  const save = async () => {
    setSaving(true);
    try {
      const d = await configApi.setHelpers(bot.id, draft);
      setData(d); setDraft(settingsOf(d.helpers));
      flash('Saved to the agent’s settings');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Helpers</div>
          <div className="cfg-page__sub">
            For a big job, {bot.name} can hand parts to short-lived helpers. Each starts with a clean slate, works on its own and reports back, so {bot.name}’s own conversation stays small. Helpers can only use tools {bot.name} has, can’t talk to you or change memory, and can never approve anything.
          </div>
        </div>
      </div>

      {ro && <div className="cfg-empty">Only the owner of this server can change these settings.</div>}

      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Use helpers</div>
              <div className="cfg-row__sub">{draft.enabled ? `${bot.name} may start helpers when a job is big enough.` : `${bot.name} does all work itself.`}</div>
            </div>
            <Switch on={draft.enabled} disabled={ro} onChange={(v) => put({ enabled: v })} label="Use helpers" />
          </div>
        </div>
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Helpers at once" htmlFor="hlp-max" hint="1 to 10. Each one uses the computer’s processor while it works.">
          <input id="hlp-max" className="text-input" type="number" min={1} max={10} disabled={ro} value={draft.maxAtOnce} onChange={(e) => put({ maxAtOnce: Math.round(Number(e.target.value)) })} />
        </Field>
        <Field label="Steps per helper" htmlFor="hlp-steps" hint="10 to 250. A helper stops and reports when it runs out.">
          <input id="hlp-steps" className="text-input" type="number" min={10} max={250} step={10} disabled={ro} value={draft.stepLimit} onChange={(e) => put({ stepLimit: Math.round(Number(e.target.value)) })} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="Strongest model a helper may use" hint="Tiers above this are not offered to the bot at all.">
          <Segmented label="Strongest helper tier" value={draft.maxTier} options={TIER_ROWS.map((t) => ({ value: t.id, label: t.label }))} onChange={(v) => !ro && put({ maxTier: v })} />
        </Field>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Models helpers may run on{h.provider ? ` (${h.provider})` : ''}</div>
        <div className="cfg-card">
          {TIER_ROWS.map((t) => {
            const r = draft.routes[t.id];
            const over = RANK[t.id] > RANK[draft.maxTier];
            return (
              <div className="cfg-row" key={t.id} style={over ? { opacity: 0.5 } : undefined}>
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{t.label}{over ? ' · above the cap' : ''}</div>
                  <div className="cfg-row__sub">{t.hint}</div>
                </div>
                <div className="cfg-row-actions">
                  <select className="text-input" aria-label={`${t.label} helper model`} disabled={ro || over} value={r?.model ?? ''} onChange={(e) => putRoute(t.id, e.target.value ? { model: e.target.value } : null)}>
                    <option value="">Not offered</option>
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select className="text-input" aria-label={`${t.label} thinking`} disabled={ro || over || !r} value={r?.effort ?? ''} onChange={(e) => putRoute(t.id, { effort: (e.target.value || null) as Effort | null })}>
                    {EFFORTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Only this bot’s own models (from its Model tab) are offered, so a helper never runs on a model the bot can’t use.</div>
        {!data.models.length && <div className="cfg-field__hint">The agent didn’t report a model list just now, so only models already set can be kept.</div>}
        {!h.perJobChoice && <div className="cfg-field__hint">This bot’s agent doesn’t have the per-job model plugin, so every helper uses the default below.</div>}
        {h.inheritsMainModel && <div className="cfg-field__hint">Nothing set yet: helpers would run on {bot.name}’s own main model.</div>}
      </section>

      {allowed.length > 0 && (
        <section className="cfg-section">
          <Field label="When the bot doesn’t pick" hint="The model a helper uses unless the bot chooses another allowed one.">
            <Segmented label="Default helper model" value={allowed.some((t) => t.id === draft.defaultTier) ? draft.defaultTier : allowed[0].id} options={allowed.map((t) => ({ value: t.id, label: t.label }))} onChange={(v) => !ro && put({ defaultTier: v })} />
          </Field>
        </section>
      )}

      {!ro && (
        <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
          <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(settingsOf(h))}>Discard</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      )}

      <section className="cfg-section">
        <div className="cfg-section__label">Recent helpers</div>
        {data.runs.length === 0 ? <div className="cfg-empty">No helpers have run yet.</div> : (
          <div className="cfg-list">{data.runs.map((r) => <RunItem key={r.id} r={r} />)}</div>
        )}
        <button type="button" className="link-btn link-btn--small" onClick={load}>Refresh</button>
      </section>
    </div>
  );
}

const STATE: Record<string, string> = { running: 'Working', completed: 'Done', failed: 'Failed', interrupted: 'Stopped', timeout: 'Timed out', unknown: 'Unknown' };

function RunItem({ r }: { r: HelperRun }) {
  const when = new Date(r.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const took = r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))} s` : null;
  return (
    <div className="cfg-item">
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.goals[0] ?? 'Helper job'}{r.goals.length > 1 ? ` and ${r.goals.length - 1} more` : ''}</div>
        <div className="cfg-item__sub">{[STATE[r.state] ?? r.state, when, took, r.models.join(', ')].filter(Boolean).join(' · ')}</div>
        {r.summary && <div className="cfg-item__prompt">{r.summary}</div>}
      </div>
    </div>
  );
}
