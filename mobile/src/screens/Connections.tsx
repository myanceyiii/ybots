import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import type { AdminChange, Bot, Client, Connection, ConnectionList, ConnProposal, ConnectorChange, ConnectorInfo, ConnectorList, PluginChange, PluginDraft, ReadyConnection, ToolRule, WebSearchStatus } from '../api';
import { Header, HeaderTitle, ListGroup, Notice, PillButton, RoundButton, refreshLook } from '../components/ui';
import { Icon } from '../components/Icon';
import { usePluginSwitch } from '../components/usePluginSwitch';
import { color, type } from '../theme';
import { ConfirmCard, CreatePlugin, DraftsList, label, NpmInstall, SettingsForm } from './Plugins';
import { ConnectByAddress, ConnectGoogle, ConnectorItem } from './Connectors';

type AddWhat = 'google' | 'address' | 'ready' | 'build' | 'npm';
const past = (c: ConnectorInfo) => c.status === 'retired' || c.status === 'gone';
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const RULES: { value: ToolRule; label: string }[] = [{ value: 'runs', label: 'Runs' }, { value: 'asks', label: 'Asks first' }, { value: 'off', label: 'Off' }];

/**
 * Connections, the same as Settings › Connections in the web and Windows apps
 * (web/src/components/config/ConnectionsSection.tsx). The server words every row
 * (server/src/connections.ts), so all three apps say the same thing: one row per connection with its
 * status, a one-line summary and who uses it, and the fix shown on the row when it needs one. Tap a
 * row for the per-bot switches (at once, with Undo), Reconnect, Turn off / Turn on / Remove (confirmed
 * once), what each tool may do, and Advanced. Then Add a connection, Suggestions, Recent changes (with
 * Undo) and Everything on your machines.
 */
