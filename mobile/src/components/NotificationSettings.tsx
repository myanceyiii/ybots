import { useCallback, useEffect, useState } from 'react';
import { toast } from '../toast';
import { AppState, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import type { Bot, Client, NotifyPatch, NotifyPrefs } from '../api';
import { APP_NAME, NOTIFY_PROFILE, background, notifyTurnedOff, setNotificationsOn } from '../background';
import { color, type } from '../theme';
import { Chip } from './ui';
import { addMinutes, isTime } from './timeField';

/**
 * Notification settings for this app (server/src/notify.ts keeps them, per app: YBots shares
 * them with the website and the Windows app). Kinds of notice, message text,
 * do not disturb, quiet hours and muted bots. Sound and vibration for each kind are Android's own
 * channel settings, one tap away.
 */
export function NotificationSettings({ api, bots = [] }: { api: Client; bots?: Bot[] }) {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [linkOn, setLinkOn] = useState(true);
  const [allowed, setAllowed] = useState(background.status().notificationsAllowed);
  // What the link itself is doing, apart from the switch: the server refused its sign-in, or Android
  // would not start it.
  const [linkState, setLinkState] = useState<{ signedOut: boolean; startFailed: boolean }>({ signedOut: false, startFailed: false });
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setAllowed(background.status().notificationsAllowed);
    setLinkState((s) => ({ ...s, signedOut: background.notifyStatus().signedOut }));
    void notifyTurnedOff().then((off) => setLinkOn(!off));
  }, []);
  useEffect(() => {
    refresh();
    api.notifyPrefs(NOTIFY_PROFILE).then((r) => setPrefs(r.prefs)).catch((e) => setErr(e?.message ?? 'Could not load.'));
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => sub.remove();
  }, [api, refresh]);

  const save = (patch: NotifyPatch) => {
    setErr(null);
    api.setNotifyPrefs(NOTIFY_PROFILE, patch).then((r) => setPrefs(r.prefs)).catch((e) => setErr(e?.message ?? 'Could not save.'));
  };

  if (!background.notifyAvailable) return null;
  const now = Date.now();
  const dndOn = !!prefs && prefs.dndUntil > now;
  const muted = prefs ? Object.entries(prefs.muted).filter(([, until]) => until === 0 || until > now) : [];
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } })();

  return (
    <View style={{ gap: 12 }}>
      <Group>
        <Row title="Notifications"
          detail={!linkOn ? `Off on this phone. ${APP_NAME} only tells you things while it is open.`
            : !allowed ? 'Android is blocking them. Turn them on so replies and approvals reach you.'
            : linkState.signedOut ? 'Not connected: the server no longer accepts this phone\'s sign-in. Sign out and sign in again with a new code.'
            : linkState.startFailed ? 'Android would not start the link just now. Turn it off and on again, or reopen the app.'
            : `On. ${APP_NAME} keeps a quiet link to your server, so replies and approvals reach you even when the app is closed.`}
          right={<Switch value={linkOn && allowed} accessibilityLabel="Notifications"
            onValueChange={(on) => { void setNotificationsOn(api, on).then((r) => { if (on && !r.allowed) background.openNotificationSettings(null); setLinkState({ signedOut: false, startFailed: on && r.allowed && !r.started }); refresh(); }); }}
            trackColor={{ true: color.primary, false: color.secondaryBorder }} />} />
        <Row title="Hide the “connected” notice" last
          detail="Android needs a small notice while the link is open. Tap Open, then turn off the Connection category. Notifications keep working."
          right={<Small title="Open" onPress={() => background.openNotificationSettings('link')} />} />
      </Group>

      {prefs && (
        <>
          <Group>
            {([['messages', 'Messages', 'Replies from your bots and messages in your groups.'],
              ['approvals', 'Approvals and questions', 'A bot is waiting on you. Low-risk requests get Allow and Deny right in the notification.'],
              ['jobs', 'Finished work', 'Pictures, new looks and documents a bot finished.']] as const).map(([k, title, detail]) => (
              <Row key={k} title={title} detail={detail}
                right={<View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Switch value={prefs.channels[k]} accessibilityLabel={title} onValueChange={(v) => save({ channels: { [k]: v } })} trackColor={{ true: color.primary, false: color.secondaryBorder }} />
                  <Pressable accessibilityRole="button" onPress={() => background.openNotificationSettings(k)}><Text style={{ fontSize: 13, color: color.inkSecondary, textDecorationLine: 'underline' }}>Sound</Text></Pressable>
                </View>} />
            ))}
            <Row title="Show message text" last detail={prefs.preview ? 'Notifications show what the bot said.' : 'Notifications only say there is a new message.'}
              right={<Switch value={prefs.preview} accessibilityLabel="Show message text" onValueChange={(v) => save({ preview: v })} trackColor={{ true: color.primary, false: color.secondaryBorder }} />} />
          </Group>

          <Group>
            <View style={{ paddingVertical: 13, paddingHorizontal: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: color.hairline }}>
              <Text style={[type.body, { fontWeight: '500' }]}>Do not disturb</Text>
              <Text style={[type.caption, { fontSize: 13 }]}>{dndOn ? `Nothing comes through until ${clock(prefs.dndUntil)}.` : 'Pause every notification for a while.'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                <Chip title="Off" selected={!dndOn} onPress={() => save({ dndUntil: 0 })} />
                <Chip title="1 hour" onPress={() => save({ dndUntil: now + 3600_000 })} />
                <Chip title="4 hours" onPress={() => save({ dndUntil: now + 4 * 3600_000 })} />
                <Chip title="Until 8 AM" onPress={() => save({ dndUntil: nextAt(8) })} />
              </ScrollView>
            </View>
            <View style={{ paddingVertical: 13, paddingHorizontal: 16, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.body, { fontWeight: '500' }]}>Quiet hours</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>Every day from {ampm(prefs.quiet.start)} to {ampm(prefs.quiet.end)}, notifications come without sound or vibration.</Text>
                </View>
                <Switch value={prefs.quiet.on} accessibilityLabel="Quiet hours" onValueChange={(v) => save({ quiet: { on: v, tz } })} trackColor={{ true: color.primary, false: color.secondaryBorder }} />
              </View>
              {prefs.quiet.on && (
                <>
                  {/* Any time of day, as on the website: hour and minute each step up and down. */}
                  <TimeField label="Starts" value={prefs.quiet.start} onChange={(t) => save({ quiet: { start: t, tz } })} />
                  <TimeField label="Ends" value={prefs.quiet.end} onChange={(t) => save({ quiet: { end: t, tz } })} />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Text style={[type.caption, { flex: 1, fontSize: 13 }]}>Let approvals ring during quiet hours</Text>
                    <Switch value={prefs.quiet.approvalsRing} accessibilityLabel="Let approvals ring during quiet hours" onValueChange={(v) => save({ quiet: { approvalsRing: v } })} trackColor={{ true: color.primary, false: color.secondaryBorder }} />
                  </View>
                </>
              )}
            </View>
          </Group>

          {/* Hidden from the list (Bot.ownerHidden): no notifications at all until shown again. */}
          {bots.some((b) => b.ownerHidden) && (
            <Group>
              {bots.filter((b) => b.ownerHidden).map((b, i, all) => (
                <Row key={b.id} title={`${b.name} is hidden`} last={i === all.length - 1}
                  detail="Off your Bots screen, so no notifications. It still works and talks to your other bots."
                  right={<Small title="Show" onPress={() => { setErr(null); api.updateBot(b.id, { ownerHidden: false }).catch((e) => setErr(e?.message ?? 'Could not show it.')); }} />} />
              ))}
            </Group>
          )}

          {muted.length > 0 && (
            <Group>
              {muted.map(([id, until], i) => (
                <Row key={id} title={`${bots.find((b) => b.id === id)?.name ?? 'A bot'} is muted`} last={i === muted.length - 1}
                  detail={until === 0 ? 'Until you turn it back on.' : `Until ${clock(until)}.`}
                  right={<Small title="Unmute" onPress={() => save({ unmute: id })} />} />
              ))}
            </Group>
          )}
        </>
      )}
      {!!err && <Text style={[type.caption, { color: color.problemInk, paddingHorizontal: 4 }]}>{err}</Text>}
    </View>
  );
}

