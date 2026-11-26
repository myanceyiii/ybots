import { useEffect, useState, type ReactNode } from 'react';
import { connectorsApi, REACH_LABEL, STATUS_LABEL, type ConnectorInfo, type ConnectorList, type NewConnector } from '../../lib/connectorsApi';
import { shortDate } from './ui';

const past = (c: ConnectorInfo) => c.status === 'retired' || c.status === 'gone';
export { past as connectorIsPast };

/**
 * Rows of connectors (server/src/connectors.ts), each with what it is, where it runs and, for the
 * owner, Add to Bots (a picker, then a change that is confirmed), Sign in, Delete or Remove.
 */
export function ConnectorRows({ list, data, busy, locked, showWanted, onPropose, onSignIn, onDelete, confirmFor, confirmBox }: {
  list: ConnectorInfo[]; data: ConnectorList; busy: boolean; locked: boolean; showWanted?: boolean;
  /** The row a pending change is about; its confirm box shows there, where the person pressed Next. */
  confirmFor?: string | null; confirmBox?: ReactNode;
  onPropose: (b: { action: 'add' | 'remove'; connectorId: string; bots?: string[] }) => void;
  onSignIn: (id: string) => void; onDelete: (c: ConnectorInfo) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <div className="cfg-card">
      {list.map((c) => (
        <div className="cfg-row connector-row" key={c.id}>
          <div className="cfg-row__text">
            <div className="cfg-row__title">
              {showWanted && c.wanted?.rank ? `${c.wanted.rank}. ` : ''}{c.name}{' '}
              <span className={`cfg-chip connector-status connector-status--${c.status}`}>{STATUS_LABEL[c.status]}</span>
              {c.firm && <span className="cfg-chip">Firm, walled off</span>}
              {c.access && <span className="cfg-chip">{c.access}</span>}
            </div>
            <div className="cfg-row__sub">
              {c.apps.length ? c.apps.map((a) => `${a.name}: ${a.bots.length ? a.bots.join(', ') : 'no Bot yet'}`).join(' · ') : REACH_LABEL[c.reach]}
            </div>
            {showWanted && c.wanted && <WantedBlock w={c.wanted} />}
            {c.description && <div className="cfg-row__sub">{c.description}</div>}
            {c.notes && <div className="cfg-row__sub">{c.notes}</div>}
            <div className="cfg-row__sub">
              {[c.machine, c.address, c.firstSeen && `since ${shortDate(c.firstSeen)}`, c.goneAt && `${c.status === 'retired' ? 'retired' : 'last found'} ${shortDate(c.goneAt)}`, c.source === 'scan' && 'found by scan'].filter(Boolean).join(' · ')}
            </div>
            {picking === c.id && (
              <div className="connector-pick">
                {data.bots.filter((b) => !c.onlyBots || c.onlyBots.some((x) => x === b.id || x.toLowerCase() === b.name.toLowerCase())).map((b) => (
                  <label key={b.id} className="connector-pick__bot">
                    <input type="checkbox" checked={chosen.includes(b.id)} onChange={(e) => setChosen((s) => (e.target.checked ? [...s, b.id] : s.filter((x) => x !== b.id)))} /> {b.name}
                  </label>
                ))}
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicking(null)}>Cancel</button>
                <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || !chosen.length} onClick={() => { onPropose({ action: 'add', connectorId: c.id, bots: chosen }); setPicking(null); }}>Next</button>
              </div>
            )}
            {confirmFor === c.id && confirmBox}
          </div>
          {data.owner && c.canAdd && picking !== c.id && (
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || locked} onClick={() => { setPicking(c.id); setChosen([]); }}>Add to Bots</button>
          )}
          {data.owner && c.custom && c.needsSignIn && (
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => onSignIn(c.id)}>Sign in</button>
          )}
          {data.owner && c.custom && !c.added && (
            <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={busy || locked} onClick={() => onDelete(c)}>Delete</button>
          )}
          {data.owner && c.added && (
            <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={busy || locked} onClick={() => onPropose({ action: 'remove', connectorId: c.id })}>Remove from Bots</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** What a wanted connection unlocks, who and which skills need it, and the setup it takes. */
export function WantedBlock({ w }: { w: NonNullable<ConnectorInfo['wanted']> }) {
  return (
    <div className="connector-wanted">
      <div className="cfg-row__sub"><strong>Unlocks:</strong> {w.unlocks}</div>
      {!!w.bots?.length && <div className="cfg-row__sub"><strong>For:</strong> {w.bots.join(' · ')}</div>}
      {!!w.skills?.length && <div className="cfg-row__sub"><strong>Skills that need it:</strong> {w.skills.join(', ')}</div>}
      {!!w.setup?.length && (
        <ol className="connector-wanted__steps">{w.setup.map((s) => <li key={s}>{s}</li>)}</ol>
      )}
      {w.needs && <div className="cfg-row__sub"><strong>Needs your OK:</strong> {w.needs}</div>}
      {w.state && <div className="cfg-row__sub"><strong>Now:</strong> {w.state}</div>}
    </div>
  );
}

/**
 * Connect a Google account (Gmail, Calendar, Drive) for a Bot. Sign-in happens on Google's own page;
 * the keys stay on the server. First time only, the owner uploads the Google Cloud Web client file.
 */
export function ConnectGoogle({ busy, onStarted }: { busy: boolean; onStarted: () => void }) {
  const [info, setInfo] = useState<{ configured: boolean; redirectUri: string; audienceUrl?: string } | null>(null);
  const [write, setWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => { connectorsApi.google().then(setInfo).catch((e) => setError((e as Error).message)); }, []);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setWorking(true); setError(null);
    try { await connectorsApi.googleClient(await file.text()); setInfo(await connectorsApi.google()); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  const start = async () => {
    setWorking(true); setError(null);
    try { const r = await connectorsApi.googleStart(write); window.open(r.signInUrl, '_blank', 'noopener'); onStarted(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  return (
    <>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__sub">You sign in on Google's page; the keys stay on your server. A Bot can send mail only after you read the whole email on a card in its chat and press Send.</div>
          </div>
          {info?.configured && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || working} onClick={start}>{working ? 'Opening…' : 'Connect Google…'}</button>}
        </div>
        {error && <div className="cfg-error" role="alert">{error}</div>}
        {info?.configured && (
          <div className="connector-form">
            <label className="connector-pick__bot"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Allow sending mail, drafts, and Calendar, Drive and Tasks changes. Each one asks on a card first; an email shows in full and goes only when you press Send. Leave it off for read only.</label>
            <div className="cfg-row__sub">If Google says the app “has not completed Google verification”, that account isn’t on the test-user list yet. Add it under Google Auth Platform › Audience › Test users, then try again. {info.audienceUrl && <a href={info.audienceUrl} target="_blank" rel="noopener noreferrer">Open test users</a>}</div>
          </div>
        )}
        {info && !info.configured && (
          <div className="connector-form">
            <div className="cfg-row__sub">One-time setup: in Google Cloud, APIs &amp; Services → Credentials → Create OAuth client ID → Web application, with this redirect address. Then upload the JSON file Google gives you.</div>
            <input className="text-input" readOnly value={info.redirectUri} onFocus={(e) => e.currentTarget.select()} aria-label="Redirect address" />
            <label className="connector-form__field"><span>Client file</span><input type="file" accept="application/json,.json" disabled={working} onChange={(e) => void upload(e.target.files?.[0])} /></label>
          </div>
        )}
    </>
  );
}

/** Connect a server by its MCP address, with no key, a key, or the server's own sign-in. */
export function ConnectByAddress({ onDone, onCancel }: { busy?: boolean; onDone: (r: { connectorId: string; signInUrl?: string }) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState<NewConnector>({ name: '', url: '', auth: 'none', headerName: 'Authorization', headerValue: '', remote: false, readOnly: false });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const set = <K extends keyof NewConnector>(k: K, v: NewConnector[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setWorking(true); setError(null);
    try { const r = await connectorsApi.create(f); setF({ name: '', url: '', auth: 'none', headerName: 'Authorization', headerValue: '', remote: false, readOnly: false }); await onDone(r); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  return (
    <>
          <div className="connector-form">
            {error && <div className="cfg-error" role="alert">{error}</div>}
            <label className="connector-form__field"><span>Name</span><input className="text-input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Weather" /></label>
            <label className="connector-form__field"><span>MCP address</span><input className="text-input" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="http://127.0.0.1:3000/mcp" inputMode="url" autoCapitalize="off" spellCheck={false} /></label>
            <div className="connector-form__field" role="radiogroup" aria-label="How it signs in">
              <span>Sign-in</span>
              <div className="connector-form__choices">
                {([['none', 'No key'], ['key', 'Key'], ['oauth', 'Sign in with the server']] as const).map(([v, l]) => (
                  <label key={v} className="connector-pick__bot"><input type="radio" name="auth" checked={f.auth === v} onChange={() => set('auth', v)} /> {l}</label>
                ))}
              </div>
            </div>
            {f.auth === 'key' && (
              <>
                <label className="connector-form__field"><span>Header</span><input className="text-input" value={f.headerName} onChange={(e) => set('headerName', e.target.value)} autoCapitalize="off" spellCheck={false} /></label>
                <label className="connector-form__field"><span>Key</span><input className="text-input" type="password" value={f.headerValue} onChange={(e) => set('headerValue', e.target.value)} placeholder="Bearer …" autoComplete="off" /></label>
              </>
            )}
            {f.auth === 'oauth' && <div className="cfg-row__sub">After Connect, the server's sign-in page opens. Sign in there, then come back.</div>}
            <label className="connector-pick__bot"><input type="checkbox" checked={!!f.remote} onChange={(e) => set('remote', e.target.checked)} /> On another machine or the internet (what Bots send it leaves this computer)</label>
            <label className="connector-pick__bot"><input type="checkbox" checked={!!f.readOnly} onChange={(e) => set('readOnly', e.target.checked)} /> Read only (tools that change things are blocked)</label>
            <div className="connector-pick">
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setError(null); onCancel(); }}>Cancel</button>
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={working || !f.name.trim() || !f.url.trim() || (f.auth === 'key' && !f.headerValue)} onClick={submit}>{working ? 'Connecting…' : 'Connect'}</button>
            </div>
          </div>
    </>
  );
}