export function Connections({ api, bots, startCreating, onBack, onOpenChat, onCode }: {
  api: Client; bots: Bot[]; startCreating?: boolean; onBack: () => void; onOpenChat: (botId: string) => void; onCode: (draftId: string) => void;
}) {
  const [data, setData] = useState<ConnectionList | null>(null);
  const [conns, setConns] = useState<ConnectorList | null>(null);
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [adminChanges, setAdminChanges] = useState<AdminChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [change, setChange] = useState<ConnProposal | null>(null);
  const [changeAt, setChangeAt] = useState<string | null>(null);
  const [cChange, setCChange] = useState<ConnectorChange | null>(null);
  const [cChangeAt, setCChangeAt] = useState<string | null>(null);
  const [pChange, setPChange] = useState<PluginChange | null>(null);
  const [adding, setAdding] = useState<AddWhat | null>(startCreating ? 'build' : null);
  const paint = useCallback((id: string, botId: string, on: boolean) => setData((d) => (d ? { ...d, connections: d.connections.map((c) => (c.id !== id ? c : { ...c, bots: c.bots.map((b) => (b.id === botId ? { ...b, on } : b)) })) } : d)), []);
  const sw = usePluginSwitch(api, () => {}, setError, true, paint);

  const load = useCallback(async () => {
    try {
      setData(await api.connections()); setError(null);
      api.connectors().then(setConns).catch(() => {});
      api.adminChanges().then((r) => setAdminChanges(r.changes)).catch(() => {});
      api.plugins().then((p) => setDrafts(p.drafts ?? [])).catch(() => {});
    } catch (e: any) { setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const owner = !!data?.owner;

  const run = async (f: () => Promise<unknown>) => { setBusy(true); setError(null); try { await f(); } catch (e: any) { setError(e?.message ?? 'Couldn’t do that.'); } finally { setBusy(false); } };
  const cancelOpen = async () => {
    if (change) await api.cancelConnection(change.id).catch(() => {});
    if (cChange) await api.cancelConnector(cChange.id).catch(() => {});
    setChange(null); setChangeAt(null); setCChange(null); setCChangeAt(null);
  };
  /** Asking for another change replaces the one still open, so no row is held up waiting on it. */
  const propose = (id: string, action: string) => run(async () => { await cancelOpen(); setChange(await api.proposeConnection(id, action)); setChangeAt(id); });
  const confirm = () => run(async () => {
    if (!change) return;
    try {
      const r = await api.confirmConnection(change.id, change.digest);
      if (r.signInUrl) { await Linking.openURL(r.signInUrl); setNote(`${r.note ?? 'Finish on the page that opened.'} Pull to refresh when you’re back.`); }
      else setNote(`Done: ${change.summary}.`);
    } finally { setChange(null); setChangeAt(null); await load(); }
  });
  const reconnect = (id: string, write?: boolean) => run(async () => {
    const r = await api.reconnectConnection(id, write);
    if (r.signInUrl) { await Linking.openURL(r.signInUrl); setNote(`${r.note} Pull to refresh when you’re back.`); }
    else { setNote(r.note); await load(); }
  });
  const setTool = (id: string, tool: string, rule: ToolRule | null) => run(async () => {
    const r = await api.setConnectionTool(id, tool, rule);
    setData((d) => (d ? { ...d, connections: d.connections.map((c) => (c.id !== id ? c : { ...c, tools: c.tools.map((t) => (t.name === tool ? r.tool : t)) })) } : d));
  });
  const proposeAdd = (connectorId: string, chosen: string[]) => run(async () => { await cancelOpen(); setCChange(await api.proposeConnector({ action: 'add', connectorId, bots: chosen })); setCChangeAt(connectorId); });
  const confirmAdd = () => run(async () => { if (!cChange) return; try { await api.confirmConnector(cChange.id, cChange.digest); setNote(`Done: ${cChange.summary}.`); } finally { setCChange(null); setCChangeAt(null); await load(); } });
  const proposePlugin = (b: Parameters<Client['proposePlugin']>[0]) => run(async () => setPChange(await api.proposePlugin(b)));
  const confirmPlugin = () => run(async () => { if (!pChange) return; try { await api.confirmPlugin(pChange.id, pChange.digest); setAdding(null); } finally { setPChange(null); await load(); } });
  const scan = () => run(async () => {
    setNote('Scanning your machines…');
    const r = await api.scanConnectors();
    setNote(r.error ? `Scan: ${r.error}` : `Scan done: ${r.found} found, ${r.added} new, ${r.gone} no longer found.`);
    await load();
  });

  const all = conns?.connectors ?? [];
  const browserSites = all.filter((c) => c.browserSite);
  const suggestions = all.filter((c) => c.wanted && !c.browserSite && !past(c)).sort((a, b) => (a.wanted?.rank ?? 99) - (b.wanted?.rank ?? 99) || a.name.localeCompare(b.name));
  const attention = (data?.connections ?? []).filter((c) => c.state === 'needs_reconnect' || c.state === 'not_working').length;

  const box = (p: { summary: string; details: string[]; danger?: boolean }, onConfirm: () => void) => (
    <View accessibilityRole="alert" style={{ backgroundColor: color.fill, borderRadius: 18, padding: 16, gap: 10, borderWidth: 1, borderColor: color.ink }}>
      <Text style={[type.body, { fontWeight: '600' }]}>{p.summary}?</Text>
      {p.details.map((d) => <Text key={d} style={[type.caption, { fontSize: 13 }]}>• {d}</Text>)}
      <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
        <PillButton title="Cancel" kind="secondary" onPress={() => { cancelOpen(); }} />
        <PillButton title={busy ? 'Working…' : 'Confirm'} disabled={busy} onPress={onConfirm} />
      </View>
    </View>
  );
  const changeBox = change && change.status === 'pending' ? box(change, confirm) : null;
  const addBox = cChange && cChange.status === 'pending' ? box(cChange, confirmAdd) : null;

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Connections</HeaderTitle>
      </Header>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 96 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21 }]}>
          Everything your bots can reach. Tap one to choose which bots use it, reconnect it, or change what it may do.
        </Text>
        {error && <Notice tone="problem">{error}</Notice>}
        {note && <Notice tone="note">{note}</Notice>}

        <Text style={label()}>Your connections{data ? ` · ${data.connections.length}` : ''}{attention ? ` · ${attention} need${attention === 1 ? 's' : ''} you` : ''}</Text>
        {!data && !error && <ActivityIndicator color={color.ink} />}
        {data && !data.connections.length && <Notice tone="note">Nothing is connected yet. Start with Add a connection below: a Google account is the quickest.</Notice>}
        {!!data?.connections.length && (
          <ListGroup>
            {data.connections.map((c, i) => (
              <ConnectionRow key={c.id} api={api} c={c} first={!i} owner={owner} busy={busy} switching={sw.pending}
                onFlip={(botId, on) => sw.flip(c.id, botId, on)} onReconnect={(w) => (c.reconnect?.confirm ? propose(c.id, 'reconnect') : reconnect(c.id, w))}
                onAction={(a) => propose(c.id, a)} onTool={(tool, rule) => setTool(c.id, tool, rule)} onSaved={load}
                confirmBox={changeAt === c.id ? changeBox : null} />
            ))}
          </ListGroup>
        )}
        {!!data?.connections.length && owner && <Text style={[type.caption, { fontSize: 13, marginLeft: 4, marginTop: -8 }]}>Switches apply right away, with Undo for a few seconds. Anything that changes data asks on a card in the chat, unless you set that tool to run on its own.</Text>}
        {data && !owner && <Notice tone="note">Only the owner of this server can add or change connections.</Notice>}

        <WebSearchCard api={api} owner={owner} />

        {owner && !!drafts.length && <DraftsList drafts={drafts} onOpenChat={onOpenChat} onCode={onCode} />}

        {owner && (
          <View style={{ gap: 8 }}>
            <Text style={label()}>Add a connection</Text>
            {pChange && pChange.status === 'pending' && <ConfirmCard change={pChange} busy={busy} onCancel={() => { api.cancelPlugin(pChange.id).catch(() => {}); setPChange(null); }} onConfirm={confirmPlugin} />}
            <ListGroup>
              <Expand id="google" open={adding} set={setAdding} first title="Google account" sub="Gmail, Calendar, Drive and Tasks for one Google account.">
                <ConnectGoogle api={api} busy={busy} onStarted={() => setNote('Finish signing in to Google on the page that opened, then come back and pull to refresh. The account then shows under Ready to add.')} />
              </Expand>
              <Expand id="ready" open={adding} set={setAdding} title={`Ready to add${data ? ` · ${data.ready.length}` : ''}`} sub="Accounts you’ve signed in to and services on your machines that no bot has yet.">
                {data && (data.ready.length
                  ? <ReadyRows list={data.ready} bots={conns?.bots ?? []} busy={busy} confirmFor={cChangeAt ?? changeAt} confirmBox={addBox ?? changeBox}
                      onAdd={proposeAdd} onReconnect={(id) => reconnect(id)} onDelete={(id) => propose(id, 'delete')} />
                  : <Text style={[type.caption, { fontSize: 13 }]}>Nothing waiting. Everything that is ready is already connected.</Text>)}
              </Expand>
              <Expand id="address" open={adding} set={setAdding} title="A service by its address" sub="Any MCP server: its address, plus a key or sign-in if it needs one.">
                <ConnectByAddress api={api} busy={busy} onDone={async (r) => {
                  if (r.signInUrl) { await Linking.openURL(r.signInUrl); setNote('Finish signing in on the page that opened, then pull to refresh and give it to your bots under Ready to add.'); }
                  else setNote('Connected. Give it to your bots under Ready to add.');
                  setAdding('ready');
                  await load();
                }} />
              </Expand>
              <Expand id="build" open={adding} set={setAdding} title="Build a plugin with a bot" sub="Describe a tool you want. A bot plans it; you read the code before it’s installed.">
                <CreatePlugin api={api} bots={bots} onCancel={() => setAdding(null)} onSent={onOpenChat} />
              </Expand>
              <Expand id="npm" open={adding} set={setAdding} title="Install a plugin from npm" sub="By package name and exact version.">
                <NpmInstall busy={busy || !!pChange} onCheck={(spec) => proposePlugin({ action: 'install', spec })} />
              </Expand>
            </ListGroup>
          </View>
        )}

        {suggestions.length > 0 && (
          <Fold title={`Suggestions · ${suggestions.length}`} sub="Connections your household skills could use, in the order to set them up.">
            <ListGroup>
              {suggestions.map((c, i) => (
                <View key={c.id} style={{ padding: 14, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: color.surface }}>
                  <Text style={[type.body, { fontWeight: '600' }]}>{c.wanted?.rank ? `${c.wanted.rank}. ` : ''}{c.name}</Text>
                  {!!c.description && <Text style={[type.caption, { fontSize: 13 }]}>{c.description}</Text>}
                  {c.wanted && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Unlocks: </Text>{c.wanted.unlocks}</Text>}
                  {!!c.wanted?.needs && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Needs your OK: </Text>{c.wanted.needs}</Text>}
                  {!!c.wanted?.state && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Now: </Text>{c.wanted.state}</Text>}
                  {c.id === 'claude-browser' && browserSites.length > 0 && (
                    <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Then used for: </Text>{browserSites.map((b) => b.name).join(', ')}. These are sign-ins inside the shared browser, not connections of their own.</Text>
                  )}
                </View>
              ))}
            </ListGroup>
          </Fold>
        )}

        {owner && adminChanges.length > 0 && (
          <Fold title={`Recent changes · ${adminChanges.length}`} sub="Changes to connections made here or by your admin bot. Undo puts one back.">
            <ListGroup>
              {adminChanges.map((ch, i) => (
                <View key={ch.id} style={{ padding: 14, gap: 8, borderTopWidth: i ? 1 : 0, borderTopColor: color.surface }}>
                  <Text style={[type.body, { fontWeight: '600' }]}>{ch.summary}</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>
                    {ch.byPerson ? `${ch.bot}${ch.via ? `, ${ch.via}` : ''}` : `${ch.bot} · ${ch.status === 'applied' ? `allowed by ${ch.approvedBy ?? 'someone'}${ch.via ? ` (${ch.via})` : ''}` : ch.status}`} · {date(new Date(ch.appliedAt ?? ch.at).getTime())}{ch.rolledBackBy ? ' · undone' : ''}
                  </Text>
                  {ch.canRollBack && (
                    <View style={{ flexDirection: 'row' }}>
                      <PillButton title="Undo" kind="secondary" disabled={busy} onPress={() => Alert.alert('Undo this change?', ch.summary, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Undo', onPress: () => run(async () => { const r = await api.undoAdminChange(ch.id); setNote(`Done: ${r.summary}.`); await load(); }) },
                      ])} />
                    </View>
                  )}
                </View>
              ))}
            </ListGroup>
          </Fold>
        )}

        {conns && owner && <MachinesFold conns={conns} busy={busy} onScan={scan} />}
      </ScrollView>
      {sw.toast}
    </View>
  );
}

