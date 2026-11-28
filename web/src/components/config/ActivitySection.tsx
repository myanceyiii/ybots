import { useEffect, useState, type ComponentType } from 'react';
import { api, type ActivityFilter, type ActivityOutcome, type ActivityPage, type ActivityRow, type ActivityStarter } from '../../lib/api';
import { fullDate, shortDate } from '../../lib/time';
import { downloadText } from '../ChatView';

/** The starter filter, in the order people ask about them. "Nobody watching" first: it is the one that matters. */
export const STARTERS: { id: ActivityStarter | 'unwatched' | ''; label: string }[] = [
  { id: '', label: 'Anyone' },
  { id: 'unwatched', label: 'Nobody watching' },
  { id: 'person', label: 'A person' },
  { id: 'routine', label: 'A routine' },
  { id: 'goal', label: 'A check-in' },
  { id: 'handoff', label: 'Another bot' },
  { id: 'script', label: 'A script' },
  { id: 'self', label: 'On its own' },
  { id: 'memory', label: 'A memory import' },
  { id: 'system', label: 'The app' },
];
const OUTCOMES: { id: ActivityOutcome | ''; label: string }[] = [{ id: '', label: 'All' }, { id: 'refused', label: 'Refused' }, { id: 'failed', label: 'Failed' }, { id: 'allowed', label: 'Allowed' }];
const OUTCOME_TEXT: Record<ActivityOutcome, string> = { allowed: 'Allowed', refused: 'Refused', failed: 'Failed' };

/** One line under the title: the bot, who it was for, what started it, and how it was decided. */
export function activitySub(r: ActivityRow): string {
  return [r.botName, r.forName && r.forName !== r.by.name ? `for ${r.forName}` : null, r.by.phrase, r.how].filter(Boolean).join(' · ');
}

/**
 * Settings > Activity: one list of everything the Bots were allowed, refused or failed to do, with what
 * started each action. Mirrors mobile/src/screens/Activity.tsx. The export is written to the trail.
 */
export function ActivitySection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const [f, setF] = useState<ActivityFilter>({});
  const [q, setQ] = useState('');
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // The search box waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.q === (q.trim() || undefined) ? x : { ...x, q: q.trim() || undefined })), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let live = true;
    setError(null);
    api.activity(f).then((r) => { if (live) setPage(r); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [f]);

  const more = async () => {
    if (!page?.rows.length) return;
    setLoadingMore(true);
    try {
      const next = await api.activity({ ...f, before: page.rows[page.rows.length - 1].id });
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
    } catch (e) { setError((e as Error).message); } finally { setLoadingMore(false); }
  };
  const exportCsv = async () => {
    setExporting(true);
    setExportNote(null);
    try {
      const r = await api.activityExport(f);
      downloadText(r.filename, r.csv, 'text/csv');
      setExportNote(r.truncated ? `Saved the newest ${r.rows.toLocaleString()} rows only. Narrow the filter to get the rest.` : `Saved ${r.rows.toLocaleString()} ${r.rows === 1 ? 'row' : 'rows'}. The download is noted in this list.`);
      setF((x) => ({ ...x })); // the export's own row shows at the top
    } catch (e) { setExportNote((e as Error).message); } finally { setExporting(false); }
  };
  const set = (patch: Partial<ActivityFilter>) => setF((x) => ({ ...x, ...patch, before: undefined }));

  return (
    <>
      <PageHead title="Activity" sub="Everything your Bots were allowed, refused or failed to do, and what started it. Kept for 180 days." />
      <section className="cfg-section">
        <div className="cfg-seg" role="radiogroup" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={(f.outcome ?? '') === o.id} className={(f.outcome ?? '') === o.id ? 'is-active' : ''} onClick={() => set({ outcome: (o.id || undefined) as ActivityOutcome | undefined })}>
              {o.label}{page && o.id ? ` ${page.counts[o.id].toLocaleString()}` : ''}
            </button>
          ))}
        </div>
        <div className="activity-filters">
          <button type="button" className={`activity-unwatched${f.by === 'unwatched' ? ' is-active' : ''}`} aria-pressed={f.by === 'unwatched'} onClick={() => set({ by: f.by === 'unwatched' ? undefined : 'unwatched' })}>
            Nobody watching{page ? ` · ${page.counts.unwatched.toLocaleString()}` : ''}
          </button>
          <select className="text-input cfg-compact-select" aria-label="Started by" value={f.by ?? ''} onChange={(e) => set({ by: (e.target.value || undefined) as ActivityFilter['by'] })}>
            {STARTERS.map((s) => <option key={s.id} value={s.id}>{s.id ? `Started by: ${s.label.toLowerCase()}` : 'Started by anyone'}</option>)}
          </select>
          <select className="text-input cfg-compact-select" aria-label="Bot" value={f.botId ?? ''} onChange={(e) => set({ botId: e.target.value || undefined })}>
            <option value="">Every Bot</option>
            {page?.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className="text-input activity-search" type="search" placeholder="Search" aria-label="Search the activity" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="activity-looks"><input type="checkbox" checked={!!f.looks} onChange={(e) => set({ looks: e.target.checked || undefined })} /> Show look-only steps (reading, listing, searching)</label>
        <div className="cfg-field__hint">
          <button type="button" className="cfg-link" disabled={exporting} onClick={exportCsv}>{exporting ? 'Saving…' : 'Download as a spreadsheet'}</button> (this filter, newest 5,000 rows).
          {exportNote && <> {exportNote}</>}
        </div>
      </section>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {!page && !error && <div className="cfg-empty">Loading…</div>}
      {page && !page.rows.length && <div className="cfg-empty">{f.by === 'unwatched' ? 'Nothing ran while nobody was watching.' : 'Nothing here yet.'}</div>}
      {page && page.rows.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-card">
            {page.rows.map((r) => (
              <div key={r.id} className="cfg-row activity-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">
                    <span className={`activity-badge is-${r.outcome}`}>{OUTCOME_TEXT[r.outcome]}</span>
                    {r.by.unwatched && <span className="activity-badge is-unwatched">Nobody watching</span>}
                    <span className="activity-title">{r.title}</span>
                  </div>
                  <div className="cfg-row__sub">{activitySub(r)}</div>
                  {r.detail && <div className="cfg-row__sub activity-detail">{r.detail}</div>}
                </div>
                <time className="activity-time" dateTime={new Date(r.at).toISOString()} title={fullDate(r.at)}>{shortDate(r.at)}</time>
              </div>
            ))}
          </div>
          {page.more && <button type="button" className="cfg-btn cfg-btn--secondary activity-more" disabled={loadingMore} onClick={more}>{loadingMore ? 'Loading…' : 'Show older'}</button>}
        </section>
      )}
    </>
  );
}
