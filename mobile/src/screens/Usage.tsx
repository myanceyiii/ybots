import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { ApiError, type Client, type UsageCounts, type UsageReport } from '../api';
import { Chip, Header, HeaderTitle, Notice, PillButton, RoundButton } from '../components/ui';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '../pageChart';
import { color, currentScheme, type } from '../theme';
import { Card, Section } from './BotSettings';

const RANGES = [{ days: 7, label: '7 days' }, { days: 14, label: '14 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
const big = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const tokens = (c: UsageCounts) => (c.inputTokens + c.outputTokens ? `${big(c.inputTokens)} in, ${big(c.outputTokens)} out` : 'tokens not reported');
const failedText = (c: UsageCounts) => (c.failed ? ` · ${c.failed} failed` : '');
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
};

function Tile({ n, label, warn }: { n: string; label: string; warn?: boolean }) {
  return (
    <View accessible accessibilityLabel={`${n} ${label}`} style={{ flexGrow: 1, flexBasis: '45%', backgroundColor: color.fill, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16 }}>
      <Text style={{ fontSize: 24, fontWeight: '600', color: warn ? color.warnInk : color.ink }}>{n}</Text>
      <Text style={[type.caption, { fontSize: 13 }]}>{label}</Text>
    </View>
  );
}

/** One row with a count on the right and a thin bar showing its share of the largest. */
function CountRow({ title, detail, count, share, last }: { title: string; detail: string; count: number; share?: number; last?: boolean }) {
  return (
    <View accessible style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
        <Text style={[type.caption, { fontSize: 13, lineHeight: 18 }]}>{detail}</Text>
        {share !== undefined && <View style={{ height: 4, borderRadius: 2, backgroundColor: color.hairline, marginTop: 3 }}><View style={{ height: 4, borderRadius: 2, width: `${Math.max(2, Math.round(share * 100))}%`, backgroundColor: color.primary }} /></View>}
      </View>
      <Text style={[type.body, { fontWeight: '600', fontVariant: ['tabular-nums'] }]}>{count.toLocaleString()}</Text>
    </View>
  );
}

/**
 * How much the bots have been working, as the web's Settings › Usage: replies and tokens per day, per bot
 * and per model. Counts only: the app does not know what a provider charges.
 */
export function Usage({ api, onBack }: { api: Client; onBack: () => void }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [again, setAgain] = useState(0);
  const { width } = useWindowDimensions();
  const w = Math.min(width, 640) - 32;
  useEffect(() => {
    let live = true;
    setError(null);
    api.usage(days).then((r) => { if (live) setData(r); }).catch((e: any) => { if (!live) return; if (e instanceof ApiError && e.status === 403) setDenied(true); else setError(e?.message ?? 'The server did not answer.'); });
    return () => { live = false; };
  }, [api, days, again]);
  const dark = currentScheme() === 'dark';
  const svg = useMemo(() => {
    if (!data || !data.totals.turns) return null;
    // Every nth day is named, so the labels never run into each other on a phone.
    const step = Math.ceil(data.byDay.length / 6);
    const block = { chart: 'bar', labels: data.byDay.map((d, i) => (i % step === 0 ? dayLabel(d.day) : '')), series: [{ name: 'Replies', values: data.byDay.map((d) => d.turns) }] };
    return chartSvg(block, { blocks: [] }, 480, 260, dark ? CHART_DARK : CHART_LIGHT);
  }, [data, dark]);
  const busiest = data?.byDay.reduce((a, d) => (d.turns > a.turns ? d : a), data.byDay[0]);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Usage</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {denied ? <Notice>Only the owner of this server can see how much the bots are used.</Notice> : (
          <>
            <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21, marginBottom: 14 }]}>How much your bots have been working. Counted from every reply; kept for 90 days.</Text>
            <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
              {RANGES.map((r) => <Chip key={r.days} title={r.label} selected={days === r.days} onPress={() => setDays(r.days)} />)}
            </View>
            {!!error && (
              <View style={{ marginBottom: 14, gap: 8 }}>
                <Notice tone="problem">Couldn't load the numbers: {error}</Notice>
                <PillButton title="Try again" kind="secondary" onPress={() => setAgain((n) => n + 1)} />
              </View>
            )}
            {!data && !error && <Text style={[type.caption, { textAlign: 'center', padding: 24 }]}>Counting…</Text>}
            {data && (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 22, opacity: data.days === days ? 1 : 0.5 }}>
                  <Tile n={data.totals.turns.toLocaleString()} label="replies" />
                  <Tile n={big(data.totals.inputTokens)} label="tokens read" />
                  <Tile n={big(data.totals.outputTokens)} label="tokens written" />
                  <Tile n={data.totals.failed.toLocaleString()} label="failed" warn={data.totals.failed > 0} />
                </View>
                {data.totals.turns === 0 ? <Notice>No replies in this period.</Notice> : (
                  <>
                    <Section title="Replies per day" hint={busiest && busiest.turns > 0 ? `Busiest day: ${dayLabel(busiest.day)}, ${busiest.turns} ${busiest.turns === 1 ? 'reply' : 'replies'}.` : undefined}>
                      {svg && (
                        <View accessible accessibilityRole="image" accessibilityLabel={`Replies per day over ${data.days} days${busiest ? `; the busiest was ${dayLabel(busiest.day)} with ${busiest.turns}` : ''}`}
                          style={{ borderRadius: 18, overflow: 'hidden', backgroundColor: color.fill }}>
                          <SvgXml xml={svg} width={w} height={(w * 260) / 480} />
                        </View>
                      )}
                    </Section>
                    <Section title="By bot">
                      <Card>
                        {data.byBot.map((b, i) => (
                          <CountRow key={b.botId} title={b.name} count={b.turns} share={b.turns / Math.max(1, data.byBot[0].turns)} last={i === data.byBot.length - 1}
                            detail={`${tokens(b)}${b.topModel ? ` · mostly ${b.topModel}` : ''}${b.lastAt ? ` · last reply ${ago(b.lastAt)}` : ''}${failedText(b)}`} />
                        ))}
                      </Card>
                    </Section>
                    <Section title="By model" hint="Side chats and helpers count for the bot they belong to. What each provider charges is on its own billing page.">
                      <Card>
                        {data.byModel.map((m, i) => (
                          <CountRow key={`${m.provider}/${m.model}`} title={m.model} count={m.turns} last={i === data.byModel.length - 1} detail={`${m.provider ? `${m.provider} · ` : ''}${tokens(m)}${failedText(m)}`} />
                        ))}
                      </Card>
                    </Section>
                  </>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
