import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { byRank, connectorsApi, type AdminChange, type ConnectorChange, type ConnectorInfo, type ConnectorList } from '../../lib/connectorsApi';
import { connectionsApi, type ConnProposal, type Connection, type ConnectionList, type ReadyConnection, type ToolRule } from '../../lib/connectionsApi';
import { pluginsApi, type PluginChange, type PluginDraft } from '../../lib/pluginsApi';
import { Icon } from '../Icon';
import { ConfirmCard, CreatePlugin, DraftsList, NpmInstall, SettingsForm } from './PluginsSection';
import { ConnectByAddress, ConnectGoogle, ConnectorRows, connectorIsPast, WantedBlock } from './ConnectorsSection';
import { PluginCode } from './PluginCode';
import { usePluginSwitch } from './usePluginSwitch';
import { Switch, shortDate } from './ui';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import type { WebSearchStatus } from '../../lib/connectorsApi';

type AddWhat = 'google' | 'ready' | 'address' | 'build' | 'npm';
const RULES: { value: ToolRule; label: string }[] = [{ value: 'runs', label: 'Runs' }, { value: 'asks', label: 'Asks first' }, { value: 'off', label: 'Off' }];

/**
 * Settings → Connections, the same on web, Windows and Android (mobile/src/screens/Connections.tsx).
 * The server words every row (server/src/connections.ts), so all three say the same thing:
 *
 *  - Your connections: one row each, with its status (Connected, Needs reconnect, Not working, Off),
 *    a one-line summary and who uses it. A row that needs attention shows its problem and Reconnect
 *    without opening. Open a row for the per-Bot switches (at once, with Undo), Reconnect, Turn off /
 *    Turn on / Remove (confirmed once), what each tool may do, and Advanced (where it runs, how it
 *    was set up) folded away.
 *  - Add a connection: a Google account, one that is ready to add, a server by its address, a plugin.
 *  - Suggestions, Recent changes (with Undo) and Everything on your machines, folded away.
 */
