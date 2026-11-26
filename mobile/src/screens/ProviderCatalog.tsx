import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { Client, EngineInfo, FallbackChoice, ProviderStatus } from '../api';
import { Chip, Notice, PillButton } from '../components/ui';
import { color, type } from '../theme';
import { Card, Row, Section, SmallButton } from './BotSettings';

const ACCESS: Record<ProviderStatus['access'], string> = {
  ready: 'Access ready', needs_key: 'No key', not_signed_in: 'Not signed in', off: 'Off for this bot', not_installed: 'Not installed', unknown: 'Access unknown',
};
const ROUTE: Record<ProviderStatus['route'], string> = { api_key: 'API key', subscription: 'Subscription', sign_in: 'Sign-in' };
const when = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : new Date(t).toLocaleDateString();
};
const SUB = 'claude-subscription-directsdk-experimental';

/**
 * Providers on the Model tab (same as the web's ProviderCatalog.tsx): the shared catalog with listed /
 * access / verified for this bot, Check (one real request from the bot's agent), the experimental
 * Claude subscription opt-in, and the explicit fallback chain.
 */
export function ProviderCatalog({ api, engine, onEngine, flash }: { api: Client; engine: EngineInfo; onEngine: (e: EngineInfo) => void; flash: (t: string, problem?: boolean) => void }) {
  const catalog = engine.catalog ?? [];
  const managed = !!engine.appManaged;
  const [checking, setChecking] = useState<string | null>(null);
  const [checkModel, setCheckModel] = useState<Record<string, string>>({});
  const [chain, setChain] = useState<FallbackChoice[]>(engine.fallbacks ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmSub, setConfirmSub] = useState(false);
  const [ack, setAck] = useState(false);
  useEffect(() => { setChain(engine.fallbacks ?? []); setConfirmSub(false); setAck(false); }, [engine.botId, JSON.stringify(engine.fallbacks ?? [])]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!catalog.length) return null;
  const usable = catalog.filter((p) => p.eligible && (p.id !== SUB || engine.subscriptionAllowed));
  const chainChanged = JSON.stringify(chain) !== JSON.stringify(engine.fallbacks ?? []);
  const modelFor = (p: ProviderStatus) => checkModel[p.id] ?? (engine.provider === p.id && engine.model ? engine.model : p.models[0] ?? '');

  const check = async (p: ProviderStatus) => {
    const model = modelFor(p).trim();
    if (!model || checking) return;
    setChecking(p.id);
    try { const r = await api.checkProvider(engine.botId, p.id, model); onEngine(r.engine); flash(r.result.ok ? `${p.name}: verified` : `${p.name}: ${r.result.detail}`, !r.result.ok); }
    catch (e: any) { flash(e?.message ?? 'The agent did not answer.', true); }
    finally { setChecking(null); }
  };
  const save = async (patch: Parameters<Client['setEngine']>[1], done: string) => {
    if (busy) return;
    setBusy(true);
    try { const r = await api.setEngine(engine.botId, patch); onEngine(r.engine); setConfirmSub(false); setAck(false); flash(done); }
    catch (e: any) { flash(e?.message ?? 'The agent did not answer.', true); }
    finally { setBusy(false); }
  };
  const setEntry = (i: number, patch: Partial<FallbackChoice>) => setChain((c) => c.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <View>
      <Section title="Providers" hint={`Listed: the app offers it. Access: ${managed ? 'this bot’s' : 'the'} agent has a key or login. Verified: a real request from its agent got an answer.${managed ? '' : ' This agent’s setup is its own; the app shows it but does not change it.'}`}>
        <View style={{ gap: 10 }}>
          {catalog.map((p) => {
            const v = p.verified;
            const canCheck = p.eligible && p.access !== 'off' && p.access !== 'not_installed';
            return (
              <View key={p.id} style={{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 8, borderLeftWidth: p.experimental ? 4 : 0, borderLeftColor: color.link }}>
                <View>
                  <Text style={[type.body, { fontWeight: '600' }]}>{p.name}</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>{ROUTE[p.route]}{p.experimental ? ' · Experimental' : ''}{p.source === 'agent' ? ' · from this agent’s config' : ''}{engine.provider === p.id ? ' · Default' : ''}</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Fact text="Listed" tone="on" />
                  <Fact text={ACCESS[p.access]} tone={p.access === 'ready' ? 'on' : p.access === 'unknown' ? 'plain' : 'off'} />
                  <Fact text={v ? `${v.ok ? 'Verified' : 'Check failed'} ${when(v.at)} · ${v.model}` : 'Not verified'} tone={v?.ok ? 'on' : v ? 'bad' : 'plain'} />
                </View>
                <Text style={[type.caption, { fontSize: 13 }]}>{p.accessNote}{p.lastTurn ? ` Last chat turn on it: ${p.lastTurn.model ?? 'default'} ${when(p.lastTurn.at)}${p.lastTurn.ok ? '' : ', failed'}.` : ''}</Text>
                {!!v && !v.ok && !!v.detail && <Text style={{ fontSize: 13, color: color.danger }}>{v.detail}</Text>}
                <Text style={[type.caption, { fontSize: 12 }]}>{p.billing}</Text>
                {canCheck && (
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <TextInput value={modelFor(p)} onChangeText={(t) => setCheckModel((m) => ({ ...m, [p.id]: t }))} autoCapitalize="none" autoCorrect={false} placeholder="Model id" placeholderTextColor={color.timestamp}
                      accessibilityLabel={`Model to check on ${p.name}`} style={{ flex: 1, borderRadius: 14, backgroundColor: color.surface, paddingHorizontal: 12, paddingVertical: 8, fontFamily: 'monospace', fontSize: 14, color: color.ink }} />
                    <SmallButton title={checking === p.id ? 'Checking…' : 'Check'} disabled={!!checking || !modelFor(p).trim()} onPress={() => check(p)} />
                  </View>
                )}
                {p.optIn && managed && (
                  <View style={{ gap: 8 }}>
                    {!!p.warning && <Notice>{p.warning}</Notice>}
                    {engine.subscriptionAllowed ? (
                      <PillButton title="Switch off for this bot" kind="secondary" disabled={busy} onPress={() => save({ allowSubscription: false }, 'Switched off')} />
                    ) : !confirmSub ? (
                      <PillButton title="Switch on for this bot…" kind="secondary" disabled={busy} onPress={() => setConfirmSub(true)} />
                    ) : (
                      <View style={{ gap: 8 }}>
                        <Card>
                          <Row title="I understand the warning above" detail="and want this bot to be able to use my Claude subscription." last right={<Switch value={ack} onValueChange={setAck} />} />
                        </Card>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                          <PillButton title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => { setConfirmSub(false); setAck(false); }} />
                          <PillButton title={busy ? 'Saving…' : 'Switch on'} style={{ flex: 1 }} disabled={!ack || busy} onPress={() => save({ allowSubscription: true, acknowledgeSubscriptionTerms: true }, 'Switched on')} />
                        </View>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </Section>

      {managed && (
        <Section title="Fallbacks" hint={chain.length
          ? 'If the default fails (out of credit, limit reached, down), the agent tries these in order for that turn, then goes back to the default.'
          : `None. If ${engine.model ?? 'the default model'} fails, the turn fails; nothing else is tried or billed.`}>
          <View style={{ gap: 10 }}>
            {chain.map((f, i) => {
              const p = usable.find((x) => x.id === f.provider);
              return (
                <View key={i} style={{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 8 }}>
                  <Text style={[type.body, { fontWeight: '600' }]}>{i + 1}. {p?.name ?? f.provider}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {usable.map((x) => <Chip key={x.id} onCard title={x.name} selected={x.id === f.provider} onPress={() => setEntry(i, { provider: x.id, model: x.models[0] ?? '' })} />)}
                  </View>
                  <TextInput value={f.model} onChangeText={(t) => setEntry(i, { model: t })} autoCapitalize="none" autoCorrect={false} placeholder={p?.models[0] ?? 'Model id'} placeholderTextColor={color.timestamp}
                    accessibilityLabel={`Fallback ${i + 1} model`} style={{ borderRadius: 14, backgroundColor: color.surface, paddingHorizontal: 12, paddingVertical: 8, fontFamily: 'monospace', fontSize: 14, color: color.ink }} />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {i > 0 && <SmallButton title="Move up" onPress={() => setChain((c) => { const n = [...c]; const [x] = n.splice(i, 1); n.splice(i - 1, 0, x); return n; })} />}
                    <SmallButton title="Remove" danger onPress={() => setChain((c) => c.filter((_, j) => j !== i))} />
                  </View>
                </View>
              );
            })}
            {chain.length < 3 && usable.length > 0 && (
              <PillButton title="Add a fallback" kind="secondary" onPress={() => setChain((c) => [...c, { provider: usable[0].id, model: usable[0].models[0] ?? '' }])} />
            )}
            {chainChanged && (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <PillButton title="Undo" kind="secondary" style={{ flex: 1 }} onPress={() => setChain(engine.fallbacks ?? [])} />
                <PillButton title={busy ? 'Saving…' : 'Save fallbacks'} style={{ flex: 1 }} disabled={busy || chain.some((f) => !f.model.trim())}
                  onPress={() => save({ fallbacks: chain.map((f) => ({ provider: f.provider, model: f.model.trim() })) }, 'Fallbacks saved')} />
              </View>
            )}
          </View>
        </Section>
      )}
    </View>
  );
}

function Fact({ text, tone }: { text: string; tone: 'on' | 'off' | 'bad' | 'plain' }) {
  const c = tone === 'on' ? color.ink : tone === 'bad' ? color.danger : color.inkMuted;
  return (
    <Pressable accessible accessibilityLabel={text} style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: c }}>
      <Text style={{ fontSize: 12, color: c }}>{text}</Text>
    </Pressable>
  );
}
