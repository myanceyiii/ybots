import { useEffect, useState } from 'react';
import { pluginsApi } from '../../lib/pluginsApi';
import { useConfigUI } from '../../configStore';
import { Glyph } from './glyphs';

/**
 * Sidebar → Connections: opens Settings › Connections (what Bots can reach, per-Bot switches, adding
 * a connection, plugins). The count is plugin plans and builds waiting on the owner.
 */
export function PluginsIsland() {
  const open = useConfigUI((s) => s.appSettings === 'connections');
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => pluginsApi.list().then((r) => { if (alive) setWaiting((r.drafts ?? []).filter((d) => d.status === 'planned' || d.status === 'checked').length); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener('focus', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', load); };
  }, [open]);
  return (
    <button type="button" className={`sidebar-island${open ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().openAppSettings('connections')} title="Connections">
      <span className="sidebar-island__icon"><Glyph name="plugin" size={18} /></span>
      <span className="sidebar-island__label">Connections</span>
      {waiting > 0 && <span className="sidebar-island__count" aria-label={`${waiting} waiting on you`}>{waiting}</span>}
    </button>
  );
}
