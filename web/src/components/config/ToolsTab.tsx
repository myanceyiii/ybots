import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { pluginsApi, type PluginInfo } from '../../lib/pluginsApi';
import { usePluginSwitch } from './usePluginSwitch';
import { Switch } from './ui';
import { useConfigUI } from '../../configStore';

/** "Reads only · 34 of 85 tools" for a server's row. */
export function accessLine(p: Pick<PluginInfo, 'status' | 'error' | 'tools' | 'readOnly' | 'reads' | 'blocked'>): string {
  if (p.status !== 'ready') return p.error ? `${p.status}: ${p.error}` : p.status === 'disabled' ? 'turned off for every Bot' : 'not running';
  const reads = p.reads ?? 0;
  const usable = p.tools - (p.blocked ?? 0);
  if (p.readOnly) return `Reads only · ${reads} of ${p.tools} tools`;
  if (usable > reads) return `Reads run, changes ask you first · ${usable} of ${p.tools} tools`;
  return `${usable} of ${p.tools} tools, all reads`;
}

/**
 * Bot settings → Tools: which connected servers (MCP apps and plugins) this bot can use. The owner's
 * switch applies at once with an Undo toast, the same as Settings → Plugins; what is shown afterwards
 * is what the server read back. Anything that changes data still asks on a card in
 * the conversation, and a bot can never answer one.
 */
export function ToolsTab({ bot }: { bot: Bot }) {
  const [data, setData] = useState<{ owner: boolean; plugins: PluginInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => pluginsApi.list().then((r) => { setData(r); setError(null); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  const sw = usePluginSwitch<{ owner: boolean; plugins: PluginInfo[] } | null>(setData as never, setError);

  const rows = (data?.plugins ?? []).map((p) => ({ p, me: p.bots.find((b) => b.id === bot.id) })).filter((r) => r.me);
  const on = rows.filter((r) => r.me!.enabled);
  const off = rows.filter((r) => !r.me!.enabled);

  const row = ({ p, me }: (typeof rows)[number]) => (
    <div className="cfg-row" key={p.id}>
      <div className="cfg-row__text">
        <div className="cfg-row__title">{p.name} {p.readOnly && <span className="cfg-chip">Read only</span>} {p.exclusive && <span className="cfg-chip">One Bot only</span>}</div>
        <div className="cfg-row__sub">{accessLine(p)}{me!.fromDefault ? ' · default' : ''}</div>
        {p.description && <div className="cfg-row__sub">{p.description}</div>}
      </div>
      <Switch on={me!.enabled} label={`${p.name} for ${bot.name}`} disabled={!data?.owner || sw.pending === `${p.id}:${bot.id}`} onChange={(v) => sw.flip(p.id, bot.id, v)} />
    </div>
  );

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Connections</div>
          <div className="cfg-page__sub">
            What {bot.name} can reach. Reads run on their own; anything that changes data, spends money or touches a computer asks you on a card first, and a Bot can never answer one.
          </div>
        </div>
        {data?.owner && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { useConfigUI.getState().closeBotSettings(); useConfigUI.getState().openAppSettings('connections'); }}>Add a connection</button>}
      </div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {!data && !error && <div className="cfg-empty">Loading…</div>}
      {data && !data.owner && <div className="cfg-empty">Only the owner of this server can change which tools a Bot has.</div>}
      {data && !rows.length && <div className="cfg-empty">Nothing is connected yet. Add a connection in Settings › Connections.</div>}
      {on.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-section__label">On for {bot.name}</div>
          <div className="cfg-card">{on.map(row)}</div>
        </section>
      )}
      {off.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-section__label">Off</div>
          <div className="cfg-card">{off.map(row)}</div>
        </section>
      )}
      {sw.toast}
    </div>
  );
}
