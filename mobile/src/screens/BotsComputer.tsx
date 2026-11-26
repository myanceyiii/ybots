import { useCallback, useEffect, useState } from 'react';
import { usePoll } from '../poll';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Bot, Client, ComputerState } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Header, HeaderTitle, Notice, RoundButton, refreshLook } from '../components/ui';
import { color, type } from '../theme';
import { Card, Row, Section, SmallButton } from './BotSettings';
import { statusText } from './Computer';

type Details = { computer: ComputerState; screens: { botId: string; screenId: string; lastUsedAt: number }[]; hibernation: { idleMinutes: number; viewers: number; dryRun: boolean } };

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
};

/**
 * The bots' shared computer, as the web's Settings › Computer: awake or asleep with Wake and Sleep, and
 * which bot has which screen, with Reset to close everything on one.
 */
export function BotsComputer({ api, bots, onBack }: { api: Client; bots: Bot[]; onBack: () => void }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try { setDetails(await api.computerDetails()); } catch (e: any) { setNote({ text: e?.message ?? 'Couldn’t reach your server.', problem: true }); }
  }, [api]);
  usePoll(load, 5000, [load]);

  const status = details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await api.ensureComputer() : await api.suspendComputer(); await load(); }
    catch (e: any) { setNote({ text: e?.message ?? 'Could not do that.', problem: true }); }
    finally { setBusy(null); }
  };
  const reset = (botId: string, name: string) => Alert.alert(`Reset ${name}'s screen?`, 'Closes every window on it, so it starts clean next time.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: () => { api.resetScreen(botId).then(() => { setNote({ text: `Reset ${name}'s screen` }); load(); }).catch((e) => setNote({ text: e?.message ?? 'Could not reset it.', problem: true })); } },
  ]);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const max = details?.computer.maxScreens ?? 4;

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Bots’ computer</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21, marginBottom: 16 }]}>Your bots share one computer. Each bot works on its own screen.</Text>
        {!!note && <View style={{ marginBottom: 14 }}><Notice tone={note.problem ? 'problem' : 'note'}>{note.text}</Notice></View>}
        <Section>
          <Card>
            <Row title={`Bots’ computer · ${details ? statusText(details.computer) : 'Checking…'}`} last
              detail={details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a bot has work.` : undefined}
              right={running || status === 'suspending'
                ? <SmallButton title={busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'} disabled={!running || !!busy} onPress={() => act('sleep')} />
                : <SmallButton title={busy === 'wake' || transitioning ? 'Waking…' : 'Wake'} disabled={transitioning || !!busy || !details} onPress={() => act('wake')} />} />
          </Card>
          {details?.computer.status === 'error' && !!details.computer.error && <View style={{ marginTop: 10 }}><Notice tone="problem">{details.computer.error}</Notice></View>}
        </Section>
        <Section title={`Screens in use${details ? ` · ${details.screens.length} of ${max}` : ''}`}
          hint={`Reset closes every window on that bot’s screen, so it starts clean next time. Up to ${max} bots can have a screen at once${details && details.screens.length >= max ? '; reset one to free it for another bot' : ''}.`}>
          <Card>
            {!details ? <Row title="Loading…" last /> : details.screens.length === 0 ? <Row title="No bot has used the computer yet." last />
              : details.screens.map((s, i) => {
                const bot = byId.get(s.botId);
                return (
                  <View key={s.botId} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, borderBottomWidth: i === details.screens.length - 1 ? 0 : 1, borderBottomColor: color.hairline }}>
                    {bot ? <BotAvatar bot={bot} size={32} /> : <View style={{ width: 32 }} />}
                    <View style={{ flex: 1 }}>
                      <Row title={bot?.name ?? 'Removed bot'} detail={`${screenLabel(s.screenId)} · used ${ago(s.lastUsedAt)}`} last
                        right={<SmallButton title="Reset" disabled={!running} onPress={() => reset(s.botId, bot?.name ?? 'this')} />} />
                    </View>
                  </View>
                );
              })}
          </Card>
          {!running && !!details?.screens.length && <Text style={[type.caption, { fontSize: 13, marginTop: 6, marginHorizontal: 4 }]}>Wake the computer first to reset a screen.</Text>}
        </Section>
      </ScrollView>
    </View>
  );
}
