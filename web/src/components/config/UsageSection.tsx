import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '@shared/page-chart';
import { api, type UsageCounts, type UsageReport } from '../../lib/api';
import { useIsDark } from '../../configStore';
import { relativeShort } from '../../lib/time';
import { downloadText } from '../ChatView';

/** The numbers on this page as CSV: a block per day, then a block per Bot. Names are quoted; a name can hold a comma. */
export function usageCsv(d: UsageReport): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [
    'Day,Replies,Failed,Tokens read,Tokens written',
    ...d.byDay.map((x) => [x.day, x.turns, x.failed, x.inputTokens, x.outputTokens].join(',')),
    '',
    'Bot,Replies,Failed,Tokens read,Tokens written,Most used model',
    ...d.byBot.map((x) => [q(x.name), x.turns, x.failed, x.inputTokens, x.outputTokens, q(x.topModel ?? '')].join(',')),
    '',
  ].join('\n');
}

const RANGES = [{ days: 7, label: '7 days' }, { days: 14, label: '14 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
const big = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const tokens = (c: UsageCounts) => (c.inputTokens + c.outputTokens ? `${big(c.inputTokens)} in, ${big(c.outputTokens)} out` : 'tokens not reported');
const failedText = (c: UsageCounts) => (c.failed ? ` · ${c.failed} failed` : '');
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Settings > Usage: replies and tokens per day, per Bot and per model, from what each reply already records.
 * Counts only: the app does not know what a provider charges.
 */
export function UsageSection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dark = useIsDark();
  useEffect(() => {
    let live = true;
    setError(null);
    api.usage(days).then((r) => { if (live) setData(r); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [days]);
  const svg = useMemo(() => {
    if (!data || !data.totals.turns) return null;
    // Every nth day is named, so the labels never run into each other.
    const step = Math.ceil(data.byDay.length / 10);
    const block = { chart: 'bar', labels: data.byDay.map((d, i) => (i % step === 0 ? dayLabel(d.day) : '')), series: [{ name: 'Replies', values: data.byDay.map((d) => d.turns) }] };
    return chartSvg(block, { blocks: [] }, 640, 260, dark ? CHART_DARK : CHART_LIGHT);
  }, [data, dark]);
  const busiest = data?.byDay.reduce((a, d) => (d.turns > a.turns ? d : a), data.byDay[0]);

  return (
    <>
      <PageHead title="Usage" sub="How much your Bots have been working. Counted from every reply; kept for 90 days." />
      <section className="cfg-section">
        <div className="cfg-seg" role="radiogroup" aria-label="Period">
          {RANGES.map((r) => <button key={r.days} type="button" role="radio" aria-checked={days === r.days} className={days === r.days ? 'is-active' : ''} onClick={() => setDays(r.days)}>{r.label}</button>)}
        </div>
        {data && data.totals.turns > 0 && <div className="cfg-field__hint"><button type="button" className="cfg-link" onClick={() => downloadText(`ybots-usage-${data.days}-days.csv`, usageCsv(data), 'text/csv')}>Download as a spreadsheet</button> (one row per day and one per Bot).</div>}
      </section>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {!data && !error && <div className="cfg-empty">Counting…</div>}
      {data && (
        <>
          <section className="cfg-section">
            <div className="usage-tiles">
              <div className="usage-tile"><div className="usage-tile__n">{data.totals.turns.toLocaleString()}</div><div className="usage-tile__l">replies</div></div>
              <div className="usage-tile"><div className="usage-tile__n">{big(data.totals.inputTokens)}</div><div className="usage-tile__l">tokens read</div></div>
              <div className="usage-tile"><div className="usage-tile__n">{big(data.totals.outputTokens)}</div><div className="usage-tile__l">tokens written</div></div>
              <div className="usage-tile"><div className={`usage-tile__n${data.totals.failed ? ' is-warn' : ''}`}>{data.totals.failed.toLocaleString()}</div><div className="usage-tile__l">failed</div></div>
            </div>
          </section>
          {data.totals.turns === 0 ? <div className="cfg-empty">No replies in this period.</div> : (
            <>
              <section className="cfg-section">
                <div className="cfg-section__label">Replies per day</div>
                {svg && <div className="page-chart usage-chart" role="img" aria-label={`Replies per day over ${data.days} days${busiest ? `; the busiest was ${dayLabel(busiest.day)} with ${busiest.turns}` : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />}
                {busiest && busiest.turns > 0 && <div className="cfg-field__hint">Busiest day: {dayLabel(busiest.day)}, {busiest.turns} {busiest.turns === 1 ? 'reply' : 'replies'}.</div>}
              </section>
              <section className="cfg-section">
                <div className="cfg-section__label">By Bot</div>
                <div className="cfg-card">
                  {data.byBot.map((b) => (
                    <div key={b.botId} className="cfg-row">
                      <div className="cfg-row__text">
                        <div className="cfg-row__title">{b.name}</div>
                        <div className="cfg-row__sub">{tokens(b)}{b.topModel ? ` · mostly ${b.topModel}` : ''}{b.lastAt ? ` · last reply ${relativeShort(b.lastAt) === "now" ? "just now" : /^\d/.test(relativeShort(b.lastAt)) ? `${relativeShort(b.lastAt)} ago` : relativeShort(b.lastAt).toLowerCase()}` : ''}{failedText(b)}</div>
                        <div className="usage-bar" aria-hidden><span style={{ width: `${Math.max(2, Math.round((b.turns / data.byBot[0].turns) * 100))}%` }} /></div>
                      </div>
                      <div className="usage-count">{b.turns.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="cfg-section">
                <div className="cfg-section__label">By model</div>
                <div className="cfg-card">
                  {data.byModel.map((m) => (
                    <div key={`${m.provider}/${m.model}`} className="cfg-row">
                      <div className="cfg-row__text">
                        <div className="cfg-row__title">{m.model}</div>
                        <div className="cfg-row__sub">{m.provider ? `${m.provider} · ` : ''}{tokens(m)}{failedText(m)}</div>
                      </div>
                      <div className="usage-count">{m.turns.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <div className="cfg-field__hint">Side chats and helpers count for the Bot they belong to. What each provider charges is on its own billing page.</div>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
