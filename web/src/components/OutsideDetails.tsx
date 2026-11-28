import { useCallback, useEffect, useMemo, useState } from 'react';
import { safeLink } from '@shared/safe-url';
import type { Bot, OutsideExchange } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';

const STATUS_TEXT = {
  ready: 'Linked through Slack',
  paused: 'Paused. Nothing goes out until you turn it back on.',
  offline: 'Slack is not reachable right now. Messages wait here.',
  'not-set-up': 'The Slack link is not set up on this server yet.',
} as const;

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function gap(a: number, b: number) {
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function stateText(x: OutsideExchange) {
  if (x.direction === 'in') return 'Received';
  if (x.state === 'answered' && x.answeredAt) return x.type === 'A' || x.type === 'FYI' ? 'Sent' : `Answered in ${gap(x.createdAt, x.answeredAt)}`;
  if (x.state === 'sent' || x.state === 'sending') return 'Waiting';
  if (x.state === 'no-answer') return 'No answer';
  if (x.state === 'failed') return 'Failed';
  return x.state;
}

/** An outside member's page: who it is, the link switch, and every exchange with it. */
export function OutsideDetails({ bot }: { bot: Bot }) {
  const o = bot.outside!;
  const bots = useStore((s) => s.bots);
  const [list, setList] = useState<OutsideExchange[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.exchanges(bot.id).then((r) => { setList(r.exchanges); setErr(r.error); }).catch((e) => setErr(e.message));
  }, [bot.id]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load, bot.lastActivityAt]);

  const askers = useMemo(() => {
    const names = new Map<string, string>();
    for (const x of list ?? []) if (x.botId && x.botName) names.set(x.botId, x.botName);
    return [...names].map(([id, name]) => ({ id, name: displayName(bots.find((b) => b.id === id) ?? { name } as Bot) }));
  }, [list, bots]);

  const shown = (list ?? []).filter((x) =>
    filter === 'all' ? true : filter === 'waiting' ? x.direction === 'out' && (x.state === 'sent' || x.state === 'sending') : x.botId === filter,
  );

  const togglePause = async () => {
    setBusy(true);
    try { await api.setLinkPaused(bot.id, o.status !== 'paused'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="details__identity">
        <BotAvatarFor bot={bot} size={64} />
        <div className="details__name" title={displayName(bot)}>{displayName(bot)}</div>
        <span className="outside-badge outside-badge--lg">via Slack</span>
        <div className={`outside-status is-${o.status}`}>{STATUS_TEXT[o.status]} · #{o.channelName}</div>
        {o.callUrl && (
          <a className="btn btn--sm btn--primary" href={o.callUrl} target="_blank" rel="noreferrer" title={`Opens ChatGPT, where ${displayName(bot)} lives`}>
            Open in ChatGPT ↗
          </a>
        )}
        {(o.status === 'ready' || o.status === 'paused') && (
          <button type="button" className="btn btn--sm btn--secondary" onClick={togglePause} disabled={busy}>
            {o.status === 'paused' ? 'Turn the link back on' : 'Pause the link'}
          </button>
        )}
      </div>
      <div className="details__sections">
        <section>
          <div className="section-label">Exchanges</div>
          <div className="filter-chips" role="tablist">
            <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button>
            {askers.map((a) => (
              <button key={a.id} type="button" className={filter === a.id ? 'is-active' : ''} onClick={() => setFilter(a.id)}>{a.name}</button>
            ))}
            <button type="button" className={filter === 'waiting' ? 'is-active' : ''} onClick={() => setFilter('waiting')}>Waiting{o.waiting ? ` (${o.waiting})` : ''}</button>
          </div>
          {err && <div className="panel-empty">{err}</div>}
          <div className="exchange-list">
            {list === null ? <div className="panel-empty">Loading…</div> : shown.length === 0 ? (
              <div className="panel-empty">Nothing here yet. When a bot messages {displayName(bot)}, or {displayName(bot)} writes to one, it shows up here.</div>
            ) : shown.map((x) => (
              <div key={x.id} className={`exchange is-${x.direction}`}>
                <div className="exchange__head">
                  <span className="exchange__who">{x.direction === 'out' ? `${x.botName ?? 'You'} → ${displayName(bot)}` : `${displayName(bot)} → ${x.botName ?? 'group'}`}</span>
                  {x.type && <span className="exchange__type">{x.type}</span>}
                  <span className="exchange__time">{when(x.createdAt)}</span>
                </div>
                <div className="exchange__text">{x.text}</div>
                {x.replies.map((r, i) => (
                  <div key={i} className="exchange__reply">
                    <span className="exchange__reply-who">{displayName(bot)} · {gap(x.createdAt, r.createdAt)} later</span>
                    <span className="exchange__text">{r.text}</span>
                  </div>
                ))}
                <div className="exchange__foot">
                  <span className={`exchange__state is-${x.state}`}>{stateText(x)}</span>
                  {x.error && <span className="exchange__error">{x.error}</span>}
                  {safeLink(x.link) && <a href={safeLink(x.link)!} target="_blank" rel="noreferrer">Open in Slack ↗</a>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
