import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { lsGet, lsSet } from '../lib/storage';
import { useStore } from '../store';
import { Icon } from './Icon';

type Timer = { name: string; state: string; next: number | null; last: number | null; activates?: string | null };
type Host = { host: string; label?: string; reachable: boolean; timers: Timer[] };

/** "in 5 min", "2 h ago", "3 days ago". The exact time is in the row's tooltip. */
export function relTime(ms: number | null, now = Date.now()): string {
  if (!ms) return '—';
  const d = ms - now, a = Math.abs(d), m = Math.round(a / 60000);
  const span = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}
const exact = (ms: number | null) => ms ? new Date(ms).toLocaleString() : 'never';
const stateWord = (s: string) => s === 'enabled' ? 'On' : s === 'disabled' ? 'Off' : s.charAt(0).toUpperCase() + s.slice(1);
const canToggle = (t: Timer) => !t.name.includes('@.') && (t.state === 'enabled' || t.state === 'disabled');
const OPEN_KEY = 'cleft.systemdTimers.open';
/** The whole section folds like Engine: closed by default, remembered per account in this browser. */
const foldKey = (uid: string | undefined) => `timersOpen.${uid ?? 'anon'}`;

/** One closed-state line and the problems that must stay visible behind the fold. */
export function timersSummary(hosts: Host[] | null, error: string, loading: boolean) {
  if (!hosts) return { line: error ? 'Unavailable' : loading ? 'Checking…' : 'Unavailable', problems: error ? [error] : [], where: '' };
  const reach = hosts.filter((h) => h.reachable);
  const total = reach.reduce((n, h) => n + h.timers.length, 0);
  const off = reach.reduce((n, h) => n + h.timers.filter((t) => t.state === 'disabled').length, 0);
  const line = `${total} timer${total === 1 ? '' : 's'}${off ? ` · ${off} off` : ''}`;
  const where = `on ${reach.length} machine${reach.length === 1 ? '' : 's'}`;
  const problems = hosts.filter((h) => !h.reachable).map((h) => `Can't reach ${h.label ?? h.host}`);
  if (error) problems.push(error);
  return { line, where, problems };
}

