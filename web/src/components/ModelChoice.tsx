import { useEffect, useState } from 'react';
import type { EngineInfo, ModelTier, ModelTierChoice, ModelUsageSummary } from '@shared/types';
import { configApi } from '../lib/configApi';

type Effort = ModelTierChoice['effort'];
type Tiers = Partial<Record<ModelTier, ModelTierChoice>>;

const TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Small talk, quick asks, teammate replies' },
  { id: 'standard', label: 'Standard', hint: 'Most requests' },
  { id: 'heavy', label: 'Heavy', hint: 'Planning, analysis, code, legal, long work' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_EFFORT: Record<ModelTier, Effort> = { light: 'low', standard: 'medium', heavy: 'high' };

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const same = (a: Tiers | null, b: Tiers | null) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Manual or Auto model choice, the three Auto tiers, and the provider lock. Lives inside the Engine
 * section; the provider it works with is the one saved there (Auto never changes provider).
 */
export function ModelChoice({ engine, onSaved }: { engine: EngineInfo; onSaved: (e: EngineInfo) => void }) {
  const botId = engine.botId;
  const [mode, setMode] = useState(engine.modelMode);
  const [tiers, setTiers] = useState<Tiers>(engine.modelTiers ?? {});
  const [lock, setLock] = useState(!!engine.providerLock);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [usage, setUsage] = useState<ModelUsageSummary | null>(null);

  useEffect(() => {
    setMode(engine.modelMode); setTiers(engine.modelTiers ?? {}); setLock(!!engine.providerLock); setNote(null);
  }, [engine.botId, engine.modelMode, engine.modelTiers, engine.providerLock]);

  useEffect(() => {
    let alive = true;
    configApi.engineUsage(botId, 7).then((r) => { if (alive) setUsage(r.usage); }).catch(() => {});
    return () => { alive = false; };
  }, [botId, engine.lastRoute?.at]);

  const provider = engine.provider;
  const providerInfo = engine.providers.find((p) => p.id === provider) ?? null;
  const known = providerInfo?.models ?? [];
  const preset = provider ? engine.tierPresets?.[provider] : undefined;
  const wantLock = lock ? provider : null;
  const changed = mode !== engine.modelMode || !same(tiers, engine.modelTiers) || (wantLock ?? null) !== (engine.providerLock ?? null);
  const listId = `tier-models-${botId}`;

  const setTier = (t: ModelTier, patch: Partial<ModelTierChoice>) => {
    setNote(null);
    setTiers((cur) => {
      const prev = cur[t] ?? { model: '', effort: DEFAULT_EFFORT[t] };
      const next = { ...prev, ...patch };
      const out = { ...cur };
      if (next.model.trim()) out[t] = { ...next, model: next.model.trim() }; else delete out[t];
      return out;
    });
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await configApi.setEngine(botId, { modelMode: mode, modelTiers: Object.keys(tiers).length ? tiers : null, providerLock: wantLock });
      onSaved(r.engine);
    } catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(false); }
  };

  const last = engine.lastRoute;

  return (
    <div className="model-choice">
      <div className="panel-row panel-row--setting">
        <span>Model choice</span>
        <div className="segmented" role="radiogroup" aria-label="Model choice">
          {(['manual', 'auto'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-active' : ''}
              onClick={() => {
                setNote(null); setMode(m);
                // Switching to Auto with no tiers yet starts from the suggested ones for this provider.
                if (m === 'auto' && preset && !Object.keys(tiers).length) setTiers({ ...preset.tiers });
              }}>{m === 'manual' ? 'Manual' : 'Auto'}</button>
          ))}
        </div>
      </div>

      {mode === 'auto' && (
        <div className="model-choice__tiers">
          <div className="model-choice__help">
            Each turn picks a tier from how hard it looks. Same provider throughout{provider ? ` (${providerInfo?.name ?? provider})` : ''}. Tiers you leave empty use the next one up, then the model above.
            {preset && <> <button type="button" className="link-btn link-btn--small" onClick={() => { setNote(null); setTiers({ ...preset.tiers }); }}>Use suggested {preset.label} tiers</button></>}
          </div>
          {TIERS.map((t) => {
            const c = tiers[t.id];
            const missing = !!c?.model && known.length > 0 && !known.includes(c.model);
            return (
              <div key={t.id} className="model-choice__tier">
                <div className="model-choice__tier-name"><b>{t.label}</b><span>{t.hint}</span></div>
                <div className="model-choice__tier-fields">
                  <input className="engine__model" list={listId} value={c?.model ?? ''} spellCheck={false} autoComplete="off"
                    aria-label={`${t.label} model`} placeholder="Model id"
                    onChange={(e) => setTier(t.id, { model: e.target.value })} />
                  <select aria-label={`${t.label} effort`} value={c?.effort ?? DEFAULT_EFFORT[t.id]} onChange={(e) => setTier(t.id, { effort: e.target.value as Effort })}>
                    {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                {missing && <div className="model-choice__warn">Not in the list this account reports. It may still work; check after the next turn.</div>}
              </div>
            );
          })}
          <datalist id={listId}>{known.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
      )}

      {provider && (
        <label className="panel-row panel-row--setting model-choice__lock">
          <span>Only ever use {providerInfo?.name ?? provider}</span>
          <input type="checkbox" checked={lock} onChange={(e) => { setNote(null); setLock(e.target.checked); }} />
        </label>
      )}

      {changed && (
        <div className="engine__actions">
          <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="link-btn link-btn--small" onClick={() => { setMode(engine.modelMode); setTiers(engine.modelTiers ?? {}); setLock(!!engine.providerLock); setNote(null); }}>Undo</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}

      {last && (
        <div className="model-choice__last" title={last.reason}>
          Last turn: {last.tier ? `${last.tier[0].toUpperCase()}${last.tier.slice(1)} · ` : ''}{last.model ?? 'engine default'}{last.ok ? '' : ' · failed'}
          <span> · {last.reason}</span>
        </div>
      )}
      {usage && usage.rows.length > 0 && (
        <div className="model-choice__usage">
          <span>Last {usage.days} days:</span>
          {usage.rows.map((r) => (
            <span key={`${r.tier}-${r.model}`}>{r.tier} · {r.model ?? 'default'} · {r.turns} turn{r.turns === 1 ? '' : 's'} · {fmtTokens(r.inputTokens + r.outputTokens)} tokens</span>
          ))}
        </div>
      )}
    </div>
  );
}