export function ConnectionsSection({ PageHead }: { PageHead: (p: { title: string; sub?: string }) => JSX.Element }) {
  const [data, setData] = useState<ConnectionList | null>(null);
  const [conns, setConns] = useState<ConnectorList | null>(null);
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<ConnProposal | null>(null);
  const [changeAt, setChangeAt] = useState<string | null>(null);
  const [cChange, setCChange] = useState<ConnectorChange | null>(null);
  const [cChangeAt, setCChangeAt] = useState<string | null>(null);
  const [pChange, setPChange] = useState<PluginChange | null>(null);
  const [adding, setAdding] = useState<AddWhat | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [adminChanges, setAdminChanges] = useState<AdminChange[]>([]);

  const loadMain = useCallback(() => connectionsApi.list().then((r) => { setData(r); setError(null); }).catch((e) => setError((e as Error).message)), []);
  const load = useCallback(() => Promise.all([
    loadMain(),
    connectorsApi.list().then(setConns).catch(() => {}),
    connectorsApi.adminChanges().then((r) => setAdminChanges(r.changes)).catch(() => {}),
    pluginsApi.list().then((r) => setDrafts(r.drafts ?? [])).catch(() => {}),
  ]), [loadMain]);
  useEffect(() => { void load(); }, [load]);
  const paint = useCallback((id: string, botId: string, on: boolean) => setData((d) => (d ? { ...d, connections: d.connections.map((c) => (c.id !== id ? c : { ...c, bots: c.bots.map((b) => (b.id === botId ? { ...b, on } : b)) })) } : d)), []);
  const sw = usePluginSwitch(() => {}, setError, paint);
  const owner = !!data?.owner;

  const run = async (f: () => Promise<unknown>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const cancelOpen = async () => {
    if (change) await connectionsApi.cancel(change.id).catch(() => {});
    if (cChange) await connectorsApi.cancel(cChange.id).catch(() => {});
    setChange(null); setChangeAt(null); setCChange(null); setCChangeAt(null);
  };
  /** Asking for another change replaces the one still open, so no row is held up waiting on it. */
  const propose = (id: string, action: string) => run(async () => { await cancelOpen(); setChange(await connectionsApi.propose(id, action)); setChangeAt(id); });
  const confirm = () => run(async () => {
    if (!change) return;
    try {
      const r = await connectionsApi.confirm(change.id, change.digest);
      if (r.signInUrl) { window.open(r.signInUrl, '_blank', 'noopener'); setNote(r.note ?? 'Finish on the page that opened, then come back here.'); }
      else setNote(`Done: ${change.summary}.`);
    } finally { setChange(null); setChangeAt(null); await load(); }
  });
  const reconnect = (id: string, write?: boolean) => run(async () => {
    const r = await connectionsApi.reconnect(id, write);
    if (r.signInUrl) window.open(r.signInUrl, '_blank', 'noopener');
    setNote(r.note);
    if (!r.signInUrl) await load();
  });
  const setTool = (id: string, tool: string, rule: ToolRule | null) => run(async () => {
    const r = await connectionsApi.setTool(id, tool, rule);
    setData((d) => (d ? { ...d, connections: d.connections.map((c) => (c.id !== id ? c : { ...c, tools: c.tools.map((t) => (t.name === tool ? r.tool : t)) })) } : d));
  });
  const proposeAdd = (connectorId: string, bots: string[]) => run(async () => { await cancelOpen(); setCChange(await connectorsApi.propose({ action: 'add', connectorId, bots })); setCChangeAt(connectorId); });
  const confirmAdd = () => run(async () => { if (!cChange) return; try { await connectorsApi.confirm(cChange.id, cChange.digest); setNote(`Done: ${cChange.summary}.`); } finally { setCChange(null); setCChangeAt(null); await load(); } });
  const proposePlugin = (b: Parameters<typeof pluginsApi.propose>[0]) => run(async () => setPChange(await pluginsApi.propose(b)));
  const confirmPlugin = () => run(async () => { if (!pChange) return; try { await pluginsApi.confirm(pChange.id, pChange.digest); setAdding(null); } finally { setPChange(null); await load(); } });
  const undoAdmin = (ch: AdminChange) => run(async () => {
    if (!window.confirm(`Undo "${ch.summary}"?`)) return;
    const r = await connectorsApi.undoAdminChange(ch.id);
    setNote(`Done: ${r.summary}.`);
    await load();
  });
  const scan = () => run(async () => {
    setNote('Scanning your machines…');
    const r = await connectorsApi.scan();
    setNote(r.error ? `Scan: ${r.error}` : `Scan done: ${r.found} found, ${r.added} new, ${r.gone} no longer found.`);
    await load();
  });

  const all = conns?.connectors ?? [];
  const browserSites = all.filter((c) => c.browserSite);
  const suggestions = all.filter((c) => c.wanted && !c.browserSite && !connectorIsPast(c)).sort(byRank);
  const attention = (data?.connections ?? []).filter((c) => c.state === 'needs_reconnect' || c.state === 'not_working').length;

  const box = (p: { summary: string; details: string[]; danger?: boolean }, onCancel: () => void, onConfirm: () => void) => (
    <div className="cfg-card plugin-confirm" role="dialog" aria-label="Confirm change" ref={(el) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
      <div className="cfg-row"><div className="cfg-row__text">
        <div className="cfg-row__title">{p.summary}?</div>
        <ul className="plugin-confirm__details">{p.details.map((d) => <li key={d}>{d}</li>)}</ul>
      </div></div>
      <div className="cfg-row plugin-confirm__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={`cfg-btn ${p.danger ? 'cfg-btn--danger' : 'cfg-btn--primary'}`} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : 'Confirm'}</button>
      </div>
    </div>
  );
  const changeBox = change && change.status === 'pending' ? box(change, () => void cancelOpen(), confirm) : null;
  const addBox = cChange && cChange.status === 'pending' ? box(cChange, () => void cancelOpen(), confirmAdd) : null;

  return (
    <>
      <PageHead title="Connections" sub="Everything your Bots can reach. Open one to choose which Bots use it, reconnect it, or change what it may do." />
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {note && <div className="cfg-row__sub connections-note" role="status">{note}</div>}

      <div className="cfg-section__label">Your connections{data ? ` · ${data.connections.length}` : ''}{attention ? ` · ${attention} need${attention === 1 ? 's' : ''} you` : ''}</div>
      {!data && !error && <div className="cfg-empty">Loading…</div>}
      {data && !data.connections.length && (
        <div className="cfg-empty">Nothing is connected yet. Start with <strong>Add a connection</strong> below: a Google account is the quickest.</div>
      )}
      {!!data?.connections.length && (
        <section className="cfg-section">
          <div className="cfg-card">
            {data.connections.map((c) => (
              <ConnectionRow key={c.id} c={c} owner={owner} busy={busy} switching={sw.pending}
                onFlip={(botId, on) => sw.flip(c.id, botId, on)} onReconnect={(w) => (c.reconnect?.confirm ? propose(c.id, 'reconnect') : reconnect(c.id, w))}
                onAction={(a) => propose(c.id, a)} onTool={(tool, rule) => setTool(c.id, tool, rule)} onSaved={loadMain}
                confirmBox={changeAt === c.id ? changeBox : null} />
            ))}
          </div>
        </section>
      )}
      {!!data?.connections.length && owner && <div className="cfg-row__sub connections-hint">Switches apply right away, with Undo for a few seconds. Anything that changes data asks on a card in the chat, unless you set that tool to run on its own.</div>}
      {data && !owner && <div className="cfg-row__sub">Only the owner of this server can add or change connections.</div>}

      <WebSearchCard owner={owner} />

      {owner && !!drafts.length && <DraftsList drafts={drafts} onCode={setCode} />}

      {owner && (
        <section className="cfg-section">
          <div className="cfg-section__label">Add a connection</div>
          {pChange && pChange.status === 'pending' && <ConfirmCard change={pChange} busy={busy} onCancel={() => { void pluginsApi.cancel(pChange.id).catch(() => {}); setPChange(null); }} onConfirm={confirmPlugin} />}
          <div className="cfg-card">
            <Expand id="google" open={adding} set={setAdding} title="Google account" sub="Gmail, Calendar, Drive and Tasks for one Google account.">
              <ConnectGoogle busy={busy} onStarted={() => setNote('Finish signing in to Google on the page that opened. The account then shows under Ready to add; give it to a Bot there.')} />
            </Expand>
            <Expand id="ready" open={adding} set={setAdding} title={`Ready to add${data ? ` · ${data.ready.length}` : ''}`} sub="Accounts you've signed in to and services on your machines that no Bot has yet.">
              {data && (data.ready.length
                ? <ReadyRows list={data.ready} bots={conns?.bots ?? []} busy={busy} confirmFor={cChangeAt ?? changeAt} confirmBox={addBox ?? changeBox}
                    onAdd={proposeAdd} onReconnect={(id) => reconnect(id)} onDelete={(id) => propose(id, 'delete')} />
                : <div className="cfg-row"><div className="cfg-row__sub">Nothing waiting. Everything that is ready is already connected.</div></div>)}
            </Expand>
            <Expand id="address" open={adding} set={setAdding} title="A service by its address" sub="Any MCP server: its address, plus a key or sign-in if it needs one.">
              <ConnectByAddress busy={busy} onCancel={() => setAdding(null)} onDone={async (r) => {
                if (r.signInUrl) { window.open(r.signInUrl, '_blank', 'noopener'); setNote('Finish signing in on the page that opened, then give it to your Bots under Ready to add.'); }
                else setNote('Connected. Give it to your Bots under Ready to add.');
                setAdding('ready');
                await load();
              }} />
            </Expand>
            <Expand id="build" open={adding} set={setAdding} title="Build a plugin with a Bot" sub="Describe a tool you want. A Bot plans it; you read the code before it's installed.">
              <CreatePlugin onCancel={() => setAdding(null)} />
            </Expand>
            <Expand id="npm" open={adding} set={setAdding} title="Install a plugin from npm" sub="By package name and exact version.">
              <NpmInstall busy={busy || !!pChange} onCheck={(spec) => proposePlugin({ action: 'install', spec })} />
            </Expand>
          </div>
        </section>
      )}

      {conns && suggestions.length > 0 && (
        <Fold title={`Suggestions · ${suggestions.length}`} sub="Connections your household skills could use, in the order to set them up.">
          <div className="cfg-card">
            {suggestions.map((c) => (
              <div className="cfg-row connector-row" key={c.id}>
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{c.wanted?.rank ? `${c.wanted.rank}. ` : ''}{c.name}</div>
                  {c.description && <div className="cfg-row__sub">{c.description}</div>}
                  {c.wanted && <WantedBlock w={c.wanted} />}
                  {c.id === 'claude-browser' && browserSites.length > 0 && (
                    <div className="cfg-row__sub"><strong>Then used for:</strong> {browserSites.map((b) => b.name).join(', ')}. These are sign-ins inside the shared browser, not connections of their own.</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Fold>
      )}

      {owner && adminChanges.length > 0 && (
        <Fold title={`Recent changes · ${adminChanges.length}`} sub="Changes to connections made here or by your admin Bot. Undo puts one back.">
          <div className="cfg-card">
            {adminChanges.map((ch) => (
              <div className="cfg-row connector-row" key={ch.id}>
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{ch.summary}</div>
                  <div className="cfg-row__sub">
                    {ch.byPerson ? `${ch.bot}${ch.via ? `, ${ch.via}` : ''}` : `${ch.bot} · ${ch.status === 'applied' ? `allowed by ${ch.approvedBy ?? 'someone'}${ch.via ? ` (${ch.via})` : ''}` : ch.status}`} · {shortDate(new Date(ch.appliedAt ?? ch.at).getTime())}
                    {ch.rolledBackBy ? ' · undone' : ''}
                  </div>
                </div>
                {ch.canRollBack && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => undoAdmin(ch)}>Undo</button>}
              </div>
            ))}
          </div>
        </Fold>
      )}

      {conns && owner && <MachinesFold conns={conns} busy={busy} onScan={scan} />}
      {code && <PluginCode draftId={code} onClose={() => setCode(null)} />}
      {sw.toast}
    </>
  );
}

const STATE_CLASS: Record<Connection['state'], string> = { connected: 'is-ok', needs_reconnect: 'is-warn', not_working: 'is-bad', off: 'is-off' };

/** One connection: a collapsed row (status, summary, who uses it, and the fix when it needs one); open it for everything else. */
function ConnectionRow({ c, owner, busy, switching, onFlip, onReconnect, onAction, onTool, onSaved, confirmBox }: {
  c: Connection; owner: boolean; busy: boolean; switching: string | null;
  onFlip: (botId: string, on: boolean) => void; onReconnect: (write?: boolean) => void; onAction: (a: string) => void;
  onTool: (tool: string, rule: ToolRule | null) => void; onSaved: () => void; confirmBox: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState(false);
  const [adv, setAdv] = useState(false);
  const [write, setWrite] = useState(false);
  const bodyId = `conn-body-${c.id}`;
  const needs = c.state === 'needs_reconnect' || c.state === 'not_working';
  return (
    <div className="connections-item">
      <button type="button" className="plugin-head" aria-expanded={open || !!confirmBox} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <div className="plugin-head__text">
          <div className="cfg-row__title conn-title">
            {c.name}
            <span className={`conn-state ${STATE_CLASS[c.state]}`}>{c.stateText}</span>
            {c.firm && <span className="cfg-chip">Firm</span>}
          </div>
          <div className="cfg-row__sub">{c.summary}</div>
          <div className="cfg-row__sub"><span className="plugin-head__on">{c.usedBy}</span> · {c.toolsLine}</div>
          {c.problem && <div className={`cfg-row__sub conn-problem ${STATE_CLASS[c.state]}`}>{c.problem}</div>}
        </div>
        <Icon name="chev_right" size={18} className="plugin-head__chev" />
      </button>
      {needs && c.reconnect && !open && !confirmBox && (
        <div className="conn-quick"><button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => onReconnect()}>{c.reconnect.label}</button></div>
      )}
      {(open || confirmBox) && (
        <div className="plugin-body" id={bodyId}>
          {c.bots.length > 0 && <div className="plugin-body__label">Who can use it</div>}
          {c.bots.map((b) => (
            <div key={b.id} className="cfg-row">
              <div className="cfg-row__text"><div className="cfg-row__title">{b.name}{b.ownerName && <span className="cfg-row__sub"> · {b.ownerName}'s</span>}</div></div>
              <Switch on={b.on} label={`${c.name} for ${b.name}`} disabled={!owner || busy || switching === `${c.id}:${b.id}`} onChange={(on) => onFlip(b.id, on)} />
            </div>
          ))}
          {owner && (c.reconnect || c.actions.length > 0) && (
            <>
              <div className="plugin-body__label">Manage</div>
              {c.reconnect && (
                <div className="cfg-row">
                  <div className="cfg-row__text">
                    <div className="cfg-row__sub">{c.reconnect.hint}</div>
                    {c.reconnect.write === false && !c.reconnect.confirm && (
                      <label className="connector-pick__bot"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Also allow changes (drafts, sending with your OK, Calendar, Drive and Tasks)</label>
                    )}
                  </div>
                  <button type="button" className={`cfg-btn ${needs ? 'cfg-btn--primary' : 'cfg-btn--secondary'}`} disabled={busy} onClick={() => onReconnect(c.reconnect?.write === false ? write : undefined)}>{c.reconnect.label}</button>
                </div>
              )}
              {c.actions.map((a) => (
                <div className="cfg-row" key={a.id}>
                  <div className="cfg-row__text"><div className="cfg-row__sub">{a.hint}</div></div>
                  <button type="button" className={`cfg-btn ${a.danger ? 'cfg-btn--ghost-danger' : 'cfg-btn--secondary'}`} disabled={busy} onClick={() => onAction(a.id)}>{a.label}</button>
                </div>
              ))}
            </>
          )}
          {confirmBox}
          {owner && c.tools.length > 0 && (
            <>
              <button type="button" className="plugin-head conn-subhead" aria-expanded={tools} onClick={() => setTools(!tools)}>
                <div className="plugin-head__text"><div className="cfg-row__title">What it can do</div><div className="cfg-row__sub">{c.toolsLine}. Choose for each tool.</div></div>
                <Icon name="chev_right" size={18} className="plugin-head__chev" />
              </button>
              {tools && c.tools.map((t) => (
                <div className="cfg-row conn-tool" key={t.name}>
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{t.label}</div>
                    {t.note && <div className="cfg-row__sub">{t.note}</div>}
                  </div>
                  <div className="conn-tool__pick">
                    {t.choices.length > 0 ? (
                      <div className="cfg-seg" role="radiogroup" aria-label={`${t.label}`}>
                        {RULES.filter((r) => t.choices.includes(r.value) || r.value === t.rule).map((r) => (
                          <button key={r.value} type="button" role="radio" aria-checked={t.rule === r.value} className={t.rule === r.value ? 'is-active' : ''} disabled={busy || !t.choices.includes(r.value)} onClick={() => t.rule !== r.value && onTool(t.name, r.value)}>{r.label}</button>
                        ))}
                      </div>
                    ) : <span className="cfg-chip">{RULES.find((r) => r.value === t.rule)?.label}</span>}
                    {t.chosen && <button type="button" className="cfg-btn cfg-btn--secondary conn-tool__reset" disabled={busy} onClick={() => onTool(t.name, null)}>Default</button>}
                  </div>
                </div>
              ))}
            </>
          )}
          {owner && c.pluginSettings && <SettingsForm p={{ id: c.id, settings: c.pluginSettings.settings as never, values: c.pluginSettings.values as never }} onSaved={onSaved} />}
          <button type="button" className="plugin-head conn-subhead" aria-expanded={adv} onClick={() => setAdv(!adv)}>
            <div className="plugin-head__text"><div className="cfg-row__title">Advanced</div><div className="cfg-row__sub">Where it runs, how it was set up, and its sign-in.</div></div>
            <Icon name="chev_right" size={18} className="plugin-head__chev" />
          </button>
          {adv && (
            <dl className="plugin-details">
              {c.details.map((d) => <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>)}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/** Accounts and services that are signed in or found and no Bot has yet: Add to Bots (pick, then confirm), Reconnect, Delete. */
function ReadyRows({ list, bots, busy, confirmFor, confirmBox, onAdd, onReconnect, onDelete }: {
  list: ReadyConnection[]; bots: { id: string; name: string }[]; busy: boolean; confirmFor: string | null; confirmBox: ReactNode;
  onAdd: (id: string, bots: string[]) => void; onReconnect: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <div className="cfg-card">
      {list.map((c) => (
        <div className="cfg-row connector-row" key={c.id}>
          <div className="cfg-row__text">
            <div className="cfg-row__title">{c.name}</div>
            <div className="cfg-row__sub">{c.summary}</div>
            {c.problem && <div className="cfg-row__sub conn-problem is-warn">{c.problem}</div>}
            {picking === c.id && (
              <div className="connector-pick">
                {bots.filter((b) => !c.onlyBots || c.onlyBots.some((x) => x === b.id || x.toLowerCase() === b.name.toLowerCase())).map((b) => (
                  <label key={b.id} className="connector-pick__bot">
                    <input type="checkbox" checked={chosen.includes(b.id)} onChange={(e) => setChosen((s) => (e.target.checked ? [...s, b.id] : s.filter((x) => x !== b.id)))} /> {b.name}
                  </label>
                ))}
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicking(null)}>Cancel</button>
                <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || !chosen.length} onClick={() => { onAdd(c.id, chosen); setPicking(null); }}>Next</button>
              </div>
            )}
            {confirmFor === c.id && confirmBox}
          </div>
          <div className="cfg-row-actions">
            {c.reconnect && <button type="button" className={`cfg-btn ${c.problem ? 'cfg-btn--primary' : 'cfg-btn--secondary'}`} disabled={busy} onClick={() => onReconnect(c.id)}>Reconnect</button>}
            {!c.needsSignIn && picking !== c.id && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => { setPicking(c.id); setChosen([]); }}>Add to Bots</button>}
            {c.canDelete && <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={busy} onClick={() => onDelete(c.id)}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One "Add a connection" choice: a row that opens its form. Only one is open at a time. */
function Expand({ id, open, set, title, sub, children }: { id: AddWhat; open: AddWhat | null; set: (v: AddWhat | null) => void; title: string; sub: string; children: ReactNode }) {
  const isOpen = open === id;
  return (
    <div className="connections-add">
      <button type="button" className="plugin-head" aria-expanded={isOpen} onClick={() => set(isOpen ? null : id)}>
        <div className="plugin-head__text">
          <div className="cfg-row__title">{title}</div>
          <div className="cfg-row__sub">{sub}</div>
        </div>
        <Icon name="chev_right" size={18} className="plugin-head__chev" />
      </button>
      {isOpen && <div className="plugin-body">{children}</div>}
    </div>
  );
}

/** A folded-away section: a heading row that opens it. */
function Fold({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="cfg-section">
      <div className="cfg-card">
        <button type="button" className="plugin-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <div className="plugin-head__text">
            <div className="cfg-row__title">{title}</div>
            <div className="cfg-row__sub">{sub}</div>
          </div>
          <Icon name="chev_right" size={18} className="plugin-head__chev" />
        </button>
      </div>
      {open && <div className="connections-fold">{children}</div>}
    </section>
  );
}

/** Every MCP server on each machine and in the cloud, from the daily scan and the catalog, now and retired (read only here; manage them above). */
function MachinesFold({ conns, busy, onScan }: { conns: ConnectorList; busy: boolean; onScan: () => void }) {
  const [history, setHistory] = useState(false);
  const list = conns.connectors.filter((c) => !c.browserSite && !(c.status === 'wanted' && !c.machine) && (history ? connectorIsPast(c) : !connectorIsPast(c)));
  const groups = useMemo(() => {
    const m = new Map<string, ConnectorInfo[]>();
    for (const c of list) { const k = c.machine ?? 'Cloud: claude.ai and ChatGPT only'; m.set(k, [...(m.get(k) ?? []), c]); }
    return [...m.entries()].sort((a, b) => (a[0].startsWith('Cloud') ? 1 : b[0].startsWith('Cloud') ? -1 : a[0].localeCompare(b[0])));
  }, [list]);
  const last = conns.lastScan;
  const none = () => {};
  return (
    <Fold title="Everything on your machines" sub="Every service the daily scan finds, and ones you've retired. Most people never need this.">
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__sub">
              {last ? `Last scan ${shortDate(last.at)}: ${last.answered.length} machine${last.answered.length === 1 ? '' : 's'} answered, ${last.found} found${last.error ? ` · ${last.error}` : ''}` : conns.scanHosts ? 'Scans every day. No scan yet.' : 'No machines are set up for scanning on the server.'}
            </div>
          </div>
          {conns.owner && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !conns.scanHosts} onClick={onScan}>Scan now</button>}
        </div>
      </div>
      <div className="connector-filters" role="tablist" aria-label="Show">
        <button type="button" role="tab" aria-selected={!history} className={`cfg-chip${!history ? ' is-active' : ''}`} onClick={() => setHistory(false)}>Now</button>
        <button type="button" role="tab" aria-selected={history} className={`cfg-chip${history ? ' is-active' : ''}`} onClick={() => setHistory(true)}>Retired</button>
      </div>
      {!list.length && <div className="cfg-empty">Nothing here.</div>}
      {groups.map(([machine, rows]) => (
        <section className="cfg-section" key={machine}>
          <div className="cfg-section__label">{machine}</div>
          <ConnectorRows list={rows} data={{ ...conns, owner: false }} busy={busy} locked onPropose={none} onSignIn={none} onDelete={none} />
        </section>
      ))}
    </Fold>
  );
}

/**
 * Web search by API (server/src/web-search.ts): which search service the Bots use, whether its key is in
 * place (never the key itself), how pages are read, and each Bot's searches this month.
 */
function WebSearchCard({ owner }: { owner: boolean }) {
  const [s, setS] = useState<WebSearchStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => connectorsApi.webSearch().then(setS).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  const flip = async (id: string, on: boolean) => {
    setBusy(id); setErr(null);
    try {
      const { bot } = await configApi.updateBot(id, { webSearch: on });
      useStore.setState((st) => ({ bots: st.bots.map((b) => (b.id === bot.id ? bot : b)) }));
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  if (!s && !err) return null;
  const month = s ? new Date(s.monthStart * 1000).toLocaleDateString(undefined, { month: 'long' }) : '';
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Web search</div>
      <div className="cfg-card">
        {s && (
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{s.service}{s.keySet ? ' · key set' : ''}</div>
              <div className="cfg-row__sub">
                Bots search by API and read pages as text, without opening a browser. Pages are read by: {s.extract}.
                {s.fallback && s.keySet ? ` If the search service fails: ${s.fallback}.` : ''} Repeat searches come from a {s.cacheMinutes}-minute cache. No approval needed: these only read.
              </div>
            </div>
          </div>
        )}
        {s?.bots.map((b) => (
          <div className="cfg-row" key={b.id}>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{b.name}</div>
              <div className="cfg-row__sub">
                {b.on ? (b.searches === null ? 'No searches yet' : `${b.searches} searches, ${b.reads ?? 0} pages read in ${month}`) : 'Off: uses its browser to look things up'}
                {b.ownSetup ? ' · its own Hermes search setup' : ''}
              </div>
            </div>
            {owner && <Switch on={b.on} onChange={(v) => flip(b.id, v)} label={`${b.name} searches the web`} disabled={busy === b.id} />}
          </div>
        ))}
      </div>
      {err && <div className="cfg-row__sub is-error" role="alert">{err}</div>}
    </section>
  );
}
