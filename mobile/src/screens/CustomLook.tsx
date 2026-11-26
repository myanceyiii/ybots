import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Bot, Client, LookAsk, LookRun } from '../api';
import { askForNotifications, followLookRun } from '../background';
import { celebrate } from '../live';
import { POSE_LABELS, type AvatarPose } from '../poses';
import { BotAvatar, BotShape } from '../components/BotAvatar';
import { KeyboardSafe } from '../components/KeyboardSafe';
import { ShapePicker } from '../components/ShapePicker';
import { CheckBadge } from '../components/CheckBadge';
import { Chip, Header, HeaderAction, HeaderTitle, Label, Notice, PillButton, RoundButton } from '../components/ui';
import { color, type } from '../theme';

/** Used until the server's own list arrives (GET /looks/options). */
const STYLES: [string, string][] = [['illustrated', 'Illustrated'], ['clay', '3D clay'], ['pixel', 'Pixel'], ['line-art', 'Line art'], ['photo', 'Photo-real']];

/**
 * A bot's look, with two tabs: Shape (pick a shape and colour) and Picture (describe one and pick
 * from the generated pictures, or upload a photo). Nothing changes on the server until Save.
 */
export function CustomLook({ api, bot, onBack, onSaved, embedded }: { api: Client; bot: Bot; onBack: () => void; onSaved: (b: Bot) => void; embedded?: boolean }) {
  const [tab, setTab] = useState<'shape' | 'picture'>(bot.avatarImageUrl ? 'picture' : 'shape');
  const [shape, setShape] = useState(bot.avatarShape);
  const [tint, setTint] = useState(bot.avatarColor);
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string | null>(null);
  const [intent, setIntent] = useState<'tweak' | 'new'>(bot.avatarImageUrl ? 'tweak' : 'new');
  const count = 3; // always 3 (server LOOK_COUNT)
  const [reference, setReference] = useState<string | null>(null);
  const [styles, setStyles] = useState<[string, string][]>(STYLES);
  useEffect(() => { Promise.resolve().then(() => api.looksOptions()).then((o) => setStyles(o.styles.map((x) => [x.id, x.label]))).catch(() => {}); }, [api]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trying, setTrying] = useState<AvatarPose | null>(null);
  const [drawFail, setDrawFail] = useState<string | null>(null);
  const [lastAsk, setLastAsk] = useState<LookAsk | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const show = (next: string[]) => { if (!alive.current) return; setCandidates((c) => [...next, ...c]); setPicked((p) => p ?? next[0] ?? null); };
  /** Follow a run on the server (it keeps going if the app is left or closed) and show its pictures. */
  const follow = async (run: string) => {
    setBusy('generate');
    try { show((await followLookRun(api, bot, run)).candidates); }
    catch (e: any) { if (alive.current) setDrawFail(e?.message || 'The image service failed without saying why.'); }
    finally { if (alive.current) setBusy(null); }
  };
  const draw = async (ask: LookAsk) => {
    setBusy('generate'); setError(null); setDrawFail(null); setLastAsk(ask);
    void askForNotifications();
    try {
      const started = await api.startLooks(bot.id, ask);
      if (started.candidates) { show(started.candidates); setBusy(null); return; }
      setPicked(null);
      await follow(started.run!);
    } catch (e: any) { setDrawFail(e?.message || 'The image service failed without saying why.'); setBusy(null); }
  };
  // Pictures drawn while this screen was closed (the app left, killed by Android, or reopened): show them, or keep waiting.
  useEffect(() => {
    let stop = false;
    api.lookRuns(bot.id).then(({ runs }) => {
      if (stop) return;
      const toAsk = (r: LookRun): LookAsk => ({ description: r.ask.description, intent: r.ask.intent, style: r.ask.style, count: r.ask.count ?? 3, reference: null });
      for (const r of runs.filter((x) => x.state !== 'making').reverse()) {
        if (r.state === 'failed') { setDrawFail(r.error ?? 'The image service failed without saying why.'); setLastAsk(toAsk(r)); api.lookRunSeen(bot.id, r.id).catch(() => {}); }
        else api.waitLookRun(bot.id, r.id).then(({ candidates: next }) => { if (!stop) { show(next); api.lookRunSeen(bot.id, r.id).catch(() => {}); } }).catch(() => {});
      }
      const drawing = runs.find((r) => r.state === 'making');
      if (drawing) { setLastAsk(toAsk(drawing)); void follow(drawing.id); }
    }).catch(() => {});
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const generate = () => {
    if (!prompt.trim()) { setError('Describe the look first.'); return; }
    return draw({ description: prompt.trim(), intent, style, count, reference });
  };
  const choosePhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7, base64: true });
    const a = r.canceled ? null : r.assets[0];
    if (!a?.base64) return null;
    const mime = a.mimeType === 'image/png' || a.mimeType === 'image/webp' ? a.mimeType : 'image/jpeg';
    return `data:${mime};base64,${a.base64}`;
  };
  const upload = async () => { const p = await choosePhoto(); if (p) setPicked(p); };
  const startFrom = async () => { const p = await choosePhoto(); if (p) setReference(p); };

  const shapeChanged = shape !== bot.avatarShape || tint !== bot.avatarColor || !!bot.avatarImageUrl;
  const canSave = !busy && (tab === 'shape' ? shapeChanged : !!picked);
  const save = async () => {
    setBusy('save'); setError(null);
    try {
      if (tab === 'picture') { const b = (await api.setAvatar(bot.id, picked)).bot; celebrate(b.id); setPicked(null); onSaved(b); return; }
      let b = bot;
      if (shape !== bot.avatarShape || tint !== bot.avatarColor) b = (await api.updateBot(bot.id, { avatarShape: shape, avatarColor: tint })).bot;
      if (bot.avatarImageUrl) b = (await api.setAvatar(bot.id, null)).bot;
      onSaved(b);
    } catch (e: any) { setError(e?.message ?? 'Could not save.'); }
    finally { setBusy(null); }
  };

  const posePic = trying && bot.avatarImageUrl ? bot.avatarPoses?.[trying] ?? bot.avatarImageUrl : null;
  const preview = tab === 'shape'
    ? <BotShape shape={shape} color={tint} size={120} mood={trying ?? undefined} />
    : picked ? <Image source={{ uri: picked }} style={{ width: 120, height: 120, borderRadius: 60 }} />
    : posePic ? <Image source={{ uri: `${api.server}${posePic}`, headers: api.authHeader }} style={{ width: 120, height: 120, borderRadius: 60 }} />
    : trying && !bot.avatarImageUrl ? <BotShape shape={bot.avatarShape} color={bot.avatarColor} size={120} mood={trying} />
    : <BotAvatar bot={bot} size={120} server={api.server} auth={api.authHeader} />;

  const content = (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 12 }}>{preview}</View>
        {!picked && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 18 }} accessibilityLabel="Try a state">
            {POSE_LABELS.map(([id, label]) => <Chip key={id} title={label} selected={trying === id} onPress={() => setTrying(trying === id ? null : id)} />)}
          </ScrollView>
        )}

        <View style={{ flexDirection: 'row', backgroundColor: color.fill, borderRadius: 22, padding: 4, marginBottom: 20 }}>
          {(['shape', 'picture'] as const).map((t) => (
            <Pressable key={t} accessibilityRole="tab" accessibilityState={{ selected: tab === t }} onPress={() => { setTab(t); setError(null); }}
              style={{ flex: 1, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: tab === t ? color.surface : 'transparent' }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: tab === t ? color.ink : color.inkMuted }}>{t === 'shape' ? 'Shape' : 'Picture'}</Text>
            </Pressable>
          ))}
        </View>

        {tab === 'shape' ? (
          <ShapePicker shape={shape} tint={tint} onShape={setShape} onTint={setTint} />
        ) : (
          <View>
            {!!bot.avatarImageUrl && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                <Chip title="Change this look" selected={intent === 'tweak'} onPress={() => setIntent('tweak')} />
                <Chip title="A whole new look" selected={intent === 'new'} onPress={() => setIntent('new')} />
              </View>
            )}
            <Label>{intent === 'tweak' ? 'What to change' : 'Describe the look'}</Label>
            <TextInput value={prompt} onChangeText={setPrompt} multiline placeholder={intent === 'tweak' ? 'Add round sunglasses and a red scarf' : 'A cheerful robot with a little apron, holding a calendar'} placeholderTextColor={color.timestamp}
              style={{ minHeight: 84, borderRadius: 18, backgroundColor: color.fill, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, lineHeight: 22, color: color.ink, textAlignVertical: 'top' }} />
            <View style={{ height: 18 }} />
            <Label>Style</Label>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              <Chip title={intent === 'tweak' ? 'Keep it' : 'Any'} selected={style === null} onPress={() => setStyle(null)} />
              {styles.map(([k, label]) => <Chip key={k} title={label} selected={k === style} onPress={() => setStyle(k)} />)}
            </ScrollView>
            <View style={{ height: 18 }} />
            <Label>Start from a picture</Label>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {reference ? <Image source={{ uri: reference }} style={{ width: 48, height: 48, borderRadius: 12 }} /> : null}
              <Chip title={reference ? 'Change picture' : intent === 'tweak' ? `${bot.name}'s current picture` : 'None'} selected={false} onPress={startFrom} />
              {reference ? <Chip title="Remove" onPress={() => setReference(null)} /> : null}
            </View>
            {candidates.length > 0 && (
              <>
                <View style={{ height: 18 }} />
                <Label>Pick one</Label>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {candidates.map((c, i) => (
                    <Pressable key={i} accessibilityLabel={`Option ${i + 1}`} accessibilityRole="radio" accessibilityState={{ checked: picked === c }} onPress={() => setPicked(c)}
                      style={{ padding: 2, borderRadius: 44, borderWidth: 3, borderColor: picked === c ? color.link : 'transparent', transform: [{ scale: picked === c ? 1.06 : 1 }] }}>
                      <Image source={{ uri: c }} style={{ width: 72, height: 72, borderRadius: 36, opacity: picked && picked !== c ? 0.45 : 1 }} />
                      {picked === c && <CheckBadge />}
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <View style={{ gap: 10, marginTop: 20 }}>
              <PillButton title={candidates.length ? 'Make more' : 'Make pictures'} icon={busy === 'generate' ? undefined : 'sparkle'} onPress={generate} disabled={!!busy} />
              {busy === 'generate' && <ActivityIndicator color={color.ink} />}
              {busy === 'generate' && <Text style={[type.caption, { textAlign: 'center' }]}>Drawing… this can take a minute or two. You can leave the app: you'll get a note when they're ready.</Text>}
              {!!drawFail && busy !== 'generate' && (
                <View style={{ gap: 8 }}>
                  <Notice tone="problem">The pictures could not be drawn: {drawFail}</Notice>
                  {lastAsk && <PillButton title="Try again" kind="secondary" onPress={() => draw(lastAsk)} disabled={!!busy} />}
                </View>
              )}
              <PillButton title="Upload a photo as it is" kind="secondary" icon="upload" onPress={upload} disabled={!!busy} />
            </View>
            {!!bot.avatarImageUrl && bot.kind !== 'room' && <Poses api={api} bot={bot} />}
          </View>
        )}
        {error && <View style={{ marginTop: 16 }}><Notice tone="problem">{error}</Notice></View>}
        <Text style={[type.caption, { textAlign: 'center', marginTop: 18 }]}>Shown everywhere {bot.name} appears.</Text>
      </ScrollView>
  );
  // Inside the bot's settings: no header of its own, and Save sits under the content while there is something to save.
  if (embedded) {
    return (
      <View style={{ flex: 1 }}>
        {content}
        {canSave && <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: color.hairline }}>
          <PillButton title={busy === 'save' ? 'Saving…' : 'Save look'} onPress={save} disabled={!canSave} />
        </View>}
      </View>
    );
  }
  return (
    <KeyboardSafe style={{ backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{bot.name}'s look</HeaderTitle>
        <HeaderAction title={busy === 'save' ? 'Saving' : 'Save'} onPress={save} disabled={!canSave} />
      </Header>
      {content}
    </KeyboardSafe>
  );
}

/** The poses made from the bot's picture, each one remade with a tap, and all of them again. */
function Poses({ api, bot }: { api: Client; bot: Bot }) {
  const [note, setNote] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  const poses = bot.avatarPoses ?? {};
  const job = bot.avatarPoseJob;
  const making = job?.state === 'making';
  const ask = (fn: () => Promise<unknown>) => fn().then(() => setNote(null)).catch((e: any) => setNote(e?.message ?? 'Could not start that.'));
  return (
    <View style={{ marginTop: 28 }}>
      <Label>Poses</Label>
      <Text style={[type.caption, { marginBottom: 12 }]}>
        {making ? `Making poses: ${job!.done} of ${job!.total}…` : job?.state === 'stopped' ? `Stopped at ${job.done} of ${job.total}.` : Object.keys(poses).length ? `${bot.name} switches between these as it works. Tap one to make it again.` : 'No poses yet.'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {POSE_LABELS.map(([id, label]) => (
          <Pressable key={id} accessibilityLabel={`${label}: make again`} disabled={making} onPress={() => ask(() => api.remakePoses(bot.id, [id], extra.trim() || undefined))} style={{ width: 68, alignItems: 'center', gap: 4 }}>
            {poses[id]
              ? <Image source={{ uri: `${api.server}${poses[id]}`, headers: api.authHeader }} style={{ width: 60, height: 60, borderRadius: 30 }} />
              : <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: color.fill }} />}
            <Text numberOfLines={1} style={{ fontSize: 12, color: color.inkMuted }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput value={extra} onChangeText={setExtra} maxLength={300} placeholder='Add to every pose (optional), e.g. "keep the hat on"' placeholderTextColor={color.timestamp} accessibilityLabel="Add to every pose"
        style={{ marginTop: 16, borderRadius: 18, backgroundColor: color.fill, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, color: color.ink }} />
      <View style={{ gap: 10, marginTop: 12 }}>
        <PillButton title={Object.keys(poses).length ? 'Make all poses again' : 'Make poses'} kind="secondary" disabled={making} onPress={() => ask(() => api.remakePoses(bot.id, undefined, extra.trim() || undefined))} />
        {Object.keys(poses).length > 0 && <PillButton title="Stop using poses" kind="plain" disabled={making} onPress={() => ask(() => api.removePoses(bot.id))} />}
      </View>
      {note && <View style={{ marginTop: 12 }}><Notice tone="problem">{note}</Notice></View>}
    </View>
  );
}
