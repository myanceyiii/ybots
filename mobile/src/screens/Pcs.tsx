import { CameraView, useCameraPermissions } from 'expo-camera';
import { toast } from '../toast';
import { usePoll } from '../poll';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import type { Bot, Client, Machine, MachineLogEntry } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Field, Header, HeaderTitle, Label, ListGroup, Notice, PillButton, RoundButton, refreshLook } from '../components/ui';
import { color, type } from '../theme';

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
};

/**
 * Your PCs (docs/remote-pc.md), as on the web app's Settings › Your PCs: paired PCs, online or not, what
 * they share, which bots may use them, watching or taking control of the screen, the activity list and Remove. A PC is paired
 * by typing the code its YBots app shows. Folders, commands and screen viewing are set on the PC.
 */
export function Pcs({ api, bots, onBack, onWatch }: { api: Client; bots: Bot[]; onBack: () => void; onWatch: (m: Machine, mode: 'watch' | 'control') => void }) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try { setMachines((await api.machines()).machines); setError(null); } catch (e: any) { setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api]);
  // Only while the app is open in front (src/poll.ts).
  usePoll(load, 10_000, [load]);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Your PCs</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21 }]}>
          PCs where the YBots Windows app lets your bots work. Anything that changes a PC needs your OK on a card, every time.
        </Text>
        {error && <Notice tone="problem">{error}</Notice>}
        <PairByCode api={api} onPaired={load} />
        {!machines ? <ActivityIndicator color={color.inkMuted} /> : machines.map((m) => <PcCard key={m.id} api={api} machine={m} bots={bots} onChange={load} onWatch={(mode) => onWatch(m, mode)} />)}
      </ScrollView>
    </View>
  );
}