const STATE_COLORS = (s: Connection['state']) => (s === 'connected' ? { fill: 'rgba(30,123,58,0.14)', ink: color.goodInk } : s === 'needs_reconnect' ? { fill: 'rgba(217,119,6,0.16)', ink: color.warnInk } : s === 'not_working' ? { fill: color.problemFill, ink: color.problemInk } : { fill: color.fill, ink: color.inkMuted });

function OutlineButton({ title, danger, disabled, onPress }: { title: string; danger?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => ({ alignSelf: 'flex-start', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: color.secondaryBorder, backgroundColor: pressed ? (danger ? color.problemFill : color.pressed) : 'transparent', opacity: disabled ? 0.5 : 1 })}>
      <Text style={{ color: danger ? color.problemInk : color.ink, fontSize: 15, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

/** One connection: a collapsed row (status, summary, who uses it, and the fix when it needs one); tap for everything else. */
function ConnectionRow({ api, c, first, owner, busy, switching, onFlip, onReconnect, onAction, onTool, onSaved, confirmBox }: {
  api: Client; c: Connection; first: boolean; owner: boolean; busy: boolean; switching: string | null;
  onFlip: (botId: string, on: boolean) => void; onReconnect: (write?: boolean) => void; onAction: (a: string) => void;
  onTool: (tool: string, rule: ToolRule | null) => void; onSaved: () => void; confirmBox: React.JSX.Element | null;
}) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState(false);
  const [adv, setAdv] = useState(false);
  const [write, setWrite] = useState(false);
  const expanded = open || !!confirmBox;
  const needs = c.state === 'needs_reconnect' || c.state === 'not_working';
  const st = STATE_COLORS(c.state);
  const sub = { fontSize: 12, fontWeight: '700' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const, color: color.inkMuted, paddingHorizontal: 14, paddingTop: 12 };
  const divider = { borderTopWidth: 1, borderTopColor: color.fill };
  return (
    <View style={first ? undefined : { borderTopWidth: 1, borderTopColor: color.surface }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${c.name}, ${c.stateText}. ${c.summary}`}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, backgroundColor: pressed ? color.pressed : 'transparent' })}>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={[type.body, { fontWeight: '600' }]}>{c.name}</Text>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: st.fill }}><Text style={{ fontSize: 12, fontWeight: '600', color: st.ink }}>{c.stateText}</Text></View>
            {c.firm && <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: color.fill }}><Text style={{ fontSize: 12, color: color.inkSecondary }}>Firm</Text></View>}
          </View>
          <Text style={[type.caption, { fontSize: 13, color: color.inkSecondary }]}>{c.summary}</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{c.usedBy} · {c.toolsLine}</Text>
          {!!c.problem && <Text style={[type.caption, { fontSize: 13, color: c.state === 'off' ? color.inkMuted : st.ink }]}>{c.problem}</Text>}
        </View>
        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}><Icon name="chevron" size={18} color={color.timestamp} /></View>
      </Pressable>
      {needs && c.reconnect && !expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, alignSelf: 'flex-start' }}><PillButton title={c.reconnect.label} disabled={busy} onPress={() => onReconnect()} /></View>
      )}
      {expanded && (
        <View style={divider}>
          {c.bots.length > 0 && <Text style={sub}>Who can use it</Text>}
          {c.bots.map((b) => (
            <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 }}>
              <Text style={[type.body, { flex: 1 }]}>{b.name}{b.ownerName ? ` · ${b.ownerName}’s` : ''}</Text>
              <Switch value={b.on} disabled={!owner || busy || switching === `${c.id}:${b.id}`} accessibilityLabel={`${c.name} for ${b.name}`} onValueChange={(on) => onFlip(b.id, on)} />
            </View>
          ))}
          {owner && (c.reconnect || c.actions.length > 0) && <Text style={sub}>Manage</Text>}
          {owner && c.reconnect && (
            <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
              <Text style={[type.caption, { fontSize: 13 }]}>{c.reconnect.hint}</Text>
              {c.reconnect.write === false && !c.reconnect.confirm && (
                <Pressable onPress={() => setWrite(!write)} accessibilityRole="checkbox" accessibilityState={{ checked: write }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Switch value={write} onValueChange={setWrite} accessibilityLabel="Also allow changes" />
                  <Text style={[type.caption, { fontSize: 13, flex: 1 }]}>Also allow changes (drafts, sending with your OK, Calendar, Drive and Tasks)</Text>
                </Pressable>
              )}
              {needs ? <View style={{ alignSelf: 'flex-start' }}><PillButton title={c.reconnect.label} disabled={busy} onPress={() => onReconnect(c.reconnect?.write === false ? write : undefined)} /></View>
                : <OutlineButton title={c.reconnect.label} disabled={busy} onPress={() => onReconnect(c.reconnect?.write === false ? write : undefined)} />}
            </View>
          )}
          {owner && c.actions.map((a) => (
            <View key={a.id} style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
              <Text style={[type.caption, { fontSize: 13 }]}>{a.hint}</Text>
              <OutlineButton title={a.label} danger={a.danger} disabled={busy} onPress={() => onAction(a.id)} />
            </View>
          ))}
          {confirmBox && <View style={{ padding: 14, paddingTop: 4 }}>{confirmBox}</View>}
          {owner && c.tools.length > 0 && (
            <View style={divider}>
              <Head title="What it can do" sub={`${c.toolsLine}. Choose for each tool.`} open={tools} onPress={() => setTools(!tools)} />
              {tools && c.tools.map((t) => (
                <View key={t.name} style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 6, borderTopWidth: 1, borderTopColor: color.surface }}>
                  <Text style={type.body}>{t.label}</Text>
                  {!!t.note && <Text style={[type.caption, { fontSize: 12 }]}>{t.note}</Text>}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {RULES.filter((r) => t.choices.includes(r.value) || r.value === t.rule).map((r) => {
                      const on = t.rule === r.value;
                      const can = t.choices.includes(r.value);
                      return (
                        <Pressable key={r.value} disabled={busy || !can || on} onPress={() => onTool(t.name, r.value)} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !can }} accessibilityLabel={`${t.label}: ${r.label}`}
                          style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: on ? color.ink : color.secondaryBorder, backgroundColor: on ? color.primary : pressed ? color.pressed : 'transparent' })}>
                          <Text style={{ fontSize: 14, fontWeight: on ? '600' : '400', color: on ? color.onPrimary : color.ink }}>{r.label}</Text>
                        </Pressable>
                      );
                    })}
                    {t.chosen && <Pressable disabled={busy} onPress={() => onTool(t.name, null)} accessibilityRole="button" style={{ paddingHorizontal: 10, paddingVertical: 7 }}><Text style={{ fontSize: 14, color: color.link }}>Default</Text></Pressable>}
                  </View>
                </View>
              ))}
            </View>
          )}
          {owner && c.pluginSettings && <SettingsForm api={api} p={{ id: c.id, settings: c.pluginSettings.settings as never, values: c.pluginSettings.values as never }} onSaved={onSaved} />}
          <View style={divider}>
            <Head title="Advanced" sub="Where it runs, how it was set up, and its sign-in." open={adv} onPress={() => setAdv(!adv)} />
            {adv && (
              <View style={{ gap: 6, margin: 14, marginTop: 0, padding: 12, borderRadius: 14, backgroundColor: color.ground }}>
                {c.details.map((d) => (
                  <View key={d.label}>
                    <Text style={[type.caption, { fontSize: 12, color: color.inkMuted }]}>{d.label}</Text>
                    <Text style={[type.body, { fontSize: 14 }]}>{d.value}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** Accounts and services that are signed in or found and no bot has yet: Add to bots (pick, then confirm), Reconnect, Delete. */
function ReadyRows({ list, bots, busy, confirmFor, confirmBox, onAdd, onReconnect, onDelete }: {
  list: ReadyConnection[]; bots: { id: string; name: string }[]; busy: boolean; confirmFor: string | null; confirmBox: React.JSX.Element | null;
  onAdd: (id: string, bots: string[]) => void; onReconnect: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <ListGroup>
      {list.map((c, i) => (
        <View key={c.id} style={{ padding: 14, gap: 8, borderTopWidth: i ? 1 : 0, borderTopColor: color.surface }}>
          <Text style={[type.body, { fontWeight: '600' }]}>{c.name}</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{c.summary}</Text>
          {!!c.problem && <Text style={[type.caption, { fontSize: 13, color: color.warnInk }]}>{c.problem}</Text>}
          {picking === c.id ? (
            <View style={{ gap: 8 }}>
              {bots.filter((b) => !c.onlyBots || c.onlyBots.some((x) => x === b.id || x.toLowerCase() === b.name.toLowerCase())).map((b) => (
                <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[type.body, { flex: 1 }]}>{b.name}</Text>
                  <Switch value={chosen.includes(b.id)} accessibilityLabel={`Add for ${b.name}`} onValueChange={(v) => setChosen((s) => (v ? [...s, b.id] : s.filter((x) => x !== b.id)))} />
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <PillButton title="Cancel" kind="secondary" onPress={() => setPicking(null)} />
                <PillButton title="Next" disabled={busy || !chosen.length} onPress={() => { onAdd(c.id, chosen); setPicking(null); }} />
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {c.reconnect && <PillButton title="Reconnect" kind={c.problem ? 'primary' : 'secondary'} disabled={busy} onPress={() => onReconnect(c.id)} />}
              {!c.needsSignIn && <PillButton title="Add to bots" kind="secondary" disabled={busy} onPress={() => { setPicking(c.id); setChosen([]); }} />}
              {c.canDelete && <OutlineButton title="Delete" danger disabled={busy} onPress={() => onDelete(c.id)} />}
            </View>
          )}
          {confirmFor === c.id && confirmBox}
        </View>
      ))}
    </ListGroup>
  );
}

function Head({ title, sub, open, onPress }: { title: string; sub: string; open: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[type.body, { fontWeight: '600' }]}>{title}</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>{sub}</Text>
      </View>
      <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron" size={18} color={color.timestamp} /></View>
    </Pressable>
  );
}

/** One "Add a connection" choice; only one is open at a time. */
function Expand({ id, open, set, first, title, sub, children }: { id: AddWhat; open: AddWhat | null; set: (v: AddWhat | null) => void; first?: boolean; title: string; sub: string; children: ReactNode }) {
  const isOpen = open === id;
  return (
    <View style={first ? undefined : { borderTopWidth: 1, borderTopColor: color.surface }}>
      <Head title={title} sub={sub} open={isOpen} onPress={() => set(isOpen ? null : id)} />
      {isOpen && <View style={{ paddingHorizontal: 8, paddingBottom: 12, gap: 10 }}>{children}</View>}
    </View>
  );
}

function Fold({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <ListGroup><Head title={title} sub={sub} open={open} onPress={() => setOpen(!open)} /></ListGroup>
      {open && children}
    </View>
  );
}

/** Every MCP server on each machine and in the cloud, from the daily scan and the catalog, now and retired (read only here; manage them above). */
function MachinesFold({ conns, busy, onScan }: { conns: ConnectorList; busy: boolean; onScan: () => void }) {
  const [history, setHistory] = useState(false);
  const list = conns.connectors.filter((c) => !c.browserSite && !(c.status === 'wanted' && !c.machine) && (history ? past(c) : !past(c)));
  const groups = useMemo(() => {
    const m = new Map<string, ConnectorInfo[]>();
    for (const c of list) { const k = c.machine ?? 'Cloud: claude.ai and ChatGPT only'; m.set(k, [...(m.get(k) ?? []), c]); }
    return [...m.entries()].sort((a, b) => (a[0].startsWith('Cloud') ? 1 : b[0].startsWith('Cloud') ? -1 : a[0].localeCompare(b[0])));
  }, [list]);
  const last = conns.lastScan;
  const none = () => {};
  const view = { ...conns, owner: false };
  return (
    <Fold title="Everything on your machines" sub="Every service the daily scan finds, and ones you’ve retired. Most people never need this.">
      <ListGroup style={{ padding: 16, gap: 10 }}>
        <Text style={[type.caption, { fontSize: 13 }]}>
          {last ? `Last scan ${date(last.at)}: ${last.answered.length} machine${last.answered.length === 1 ? '' : 's'} answered, ${last.found} found${last.error ? ` · ${last.error}` : ''}` : conns.scanHosts ? 'Scans every day. No scan yet.' : 'No machines are set up for scanning on the server.'}
        </Text>
        {conns.owner && <View style={{ alignSelf: 'flex-start' }}><PillButton title="Scan now" kind="secondary" disabled={busy || !conns.scanHosts} onPress={onScan} /></View>}
      </ListGroup>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <PillButton title="Now" kind={!history ? 'primary' : 'secondary'} onPress={() => setHistory(false)} />
        <PillButton title="Retired" kind={history ? 'primary' : 'secondary'} onPress={() => setHistory(true)} />
      </View>
      {!list.length && <Notice tone="note">Nothing here.</Notice>}
      {groups.map(([machine, rows]) => (
        <View key={machine} style={{ gap: 8 }}>
          <Text style={label()}>{machine}</Text>
          <ListGroup>{rows.map((c, i) => <ConnectorItem key={c.id} c={c} data={view} busy={busy} locked first={!i} confirmBox={null} onPropose={none} onSignIn={none} onDelete={none} />)}</ListGroup>
        </View>
      ))}
    </Fold>
  );
}

/**
 * Web search by API (server/src/web-search.ts), as in Settings › Connections on the web and Windows apps:
 * the search service the bots use, whether its key is in place (never the key), how pages are read, and
 * each bot's searches this month, with the owner's on/off switch per bot.
 */
function WebSearchCard({ api, owner }: { api: Client; owner: boolean }) {
  const [s, setS] = useState<WebSearchStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api.webSearch().then(setS).catch((e: any) => setErr(e?.message ?? 'Couldn’t load web search.')), [api]);
  useEffect(() => { load(); }, [load]);
  const flip = async (id: string, on: boolean) => {
    setBusy(id); setErr(null);
    try { await api.updateBot(id, { webSearch: on }); await load(); } catch (e: any) { setErr(e?.message ?? 'Couldn’t change it.'); } finally { setBusy(null); }
  };
  if (!s && !err) return null;
  const month = s ? new Date(s.monthStart * 1000).toLocaleDateString(undefined, { month: 'long' }) : '';
  return (
    <View style={{ gap: 8 }}>
      <Text style={label()}>Web search</Text>
      {err && <Notice tone="problem">{err}</Notice>}
      {s && (
        <ListGroup>
          <View style={{ paddingVertical: 13, paddingHorizontal: 16, gap: 2, borderBottomWidth: s.bots.length ? 1 : 0, borderBottomColor: color.hairline }}>
            <Text style={[type.body, { fontWeight: '500' }]}>{s.service}{s.keySet ? ' · key set' : ''}</Text>
            <Text style={[type.caption, { fontSize: 13 }]}>
              Bots search by API and read pages as text, without opening a browser. Pages are read by: {s.extract}.
              {s.fallback && s.keySet ? ` If the search service fails: ${s.fallback}.` : ''} Repeat searches come from a {s.cacheMinutes}-minute cache. No approval needed: these only read.
            </Text>
          </View>
          {s.bots.map((b, i) => (
            <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: i === s.bots.length - 1 ? 0 : 1, borderBottomColor: color.hairline }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.body, { fontWeight: '500' }]}>{b.name}</Text>
                <Text style={[type.caption, { fontSize: 13 }]}>
                  {b.on ? (b.searches === null ? 'No searches yet' : `${b.searches} searches, ${b.reads ?? 0} pages read in ${month}`) : 'Off: uses its browser to look things up'}
                  {b.ownSetup ? ' · its own Hermes search setup' : ''}
                </Text>
              </View>
              {owner && <Switch value={b.on} disabled={busy === b.id} onValueChange={(v) => flip(b.id, v)} accessibilityLabel={`${b.name} searches the web`} />}
            </View>
          ))}
        </ListGroup>
      )}
    </View>
  );
}
