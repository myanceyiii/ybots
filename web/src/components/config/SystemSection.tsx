import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { api, ApiError, type CheckState, type ServerStatus } from '../../lib/api';

const mb = (n: number) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n >= 1_073_741_824 ? `${(n / 1_073_741_824).toFixed(1)} GB` : `${(n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0)} MB`);
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
const upFor = (sec: number) => {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
};
const STATE_WORD: Record<CheckState, string> = { ok: 'Fine', warn: 'Look', bad: 'Problem' };
const BOT_STATE: Record<string, string> = { ready: 'Ready', starting: 'Starting', stopped: 'Stopped', error: 'Problem', none: 'No engine' };

function Dot({ state }: { state: CheckState }) {
  return <span className={`sys-dot is-${state}`} role="img" aria-label={STATE_WORD[state]} />;
}

/**
 * Settings > System: how the server itself is doing, for its owner. One line per thing that can go wrong
 * (database, disk, bots' engines, routines, backups), then the detail behind each.
 */
export function SystemSection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const [st, setSt] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [clearing, setClearing] = useState(false);
  const load = useCallback(() => api.status().then((s) => { setSt(s); setError(null); }).catch((e) => {
    if (e instanceof ApiError && e.status === 403) setDenied(true); else setError((e as Error).message);
  }), []);
  useEffect(() => {
    void load();
    // Fresh while it is on screen; nothing is asked of the server once the page is left or the tab is hidden.
    const t = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const snapshot = async () => {
    setBusy(true); setNote(null);
    try { const r = await api.snapshotNow(); setNote(r.snapshot ? `Saved ${r.snapshot.name} (${mb(r.snapshot.bytes)}).` : 'Saved.'); await load(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };

  const copyReport = () => {
    if (!st) return;
    const lines = [
      `YBots server report, ${new Date(st.at).toLocaleString()}`,
      `Build ${st.server.commit ?? 'unknown'} on ${st.server.host}, up ${upFor(st.server.uptimeSec)}, memory ${st.server.memoryMb} MB${st.disk ? `, disk ${mb(st.disk.freeBytes)} free` : ''}`,
      ...(st.deploy ? [`Last ${st.deploy.action === 'rollback' ? 'rollback' : 'update'}: ${when(st.deploy.at)} by ${st.deploy.by} (${st.deploy.result})`] : []),
      '', 'Checks:',
      ...st.checks.map((c) => `- [${STATE_WORD[c.state]}] ${c.label}: ${c.detail}`),
      ...(st.requests.slowest.length ? ['', 'Slowest answers:', ...[...st.requests.slowest].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `- ${(r.ms / 1000).toFixed(1)} s ${r.path}`)] : []),
      '', `Recent problems (${st.problems.length}):`,
      ...st.problems.slice(0, 30).map((p) => `- ${when(p.at)} ${p.level}${p.count > 1 ? ` x${p.count}` : ''}: ${p.text}`),
    ];
    navigator.clipboard?.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setNote('Could not copy. Select the text on this page instead.'));
  };
  if (denied) return (<><PageHead title="System" /><div className="cfg-empty">Only the owner of this server can see how it is running.</div></>);
  if (!st) return (<><PageHead title="System" sub="How the server behind your Bots is doing." />{error ? <div className="cfg-error" role="alert">{error} <button type="button" className="cfg-link" onClick={() => void load()}>Try again</button></div> : <div className="cfg-empty">Checking…</div>}</>);

  const clear = async () => {
    setClearing(true);
    try { await api.clearProblems(); await load(); } catch (e) { setNote((e as Error).message); } finally { setClearing(false); }
  };
  // What needs a look comes first; the rest keep the server's order.
  const rank: Record<CheckState, number> = { bad: 0, warn: 1, ok: 2 };
  const checks = [...st.checks].sort((a, b) => rank[a.state] - rank[b.state]);
  const worst: CheckState = st.checks.some((c) => c.state === 'bad') ? 'bad' : st.checks.some((c) => c.state === 'warn') ? 'warn' : 'ok';
  const headline = worst === 'ok' ? 'Everything is running normally' : worst === 'warn' ? 'Running, with something to look at' : 'Something needs attention';
  return (
    <>
      <PageHead title="System" sub="How the server behind your Bots is doing." />
      {error && <div className="cfg-error" role="alert">Could not refresh: {error}</div>}
      <section className="cfg-section">
        <div className={`sys-banner is-${worst}`} role="status">
          <Dot state={worst} />
          <div className="cfg-row__text">
            <div className="sys-banner__title">{headline}</div>
            <div className="cfg-row__sub">{st.server.version !== '0' ? `Version ${st.server.version}${st.server.commit ? ` (${st.server.commit.slice(0, 7)})` : ''}` : st.server.commit ? `Build ${st.server.commit.slice(0, 7)}` : 'Running'} · up {upFor(st.server.uptimeSec)} on {st.server.host} · checked {new Date(st.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={copyReport} title="Copy this page as text, to paste to Howard or into a note">{copied ? 'Copied' : 'Copy report'}</button>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void load()}>Check again</button>
        </div>
      </section>

      {st.deploy && (
        <section className="cfg-section">
          <div className="cfg-field__hint">Last {st.deploy.action === 'rollback' ? 'rollback' : 'update'}: {when(st.deploy.at)} by {st.deploy.by}{st.deploy.to ? `, to ${st.deploy.to}` : ''}{/^ok/.test(st.deploy.result) ? '' : ` (${st.deploy.result})`}.</div>
        </section>
      )}
      <section className="cfg-section">
        <div className="cfg-section__label">Checks</div>
        <div className="cfg-card">
          {checks.map((c) => (
            <div key={c.id} className="cfg-row">
              <Dot state={c.state} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{c.label}</div>
                <div className={`cfg-row__sub${c.state === 'bad' ? ' cfg-row__warn' : ''}`}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Bots</div>
        <div className="cfg-card">
          {st.bots.length === 0 && <div className="cfg-empty cfg-empty--flat">No Bots yet.</div>}
          {st.bots.map((b) => {
            const state: CheckState = b.state === 'error' ? 'bad' : b.state === 'ready' || b.state === 'none' ? 'ok' : 'warn';
            return (
              <div key={b.id} className="cfg-row">
                <Dot state={state} />
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{b.name}</div>
                  <div className="cfg-row__sub">
                    {BOT_STATE[b.state] ?? b.state}{b.busy ? ' · working now' : ''}{b.awaiting ? ' · waiting on you' : ''}{b.model ? ` · ${b.model}` : ''}
                    {b.error ? ` · ${b.error}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Database copies</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{st.db.snapshotsKeep ? `A copy every day, the newest ${st.db.snapshotsKeep} kept` : 'Daily copies are switched off'}</div>
              <div className="cfg-row__sub">
                {st.db.snapshots.length ? `${st.db.snapshots.length} on this server, newest ${when(st.db.snapshots[0].at)} (${mb(st.db.snapshots[0].bytes)})` : 'None yet'}
                {st.db.lastMaintenanceAt ? ` · tidied ${when(st.db.lastMaintenanceAt)}${st.db.lastMaintenance ? `: ${st.db.lastMaintenance}` : ''}` : ''}
              </div>
              {st.db.lastSnapshotError && <div className="cfg-row__sub cfg-row__warn">Last copy failed: {st.db.lastSnapshotError}</div>}
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !st.db.snapshotsKeep} onClick={() => void snapshot()}>{busy ? 'Copying…' : 'Copy now'}</button>
          </div>
          {note && <div className="cfg-row"><div className="cfg-row__sub" role="status">{note}</div></div>}
        </div>
        <div className="cfg-field__hint">These copies are a quick way back after a mistake on this server. The weekly encrypted backup is the one kept somewhere else{st.backup ? `; its last run was ${when(st.backup.at)}${st.backup.ok ? '' : ' and it did not finish'}` : ''}.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Recent problems{st.problems.length > 0 && <>{' · '}<button type="button" className="cfg-link" disabled={clearing} onClick={() => void clear()} title="Empty this list once you have read it. New problems still show.">{clearing ? 'Clearing…' : 'Clear the list'}</button></>}</div>
        <div className="cfg-card">
          {st.problems.length === 0 ? <div className="cfg-empty cfg-empty--flat">Nothing has gone wrong lately.</div> : st.problems.slice(0, 20).map((p, i) => (
            <div key={`${p.at}-${i}`} className="cfg-row sys-problem">
              <Dot state={p.level === 'error' ? 'bad' : 'warn'} />
              <div className="cfg-row__text">
                <div className="sys-problem__text">{p.text}</div>
                <div className="cfg-row__sub">{when(p.at)}{p.count > 1 ? ` · ${p.count} times` : ''}{p.before ? ' · before the last restart' : ''}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="cfg-field__hint">
          Since the server started: {st.requests.total.toLocaleString()} requests, {st.requests.errors} failed, {st.requests.slow} slow
          {' · '}memory {st.server.memoryMb} MB{st.disk ? ` · disk ${mb(st.disk.freeBytes)} free` : ''}{' · '}{st.apps.listening} app{st.apps.listening === 1 ? '' : 's'} connected now
          {st.sessions ? ` · ${st.sessions.people} device${st.sessions.people === 1 ? '' : 's'} and ${st.sessions.scripts} helper program${st.sessions.scripts === 1 ? '' : 's'} signed in` : ''}.
        </div>
        <details className="sys-more">
          <summary>More about the server</summary>
          <div className="cfg-field__hint">
            Node {st.server.node.replace(/^v/, '')} · load {st.server.load} on {st.server.cpus} processor{st.server.cpus === 1 ? '' : 's'}
            {typeof st.stallMs === 'number' ? ` · longest wait in the last minute ${st.stallMs < 1000 ? `${st.stallMs} ms` : `${(st.stallMs / 1000).toFixed(1)} s`}` : ''}
            {' · '}database {mb(st.db.bytes)}{st.db.walBytes ? ` plus ${mb(st.db.walBytes)} not yet folded in` : ''}
            {' · '}started {when(st.server.startedAt)}
          </div>
          {st.requests.slowest.length > 0 && (
            <>
              <div className="cfg-field__hint">The slowest answers since the server started:</div>
              <div className="cfg-card">
                {[...st.requests.slowest].sort((a, b) => b.ms - a.ms).slice(0, 8).map((r, i) => (
                  <div key={`${r.at}-${i}`} className="cfg-row">
                    <div className="cfg-row__text">
                      <div className="sys-problem__text">{r.path}</div>
                      <div className="cfg-row__sub">{(r.ms / 1000).toFixed(1)} s · {when(r.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </details>
      </section>
    </>
  );
}
