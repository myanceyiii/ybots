import { useEffect, useState } from 'react';
import type { EngineInfo, FallbackChoice, ProviderStatus } from '@shared/types';
import { configApi } from '../lib/configApi';

const ACCESS: Record<ProviderStatus['access'], string> = {
  ready: 'Access ready', needs_key: 'No key', not_signed_in: 'Not signed in', off: 'Off for this bot', not_installed: 'Not installed', unknown: 'Unknown',
};
const ROUTE: Record<ProviderStatus['route'], string> = { api_key: 'API key', subscription: 'Subscription', sign_in: 'Sign-in' };

const when = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : new Date(t).toLocaleDateString();
};
const sameChain = (a: FallbackChoice[], b: FallbackChoice[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Providers section of a bot's Engine settings (shared provider catalog, server/src/provider-catalog.ts):
 * every provider the app offers with three separate facts (listed, access, verified), a Check that makes
 * one real request from the bot's own agent, the opt-in for the experimental Claude subscription route,
 * and the bot's explicit fallback chain.
 */
export function ProviderCatalog({ engine, onSaved }: { engine: EngineInfo; onSaved: (e: EngineInfo) => void }) {
  const botId = engine.botId;
  const catalog = engine.catalog ?? [];
  const managed = !!engine.appManaged;
  const [checking, setChecking] = useState<string | null>(null);
  const [checkModel, setCheckModel] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [chain, setChain] = useState<FallbackChoice[]>(engine.fallbacks ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmSub, setConfirmSub] = useState(false);
  const [ack, setAck] = useState(false);

  useEffect(() => { setChain(engine.fallbacks ?? []); setNote(null); setConfirmSub(false); setAck(false); }, [botId, JSON.stringify(engine.fallbacks ?? [])]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!catalog.length) return null;
  const usable = catalog.filter((p) => p.eligible && (p.id !== 'claude-subscription-directsdk-experimental' || engine.subscriptionAllowed));
  const chainChanged = !sameChain(chain, engine.fallbacks ?? []);

  const modelFor = (p: ProviderStatus) => checkModel[p.id] ?? (engine.provider === p.id && engine.model ? engine.model : p.models[0] ?? '');

  const check = async (p: ProviderStatus) => {
    const model = modelFor(p).trim();
    if (!model || checking) return;
    setChecking(p.id); setNote(null);
    try { const r = await configApi.checkProvider(botId, p.id, model); onSaved(r.engine); if (!r.result.ok) setNote(`${p.name}: ${r.result.detail}`); }
    catch (e) { setNote(`Couldn’t check ${p.name}: ${(e as Error).message || 'the agent did not answer'}`); }
    finally { setChecking(null); }
  };

  const save = async (patch: Parameters<typeof configApi.setEngine>[1]) => {
    if (busy) return;
    setBusy(true); setNote(null);
    try { const r = await configApi.setEngine(botId, patch); onSaved(r.engine); setConfirmSub(false); setAck(false); }
    catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(false); }
  };

  const setEntry = (i: number, patch: Partial<FallbackChoice>) => setChain((c) => c.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => setChain((c) => { const n = [...c]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });

  return (
    <div className="providers">
      <div className="providers__head">Providers</div>
      <div className="providers__help">
        Listed means the app offers it. Access means {managed ? 'this bot’s' : 'the'} agent has a key or login for it. Verified means a real request from {managed ? 'this bot’s' : 'its'} agent got an answer.
        {!managed && ' This agent’s setup is its own; the app shows it but does not change it.'}
      </div>
      {catalog.map((p) => {
        const v = p.verified;
        const models = p.models;
        const listId = `check-models-${botId}-${p.id}`;
        const canCheck = p.eligible && p.access !== 'off' && p.access !== 'not_installed';
        return (
          <div key={p.id} className={`providers__row${p.experimental ? ' is-experimental' : ''}`}>
            <div className="providers__title">
              <b>{p.name}</b>
              <span>{ROUTE[p.route]}{p.experimental ? ' · Experimental' : ''}{p.source === 'agent' ? ' · from this agent’s config' : ''}{engine.provider === p.id ? ' · Default' : ''}</span>
            </div>
            <div className="providers__facts">
              <span className="providers__fact is-on" title="In the shared catalog">Listed</span>
              <span className={`providers__fact${p.access === 'ready' ? ' is-on' : p.access === 'unknown' ? '' : ' is-off'}`} title={p.accessNote}>{ACCESS[p.access]}</span>
              <span className={`providers__fact${v?.ok ? ' is-on' : v ? ' is-bad' : ''}`} title={v?.detail ?? 'No check made yet'}>
                {v ? `${v.ok ? 'Verified' : 'Check failed'} ${when(v.at)} · ${v.model}` : 'Not verified'}
              </span>
            </div>
            <div className="providers__note">{p.accessNote}{p.lastTurn ? ` Last chat turn on it: ${p.lastTurn.model ?? 'default'} ${when(p.lastTurn.at)}${p.lastTurn.ok ? '' : ', failed'}.` : ''}</div>
            {v && !v.ok && v.detail && <div className="providers__error">{v.detail}</div>}
            <div className="providers__billing">{p.billing}</div>
            {canCheck && (
              <div className="providers__check">
                <input className="engine__model" list={listId} value={modelFor(p)} spellCheck={false} autoComplete="off" aria-label={`Model to check on ${p.name}`}
                  placeholder="Model id" onChange={(e) => setCheckModel((m) => ({ ...m, [p.id]: e.target.value }))} />
                <datalist id={listId}>{models.map((m) => <option key={m} value={m} />)}</datalist>
                <button type="button" className="link-btn link-btn--small" onClick={() => check(p)} disabled={!!checking || !modelFor(p).trim()}>
                  {checking === p.id ? 'Checking…' : 'Check'}
                </button>
              </div>
            )}
            {p.optIn && managed && (
              <div className="providers__optin">
                {p.warning && <div className="providers__warn">{p.warning}</div>}
                {engine.subscriptionAllowed ? (
                  <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={() => save({ allowSubscription: false })}>Switch off for this bot</button>
                ) : !confirmSub ? (
                  <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={() => setConfirmSub(true)}>Switch on for this bot…</button>
                ) : (
                  <div className="providers__confirm">
                    <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand the warning above and want this bot to be able to use my Claude subscription.</label>
                    <div className="engine__actions">
                      <button type="button" className="btn btn--sm btn--bot" disabled={!ack || busy} onClick={() => save({ allowSubscription: true, acknowledgeSubscriptionTerms: true })}>{busy ? 'Saving…' : 'Switch on'}</button>
                      <button type="button" className="link-btn link-btn--small" onClick={() => { setConfirmSub(false); setAck(false); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {managed && (
        <div className="providers__fallbacks">
          <div className="providers__head">Fallbacks</div>
          <div className="providers__help">
            {chain.length
              ? 'If the default fails (out of credit, limit reached, down), the agent tries these in order for that turn, then goes back to the default.'
              : `None. If ${engine.model ?? 'the default model'} fails, the turn fails; nothing else is tried or billed.`}
          </div>
          {chain.map((f, i) => {
            const p = usable.find((x) => x.id === f.provider);
            const listId = `fb-models-${botId}-${i}`;
            return (
              <div key={i} className="providers__fb">
                <span className="providers__fb-n">{i + 1}</span>
                <select aria-label={`Fallback ${i + 1} provider`} value={f.provider} onChange={(e) => setEntry(i, { provider: e.target.value, model: usable.find((x) => x.id === e.target.value)?.models[0] ?? '' })}>
                  {!p && <option value={f.provider}>{f.provider}</option>}
                  {usable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <input className="engine__model" list={listId} value={f.model} spellCheck={false} autoComplete="off" aria-label={`Fallback ${i + 1} model`} placeholder="Model id"
                  onChange={(e) => setEntry(i, { model: e.target.value })} />
                <datalist id={listId}>{(p?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
                <button type="button" className="link-btn link-btn--small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="link-btn link-btn--small" aria-label="Remove" onClick={() => setChain((c) => c.filter((_, j) => j !== i))}>Remove</button>
              </div>
            );
          })}
          <div className="engine__actions">
            {chain.length < 3 && usable.length > 0 && (
              <button type="button" className="link-btn link-btn--small" onClick={() => setChain((c) => [...c, { provider: usable[0].id, model: usable[0].models[0] ?? '' }])}>Add a fallback</button>
            )}
            {chainChanged && (
              <>
                <button type="button" className="btn btn--sm btn--bot" disabled={busy || chain.some((f) => !f.model.trim())} onClick={() => save({ fallbacks: chain.map((f) => ({ provider: f.provider, model: f.model.trim() })) })}>{busy ? 'Saving…' : 'Save fallbacks'}</button>
                <button type="button" className="link-btn link-btn--small" onClick={() => setChain(engine.fallbacks ?? [])}>Undo</button>
              </>
            )}
          </div>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
    </div>
  );
}
