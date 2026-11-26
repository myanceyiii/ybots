import { useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import type { Bot, Client, PluginChange, PluginDraft, PluginInfo, PluginSetting } from '../api';
import { Chip, Field, ListGroup, Notice, PillButton } from '../components/ui';
import { color, type } from '../theme';

const DRAFT_STATUS: Record<string, string> = { planned: 'Plan waiting for your Build', building: 'Being built', checking: 'Being checked', checked: 'Ready for your review', failed: 'Checks failed; the Bot was told what to fix', installed: 'Installed', rejected: 'Not installed', removed: 'Removed' };
const HAS_CODE = new Set(['checked', 'failed', 'installed', 'rejected', 'removed']);
export const label = () => ({ fontSize: 13, fontWeight: '700' as const, letterSpacing: 0.7, textTransform: 'uppercase' as const, color: color.inkMuted, marginLeft: 4 });

export function DraftsList({ drafts, onOpenChat, onCode }: { drafts: PluginDraft[]; onOpenChat: (botId: string) => void; onCode: (draftId: string) => void }) {
  const waiting = drafts.filter((d) => d.status === 'planned' || d.status === 'checked');
  return (
    <View style={{ gap: 8 }}>
      <Text style={label()}>Plugins made with a bot{waiting.length ? ` · ${waiting.length} waiting on you` : ''}</Text>
      <ListGroup>
        {drafts.map((d, i) => (
          <View key={d.id} style={{ padding: 14, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: color.surface }}>
            <Text style={[type.body, { fontWeight: '600' }]}>{d.title}</Text>
            <Text style={[type.caption, { fontSize: 13, color: d.status === 'checked' || d.status === 'planned' ? color.link : color.inkMuted }]}>{d.botName} · {DRAFT_STATUS[d.status] ?? d.status}</Text>
            <Text style={[type.caption, { fontSize: 13 }]}>{d.tools.map((t) => `${t.name}${t.writes ? ' (changes things)' : ''}`).join(', ')} · {d.network.length ? `talks to ${d.network.join(', ')}` : 'no network'}</Text>
            {d.checks?.some((c) => !c.ok) && <Text style={[type.caption, { fontSize: 13, color: color.problemInk }]}>{d.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' · ')}</Text>}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {HAS_CODE.has(d.status) && <PillButton title="View code" kind="secondary" onPress={() => onCode(d.id)} />}
              <PillButton title={d.status === 'planned' ? 'Review plan' : d.status === 'checked' ? 'Review and install' : 'Open chat'} kind={d.status === 'planned' || d.status === 'checked' ? 'primary' : 'secondary'} onPress={() => onOpenChat(d.botId)} />
            </View>
          </View>
        ))}
      </ListGroup>
      <Text style={[type.caption, { fontSize: 13, marginLeft: 4 }]}>Build and Install are on the cards in each bot’s chat, so you tap them next to what the bot said.</Text>
    </View>
  );
}

/** Install a plugin from npm by exact version. Proposed first; it arrives switched off. */
export function NpmInstall({ busy, onCheck }: { busy: boolean; onCheck: (spec: string) => void }) {
  const [spec, setSpec] = useState('');
  return (
    <View style={{ gap: 10 }}>
      <Field value={spec} onChangeText={setSpec} placeholder="package-name@1.2.3" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Package and exact version" returnKeyType="go" onSubmitEditing={() => { if (!busy && spec.trim()) onCheck(spec.trim()); }} />
      <Text style={[type.caption, { fontSize: 13 }]}>Checked before anything is installed: exact version, no install scripts, pinned dependencies. It arrives switched off.</Text>
      <View style={{ alignSelf: 'flex-start' }}><PillButton title="Check" kind="secondary" disabled={busy || !spec.trim()} onPress={() => onCheck(spec.trim())} /></View>
    </View>
  );
}

/** Pick a Bot and say what the plugin should do. It goes into that Bot's chat as your message. */
export function CreatePlugin({ api, bots, onCancel, onSent }: { api: Client; bots: Bot[]; onCancel: () => void; onSent: (botId: string) => void }) {
  const builders = bots.filter((b) => b.kind !== 'room' && !b.outside);
  const [botId, setBotId] = useState(() => (builders.find((b) => (b as any).isPrimary) ?? builders[0])?.id ?? '');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try { const r = await api.createPlugin(botId, idea.trim()); onSent(r.botId); } catch (e: any) { setError(e?.message ?? 'Couldn’t send that.'); } finally { setBusy(false); }
  };
  return (
    <ListGroup style={{ padding: 16, gap: 12 }}>
      <Text style={[type.body, { fontWeight: '600' }]}>Create plugin</Text>
      <Text style={[type.caption, { fontSize: 13 }]}>Who builds it? The Bot plans it in its chat. It can’t install anything.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {builders.map((b) => <Chip key={b.id} title={b.name} selected={b.id === botId} onPress={() => setBotId(b.id)} />)}
      </View>
      <Text style={[type.caption, { fontSize: 13 }]}>What should it do?</Text>
      <TextInput value={idea} onChangeText={setIdea} multiline maxLength={2000} accessibilityLabel="What should it do?"
        placeholder="For example: look up the weather for a city." placeholderTextColor={color.timestamp}
        style={{ minHeight: 110, borderRadius: 18, backgroundColor: color.fill, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: color.ink, textAlignVertical: 'top' }} />
      <Text style={[type.caption, { fontSize: 13 }]}>Next: a plan card in the chat → you tap Build → the server checks the code in a sandbox → you read the code and permissions → you tap Install. It arrives switched off unless you pick Bots on that card. Plugins can never answer approvals.</Text>
      {error && <Notice tone="problem">{error}</Notice>}
      <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
        <PillButton title="Cancel" kind="secondary" disabled={busy} onPress={onCancel} />
        <PillButton title={busy ? 'Sending…' : 'Ask for a plan'} disabled={busy || !botId || idea.trim().length < 8} onPress={send} />
      </View>
    </ListGroup>
  );
}

