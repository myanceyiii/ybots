import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { ApiError, type CheckState, type Client, type ServerStatus } from '../api';
import { Header, HeaderTitle, Notice, PillButton, RoundButton, refreshLook } from '../components/ui';
import { tap } from '../haptics';
import { usePoll } from '../poll';
import { color, type } from '../theme';
import { Card, Section, SmallButton } from './BotSettings';

const mb = (n: number) => (n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n >= 1_073_741_824 ? `${(n / 1_073_741_824).toFixed(1)} GB` : `${(n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0)} MB`);
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
const upFor = (sec: number) => {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
};
const STATE_WORD: Record<CheckState, string> = { ok: 'Fine', warn: 'Look', bad: 'Problem' };
const BOT_STATE: Record<string, string> = { ready: 'Ready', starting: 'Starting', stopped: 'Stopped', error: 'Problem', none: 'No engine' };
const dotColor = (s: CheckState) => (s === 'ok' ? color.goodInk : s === 'warn' ? color.warnInk : color.danger);

/** One line of a card: a coloured dot that also says its state to a screen reader, a title and the detail. */
function Line({ state, title, detail, bad, last, right }: { state?: CheckState; title: string; detail?: string; bad?: boolean; last?: boolean; right?: React.ReactNode }) {
  return (
    <View accessible={!right} accessibilityLabel={right ? undefined : `${state ? `${STATE_WORD[state]}. ` : ''}${title}. ${detail ?? ''}`}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline }}>
      {state && <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 6, backgroundColor: dotColor(state) }} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
        {!!detail && <Text selectable style={[type.caption, { fontSize: 13, lineHeight: 18, color: bad ? color.danger : color.inkSecondary }]}>{detail}</Text>}
      </View>
      {right}
    </View>
  );
}

/**
 * How the server behind the bots is doing, for its owner, as the web's Settings › System: one line per
 * thing that can go wrong (database, disk, bots' engines, routines, backups), then the detail behind each.
 * Fresh every 15 seconds while it is on screen and the app is in front.
 */