/** The pairing id in a computer's QR code (https://<server>/pair/<id>), or null. */
export const pairIdFromUrl = (data: string) => /\/pair\/([A-Za-z0-9_-]{16,})(?:[?#].*)?$/.exec(data.trim())?.[1] ?? null;

/**
 * Pair a PC, or sign the Windows app in, from this phone: scan the QR code the computer shows (the phone's
 * own camera app would open it in the browser instead, which is not signed in), or type its short code.
 */
function PairByCode({ api, onPaired }: { api: Client; onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const ask = (p: { id: string; code: string; device: string; kind?: 'sign-in' | 'machine' }) => {
    const machine = p.kind === 'machine';
    Alert.alert(
      machine ? `Let your bots use ${p.device}?` : `Sign in YBots on ${p.device}?`,
      machine
        ? `Only allow this if ${p.code} is on that PC’s screen right now. Bots can then ask to work in the folders shared on it. Anything that changes the PC still needs your OK on a card.`
        : `Only allow this if ${p.code} is on that computer’s screen right now. It will be signed in to your account.`,
      [
        { text: 'Deny', style: 'cancel', onPress: () => { api.pairAnswer(p.id, false).catch((e) => toast(`Couldn't send your answer: ${e?.message ?? 'the server did not answer'}`)); } },
        { text: 'Allow', onPress: async () => {
          try { await api.pairAnswer(p.id, true); setCode(''); setNote(machine ? `${p.device} is paired. Choose its bots below.` : `${p.device} is signed in.`); onPaired(); }
          catch (e: any) { setNote(e?.message ?? 'That didn’t work.'); }
        } },
      ],
    );
  };
  const go = async () => {
    setBusy(true); setNote(null);
    try { ask(await api.pairByCode(code)); } catch (e: any) { setNote(e?.message ?? 'That code didn’t work.'); } finally { setBusy(false); }
  };
  const scanned = async (data: string) => {
    if (busy) return;
    const id = pairIdFromUrl(data);
    if (!id) { setNote('That QR code is not a YBots pairing code. Scan the code the computer shows.'); return; }
    setCamera(false); setBusy(true); setNote(null);
    try { ask({ id, ...(await api.pairInfo(id)) }); } catch (e: any) { setNote(e?.message ?? 'That code didn’t work.'); } finally { setBusy(false); }
  };
  const openCamera = async () => {
    if (!permission?.granted && !(await requestPermission()).granted) { setNote('The camera is off for this app. Type the code instead.'); return; }
    setNote(null); setCamera(true);
  };
  return (
    <View>
      <Label>Pair a PC or sign in a computer</Label>
      <ListGroup style={{ padding: 14, gap: 10 }}>
        <Text style={[type.caption, { color: color.inkSecondary }]}>On the PC, open YBots. To sign it in, use the code on its sign-in screen. To let your bots use it, choose File › Let YBots use this PC…, then Pair this PC. Scan the QR code here, or type the short code it shows.</Text>
        {camera ? (
          <View style={{ alignSelf: 'center', width: 260, height: 260, borderRadius: 24, overflow: 'hidden', backgroundColor: '#1A1A1A' }}>
            <CameraView style={{ width: 260, height: 260 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={busy ? undefined : ({ data }) => { void scanned(data); }} />
          </View>
        ) : null}
        <PillButton title={camera ? 'Close the camera' : 'Scan the QR code'} icon={camera ? undefined : 'camera'} kind={camera ? 'secondary' : 'primary'} disabled={busy} onPress={() => (camera ? setCamera(false) : openCamera())} />
        <Field value={code} onChangeText={setCode} placeholder="ABC-123" autoCapitalize="characters" autoCorrect={false} maxLength={8} accessibilityLabel="Short code from the PC" returnKeyType="go" onSubmitEditing={() => { if (!busy && code.replace(/[^A-Za-z0-9]/g, '').length === 6) go(); }} style={{ backgroundColor: color.surface }} />
        <PillButton title={busy ? 'Looking…' : 'Continue'} kind="secondary" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length !== 6} onPress={go} />
        {note && <Text style={[type.caption, { color: color.inkSecondary }]}>{note}</Text>}
      </ListGroup>
    </View>
  );
}

function PcCard({ api, machine: m, bots, onChange, onWatch }: { api: Client; machine: Machine; bots: Bot[]; onChange: () => void; onWatch: (mode: 'watch' | 'control') => void }) {
  const [log, setLog] = useState<MachineLogEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const agents = bots.filter((b) => b.kind !== 'room');
  const setBot = async (botId: string, on: boolean) => {
    setNote(null);
    try { await api.setMachineBots(m.id, on ? [...m.bots, botId] : m.bots.filter((b) => b !== botId)); onChange(); }
    catch (e: any) { setNote(e?.message ?? 'Couldn’t change that.'); }
  };
  const remove = () => Alert.alert(`Remove ${m.name}?`, 'Its key stops working at once. Pair it again from the PC to use it later.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => api.removeMachine(m.id).then(onChange, (e) => setNote(e?.message ?? 'Couldn’t remove it.')) },
  ]);

  return (
    <View style={{ gap: 10 }}>
      <Label>{m.name}</Label>
      <ListGroup style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: m.online ? '#1E9E5A' : color.timestamp }} />
          <Text style={[type.body, { fontWeight: '600', flex: 1 }]}>{m.online ? 'Online' : m.lastSeenAt ? `Offline · seen ${ago(m.lastSeenAt)}` : 'Offline · never connected'}</Text>
        </View>
        <Text style={[type.caption, { color: color.inkSecondary }]}>
          {m.online ? `Commands ${m.commands ? 'allowed' : 'off'} · Screen viewing ${m.screen ? 'allowed' : 'off'} · Taking control ${m.control ? 'allowed' : 'off'} · Copy and paste ${m.clipboard ? 'allowed' : 'off'} · set on the PC` : 'Turn it on in the YBots app on that PC.'}
        </Text>
        <Text style={[type.caption, { color: color.inkSecondary }]}>Shared: {m.folders.length ? m.folders.map((f) => f.path).join(', ') : m.online ? 'nothing yet' : 'shown while online'}</Text>
        <PillButton title="Watch screen" kind="secondary" icon="eye" disabled={!m.online || !m.screen} onPress={() => onWatch('watch')} />
        <PillButton title="Take control" kind="secondary" icon="pointer" disabled={!m.online || !m.control} onPress={() => onWatch('control')} />
      </ListGroup>

      <Label>Bots that may use {m.name}</Label>
      <ListGroup>
        {agents.map((b, i) => {
          const blocked = m.blockedBots.includes(b.id) || m.pcBlocked.some((n) => n.toLowerCase() === b.name.toLowerCase());
          return (
            <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: i === agents.length - 1 ? 0 : 1, borderBottomColor: color.hairline }}>
              <BotAvatar bot={b} size={30} server={api.server} auth={api.authHeader} />
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { fontWeight: '500' }]}>{b.name}</Text>
                {blocked && <Text style={[type.caption, { color: color.inkMuted }]}>Can never use a PC.</Text>}
              </View>
              <Switch value={!blocked && m.bots.includes(b.id)} disabled={blocked} onValueChange={(v) => setBot(b.id, v)} accessibilityLabel={`${b.name} may use ${m.name}`} />
            </View>
          );
        })}
      </ListGroup>
      {note && <Notice tone="problem">{note}</Notice>}

      <ListGroup>
        <Pressable onPress={() => (log ? setLog(null) : api.machineLog(m.id).then((r) => setLog(r.log), () => setLog([])))} style={{ padding: 14 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>{log ? 'Hide activity' : 'Show activity'}</Text>
          <Text style={[type.caption, { color: color.inkMuted }]}>Everything bots asked to do on this PC, allowed or not.</Text>
        </Pressable>
        {log?.slice(0, 30).map((l) => (
          <View key={l.id} style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            <Text style={[type.caption, { color: color.ink }]}>{l.botName ?? 'You'} · {l.tool.replace(/^pc_/, '').replace(/_/g, ' ')} · {l.outcome}</Text>
            <Text style={[type.caption, { color: color.inkMuted }]}>{new Date(l.at).toLocaleString()}{l.detail ? ` · ${l.detail}` : ''}</Text>
          </View>
        ))}
        {log && !log.length && <Text style={[type.caption, { paddingHorizontal: 14, paddingBottom: 12 }]}>Nothing yet.</Text>}
      </ListGroup>
      <PillButton title="Remove this PC" kind="plain" onPress={remove} />
    </View>
  );
}