export function ConfirmCard({ change, busy, onCancel, onConfirm }: { change: PluginChange; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const del = change.action === 'delete';
  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, padding: 16, gap: 10, borderWidth: 1, borderColor: del ? color.problemInk : color.ink }}>
      <Text style={[type.body, { fontWeight: '600' }]}>{change.summary}?</Text>
      {change.details.map((d) => <Text key={d} style={[type.caption, { fontSize: 13 }]}>• {d}</Text>)}
      <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
        <PillButton title="Cancel" kind="secondary" onPress={onCancel} />
        <PillButton title={busy ? 'Working…' : del ? 'Delete' : 'Confirm'} disabled={busy} onPress={onConfirm} />
      </View>
    </View>
  );
}

export function SettingsForm({ api, p, onSaved }: { api: Client; p: Pick<PluginInfo, 'id' | 'settings' | 'values'>; onSaved: () => void }) {
  const fields = p.settings ?? [];
  const values = p.values ?? {};
  const [vals, setVals] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, typeof values[f.key] === 'object' ? '' : (values[f.key] ?? (f.type === 'boolean' ? false : ''))])));
  const [note, setNote] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setVals((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setNote(null);
    try {
      // A number left half-typed ("1.", "-") is sent as the number it is, or left out.
      const out = Object.fromEntries(Object.entries(vals).map(([k, v]) => (fields.find((f) => f.key === k)?.type === 'number' && typeof v === 'string' ? [k, v === '' || Number.isNaN(Number(v)) ? '' : Number(v)] : [k, v])));
      await api.savePluginSettings(p.id, out); setNote('Saved. The plugin restarts with these settings.'); onSaved(); } catch (e: any) { setNote(e?.message ?? 'Couldn’t save.'); }
  };
  const input = (f: PluginSetting) => {
    switch (f.type) {
      case 'boolean': return <Switch value={vals[f.key] === true} onValueChange={(v) => set(f.key, v)} accessibilityLabel={f.label} />;
      case 'select': return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{f.options.map((o) => <Chip key={o.value} title={o.label} selected={vals[f.key] === o.value} onPress={() => set(f.key, o.value)} />)}</View>;
      case 'number': return <Field keyboardType="numeric" value={String(vals[f.key] ?? '')} onChangeText={(t) => { const c = t.replace(/[^0-9.-]/g, ''); /* Half-typed numbers ("1.", "-") stay as typed; they used to turn into NaN or lose the point. */ set(f.key, c === '' || c === '-' || c.endsWith('.') || Number.isNaN(Number(c)) ? c : Number(c)); }} accessibilityLabel={f.label} />;
      case 'secret': return <Field secureTextEntry autoCapitalize="none" autoCorrect={false} value={String(vals[f.key] ?? '')} onChangeText={(t) => set(f.key, t)} accessibilityLabel={f.label}
        placeholder={(values[f.key] as { set?: boolean } | undefined)?.set ? 'Saved (leave blank to keep)' : ''} />;
      default: return <Field value={String(vals[f.key] ?? '')} onChangeText={(t) => set(f.key, t)} placeholder={f.placeholder} accessibilityLabel={f.label} />;
    }
  };
  return (
    <View style={{ padding: 14, gap: 10, borderTopWidth: 1, borderTopColor: color.surface }}>
      <Text style={[type.body, { fontWeight: '600' }]}>Settings</Text>
      {fields.map((f) => (
        <View key={f.key} style={{ gap: 6 }}>
          <Text style={type.body}>{f.label}</Text>
          {!!f.help && <Text style={[type.caption, { fontSize: 12 }]}>{f.help}</Text>}
          {input(f)}
        </View>
      ))}
      {note && <Text style={[type.caption, { fontSize: 13 }]}>{note}</Text>}
      <View style={{ alignSelf: 'flex-start' }}><PillButton title="Save settings" onPress={save} /></View>
    </View>
  );
}