/** Mute one bot or group: off, for an hour, for eight hours, or until turned back on. For a bot's settings. */
export function MuteRow({ api, bot }: { api: Client; bot: Bot }) {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  useEffect(() => { api.notifyPrefs(NOTIFY_PROFILE).then((r) => setPrefs(r.prefs)).catch(() => {}); }, [api]);
  if (!prefs) return null;
  const until = prefs.muted[bot.id];
  const on = until !== undefined && (until === 0 || until > Date.now());
  const set = (patch: NotifyPatch) => api.setNotifyPrefs(NOTIFY_PROFILE, patch).then((r) => setPrefs(r.prefs)).catch((e) => toast(`That setting was not saved: ${e?.message ?? 'the server did not answer'}`));
  return (
    <View style={{ paddingVertical: 13, paddingHorizontal: 16, gap: 10 }}>
      <Text style={[type.body, { fontWeight: '500' }]}>Notifications</Text>
      <Text style={[type.caption, { fontSize: 13 }]}>{!on ? `You hear about ${bot.name}'s replies and requests.` : until === 0 ? `${bot.name} is muted until you turn it back on.` : `${bot.name} is muted until ${clock(until!)}.`}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip title="On" selected={!on} onCard onPress={() => set({ unmute: bot.id })} />
        <Chip title="Mute 1 hour" onCard onPress={() => set({ mute: { botId: bot.id, until: Date.now() + 3600_000 } })} />
        <Chip title="Mute 8 hours" onCard onPress={() => set({ mute: { botId: bot.id, until: Date.now() + 8 * 3600_000 } })} />
        <Chip title="Mute" selected={on && until === 0} onCard onPress={() => set({ mute: { botId: bot.id, until: 0 } })} />
      </ScrollView>
    </View>
  );
}

