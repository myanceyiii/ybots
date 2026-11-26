import { useCallback, useEffect, useMemo, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import type { Client, ConnectorChange, ConnectorInfo, ConnectorList, ConnectorReach, ConnectorStatus, NewConnector } from '../api';
import { Field, Header, HeaderTitle, ListGroup, Notice, PillButton, RoundButton } from '../components/ui';
import { color, type } from '../theme';

const STATUS: Record<ConnectorStatus, string> = { active: 'Running', stopped: 'Stopped', retired: 'Retired', gone: 'No longer found', unknown: 'Not checked yet', wanted: 'Wanted' };
const REACH: Record<ConnectorReach, string> = {
  cleft: 'Bots can use it', 'needs-setup': 'Needs setup before bots can use it', cloud: 'Cloud connector (claude.ai or ChatGPT)', native: 'Built into a bot directly',
};
type Filter = 'all' | 'wanted' | 'usable' | 'add' | 'history';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'Current' }, { id: 'wanted', label: 'Wanted' }, { id: 'usable', label: 'Bots use' }, { id: 'add', label: 'Can add' }, { id: 'history', label: 'History' }];
const past = (c: ConnectorInfo) => c.status === 'retired' || c.status === 'gone';
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** One connector: what it is, where it runs and, for the owner, Add to bots (pick, then confirm), Sign in, Delete or Remove. */
export function ConnectorItem({ c, data, busy, locked, first, showWanted, onPropose, onSignIn, onDelete, confirmBox }: {
  c: ConnectorInfo; data: ConnectorList; busy: boolean; locked: boolean; first: boolean; showWanted?: boolean;
  /** The confirm box for a change asked for on this row, shown here where the person tapped Next. */
  confirmBox?: React.JSX.Element | null;
  onPropose: (b: { action: 'add' | 'remove'; connectorId: string; bots?: string[] }) => void; onSignIn: (id: string) => void; onDelete: (c: ConnectorInfo) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  return (
                <View style={{ padding: 14, gap: 4, borderTopWidth: first ? 0 : 1, borderTopColor: color.surface }}>
                  <Text style={[type.body, { fontWeight: '600' }]}>{showWanted && c.wanted?.rank ? `${c.wanted.rank}. ` : ''}{c.name}</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>
                    {[STATUS[c.status], c.access, c.firm && 'firm, walled off'].filter(Boolean).join(' · ')}
                  </Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>
                    {c.apps.length ? c.apps.map((a) => `${a.name}: ${a.bots.length ? a.bots.join(', ') : 'no bot yet'}`).join(' · ') : REACH[c.reach]}
                  </Text>
                  {showWanted && c.wanted && (
                    <View style={{ gap: 3, marginVertical: 2 }}>
                      <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Unlocks: </Text>{c.wanted.unlocks}</Text>
                      {!!c.wanted.bots?.length && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>For: </Text>{c.wanted.bots.join(' · ')}</Text>}
                      {!!c.wanted.skills?.length && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Skills that need it: </Text>{c.wanted.skills.join(', ')}</Text>}
                      {c.wanted.setup?.map((s, n) => <Text key={s} style={[type.caption, { fontSize: 12, marginLeft: 8 }]}>{n + 1}. {s}</Text>)}
                      {!!c.wanted.needs && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Needs your OK: </Text>{c.wanted.needs}</Text>}
                      {!!c.wanted.state && <Text style={[type.caption, { fontSize: 13 }]}><Text style={{ fontWeight: '600' }}>Now: </Text>{c.wanted.state}</Text>}
                    </View>
                  )}
                  {!!c.description && <Text style={[type.caption, { fontSize: 13 }]}>{c.description}</Text>}
                  {!!c.notes && <Text style={[type.caption, { fontSize: 13 }]}>{c.notes}</Text>}
                  <Text style={[type.caption, { fontSize: 12, color: color.inkMuted }]}>
                    {[c.machine, c.address, c.firstSeen && `since ${date(c.firstSeen)}`, c.goneAt && `${c.status === 'retired' ? 'retired' : 'last found'} ${date(c.goneAt)}`, c.source === 'scan' && 'found by scan'].filter(Boolean).join(' · ')}
                  </Text>
                  {picking && (
                    <View style={{ gap: 6, marginTop: 6 }}>
                      {data.bots.filter((b) => !c.onlyBots || c.onlyBots.some((x) => x === b.id || x.toLowerCase() === b.name.toLowerCase())).map((b) => (
                        <Pressable key={b.id} onPress={() => setChosen((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
                          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
                          <Text style={type.body}>{b.name}</Text>
                          <Switch value={chosen.includes(b.id)} onValueChange={(v) => setChosen((s) => (v ? [...s, b.id] : s.filter((x) => x !== b.id)))} accessibilityLabel={`${c.name} for ${b.name}`} />
                        </Pressable>
                      ))}
                      <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
                        <PillButton title="Cancel" kind="secondary" onPress={() => setPicking(false)} />
                        <PillButton title="Next" disabled={busy || !chosen.length} onPress={() => { onPropose({ action: 'add', connectorId: c.id, bots: chosen }); setPicking(false); }} />
                      </View>
                    </View>
                  )}
                  {confirmBox}
                  {data.owner && c.canAdd && !picking && (
                    <View style={{ alignItems: 'flex-start', marginTop: 6 }}>
                      <PillButton title="Add to bots" kind="secondary" disabled={busy || locked} onPress={() => { setPicking(true); setChosen([]); }} />
                    </View>
                  )}
                  {data.owner && c.custom && (c.needsSignIn || !c.added) && (
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                      {c.needsSignIn && <PillButton title="Sign in" disabled={busy} onPress={() => onSignIn(c.id)} />}
                      {!c.added && <PillButton title="Delete" kind="secondary" disabled={busy || locked} onPress={() => onDelete(c)} />}
                    </View>
                  )}
                  {data.owner && c.added && (
                    <View style={{ alignItems: 'flex-start', marginTop: 6 }}>
                      <PillButton title="Remove from bots" kind="secondary" disabled={busy || locked} onPress={() => onPropose({ action: 'remove', connectorId: c.id })} />
                    </View>
                  )}
                </View>
  );
}

/**
 * Connect a Google account (Gmail, Calendar, Drive), as on the web's Settings › Connectors. Sign-in is
 * on Google's own page and the keys stay on the server. The first time, the owner picks the Google
 * Cloud Web client file.
 */
export function ConnectGoogle({ api, busy, onStarted }: { api: Client; busy: boolean; onStarted: () => void }) {
  const [info, setInfo] = useState<{ configured: boolean; redirectUri: string; audienceUrl?: string } | null>(null);
  const [write, setWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => { api.googleConnector().then(setInfo).catch((e: any) => setError(e?.message ?? 'Couldn’t reach your server.')); }, [api]);
  const go = async (f: () => Promise<void>) => { setWorking(true); setError(null); try { await f(); } catch (e: any) { setError(e?.message ?? 'Couldn’t do that.'); } finally { setWorking(false); } };
  const upload = () => go(async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['application/json', '*/*'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    await api.googleClient(await new FsFile(r.assets[0].uri).text());
    setInfo(await api.googleConnector());
  });
  const start = () => go(async () => { const r = await api.googleStart(write); await Linking.openURL(r.signInUrl); onStarted(); });
  return (
    <ListGroup>
      <View style={{ padding: 14, gap: 8 }}>
        <Text style={[type.body, { fontWeight: '600' }]}>Connect a Google account</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>Gmail, Calendar, Drive and Tasks for one Google account. You sign in on Google’s page; the keys stay on your server. A bot can send mail only after you read the whole email on a card in its chat and press Send.</Text>
        {!!error && <Notice tone="problem">{error}</Notice>}
        {info?.configured && (
          <>
            <Pressable onPress={() => setWrite((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Switch value={write} onValueChange={setWrite} accessibilityLabel="Allow changes" />
              <Text style={[type.caption, { flex: 1, fontSize: 13 }]}>Allow sending mail, drafts, and Calendar, Drive and Tasks changes. Each one asks on a card first; an email shows in full and goes only when you press Send. Off means read only.</Text>
            </Pressable>
            <View style={{ alignItems: 'flex-start' }}><PillButton title={working ? 'Opening…' : 'Connect Google'} disabled={busy || working} onPress={start} /></View>
            <Text style={[type.caption, { fontSize: 13 }]}>If Google says the app “has not completed Google verification”, that account isn’t on the test-user list yet. Add it under Google Auth Platform › Audience › Test users, then try again.</Text>
            {!!info.audienceUrl && <View style={{ alignItems: 'flex-start' }}><PillButton title="Open test users" kind="secondary" onPress={() => void Linking.openURL(info.audienceUrl!)} /></View>}
          </>
        )}
        {info && !info.configured && (
          <>
            <Text style={[type.caption, { fontSize: 13 }]}>One-time setup: in Google Cloud, APIs & Services › Credentials › Create OAuth client ID › Web application, with this redirect address. Then pick the JSON file Google gives you.</Text>
            <Field value={info.redirectUri} editable={false} selectTextOnFocus />
            <View style={{ alignItems: 'flex-start' }}><PillButton title={working ? 'Uploading…' : 'Pick the client file'} kind="secondary" disabled={working} onPress={upload} /></View>
          </>
        )}
      </View>
    </ListGroup>
  );
}

const BLANK: NewConnector = { name: '', url: '', auth: 'none', headerName: 'Authorization', headerValue: '', remote: false, readOnly: false };

/** Connect a server by its MCP address, as on the web's Settings › Connectors. Keys stay on the server. */
export function ConnectByAddress({ api, busy, onDone }: { api: Client; busy: boolean; onDone: (r: { connectorId: string; signInUrl?: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<NewConnector>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const set = <K extends keyof NewConnector>(k: K, v: NewConnector[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setWorking(true); setError(null);
    try { const r = await api.createConnector(f); setOpen(false); setF(BLANK); await onDone(r); }
    catch (e: any) { setError(e?.message ?? 'Couldn’t connect it.'); } finally { setWorking(false); }
  };
  const row = (label: string, value: boolean, on: (v: boolean) => void) => (
    <Pressable onPress={() => on(!value)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <Text style={[type.caption, { fontSize: 14, flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={on} accessibilityLabel={label} />
    </Pressable>
  );
  return (
    <ListGroup style={{ padding: 16, gap: 10 }}>
      <Text style={[type.body, { fontWeight: '600' }]}>Connect a server</Text>
      <Text style={[type.caption, { fontSize: 13 }]}>Any MCP server, by its address. Keys stay on your server and are never shown again.</Text>
      {!open && <PillButton title="Connect…" kind="secondary" disabled={busy} onPress={() => setOpen(true)} />}
      {open && (
        <View style={{ gap: 10 }}>
          {error && <Notice tone="problem">{error}</Notice>}
          <Field value={f.name} onChangeText={(v) => set('name', v)} placeholder="Name, e.g. Weather" accessibilityLabel="Name" />
          <Field value={f.url} onChangeText={(v) => set('url', v)} placeholder="MCP address, e.g. http://127.0.0.1:3000/mcp" accessibilityLabel="MCP address" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {([['none', 'No key'], ['key', 'Key'], ['oauth', 'Sign in with the server']] as const).map(([v, l]) => (
              <PillButton key={v} title={l} kind={f.auth === v ? 'primary' : 'secondary'} onPress={() => set('auth', v)} />
            ))}
          </View>
          {f.auth === 'key' && (
            <>
              <Field value={f.headerName} onChangeText={(v) => set('headerName', v)} placeholder="Header, usually Authorization" accessibilityLabel="Header" autoCapitalize="none" autoCorrect={false} />
              <Field value={f.headerValue} onChangeText={(v) => set('headerValue', v)} placeholder="Key, e.g. Bearer …" accessibilityLabel="Key" secureTextEntry autoCapitalize="none" autoCorrect={false} />
            </>
          )}
          {f.auth === 'oauth' && <Text style={[type.caption, { fontSize: 13 }]}>After Connect, the server’s sign-in page opens. Sign in there, then come back.</Text>}
          {row('On another machine or the internet (what bots send it leaves this computer)', !!f.remote, (v) => set('remote', v))}
          {row('Read only (tools that change things are blocked)', !!f.readOnly, (v) => set('readOnly', v))}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <PillButton title="Cancel" kind="secondary" onPress={() => { setOpen(false); setError(null); }} />
            <PillButton title={working ? 'Connecting…' : 'Connect'} disabled={working || !f.name.trim() || !f.url.trim() || (f.auth === 'key' && !f.headerValue)} onPress={submit} />
          </View>
        </View>
      )}
    </ListGroup>
  );
}