export function SystemStatus({ api, onBack }: { api: Client; onBack: () => void }) {
  const [st, setSt] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => api.status().then((s) => { setSt(s); setError(null); }).catch((e: any) => {
    if (e instanceof ApiError && e.status === 403) setDenied(true); else setError(e?.message ?? 'The server did not answer.');
  }), [api]);
  usePoll(() => { if (!denied) void load(); }, 15_000, [load, denied]);

  const snapshot = async () => {
    setBusy(true); setNote(null);
    try { const r = await api.snapshotNow(); tap('success'); setNote(r.snapshot ? `Saved ${r.snapshot.name} (${mb(r.snapshot.bytes)}).` : 'Saved.'); await load(); }
    catch (e: any) { tap('error'); setNote(e?.message ?? 'Could not make a copy.'); }
    finally { setBusy(false); }
  };

  const worst: CheckState = !st ? 'ok' : st.checks.some((c) => c.state === 'bad') ? 'bad' : st.checks.some((c) => c.state === 'warn') ? 'warn' : 'ok';
  const headline = worst === 'ok' ? 'Everything is running normally' : worst === 'warn' ? 'Running, with something to look at' : 'Something needs attention';
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>System</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {denied ? <Notice>Only the owner of this server can see how it is running.</Notice> : !st ? (
          error ? (
            <View style={{ gap: 8 }}>
              <Notice tone="problem">Couldn't check the server: {error}</Notice>
              <PillButton title="Try again" kind="secondary" onPress={() => void load()} />
            </View>
          ) : <Text style={[type.caption, { textAlign: 'center', padding: 24 }]}>Checking…</Text>
        ) : (
          <>
            {!!error && <View style={{ marginBottom: 14 }}><Notice tone="problem">Could not refresh: {error}</Notice></View>}
            <Section>
              <Card>
                <Line state={worst} title={headline} last
                  detail={`${st.server.version !== '0' ? `Version ${st.server.version}${st.server.commit ? ` (${st.server.commit.slice(0, 7)})` : ''}` : st.server.commit ? `Build ${st.server.commit.slice(0, 7)}` : 'Running'} · up ${upFor(st.server.uptimeSec)} on ${st.server.host} · checked ${new Date(st.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`} />
              </Card>
            </Section>
            <Section title="Checks">
              <Card>
                {st.checks.map((c, i) => <Line key={c.id} state={c.state} title={c.label} detail={c.detail} bad={c.state === 'bad'} last={i === st.checks.length - 1} />)}
              </Card>
            </Section>
            <Section title="Bots">
              <Card>
                {st.bots.length === 0 && <Line title="No bots yet" last />}
                {st.bots.map((b, i) => (
                  <Line key={b.id} last={i === st.bots.length - 1} title={b.name} bad={b.state === 'error'}
                    state={b.state === 'error' ? 'bad' : b.state === 'ready' || b.state === 'none' ? 'ok' : 'warn'}
                    detail={`${BOT_STATE[b.state] ?? b.state}${b.busy ? ' · working now' : ''}${b.awaiting ? ' · waiting on you' : ''}${b.model ? ` · ${b.model}` : ''}${b.error ? ` · ${b.error}` : ''}`} />
                ))}
              </Card>
            </Section>
            <Section title="Database copies" hint={`These copies are a quick way back after a mistake on this server. The weekly encrypted backup is the one kept somewhere else${st.backup ? `; its last run was ${when(st.backup.at)}${st.backup.ok ? '' : ' and it did not finish'}` : ''}.`}>
              <Card>
                <Line last={!note && !st.db.lastSnapshotError}
                  title={st.db.snapshotsKeep ? `A copy every day, the newest ${st.db.snapshotsKeep} kept` : 'Daily copies are switched off'}
                  detail={`${st.db.snapshots.length ? `${st.db.snapshots.length} on this server, newest ${when(st.db.snapshots[0].at)} (${mb(st.db.snapshots[0].bytes)})` : 'None yet'}${st.db.lastMaintenanceAt ? ` · tidied ${when(st.db.lastMaintenanceAt)}${st.db.lastMaintenance ? `: ${st.db.lastMaintenance}` : ''}` : ''}`}
                  right={<SmallButton title={busy ? 'Copying…' : 'Copy now'} disabled={busy || !st.db.snapshotsKeep} onPress={() => void snapshot()} />} />
                {!!st.db.lastSnapshotError && <Line state="bad" bad title="Last copy failed" detail={st.db.lastSnapshotError} last={!note} />}
                {!!note && <Line title={note} last />}
              </Card>
            </Section>
            <Section title="Recent problems"
              hint={`Since the server started: ${st.requests.total.toLocaleString()} requests, ${st.requests.errors} failed, ${st.requests.slow} slow · memory ${st.server.memoryMb} MB${st.disk ? ` · disk ${mb(st.disk.freeBytes)} free` : ''} · ${st.apps.listening} app${st.apps.listening === 1 ? '' : 's'} connected now.`}>
              <Card>
                {st.problems.length === 0 ? <Line title="Nothing has gone wrong since the server started." last /> : st.problems.slice(0, 20).map((p, i, all) => (
                  <Line key={`${p.at}-${i}`} state={p.level === 'error' ? 'bad' : 'warn'} title={p.text} detail={`${when(p.at)}${p.count > 1 ? ` · ${p.count} times` : ''}`} last={i === all.length - 1} />
                ))}
              </Card>
              {st.problems.length > 0 && (
                <View style={{ alignSelf: 'flex-start', marginTop: 10 }}>
                  <SmallButton title="Clear the list" onPress={() => { api.clearProblems().then(() => { tap('success'); void load(); }, (e: any) => { tap('error'); setError(e?.message ?? 'Could not clear the list.'); }); }} />
                </View>
              )}
            </Section>
          </>
        )}
      </ScrollView>
    </View>
  );
}