const ampm = (t: string) => {
  const h = Number(t.slice(0, 2)), m = t.slice(3, 5);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'AM' : 'PM'}`;
};
const clock = (ms: number) => {
  const d = new Date(ms);
  const same = d.toDateString() === new Date().toDateString();
  return `${same ? '' : 'tomorrow '}${ampm(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)}`;
};
const nextAt = (hour: number) => {
  const d = new Date(); d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
};

/** One time of day (HH:mm): the hour and the minutes step separately, so every time can be set. */
function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (t: string) => void }) {
  const t = isTime(value) ? value : '22:00';
  const Step = ({ by, unit, sign }: { by: number; unit: string; sign: '−' | '+' }) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${sign === '+' ? 'later' : 'earlier'} by ${unit}`} onPress={() => onChange(addMinutes(t, by))}
      style={({ pressed }) => ({ width: 40, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 17, color: color.ink }}>{sign}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessible={false}>
      <Text style={[type.caption, { fontSize: 13, width: 48 }]}>{label}</Text>
      <Step by={-60} unit="an hour" sign="−" />
      <Text accessibilityLabel={`${label} ${ampm(t)}`} style={[type.body, { fontWeight: '600', minWidth: 84, textAlign: 'center' }]}>{ampm(t)}</Text>
      <Step by={60} unit="an hour" sign="+" />
      <Text style={[type.caption, { fontSize: 13, marginLeft: 6 }]}>min</Text>
      <Step by={-5} unit="5 minutes" sign="−" />
      <Step by={5} unit="5 minutes" sign="+" />
    </View>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <View style={{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }}>{children}</View>;
}

function Row({ title, detail, right, last }: { title: string; detail: string; right?: React.ReactNode; last?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>{detail}</Text>
      </View>
      {right}
    </View>
  );
}

function Small({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 14, fontWeight: '500', color: color.ink }}>{title}</Text>
    </Pressable>
  );
}
