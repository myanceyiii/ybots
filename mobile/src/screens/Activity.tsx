import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, Share, Text, TextInput, View } from 'react-native';
import { File as FsFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { ApiError, type ActivityFilter, type ActivityOutcome, type ActivityPage, type ActivityRow, type ActivityStarter, type Client } from '../api';
import { Chip, Header, HeaderTitle, Notice, PillButton, RoundButton, Sheet } from '../components/ui';
import { color, type } from '../theme';

const OUTCOMES: { id: ActivityOutcome | ''; label: string }[] = [{ id: '', label: 'All' }, { id: 'refused', label: 'Refused' }, { id: 'failed', label: 'Failed' }, { id: 'allowed', label: 'Allowed' }];
/** Same list and order as the web's Settings > Activity (web/src/components/config/ActivitySection.tsx). */
const STARTERS: { id: ActivityStarter | 'unwatched' | ''; label: string }[] = [
  { id: '', label: 'Anyone' },
  { id: 'unwatched', label: 'Nobody watching' },
  { id: 'person', label: 'A person' },
  { id: 'routine', label: 'A routine' },
  { id: 'goal', label: 'A check-in' },
  { id: 'handoff', label: 'Another bot' },
  { id: 'script', label: 'A script' },
  { id: 'self', label: 'On its own' },
  { id: 'memory', label: 'A memory import' },
  { id: 'system', label: 'The app' },
];
const OUTCOME_TEXT: Record<ActivityOutcome, string> = { allowed: 'Allowed', refused: 'Refused', failed: 'Failed' };

const when = (t: number) => {
  const d = new Date(t), today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
};
/** The line under the title, as the web writes it (ActivitySection.tsx activitySub). */
const sub = (r: ActivityRow) => [r.botName, r.forName && r.forName !== r.by.name ? `for ${r.forName}` : null, r.by.phrase, r.how].filter(Boolean).join(' · ');

function Badge({ text, tone }: { text: string; tone: 'good' | 'problem' | 'warn' | 'plain' }) {
  const fill = tone === 'good' ? color.fill : tone === 'problem' ? color.problemFill : tone === 'warn' ? color.alertFill : color.fill;
  const ink = tone === 'good' ? color.goodInk : tone === 'problem' ? color.problemInk : tone === 'warn' ? color.warnInk : color.inkSecondary;
  return <View style={{ backgroundColor: fill, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}><Text style={{ color: ink, fontSize: 12, fontWeight: '600' }}>{text}</Text></View>;
}

function Row({ r }: { r: ActivityRow }) {
  return (
    <View accessible accessibilityLabel={`${OUTCOME_TEXT[r.outcome]}${r.by.unwatched ? ', nobody watching' : ''}: ${r.title}. ${sub(r)}. ${when(r.at)}`}
      style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: color.hairline, gap: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Badge text={OUTCOME_TEXT[r.outcome]} tone={r.outcome === 'allowed' ? 'good' : r.outcome === 'refused' ? 'problem' : 'warn'} />
        {r.by.unwatched && <Badge text="Nobody watching" tone="plain" />}
        <Text style={[type.caption, { marginLeft: 'auto', fontSize: 12 }]}>{when(r.at)}</Text>
      </View>
      <Text style={[type.body, { fontWeight: '500' }]}>{r.title}</Text>
      <Text style={[type.caption, { fontSize: 13, lineHeight: 18 }]}>{sub(r)}</Text>
      {!!r.detail && <Text selectable style={[type.caption, { fontSize: 12, lineHeight: 17, fontFamily: Platform.OS === 'android' ? 'monospace' : undefined }]}>{r.detail}</Text>}
    </View>
  );
}

/** Save the CSV through Android's share sheet (Files, Drive, …), the way Download my data does (exportData.ts). */
async function saveCsv(name: string, csv: string) {
  if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) { await Share.share({ message: csv.slice(0, 100_000), title: name }); return; }
  const file = new FsFile(Paths.cache, name);
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  file.write(csv);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'Save the activity' });
}

/**
 * Everything the bots were allowed, refused or failed to do, and what started it: the web's
 * Settings > Activity on the phone. "Nobody watching" is the first filter; the download is noted in the list.
 */
