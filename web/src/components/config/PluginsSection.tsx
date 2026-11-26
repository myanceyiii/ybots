import { useState } from 'react';
import type { SettingField } from '@shared/plugins/ui-schema';
import { pluginsApi, type PluginChange, type PluginDraft, type PluginInfo } from '../../lib/pluginsApi';
import { Switch } from './ui';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';

const DRAFT_STATUS: Record<string, string> = { planned: 'waiting for Build', building: 'being built', checking: 'being checked', checked: 'ready for your review', failed: 'checks failed', installed: 'installed', rejected: 'not installed', removed: 'removed' };
const HAS_CODE = new Set(['checked', 'failed', 'installed', 'rejected', 'removed']);

/** Close Settings and open a Bot's chat (where its plan and review cards are). */
export function openBotChat(botId: string) {
  useConfigUI.getState().closeAppSettings();
  useConfigUI.getState().setView('chat');
  useStore.getState().selectBot(botId);
  useStore.getState().set({ pane: 'content' });
}


/** Plugins a Bot planned or built, and the button that takes you to its card in that Bot's chat. */
export function DraftsList({ drafts, onCode }: { drafts: PluginDraft[]; onCode: (draftId: string) => void }) {
  const waiting = drafts.filter((d) => d.status === 'planned' || d.status === 'checked').length;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Plugins made with a Bot{waiting ? ` · ${waiting} waiting on you` : ''}</div>
      <div className="cfg-card">
        {drafts.map((d) => (
          <div key={d.id} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{d.title}</div>
              <div className="cfg-row__sub">{d.botName} · {DRAFT_STATUS[d.status] ?? d.status}{d.checks?.some((c) => !c.ok) ? ` · ${d.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')} failed` : ''}</div>
              <div className="cfg-row__sub">{d.tools.map((t) => `${t.name}${t.writes ? ' (changes things)' : ''}`).join(', ')} · {d.network.length ? `talks to ${d.network.join(', ')}` : 'no network'}</div>
            </div>
            <div className="cfg-row-actions">
              {HAS_CODE.has(d.status) && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => onCode(d.id)}>View code</button>}
              <button type="button" className={`cfg-btn ${d.status === 'planned' || d.status === 'checked' ? 'cfg-btn--primary' : 'cfg-btn--secondary'}`} onClick={() => openBotChat(d.botId)}>
                {d.status === 'planned' ? 'Review plan' : d.status === 'checked' ? 'Review and install' : 'Open chat'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="cfg-row__sub">Build and Install are on the cards in each Bot's conversation, so you always press them next to what the Bot said.</div>
    </section>
  );
}

/** Install a plugin from npm by exact version. Proposed first; it arrives switched off. */
export function NpmInstall({ busy, onCheck }: { busy: boolean; onCheck: (spec: string) => void }) {
  const [spec, setSpec] = useState('');
  return (
    <div className="connector-form">
      <div className="cfg-row__sub">Checked before anything is installed: exact version, no install scripts, pinned dependencies. It arrives switched off.</div>
      <div className="connector-pick">
        <input className="text-input" placeholder="package-name@1.2.3" value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="Package and exact version" />
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || !spec.trim()} onClick={() => onCheck(spec.trim())}>Check</button>
      </div>
    </div>
  );
}

/** Pick a Bot and say what the plugin should do. The request goes into that Bot's chat as your message. */
export function CreatePlugin({ onCancel }: { onCancel: () => void }) {
  const bots = useStore((s) => s.bots).filter((b) => b.kind !== 'room' && !b.outside);
  const [botId, setBotId] = useState(() => (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? '');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try { const r = await pluginsApi.create(botId, idea.trim()); openBotChat(r.botId); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Create plugin</div>
      <div className="cfg-card plugin-create">
        <div className="cfg-row">
          <div className="cfg-row__text"><label className="cfg-row__title" htmlFor="plugin-create-bot">Who builds it</label><div className="cfg-row__sub">The Bot plans it in its chat. It can't install anything.</div></div>
          <select id="plugin-create-bot" className="text-input plugin-create__bot" value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="cfg-row plugin-create__idea">
          <label className="cfg-row__title" htmlFor="plugin-create-idea">What should it do?</label>
          <textarea id="plugin-create-idea" className="text-input" rows={4} maxLength={2000} value={idea} onChange={(e) => setIdea(e.target.value)}
            placeholder="For example: look up the weather for a city, or list this week's court holidays for Texas." />
        </div>
        <div className="cfg-row"><div className="cfg-row__sub">Next: a plan card in the chat (its tools and the sites it talks to) → you press Build → the server checks the code in a sandbox → you read the code and permissions → you press Install. It arrives switched off unless you pick Bots on that card. Plugins can never answer approvals.</div></div>
        {error && <div className="cfg-error" role="alert">{error}</div>}
        <div className="cfg-row plugin-confirm__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || !botId || idea.trim().length < 8} onClick={send}>{busy ? 'Sending…' : 'Ask for a plan'}</button>
        </div>
      </div>
    </section>
  );
}

export function ConfirmCard({ change, busy, onCancel, onConfirm }: { change: PluginChange; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const del = change.action === 'delete';
  return (
    <section className="cfg-section">
      <div className="cfg-card plugin-confirm" role="dialog" aria-label="Confirm change">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">{change.summary}?</div>
            <ul className="plugin-confirm__details">{change.details.map((d) => <li key={d}>{d}</li>)}</ul>
            <div className="cfg-row__sub">Confirm within {Math.max(1, Math.round((change.expiresAt - Date.now()) / 60000))} minutes.</div>
          </div>
        </div>
        <div className="cfg-row plugin-confirm__actions">
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={`cfg-btn ${del ? 'cfg-btn--danger' : 'cfg-btn--primary'}`} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : del ? 'Delete' : 'Confirm'}</button>
        </div>
      </div>
    </section>
  );
}

export function SettingsForm({ p, onSaved }: { p: Pick<PluginInfo, "id" | "settings" | "values">; onSaved: () => void }) {
  const initial = Object.fromEntries(p.settings.map((f) => [f.key, typeof p.values[f.key] === 'object' ? '' : (p.values[f.key] ?? (f.type === 'boolean' ? false : ''))]));
  const [vals, setVals] = useState<Record<string, unknown>>(initial);
  const [note, setNote] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setVals((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setNote(null);
    try { await pluginsApi.saveSettings(p.id, vals); setNote('Saved. The plugin restarts with these settings.'); onSaved(); } catch (e) { setNote((e as Error).message); }
  };
  const input = (f: SettingField) => {
    const id = `ps-${p.id}-${f.key}`;
    switch (f.type) {
      case 'boolean': return <Switch on={vals[f.key] === true} label={f.label} onChange={(v) => set(f.key, v)} />;
      case 'select': return <select id={id} className="text-input" value={String(vals[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}><option value="" />{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      case 'number': return <input id={id} className="text-input" type="number" value={String(vals[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} />;
      case 'secret': return <input id={id} className="text-input" type="password" autoComplete="off" placeholder={(p.values[f.key] as { set?: boolean } | undefined)?.set ? 'Saved (leave blank to keep)' : ''} value={String(vals[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
      default: return <input id={id} className="text-input" placeholder={f.placeholder} value={String(vals[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };
  return (
    <div className="plugin-settings">
      {p.settings.map((f) => (
        <div key={f.key} className="cfg-row">
          <div className="cfg-row__text"><label className="cfg-row__title" htmlFor={`ps-${p.id}-${f.key}`}>{f.label}</label>{f.help && <div className="cfg-row__sub">{f.help}</div>}</div>
          {input(f)}
        </div>
      ))}
      <div className="cfg-row">
        {note && <div className="cfg-row__sub" role="status">{note}</div>}
        <button type="button" className="cfg-btn cfg-btn--primary" onClick={save}>Save settings</button>
      </div>
    </div>
  );
}
