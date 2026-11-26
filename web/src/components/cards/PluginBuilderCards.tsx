import { useState } from 'react';
import type { CardBody } from '@shared/types';
import { pluginsApi } from '../../lib/pluginsApi';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { PluginCode } from '../config/PluginCode';

type Plan = Extract<CardBody, { card: 'plugin-plan' }>;
type Review = Extract<CardBody, { card: 'plugin-review' }>;

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const ToolList = ({ tools }: { tools: Plan['tools'] }) => (
  <ul className="plugin-build__tools">
    {tools.map((t) => <li key={t.name}><code>{t.name}</code> {t.description} <span className={`plugin-card__badge is-${t.writes ? 'warn' : 'neutral'}`}>{t.writes ? 'changes things' : 'reads only'}</span></li>)}
  </ul>
);

/** A bot's plan for a plugin. Build authorizes building this plan only; nothing is installed. */
export function PluginPlanCard({ body }: { body: Plan }) {
  const { busy, error, run } = useRun();
  const pending = body.status === 'pending';
  return (
    <div className={`card plugin-build${pending ? '' : ' is-resolved'}`}>
      <div className="card__head"><div className="card__titles">
        <div className="card__eyebrow">New plugin plan</div>
        <div className="card__title">{body.title}</div>
        <div className="card__sub">{body.purpose}</div>
      </div></div>
      <div className="plugin-card__body">
        <ToolList tools={body.tools} />
        <div className="card__sub">{body.network.length ? `Talks to: ${body.network.join(', ')}` : 'No network access.'}</div>
      </div>
      {pending ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => run(() => pluginsApi.dismiss(body.draftId))}>Not now</button>
          <button type="button" className="btn btn--primary btn--grow" disabled={busy} onClick={() => run(() => pluginsApi.build(body.draftId))}>Build</button>
        </div>
      ) : (
        <div className="card__outcome" style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'dismissed' ? 'close' : 'check'} size={12} opacity={0.7} />
          {{ building: 'Building. You review it before anything is installed.', built: 'Built and installed', dismissed: 'Not built', expired: 'Expired. Ask the Bot to plan it again.' }[body.status as 'building' | 'built' | 'dismissed' | 'expired']}
        </div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{error}</div>}
    </div>
  );
}

const OUTCOME: Record<string, string> = { installed: 'Installed', rejected: 'Not installed', removed: 'Removed (restore it from Settings, Plugins)', superseded: 'Replaced by a newer version below', failed: 'Checks failed; the Bot was told what to fix', expired: 'Expired. Ask the Bot to submit it again.' };

/** The checked draft. Install sends back the fingerprint shown here; only the owner can press it. */
export function PluginReviewCard({ body }: { body: Review }) {
  const { busy, error, run } = useRun();
  const bots = useStore((s) => s.bots);
  const [picked, setPicked] = useState<string[]>([]);
  const [code, setCode] = useState(false);
  const pending = body.status === 'pending';
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className={`card plugin-build${pending ? '' : ' is-resolved'}`}>
      <div className="card__head"><div className="card__titles">
        <div className="card__eyebrow">Plugin ready for review</div>
        <div className="card__title">{body.title}</div>
        {body.digest && <div className="card__sub">Fingerprint <code>{body.digest.slice(0, 16)}</code></div>}
      </div></div>
      <div className="plugin-card__body">
        <ul className="plugin-build__checks">
          {body.checks.map((c) => <li key={c.name} className={c.ok ? 'is-ok' : 'is-bad'}><Icon name={c.ok ? 'check' : 'close'} size={12} /> <b>{c.name}:</b> {c.detail}</li>)}
        </ul>
        {body.notes.length > 0 && <ul className="plugin-build__notes">{body.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <ToolList tools={body.tools} />
        <div className="card__sub">{body.network.length ? `Talks to: ${body.network.join(', ')}` : 'No network access.'} Files: {body.files.join(', ')}</div>
        {body.status !== 'superseded' && <button type="button" className="btn btn--secondary plugin-build__code" onClick={() => setCode(true)}>View code</button>}
        {pending && (
          <fieldset className="plugin-build__bots">
            <legend>Turn it on for (optional)</legend>
            {bots.map((b) => <label key={b.id}><input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)} /> {b.name}</label>)}
          </fieldset>
        )}
      </div>
      {pending ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => run(() => pluginsApi.dismiss(body.draftId))}>Don't install</button>
          <button type="button" className="btn btn--primary btn--grow" disabled={busy} onClick={() => run(() => pluginsApi.installDraft(body.draftId, body.digest, picked))}>Install</button>
        </div>
      ) : body.status === 'installed' ? (
        <div className="card__actions">
          <span className="card__outcome"><Icon name="check" size={12} opacity={0.7} /> Installed</span>
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => run(() => pluginsApi.undoDraft(body.draftId))}>Undo</button>
        </div>
      ) : (
        <div className="card__outcome" style={{ padding: '0 16px 16px' }}>{OUTCOME[body.status] ?? body.status}</div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{error}</div>}
      {code && <PluginCode draftId={body.draftId} onClose={() => setCode(false)} />}
    </div>
  );
}