export function Activity({ api, onBack }: { api: Client; onBack: () => void }) {
  const [f, setF] = useState<ActivityFilter>({});
  const [q, setQ] = useState('');
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [again, setAgain] = useState(0);
  const [more, setMore] = useState(false);
  const [picker, setPicker] = useState<'by' | 'bot' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.q === (q.trim() || undefined) ? x : { ...x, q: q.trim() || undefined })), 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let live = true;
    setError(null);
    api.activity(f).then((r) => { if (live) setPage(r); }).catch((e: any) => { if (!live) return; if (e instanceof ApiError && e.status === 403) setDenied(true); else setError(e?.message ?? 'The server did not answer.'); });
    return () => { live = false; };
  }, [api, f, again]);

  const set = (patch: Partial<ActivityFilter>) => setF((x) => ({ ...x, ...patch, before: undefined }));
  const older = async () => {
    if (!page?.more || more) return;
    setMore(true);
    try { const next = await api.activity({ ...f, before: page.rows[page.rows.length - 1].id }); setPage({ ...next, rows: [...page.rows, ...next.rows] }); } catch { /* the button stays */ } finally { setMore(false); }
  };
  const download = async () => {
    setSaving(true);
    setNote(null);
    try {
      const r = await api.activityExport(f);
      await saveCsv(r.filename, r.csv);
      setNote(r.truncated ? `Saved the newest ${r.rows.toLocaleString()} rows only. Narrow the filter to get the rest.` : `Saved ${r.rows.toLocaleString()} ${r.rows === 1 ? 'row' : 'rows'}. The download is noted in this list.`);
      setAgain((n) => n + 1);
    } catch (e: any) { setNote(e?.message ?? 'Could not save.'); } finally { setSaving(false); }
  };
  const byLabel = STARTERS.find((s) => s.id === (f.by ?? ''))?.label ?? 'Anyone';
  const botLabel = f.botId ? page?.bots.find((b) => b.id === f.botId)?.name ?? 'One bot' : 'Every bot';

  const head = (
    <View style={{ padding: 16, paddingBottom: 8, gap: 12 }}>
      <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21 }]}>Everything your bots were allowed, refused or failed to do, and what started it. Kept for 180 days.</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {OUTCOMES.map((o) => <Chip key={o.id} title={`${o.label}${page && o.id ? ` ${page.counts[o.id].toLocaleString()}` : ''}`} selected={(f.outcome ?? '') === o.id} onPress={() => set({ outcome: (o.id || undefined) as ActivityOutcome | undefined })} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip title={`Nobody watching${page ? ` ${page.counts.unwatched.toLocaleString()}` : ''}`} selected={f.by === 'unwatched'} onPress={() => set({ by: f.by === 'unwatched' ? undefined : 'unwatched' })} />
        <Chip title={`Started by: ${byLabel.toLowerCase()} ▾`} selected={!!f.by && f.by !== 'unwatched'} onPress={() => setPicker('by')} />
        <Chip title={`${botLabel} ▾`} selected={!!f.botId} onPress={() => setPicker('bot')} />
        <Chip title="Look-only steps" selected={!!f.looks} onPress={() => set({ looks: f.looks ? undefined : true })} />
      </View>
      <TextInput value={q} onChangeText={setQ} placeholder="Search" placeholderTextColor={color.inkMuted} accessibilityLabel="Search the activity" returnKeyType="search"
        style={{ backgroundColor: color.fill, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: color.ink }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <PillButton title={saving ? 'Saving…' : 'Download as a spreadsheet'} kind="secondary" icon="download" disabled={saving} onPress={download} />
      </View>
      {!!note && <Text style={[type.caption, { fontSize: 13 }]}>{note}</Text>}
      {!!error && (
        <View style={{ gap: 8 }}>
          <Notice tone="problem">Couldn't load the activity: {error}</Notice>
          <PillButton title="Try again" kind="secondary" onPress={() => setAgain((n) => n + 1)} />
        </View>
      )}
      {!page && !error && <Text style={[type.caption, { textAlign: 'center', padding: 24 }]}>Loading…</Text>}
      {page && !page.rows.length && <Notice>{f.by === 'unwatched' ? 'Nothing ran while nobody was watching.' : 'Nothing here yet.'}</Notice>}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Activity</HeaderTitle>
      </Header>
      {denied ? <View style={{ padding: 16 }}><Notice>Only the owner of this server can see the bots' activity.</Notice></View> : (
        <FlatList
          data={page?.rows ?? []}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => <Row r={item} />}
          ListHeaderComponent={head}
          onEndReachedThreshold={0.4}
          onEndReached={older}
          ListFooterComponent={page?.more ? <Pressable onPress={older} style={{ padding: 18, alignItems: 'center' }}><Text style={[type.caption, { color: color.link }]}>{more ? 'Loading…' : 'Show older'}</Text></Pressable> : <View style={{ height: 32 }} />}
          keyboardShouldPersistTaps="handled"
        />
      )}
      <Sheet visible={picker !== null} onClose={() => setPicker(null)} title={picker === 'by' ? 'Started by' : 'Bot'}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 4 }}>
          {picker === 'by' && STARTERS.map((s) => <Chip key={s.id} onCard title={s.label} selected={(f.by ?? '') === s.id} onPress={() => { set({ by: (s.id || undefined) as ActivityFilter['by'] }); setPicker(null); }} />)}
          {picker === 'bot' && [{ id: '', name: 'Every bot' }, ...(page?.bots ?? [])].map((b) => <Chip key={b.id} onCard title={b.name} selected={(f.botId ?? '') === b.id} onPress={() => { set({ botId: b.id || undefined }); setPicker(null); }} />)}
        </View>
      </Sheet>
    </View>
  );
}