export function SystemdTimers({ botId }: { botId: string }) {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const uid = useStore((st) => st.user?.id);
  const [folded, setFoldedState] = useState(() => lsGet(foldKey(uid)) !== '1');
  const setFolded = (v: boolean) => { setFoldedState(v); lsSet(foldKey(uid), v ? '0' : '1'); };
  const bodyId = useId();
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}'); } catch { return {}; }
  });
  const path = `/api/bots/${encodeURIComponent(botId)}/systemd-timers`;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error('Timer list unavailable.');
      const body = await res.json();
      setForbidden(false);
      setHosts(body.hosts); setCheckedAt(body.checkedAt ?? Date.now()); setError('');
    } catch { setError('Timer list unavailable. Try Refresh.'); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  function toggleOpen(host: string) {
    setOpen((o) => {
      const next = { ...o, [host]: !o[host] };
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* per-viewer only */ }
      return next;
    });
  }
  async function change(host: string, timer: Timer) {
    const action = timer.state === 'enabled' ? 'disable' : 'enable';
    setPending(`${host}/${timer.name}`); setError('');
    try {
      const res = await fetch(`${path}/change`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, unit: timer.name, action }) });
      if (!res.ok) throw new Error('Change not completed or verified.');
      await load();
    } catch { setError(`${timer.name} was not changed, or the change could not be confirmed. Refresh to check.`); }
    finally { setPending(''); }
  }
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => hosts?.map((h) => ({ ...h, timers: q ? h.timers.filter((t) => t.name.toLowerCase().includes(q) || (t.activates ?? '').toLowerCase().includes(q)) : h.timers })), [hosts, q]);
  if (forbidden) return null;
  const total = hosts?.reduce((n, h) => n + h.timers.length, 0) ?? 0;
  const sum = timersSummary(hosts, error, loading);
  const sectionOpen = !folded;
  return <section aria-label="Systemd timers" className={`timers engine-fold${sectionOpen ? ' is-open' : ''}`}>
    <button type="button" className="engine-fold__head" aria-expanded={sectionOpen} aria-controls={bodyId} onClick={() => setFolded(sectionOpen)} title={[`${sum.line} ${sum.where}`.trim(), ...sum.problems].join('\n')}>
      <span className="engine-fold__chev" aria-hidden><Icon name="chev_right" size={12} opacity={0.6} /></span>
      <span className="engine-fold__label">Systemd timers</span>
      {!sectionOpen && <span className="engine-fold__sum">{sum.line}</span>}
      {sum.problems.length > 0 && <span className="engine-fold__problems" aria-label={`${sum.problems.length} problem${sum.problems.length === 1 ? '' : 's'}: ${sum.problems.join('; ')}`}>
        <i aria-hidden />{sum.problems.length} {sum.problems.length === 1 ? 'problem' : 'problems'}
      </span>}
    </button>
    <div id={bodyId} className="engine-fold__body" hidden={!sectionOpen}>
    <div className="timers__bar"><span>{hosts ? `${sum.line} ${sum.where}` : ''}</span><button type="button" className="link-btn link-btn--small" disabled={loading} onClick={() => void load()}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    <div className="panel-card">
      {error && <div role="alert" className="panel-empty timers__error">{error}</div>}
      {!hosts && !error && <div className="panel-empty">Checking timers on each machine…</div>}
      {hosts && total > 8 && <input className="timers__filter" type="search" placeholder="Find a timer" aria-label="Find a timer" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {shown?.map((h) => {
        const off = h.timers.filter((t) => t.state === 'disabled').length;
        const isOpen = !!q || !!open[h.host];
        if (q && h.timers.length === 0) return null;
        return <div key={h.host} className="timers__host">
          <button type="button" className="timers__host-head" aria-expanded={isOpen} onClick={() => toggleOpen(h.host)}>
            <span className="timers__chev" aria-hidden>{isOpen ? '▾' : '▸'}</span>
            <span className="timers__host-name">{h.label ?? h.host}</span>
            <span className="timers__host-sum">{!h.reachable ? <span className="timers__bad">Can't reach</span> : `${h.timers.length} timer${h.timers.length === 1 ? '' : 's'}${off ? ` · ${off} off` : ''}`}</span>
          </button>
          {isOpen && (!h.reachable
            ? <div className="panel-empty">This machine didn't answer. Its timers are not shown so nothing out of date looks current.</div>
            : h.timers.length === 0 ? <div className="panel-empty">No timers.</div>
            : h.timers.map((t) => <div className="timers__row" key={t.name}>
              <span className="timers__text">
                <span className="timers__name" title={t.activates ? `Runs ${t.activates}` : t.name}>{t.name.replace(/\.timer$/, '')}</span>
                <span className="timers__sub">
                  <span className={`timers__state timers__state--${t.state}`}>{stateWord(t.state)}</span>
                  <span title={`Next: ${exact(t.next)}`}> · Next {relTime(t.next)}</span>
                  <span title={`Last: ${exact(t.last)}`}> · Last {relTime(t.last)}</span>
                </span>
              </span>
              {canToggle(t) && <button type="button" className="btn btn--sm btn--secondary" disabled={!!pending} onClick={() => void change(h.host, t)}>
                {pending === `${h.host}/${t.name}` ? 'Waiting for approval…' : t.state === 'enabled' ? 'Turn off' : 'Turn on'}
              </button>}
            </div>))}
        </div>;
      })}
      {checkedAt && <div className="timers__foot">Checked {new Date(checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Turning a timer on or off asks you first in the chat.</div>}
    </div>
    </div>
  </section>;
}
