import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { engineSummary } from '@shared/engine-summary';
import { lsGet, lsSet } from '../lib/storage';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';
import { ModelChoice } from './ModelChoice';
import { ProviderCatalog } from './ProviderCatalog';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** The last "open the Engine section" request handled; the section may mount after the request (tab switch). */
let handledReveal = 0;

/** Open or closed is remembered per account in this browser; a new account starts closed. */
const openKey = (uid: string | undefined) => `engineOpen.${uid ?? 'anon'}`;

/**
 * The Engine section's frame: a header that folds the messy settings away. Closed, it shows one line
 * (model and effort) and how many problems need attention, so nothing wrong hides behind the fold.
 */
function EngineFold({ bot, engine, checking, children }: { bot: Bot; engine: EngineInfo | null; checking: boolean; children: ReactNode }) {
  const uid = useStore((s) => s.user?.id);
  const reveal = useStore((s) => s.engineReveal);
  const [open, setOpenState] = useState(() => lsGet(openKey(uid)) === '1');
  const headRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const setOpen = (v: boolean) => { setOpenState(v); lsSet(openKey(uid), v ? '1' : '0'); };
  // Opened from elsewhere ("Engine and providers" in the chat menu): unfold, bring it into view, focus it.
  useEffect(() => {
    if (!reveal || reveal <= handledReveal) return;
    handledReveal = reveal;
    setOpen(true);
    requestAnimationFrame(() => { headRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); headRef.current?.focus({ preventScroll: true }); });
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = engine ? engineSummary(engine, bot.effort) : null;
  const problems = sum?.problems ?? [];
  const line = sum ? sum.line : checking ? 'Checking…' : 'Unavailable';
  const title = sum ? [sum.providerName && `${sum.providerName} · ${sum.line}`, ...problems].filter(Boolean).join('\n') : undefined;
  return (
    <section className={`engine-fold${open ? ' is-open' : ''}`}>
      <button ref={headRef} type="button" className="engine-fold__head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} title={title}>
        <span className="engine-fold__chev" aria-hidden><Icon name="chev_right" size={12} opacity={0.6} /></span>
        <span className="engine-fold__label">Engine</span>
        {!open && <span className="engine-fold__sum">{line}</span>}
        {problems.length > 0 && (
          <span className="engine-fold__problems" aria-label={`${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.join('; ')}`}>
            <i aria-hidden />{problems.length} {problems.length === 1 ? 'problem' : 'problems'}
          </span>
        )}
      </button>
      <div id={bodyId} className="engine-fold__body" hidden={!open}>
        {problems.length > 0 && (
          <ul className="engine-fold__list">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * "Engine" section of the details panel: which provider and model run this bot's agent, signing in to
 * a subscription, and the agent's status. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'signin' | 'restart' | 'screen' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  /** The one-time "I understand" for picking an opt-in provider (the Claude subscription) that is off for this bot. */
  const [ack, setAck] = useState(false);
  const dirty = useRef(false);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); setNote(null); setSigningIn(false); setAck(false); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  // Signing in happens on the bot's computer. Check while that view is open, and once more when it closes.
  useEffect(() => {
    if (!signingIn) return;
    if (!viewerOpen) { setSigningIn(false); load(true); return; }
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [signingIn, viewerOpen, load]);

  if (phase !== 'ok' || !engine) {
    return (
      <EngineFold bot={bot} engine={null} checking={phase === 'loading'}>
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
      </EngineFold>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const listed = engine.catalog?.find((c) => c.id === selected?.id) ?? null;
  const suggestions = selected?.models.length ? selected.models : listed?.models ?? [];
  // Picking the Claude subscription while it is off for this bot switches it on in the same save, once the warning is accepted.
  const needsOptIn = !!selected?.optIn && !selected.enabled;
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  const wantModel = model.trim() && model.trim() !== (engine.model ?? '') ? model.trim() : undefined;
  const changed = !!wantProvider || !!wantModel;
  // The Claude subscription route has no sign-in here: it uses the bots' own Claude login on the server.
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected && !p.optIn);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected && !selected.optIn ? selected : null;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id); setAck(false);
    const next = providers.find((p) => p.id === id);
    const list = next?.models.length ? next.models : engine.catalog?.find((c) => c.id === id)?.models ?? [];
    // A model from another provider will not work here, so start from this provider's first suggestion.
    if (list.length && !list.includes(model.trim())) setModel(list[0]);
  };

  const save = async () => {
    if (!changed || busy) return;
    // Checked before busy is set: returning after it would leave every button on this screen disabled.
    if (needsOptIn && !ack) return;
    setBusy('save'); setNote(null);
    try {
      const r = await configApi.setEngine(botId, {
        ...(wantProvider ? { provider: wantProvider } : {}), ...(wantModel ? { model: wantModel } : {}),
        ...(needsOptIn ? { allowSubscription: true, acknowledgeSubscriptionTerms: true } : {}),
      });
      dirty.current = false; setAck(false); apply(r.engine);
      if (r.notes?.length) setNote(r.notes.join(' '));
    }
    catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const signIn = async () => {
    if (busy) return;
    setBusy('signin'); setNote(null);
    try {
      await configApi.engineLogin(botId, signInTo?.id);
      // The sign-in runs in a terminal on the bot's screen, so take the person there with the mouse and keyboard.
      set({ viewerOpen: true, viewerMode: 'control', viewerHint: `Finish signing in on ${bot.name}’s computer, then hand back.` });
      setSigningIn(true);
    } catch (e) { setNote(`Couldn’t start sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  return (
    <EngineFold bot={bot} engine={engine} checking={false}>
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{selected?.name ?? (provider || 'Default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {!selected && <option value={provider}>{provider || 'Default'}</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.optIn && !p.enabled ? 'Off for this bot, choose to switch on' : `${KIND[p.kind]} · ${p.connected ? 'Connected' : 'Not connected'}`}</option>)}
          </select>
        </span>
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{needsOptIn ? 'Off for this bot' : selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
        </div>
      )}
      {needsOptIn && (
        <div className="providers__optin engine__optin">
          {listed?.warning && <div className="providers__warn">{listed.warning}</div>}
          <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand the warning above and want {bot.name} to be able to use my Claude subscription. Saving switches it on for {bot.name}.</label>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <label htmlFor={`${listId}-input`}>{engine.modelMode === 'auto' ? 'Fallback model' : 'Model'}</label>
        <input
          id={`${listId}-input`} className="engine__model" list={listId} value={model} spellCheck={false} autoComplete="off"
          placeholder={suggestions[0] ?? 'Model id'}
          onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      <div className="engine__actions">
        <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save' || (needsOptIn && !ack)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>}
      </div>
      <ModelChoice engine={engine} onSaved={(e) => apply(e, true)} />
      <ProviderCatalog engine={engine} onSaved={(e) => apply(e, true)} />
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? 'Opening sign-in…' : signInTo ? `Sign in to ${signInTo.name}…` : 'Sign in to a subscription…'}
        </button>
      )}
      {engine.restartNote && <div className="engine__notice"><span>{engine.restartNote}</span></div>}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
    </EngineFold>
  );
}
