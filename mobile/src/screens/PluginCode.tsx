import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import type { Client, DraftFiles } from '../api';
import { Chip, Header, HeaderTitle, Notice, RoundButton } from '../components/ui';
import { color, type } from '../theme';

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * The code a Bot wrote for a plugin, as the server checked it, to read before tapping Install. Read
 * only. Same content as the web and Windows apps' code view; long lines scroll sideways.
 */
export function PluginCode({ api, draftId, onBack }: { api: Client; draftId: string; onBack: () => void }) {
  const [data, setData] = useState<DraftFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    api.pluginCode(draftId).then((d) => { setData(d); setFile(d.files.find((f) => f.path === 'index.mjs')?.path ?? d.files[0]?.path ?? null); })
      .catch((e: any) => setError(e?.message ?? 'Couldn’t load the code.'));
  }, [api, draftId]);
  const shown = data?.files.find((f) => f.path === file);
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{data ? data.title : 'The code'}</HeaderTitle>
      </Header>
      <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 8 }}>
        {error && <Notice tone="problem">{error}</Notice>}
        {!data && !error && <ActivityIndicator color={color.ink} />}
        {data?.digest ? (
          <Text style={[type.caption, { fontSize: 13, color: data.matches ? color.inkMuted : color.problemInk }]}>
            Fingerprint {data.digest.slice(0, 16)} · {data.matches ? 'matches the review card' : 'does NOT match the review card; don’t install'}
          </Text>
        ) : data ? <Text style={[type.caption, { fontSize: 13 }]}>Not ready for review yet ({data.status}).</Text> : null}
        {data && !data.files.length && <Notice tone="note">The Bot hasn’t sent any files yet.</Notice>}
        {!!data?.files.length && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {data.files.map((f) => <Chip key={f.path} title={`${f.path} · ${f.kit ? 'server kit' : kb(f.size)}`} selected={f.path === file} onPress={() => setFile(f.path)} />)}
          </ScrollView>
        )}
      </View>
      {shown && (
        <ScrollView style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 16, backgroundColor: color.fill }} contentContainerStyle={{ padding: 12 }}>
          {shown.kit ? (
            <Text style={[type.caption, { fontSize: 14 }]}>This is YBots’s own plugin kit. The server adds the same file to every made plugin; the Bot didn’t write it.</Text>
          ) : shown.text === null ? (
            <Text style={[type.caption, { fontSize: 14 }]}>Too large to show here ({kb(shown.size)}).</Text>
          ) : (
            <ScrollView horizontal>
              <Text selectable style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19, color: color.ink }}>{shown.text}</Text>
            </ScrollView>
          )}
        </ScrollView>
      )}
    </View>
  );
}
