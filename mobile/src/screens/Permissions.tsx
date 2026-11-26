import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import type { AllowRule, AllowRuleUse, Client, FreeRunBot } from '../api';
import { Header, HeaderTitle, Notice, RoundButton, refreshLook, PillButton } from '../components/ui';
import { color, type } from '../theme';
import { Card, Row, Section, SmallButton } from './BotSettings';

/** The risky classes in server/src/allow-rules.ts, as the web's Permissions list names them. */
const RISK_TEXT: Record<string, string> = {
  shell: 'Can run commands or code', files: 'Can write or change files', delete: 'Can delete things', message: 'Can send messages or mail',
  money: 'Can move money or change the budget', host: 'Can change a server or PC', install: 'Can install software',
  browser: 'Can click and type on websites', computer: 'Can control a computer', schedule: 'Can set up work that runs later',
};

/** A tool's slug as an app and an action, as the web shows it (AppSettings.tsx humanizeTool). */
function humanizeTool(slug: string): { app: string; action: string } {
  const [app, ...rest] = slug.split('__');
  if (rest.length) return { app, action: rest.join('__').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) };
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
};
/**
 * The owner's master switch for the maintainer bot (Howard): every terminal command runs without a card
 * (server/src/maintainer-guard.ts, "free-run"), as on the web. Renders nothing for other bots.
 */
export function FreeRunSection({ api, botId, compact }: { api: Client; botId?: string; compact?: boolean }) {
  const [bots, setBots] = useState<FreeRunBot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.allowRules(botId).then((r) => setBots(r.freeRun ?? [])).catch(() => setBots([])); }, [api, botId]);
  useEffect(() => { load(); }, [load]);
  if (!bots?.length) return null;
  const flip = async (b: FreeRunBot, on: boolean) => {
    setError(null);
    setBots((all) => all?.map((x) => (x.botId === b.botId ? { ...x, on } : x)) ?? null);
    try { await api.setFreeTerminal(b.botId, on); } catch (e: any) { setError(e?.message ?? 'Could not change it.'); }
    load();
  };
  return (
    <Section title="Terminal commands">
      {!!error && <View style={{ marginBottom: 10 }}><Notice tone="problem">{error}</Notice></View>}
      <Card>
        {bots.map((b, i) => (
          <Row key={b.botId} last={i === bots.length - 1}
            title={compact ? 'Run terminal commands without asking' : `${b.botName} runs terminal commands without asking`}
            detail={(b.on
              ? `On: every command, sudo and deploys included, goes ahead with no card. Each one is listed under Recently allowed and in the maintainer log. Output from secret files is hidden. Anything touching Sheldon's firm data still asks.`
              : `Off: ${b.botName} asks on a card before commands that change things. Looking around still runs.`) + (b.canChange ? '' : ' Only the owner can change this.')}
            right={<Switch value={b.on} disabled={!b.canChange} onValueChange={(v) => void flip(b, v)} accessibilityLabel={`${b.botName} runs terminal commands without asking`} />} />
        ))}
      </Card>
    </Section>
  );
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * What every bot may do without asking, as the web's Settings › Permissions: the "Always allow" rules
 * (Ask again removes one), what was recently allowed without asking, and the older per-tool choices.
 */
export function Permissions({ api, onBack }: { api: Client; onBack: () => void }) {
  const [data, setData] = useState<{ rules: AllowRule[]; log: AllowRuleUse[] } | null>(null);
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    // A list that could not be read says so. (It used to show "Nothing here yet", as if no bot had any rule.)
    await Promise.all([
      api.allowRules().then((r) => { setData(r); setLoadError(null); }).catch((e: any) => setLoadError(e?.message ?? 'The server did not answer.')),
      api.policies().then((r) => setPolicies(r.policies)).catch(() => {}),
    ]);
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const run = (p: Promise<unknown>) => { setError(null); p.then(load).catch((e: any) => setError(e?.message ?? 'Could not change it.')); };
  const rules = [...(data?.rules ?? [])].sort((a, b) => a.botName.localeCompare(b.botName));

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Permissions</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21, marginBottom: 16 }]}>
          What each bot may do without asking first. Remove one and that bot asks again next time.
        </Text>
        {!!error && <View style={{ marginBottom: 14 }}><Notice tone="problem">{error}</Notice></View>}
        {!!loadError && (
          <View style={{ marginBottom: 14, gap: 8 }}>
            <Notice tone="problem">Couldn't load the permissions: {loadError} {data ? 'What is below may be out of date.' : ''}</Notice>
            <PillButton title="Try again" kind="secondary" onPress={() => void load()} />
          </View>
        )}
        <FreeRunSection api={api} />
        <Section title="Always allowed" hint="Each rule covers one bot and one action. ⚠ marks rules that let that bot do something risky without asking, like running commands or sending messages. Sending an email always asks.">
          <Card>
            {data === null ? <Row title={loadError ? 'Not loaded' : 'Loading…'} last /> : rules.length === 0 ? (
              <Row title="Nothing here yet" detail="Choose “Always allow” on an approval and it shows up here, for that bot only." last />
            ) : rules.map((r, i) => (
              <Row key={r.id} title={`${r.botName} · ${r.label}`} last={i === rules.length - 1}
                detail={`${r.risk ? `⚠ ${RISK_TEXT[r.risk] ?? 'Risky action'}\n` : ''}Added by ${r.createdBy} on the ${r.createdVia}, ${when(r.createdAt)} · ${r.uses ? `used ${r.uses} time${r.uses === 1 ? '' : 's'}, last ${ago(r.lastUsedAt ?? r.createdAt)}` : 'not used yet'}`}
                right={<SmallButton title="Ask again" onPress={() => run(api.deleteAllowRule(r.id))} />} />
            ))}
          </Card>
        </Section>
        {!!data?.log.length && (
          <Section title="Recently allowed without asking">
            <Card>
              {data.log.slice(0, 15).map((u, i, all) => <Row key={u.id} title={`${u.botName} · ${u.label}`} detail={ago(u.at)} last={i === all.length - 1} />)}
            </Card>
          </Section>
        )}
        {policies.length > 0 && (
          <Section title="Older choices for every bot">
            <Card>
              {policies.map((p, i) => {
                const h = humanizeTool(p.tool);
                return (
                  <Row key={p.tool} title={`${h.app}${h.action ? ` · ${h.action}` : ''}`} last={i === policies.length - 1}
                    detail={`${p.mode === 'always_allow' ? 'Always allowed for every bot' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · ${p.tool}`}
                    right={<SmallButton title={p.mode === 'blocked' ? 'Remove' : 'Ask again'} onPress={() => run(api.deletePolicy(p.tool))} />} />
                );
              })}
            </Card>
          </Section>
        )}
      </ScrollView>
    </View>
  );
}
