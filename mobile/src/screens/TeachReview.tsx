import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, View } from 'react-native';
import type { Bot, Client, TeachDraft, TeachState } from '../api';
import { Icon } from '../components/Icon';
import { Field, Header, HeaderTitle, Label, Notice, PillButton, RoundButton } from '../components/ui';
import { color, type } from '../theme';
import { toast } from '../toast';

/** How often the screen asks again while a recording runs or its skill is being written. */
const POLL_MS = 1500;

/** The bot's Teach a bot state (server/src/teach.ts), kept fresh while a recording runs or is being written up. */
export function useTeach(api: Client, botId: string) {
  const [state, setState] = useState<TeachState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try { const s = await api.teach(botId); if (alive.current) { setState(s); setError(null); } } catch (e: any) { if (alive.current) setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api, botId]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  const status = state?.recording?.status;
  useEffect(() => {
    if (status !== 'recording' && status !== 'drafting') return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [status, refresh]);
  return { state, setState, error, setError, refresh };
}

/**
 * Review what you showed a bot, as on the web (web/src/components/TeachReview.tsx): the steps recorded in its
 * browser (passwords and codes never recorded), the skill the bot wrote from them, editable, and Save, Write
 * again (without the steps you took out) or Discard.
 */
export function TeachReview({ api, bot, onBack }: { api: Client; bot: Bot; onBack: () => void }) {
  const { state, setState, error, setError } = useTeach(api, bot.id);
  const rec = state?.recording ?? null;
  const [draft, setDraft] = useState<TeachDraft | null>(null);
  const [drop, setDrop] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'save' | 'redraft' | 'discard' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const name = bot.name;

  const draftKey = rec?.draft ? `${rec.id}:${rec.draft.name}:${rec.draft.body.length}:${rec.status}` : '';
  useEffect(() => { if (rec?.draft) setDraft({ ...rec.draft }); }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (rec) setNote(rec.note); }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (kind: 'save' | 'redraft' | 'discard') => {
    if (!rec) return;
    setBusy(kind); setError(null);
    try {
      if (kind === 'save' && draft) { const r = await api.teachSave(bot.id, rec.id, draft); setSaved(r.skillName); }
      else if (kind === 'redraft') { setState(await api.teachRedraft(bot.id, rec.id, { note, remove: [...drop] })); setDrop(new Set()); }
      else if (kind === 'discard') { await api.teachDiscard(bot.id, rec.id); toast('Recording discarded'); onBack(); }
    } catch (e: any) { setError(e?.message ?? 'That didn’t work.'); } finally { setBusy(null); }
  };

  const ready = !saved && !!rec && (rec.status === 'ready' || rec.status === 'stopped');
  const input = { borderRadius: 18, minHeight: 48 } as const;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{saved ? 'Skill saved' : `Teach ${name}`}</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }} keyboardShouldPersistTaps="handled">
        {!!error && <Notice tone="problem">{error}</Notice>}
        {saved ? (
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 8 }}>
            <Icon name="check" size={22} />
            <Text style={[type.body, { flex: 1 }]}>Saved as {saved}. {name} will use it the next time this task comes up. You can change it any time in {name}’s Skills.</Text>
          </View>
        ) : !state && !error ? <ActivityIndicator color={color.inkMuted} style={{ marginTop: 24 }} />
          : !rec ? <Text style={type.caption}>There’s no recording waiting for {name}. Take control of {name}’s screen and tap Record to show it a task.</Text>
          : rec.status === 'recording' ? <Text style={type.caption}>Still recording. Tap Stop on {name}’s screen when you’ve finished.</Text>
          : (
            <>
              <Label>The skill</Label>
              {rec.status === 'drafting' || !draft ? (
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 }}>
                  {rec.status === 'drafting' && <ActivityIndicator color={color.inkMuted} />}
                  <Text style={type.caption}>{rec.status === 'drafting' ? `${name} is writing the skill…` : 'No skill yet. Tap Write again.'}</Text>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {!!rec.error && <Notice>{name} couldn’t write it this time ({rec.error}), so these are the recorded steps as they are. Edit them, or tap Write again.</Notice>}
                  <Field value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="Name" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Name" style={input} />
                  <Field value={draft.description} onChangeText={(v) => setDraft({ ...draft, description: v })} placeholder="When to use it" multiline accessibilityLabel="When to use it" style={input} />
                  <Field value={draft.body} onChangeText={(v) => setDraft({ ...draft, body: v })} placeholder={`Steps for ${name}`} multiline autoCorrect={false} accessibilityLabel={`Steps for ${name}`}
                    style={{ ...input, minHeight: 220, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 14 }} />
                </View>
              )}

              <Label>What you did ({rec.lines.length} {rec.lines.length === 1 ? 'step' : 'steps'})</Label>
              <View style={{ backgroundColor: color.fill, borderRadius: 18, paddingVertical: 6 }}>
                {rec.lines.map((l, i) => {
                  const out = drop.has(i);
                  return (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4, minHeight: 44 }}>
                      <Text style={{ width: 24, fontSize: 14, color: color.inkMuted }}>{i + 1}.</Text>
                      <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, color: out || rec.steps[i]?.sensitive ? color.inkMuted : color.ink, textDecorationLine: out ? 'line-through' : 'none', fontStyle: rec.steps[i]?.sensitive ? 'italic' : 'normal' }}>{l}</Text>
                      <Pressable accessibilityRole="button" accessibilityLabel={out ? `Keep step ${i + 1}` : `Leave out step ${i + 1}`} hitSlop={6}
                        onPress={() => setDrop((d) => { const n = new Set(d); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                        style={({ pressed }) => ({ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                        {out ? <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink }}>Keep</Text> : <Icon name="close" size={16} color={color.inkMuted} />}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
              <Text style={type.caption}>Passwords, card numbers and codes were not recorded. The skill tells {name} to ask you for them with a secure card.</Text>
              <Field value={note} onChangeText={setNote} placeholder={`Anything ${name} should know (optional)`} multiline maxLength={600} accessibilityLabel={`Anything ${name} should know`} style={input} />
            </>
          )}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        {saved ? <PillButton title="Done" onPress={onBack} style={{ flex: 1 }} /> : (
          <>
            {!!rec && rec.status !== 'recording' && <PillButton title={busy === 'discard' ? 'Discarding…' : 'Discard'} kind="plain" onPress={() => void act('discard')} disabled={!!busy} style={{ flex: 1 }} />}
            {ready && rec.lines.length > 0 && <PillButton title={busy === 'redraft' ? 'Asking…' : 'Write again'} kind="secondary" onPress={() => void act('redraft')} disabled={!!busy || drop.size >= rec.lines.length} style={{ flex: 1 }} />}
            {ready && <PillButton title={busy === 'save' ? 'Saving…' : 'Save skill'} onPress={() => void act('save')} disabled={!!busy || !draft || !draft.name.trim() || !draft.body.trim()} style={{ flex: 1 }} />}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
