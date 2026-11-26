import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Client, DeviceSession } from '../api';
import { Header, HeaderTitle, Notice, PillButton, RoundButton, refreshLook } from '../components/ui';
import { tap } from '../haptics';
import { color, type } from '../theme';
import { toast } from '../toast';
import { Card, Row, Section, SmallButton } from './BotSettings';

const seen = (d: DeviceSession) => {
  if (d.current) return 'This phone';
  const t = d.lastSeenAt ?? d.createdAt;
  const m = Math.round((Date.now() - t) / 60_000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
  return `${d.lastSeenAt ? 'Last used' : 'Signed in'} ${ago}`;
};

/**
 * Every place this account is signed in, as the web's Settings › Signed-in devices: sign one out (a lost
 * phone, an old laptop), or everything except this phone. Helper programs are listed apart from people.
 */
export function Devices({ api, onBack }: { api: Client; onBack: () => void }) {
  const [list, setList] = useState<DeviceSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => api.sessions().then((r) => { setList(r.sessions); setLoadError(null); }).catch((e: any) => setLoadError(e?.message ?? 'The server did not answer.')), [api]);
  useEffect(() => { void load(); }, [load]);
  const act = (p: Promise<{ sessions: DeviceSession[] }>, done: string) => {
    setError(null);
    p.then((r) => { setList(r.sessions); tap('success'); toast(done); }).catch((e: any) => { tap('error'); setError(e?.message ?? 'Could not sign it out.'); });
  };
  const name = (d: DeviceSession) => d.device ?? (d.kind === 'script' ? 'A script' : 'A device');
  const signOut = (d: DeviceSession) => Alert.alert(`Sign out ${name(d)}?`, d.kind === 'script' ? 'This helper program stops working until it is signed in again.' : 'It needs a new sign-in code before it can open your bots again.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => act(api.signOutDevice(d.id), 'Signed out') }]);
  const people = (list ?? []).filter((d) => d.kind !== 'script');
  const scripts = (list ?? []).filter((d) => d.kind === 'script');
  const others = people.filter((d) => !d.current);
  const signOutOthers = () => Alert.alert(`Sign out ${others.length} other device${others.length === 1 ? '' : 's'}?`, 'This phone stays signed in, and so do helper programs.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => act(api.signOutOthers(), 'Signed out everywhere else') }]);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Signed-in devices</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21, marginBottom: 16 }]}>
          Everywhere your account is signed in. Sign out anything you no longer use or do not recognise.
        </Text>
        {!!error && <View style={{ marginBottom: 14 }}><Notice tone="problem">{error}</Notice></View>}
        {!!loadError && (
          <View style={{ marginBottom: 14, gap: 8 }}>
            <Notice tone="problem">Couldn't load the list: {loadError}</Notice>
            <PillButton title="Try again" kind="secondary" onPress={() => void load()} />
          </View>
        )}
        <Section title="Phones, computers and browsers">
          <Card>
            {list === null ? <Row title={loadError ? 'Not loaded' : 'Loading…'} last /> : people.length === 0 ? <Row title="Nothing here" last /> : people.map((d, i) => (
              <Row key={d.id} title={name(d)} last={i === people.length - 1}
                detail={`${seen(d)}${d.who ? ` · ${d.who}` : ''}`}
                right={d.current ? undefined : <SmallButton title="Sign out" danger onPress={() => signOut(d)} />} />
            ))}
          </Card>
        </Section>
        {others.length > 1 && (
          <View style={{ marginBottom: 22 }}>
            <PillButton title="Sign out everywhere else" kind="secondary" onPress={signOutOthers} />
          </View>
        )}
        {scripts.length > 0 && (
          <Section title={`Helper programs (${scripts.length})`} hint="Programs that sign in to do work for you, not people. Signing one out stops it until it is set up again.">
            <Card>
              {scripts.map((d, i) => (
                <Row key={d.id} title={`${name(d)}${d.who ? ` · ${d.who}` : ''}`} detail={seen(d)} last={i === scripts.length - 1}
                  right={<SmallButton title="Sign out" danger onPress={() => signOut(d)} />} />
              ))}
            </Card>
            {scripts.length > 1 && (
              <View style={{ marginTop: 10 }}>
                <PillButton title={`Sign out all ${scripts.length} helper programs`} kind="secondary" onPress={() => Alert.alert(`Sign out ${scripts.length} helper programs?`, 'Each one stops working until it is signed in again. Your phones, computers and browsers stay signed in.',
                  [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => act(api.signOutScripts(), 'Helper programs signed out') }])} />
              </View>
            )}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}
