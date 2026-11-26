import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import type { Client } from '../api';
import { color, type } from '../theme';
import { Icon } from './Icon';
import * as SecureStore from 'expo-secure-store';

const FOLD_KEY = 'cleftbot.timersOpen';

type Host = Awaited<ReturnType<Client['systemdTimers']>>['hosts'][number];
type Timer = Host['timers'][number];

/** "in 5 min", "2 h ago". Same wording as web/src/components/SystemdTimers.tsx. */
function relTime(ms: number | null, now = Date.now()): string {
  if (!ms) return '—';
  const d = ms - now, a = Math.abs(d), m = Math.round(a / 60000);
  const span = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}
const stateWord = (s: string) => s === 'enabled' ? 'On' : s === 'disabled' ? 'Off' : s.charAt(0).toUpperCase() + s.slice(1);
const canToggle = (t: Timer) => !t.name.includes('@.') && (t.state === 'enabled' || t.state === 'disabled');

export function SystemdTimers({ api, botId }: { api: Client; botId: string }) {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // The whole list folds like "Providers and fallbacks": closed by default, remembered on this phone.
  const [sectionOpen, setSectionOpenState] = useState(() => { try { return SecureStore.getItem(FOLD_KEY) === '1'; } catch { return false; } });
  const setSectionOpen = (v: boolean) => { setSectionOpenState(v); SecureStore.setItemAsync(FOLD_KEY, v ? '1' : '0').catch(() => {}); };
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.systemdTimers(botId); setHosts(r.hosts); setCheckedAt(r.checkedAt ?? Date.now()); setError(''); }
    catch { setError('Could not load timers. Try Refresh.'); }
    finally { setLoading(false); }
  }, [api, botId]);
  useEffect(() => { void load(); }, [load]);
  async function change(host: string, t: Timer) {
    setBusy(`${host}/${t.name}`); setError('');
    try { await api.changeSystemdTimer(botId, host, t.name, t.state === 'enabled' ? 'disable' : 'enable'); await load(); }
    catch { setError(`${t.name} was not changed, or the change could not be confirmed. Refresh to check.`); }
    finally { setBusy(''); }
  }
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => hosts?.map((h) => ({ ...h, timers: q ? h.timers.filter((t) => t.name.toLowerCase().includes(q) || (t.activates ?? '').toLowerCase().includes(q)) : h.timers })), [hosts, q]);
  const total = hosts?.reduce((n, h) => n + h.timers.length, 0) ?? 0;

  const reach = hosts?.filter((h) => h.reachable) ?? [];
  const offCount = reach.reduce((n, h) => n + h.timers.filter((t) => t.state === 'disabled').length, 0);
  const reachTotal = reach.reduce((n, h) => n + h.timers.length, 0);
  const line = hosts ? `${reachTotal} timer${reachTotal === 1 ? '' : 's'}${offCount ? ` · ${offCount} off` : ''} on ${reach.length} machine${reach.length === 1 ? '' : 's'}` : error ? 'Unavailable' : 'Checking…';
  const problems = (hosts?.filter((h) => !h.reachable).length ?? 0) + (error ? 1 : 0);
  const problemText = `${problems} ${problems === 1 ? 'problem' : 'problems'}`;
  return <View style={{ gap: 10, paddingTop: 6 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: sectionOpen }} accessibilityLabel={`Systemd timers, ${sectionOpen ? 'open' : 'closed'}, ${line}${problems ? `, ${problemText}` : ''}`}
      onPress={() => setSectionOpen(!sectionOpen)}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.fill })}>
      <View style={{ transform: [{ rotate: sectionOpen ? '90deg' : '0deg' }] }}><Icon name="chevron" size={16} color={color.inkMuted} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>Systemd timers</Text>
        <Text numberOfLines={1} style={[type.caption, { fontSize: 13 }]}>{line}</Text>
      </View>
      {problems > 0 && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 12, backgroundColor: color.problemFill }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.danger }} />
        <Text style={{ fontSize: 12, color: color.problemInk }}>{problemText}</Text>
      </View>}
    </Pressable>
    {sectionOpen && <>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
      <Pressable accessibilityRole="button" disabled={loading} onPress={() => void load()} hitSlop={10}>
        <Text style={{ fontSize: 15, color: color.link }}>{loading ? 'Checking…' : 'Refresh'}</Text>
      </Pressable>
    </View>
    {!!error && <Text accessibilityRole="alert" style={{ color: color.problemInk }}>{error}</Text>}
    {!hosts && !error && <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><ActivityIndicator color={color.inkMuted} /><Text style={type.caption}>Checking timers on each machine…</Text></View>}
    {hosts && total > 8 && <TextInput value={filter} onChangeText={setFilter} placeholder="Find a timer" placeholderTextColor={color.inkMuted} accessibilityLabel="Find a timer" autoCapitalize="none" autoCorrect={false}
      style={{ height: 40, borderRadius: 10, paddingHorizontal: 12, backgroundColor: color.fill, color: color.ink, fontSize: 15 }} />}
    {shown?.map((h) => {
      if (q && h.timers.length === 0) return null;
      const isOpen = !!q || !!open[h.host];
      const off = h.timers.filter((t) => t.state === 'disabled').length;
      return <View key={h.host} style={{ borderRadius: 12, backgroundColor: color.surface, borderWidth: 0.5, borderColor: color.hairline }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} onPress={() => setOpen((o) => ({ ...o, [h.host]: !o[h.host] }))}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, opacity: pressed ? 0.7 : 1 })}>
          <Text style={{ width: 14, color: color.inkMuted }}>{isOpen ? '▾' : '▸'}</Text>
          <Text style={[type.body, { flex: 1, fontWeight: '500' }]}>{h.label ?? h.host}</Text>
          <Text style={[type.caption, !h.reachable && { color: color.problemInk }]}>{!h.reachable ? "Can't reach" : `${h.timers.length}${off ? ` · ${off} off` : ''}`}</Text>
        </Pressable>
        {isOpen && (!h.reachable
          ? <Text style={[type.caption, { paddingHorizontal: 12, paddingBottom: 12 }]}>This machine didn't answer. Its timers are not shown so nothing out of date looks current.</Text>
          : h.timers.map((t) => <View key={t.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 0.5, borderTopColor: color.hairline }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={type.body}>{t.name.replace(/\.timer$/, '')}</Text>
              <Text style={type.caption}><Text style={{ color: t.state === 'enabled' ? color.ink : color.inkMuted, fontWeight: '500' }}>{stateWord(t.state)}</Text> · Next {relTime(t.next)} · Last {relTime(t.last)}</Text>
            </View>
            {canToggle(t) && <Pressable accessibilityRole="button" disabled={!!busy} onPress={() => void change(h.host, t)}
              style={({ pressed }) => ({ paddingHorizontal: 12, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: color.secondaryButton, opacity: busy && busy !== `${h.host}/${t.name}` ? 0.5 : pressed ? 0.8 : 1 })}>
              <Text style={{ fontSize: 14, fontWeight: '500', color: color.ink }}>{busy === `${h.host}/${t.name}` ? 'Waiting…' : t.state === 'enabled' ? 'Turn off' : 'Turn on'}</Text>
            </Pressable>}
          </View>))}
      </View>;
    })}
    {checkedAt && <Text style={type.time}>Checked {new Date(checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Turning a timer on or off asks you first in Howard's chat.</Text>}
    </>}
  </View>;
}
