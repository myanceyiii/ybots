import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import type { Client, ListSummaryInfo, ListSummaryPrefs } from '../api';
import { color, type } from '../theme';

/**
 * Chat list previews, as Settings › General › Chat list on the web: the Bot's own last message (or who posted
 * last), or a short AI summary of the conversation on a model from your Hermes (server/src/list-summary.ts).
 */
export function ChatListSettings({ api }: { api: Client }) {
  const [info, setInfo] = useState<ListSummaryInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => { api.listSummary().then(setInfo).catch((e) => setErr((e as Error).message)); }, [api]);
  const save = async (patch: Partial<ListSummaryPrefs>) => {
    if (!info) return;
    setInfo({ ...info, prefs: { ...info.prefs, ...patch } });
    try { const { prefs } = await api.setListSummary(patch); setInfo((i) => (i ? { ...i, prefs } : i)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  };
  const p = info?.prefs;
  const o = info?.options;
  const current = p?.model ?? (o?.auto.model ? `Automatic (${o.auto.model})` : 'Automatic');
  const choices: { provider: string | null; model: string | null; label: string }[] = [
    { provider: null, model: null, label: o?.auto.model ? `Automatic (${o.auto.model})` : 'Automatic' },
    ...(o?.providers ?? []).flatMap((pr) => pr.models.map((m) => ({ provider: pr.id, model: m, label: `${m} · ${pr.name}` }))),
  ];
  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>AI summary in the chat list</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{p?.on
            ? 'Each chat shows a few words on what the conversation is about. Made only after a chat changes, then saved.'
            : 'Each chat shows the Bot’s own last message, or who posted last, such as “You posted last.”'}</Text>
        </View>
        <Switch value={!!p?.on} disabled={!info} onValueChange={(v) => { void save({ on: v }); }}
          trackColor={{ true: color.primary, false: color.secondaryBorder }} accessibilityLabel="AI summary in the chat list" />
      </View>
      {p?.on && (
        <Pressable accessibilityRole="button" onPress={() => setPicking((x) => !x)}
          style={({ pressed }) => ({ paddingVertical: 13, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: color.hairline, opacity: pressed ? 0.7 : 1, gap: 2 })}>
          <Text style={[type.body, { fontWeight: '500' }]}>Summary model</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{o?.ready ? current : 'Your Hermes is not answering, so its models can’t be listed right now.'}</Text>
        </Pressable>
      )}
      {p?.on && picking && choices.map((c) => {
        const on = (c.model ?? null) === (p.model ?? null) && (c.model == null || c.provider === p.provider);
        return (
          <Pressable key={`${c.provider}|${c.model}`} accessibilityRole="radio" accessibilityState={{ selected: on }}
            onPress={() => { setPicking(false); void save({ provider: c.provider, model: c.model }); }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: color.hairline, backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Text style={{ width: 18, color: color.link, fontWeight: '700' }}>{on ? '✓' : ''}</Text>
            <Text style={[type.body, { flex: 1 }]}>{c.label}</Text>
          </Pressable>
        );
      })}
      <Text style={[type.caption, { fontSize: 12.5, paddingHorizontal: 16, paddingBottom: 12, paddingTop: p?.on ? 8 : 0 }]}>
        Sheldon’s chat and groups he is in never get an AI summary.{info?.lastError && p?.on ? ` Last problem: ${info.lastError.error}` : ''}
      </Text>
      {!!err && <Text style={{ color: color.problemInk, paddingHorizontal: 16, paddingBottom: 12 }}>{err}</Text>}
    </View>
  );
}
