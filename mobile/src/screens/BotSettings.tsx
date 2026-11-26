import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { startFresh } from '../fresh';
import type { AllowRule, AllowRuleUse, Bot, BotPatch, Client, Effort, EngineInfo, HelperRun, HelperSettings, HelpersBundle, ModelTier, PluginChange, PluginInfo, Routine, SettingsBundle, Skill, VoiceOptions } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { KeyboardSafe } from '../components/KeyboardSafe';
import { Chip, Label, Notice, PillButton, RoundButton } from '../components/ui';
import { color, currentScheme, type } from '../theme';
import { toast } from '../toast';
import { CHAT_COLORS, CHAT_COLOR_ORDER, chatInk, type ChatColor } from '../chatColors';
import { GroupMembers } from '../components/GroupMembers';
import { usePluginSwitch } from '../components/usePluginSwitch';
import { FreeRunSection } from './Permissions';
import { BackgroundSettings } from '../components/BackgroundSettings';
import { MuteRow } from '../components/NotificationSettings';
import { background } from '../background';
import { ShapePicker } from '../components/ShapePicker';
import { CustomLook } from './CustomLook';
import { SkillsScreen } from './AgentSkills';
import { useVoiceSamples } from '../voiceSample';
import { useSimple } from '../simple';
import { ProviderCatalog } from './ProviderCatalog';
import Constants from 'expo-constants';
import { appName } from '../theme';
import { engineSummary } from '../engineSummary';
import * as SecureStore from 'expo-secure-store';
import { SystemdTimers } from '../components/SystemdTimers';

/**
 * Everything the web app's settings hold for one bot, laid out for a phone: a row of tabs under the header
 * (General, Look, Model, Helpers, Tools, Voice, Skills, Memories, Routines; a group also has Members), each one a single scrolling column.
 */
export type SettingsTab = 'systemd' | 'general' | 'members' | 'look' | 'model' | 'helpers' | 'tools' | 'voice' | 'skills' | 'memories' | 'routines';

export function BotSettings({ api, bot, bots = [], initialTab = 'general', onBack, onBot, onDeleted, onComputer, onSignOut, onDeviceLink, onDevices, onHub, onAsk }: {
  api: Client; bot: Bot; /** Every bot, for a group's Members tab. */ bots?: Bot[]; initialTab?: SettingsTab; onBack: () => void; onBot: (b: Bot) => void; onDeleted: () => void;
  /** Opens the bot's computer (a model sign-in runs in a terminal there). */
  onComputer: () => void;
  /** For a one-bot app with no home screen: signing out lives here instead, and the bot can't be deleted or made primary. */
  onSignOut?: () => void;
  /** One-bot app: Sign in another device (DeviceLink.tsx), which YBots keeps in the account sheet on Home. */
  onDeviceLink?: () => void;
  /** One-bot app: the list of signed-in devices (Devices.tsx), which YBots opens from Home. */
  onDevices?: () => void;
  /** The simple view: open Today, Reminders or Things to ask. */
  onHub?: (tab: 'today' | 'reminders' | 'ideas') => void;
  /** The simple view: put these words in the chat's message box and go there. */
  onAsk?: (text: string) => void;
}) {
  const [picked, setTab] = useState<SettingsTab>(initialTab);
  const [data, setData] = useState<SettingsBundle | null>(null);
  const [hasSystemd, setHasSystemd] = useState(false);
  useEffect(() => {
    let active = true;
    setHasSystemd(false);
    if (!bot.outside && bot.kind !== 'room') api.systemdTimers(bot.id, true).then(() => { if (active) setHasSystemd(true); }).catch(() => {});
    return () => { active = false; };
  }, [api, bot.id, bot.kind, bot.outside]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.settings(bot.id).then((d) => { setData(d); setLoadError(null); }).catch((e) => setLoadError(e?.message ?? 'Could not load settings.'));
  }, [api, bot.id]);
  useEffect(() => { reload(); }, [reload]);

  const hasEngine = bot.kind !== 'room' && !bot.outside;
  // A scoped sign-in's view (simple.ts): her assistant's look, voice, memories and reminders, without the model,
  // helpers, connections and skills that Alex looks after.
  const simple = useSimple();
  // A group has no agent of its own: no look, model, helpers, voice, memories or routines. Its members bring theirs.
  const isGroup = bot.kind === 'room';
  const tabs: { id: SettingsTab; label: string; count?: number }[] = simple && !isGroup ? [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Look' },
    { id: 'voice', label: 'Voice' },
    { id: 'memories', label: 'Remembers', count: data?.memories.length },
    { id: 'routines', label: 'Reminders', count: data?.routines.length },
  ] : isGroup ? [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Picture' },
    { id: 'members', label: 'Members' },
    { id: 'skills', label: 'Skills', count: data?.skills.length },
  ] : [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Look' },
    ...(hasEngine ? [{ id: 'model' as const, label: 'Model' }, { id: 'helpers' as const, label: 'Helpers' }, { id: 'tools' as const, label: 'Connections' }] : []),
    { id: 'voice', label: 'Voice' },
    { id: 'skills', label: 'Skills', count: bot.kind === 'room' ? data?.skills.length : undefined },
    { id: 'memories', label: 'Memories', count: data?.memories.length },
    { id: 'routines', label: 'Routines', count: data?.routines.length },
    ...(hasSystemd ? [{ id: 'systemd' as const, label: 'Timers' }] : []),
  ];

  const tab: SettingsTab = tabs.some((t) => t.id === picked) ? picked : 'general';

  return (
    <KeyboardSafe style={{ backgroundColor: color.ground }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <BotAvatar bot={bot} size={36} server={api.server} auth={api.authHeader} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={type.screenTitle}>{bot.name}</Text>
          <Text numberOfLines={1} style={type.caption}>Settings</Text>
        </View>
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 10 }} accessibilityRole="tablist">
          {tabs.map((t) => (
            <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }} onPress={() => setTab(t.id)}
              style={({ pressed }) => ({ height: 40, paddingHorizontal: 16, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tab === t.id ? color.primary : color.fill, opacity: pressed ? 0.8 : 1 })}>
              <Text style={{ fontSize: 15, fontWeight: '500', color: tab === t.id ? color.onPrimary : color.ink }}>{t.label}</Text>
              {!!t.count && <Text style={{ fontSize: 13, color: tab === t.id ? color.onPrimaryMuted : color.inkMuted }}>{t.count}</Text>}
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {loadError && tab !== 'look' && tab !== 'general' && (
        <View style={{ paddingHorizontal: 16, gap: 8, marginBottom: 6 }}>
          <Notice tone="problem">Couldn't load settings: {loadError}</Notice>
          <PillButton title="Try again" kind="secondary" onPress={reload} />
        </View>
      )}
      {tab === 'look' ? <CustomLook api={api} bot={bot} embedded onBack={onBack} onSaved={onBot} />
        : (
          // Each tab starts at its top (the key), not wherever the last tab was scrolled to.
          <ScrollView key={tab} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 40 }}>
            {tab === 'members' && <GroupMembers api={api} room={bot} bots={bots} />}
            {tab === 'general' && (isGroup
              ? <GroupGeneral api={api} bot={bot} onBot={onBot} onDeleted={onDeleted} onLook={() => setTab('look')} />
              : <General api={api} bot={bot} onBot={onBot} onDeleted={onDeleted} onLook={() => setTab('look')} onSignOut={onSignOut} onDeviceLink={onDeviceLink} onDevices={onDevices} simple={simple} onHub={onHub} />)}
            {tab === 'model' && <Model api={api} bot={bot} onBot={onBot} onComputer={onComputer} />}
            {tab === 'helpers' && <Helpers api={api} bot={bot} />}
            {tab === 'tools' && <Tools api={api} bot={bot} />}
            {tab === 'voice' && <Voice api={api} bot={bot} onBot={onBot} />}
            {tab === 'skills' && <SkillsScreen api={api} bot={bot} appSkills={data?.skills} onAppChange={reload}
              fallback={(notice) => <Skills api={api} bot={bot} skills={data?.skills} onChange={reload} notice={notice} />} />}
            {tab === 'memories' && <Memories api={api} bot={bot} data={data} onChange={reload} simple={simple} onAsk={onAsk} />}
            {tab === 'routines' && <Routines api={api} bot={bot} initial={data?.routines} simple={simple} onHub={onHub} />}
            {tab === 'systemd' && <SystemdTimers api={api} botId={bot.id} />}
          </ScrollView>
        )}
    </KeyboardSafe>
  );
}

// ---------------------------------------------------------------------------

const EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest replies. Good for quick lookups and chit-chat.' },
  { value: 'medium', label: 'Medium', hint: 'A good balance for most work.' },
  { value: 'high', label: 'High', hint: 'Thinks longer before acting. Better for tricky, multi-step work.' },
  { value: 'xhigh', label: 'Max', hint: 'Thinks the longest. Slowest, for the hardest problems.' },
];

const input = () => ({ borderRadius: 18, backgroundColor: color.fill, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16, color: color.ink } as const);

export function Section({ title, hint, children }: { title?: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 22 }}>
      {!!title && <Label>{title}</Label>}
      {children}
      {!!hint && <Text style={[type.caption, { fontSize: 13, marginTop: 6, marginHorizontal: 4 }]}>{hint}</Text>}
    </View>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }}>{children}</View>;
}

/** A row in a card: title and detail on the left, a control on the right. */
export function Row({ title, detail, right, last, onPress }: { title: string; detail?: string; right?: React.ReactNode; last?: boolean; onPress?: () => void }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, backgroundColor: pressed && onPress ? color.pressed : 'transparent', borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline })}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
        {!!detail && <Text style={[type.caption, { fontSize: 13 }]}>{detail}</Text>}
      </View>
      {right}
    </Pressable>
  );
}

export function SmallButton({ title, onPress, danger, disabled }: { title: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={({ pressed }) => ({ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 14, fontWeight: '500', color: danger ? color.danger : color.ink }}>{title}</Text>
    </Pressable>
  );
}

function IconButton({ icon, label, onPress }: { icon: 'close' | 'sliders' | 'refresh'; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Icon name={icon} size={17} color={color.inkMuted} />
    </Pressable>
  );
}

const confirm = (title: string, message: string, action: string, run: () => void) =>
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: 'destructive', onPress: run }]);

function useFlash() {
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const flash = (text: string, problem = false) => {
    if (t.current) clearTimeout(t.current);
    setNote({ text, problem });
    t.current = setTimeout(() => setNote(null), problem ? 5000 : 2400);
  };
  const view = note ? <View style={{ marginBottom: 14 }}><Notice tone={note.problem ? 'problem' : 'note'}>{note.text}</Notice></View> : null;
  return { flash, view };
}


const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------------------------------------------------------------------------

/**
 * What this bot may do without asking: the "Always allow" rules made on its approval cards, with who
 * made each one and when, how often it was used, and a button to make it ask again.
 */
function AlwaysAllowed({ api, bot, simple }: { api: Client; bot: Bot; simple?: boolean }) {
  const [rules, setRules] = useState<AllowRule[] | null>(null);
  const [log, setLog] = useState<AllowRuleUse[]>([]);
  // A list that could not be read says so, instead of "Nothing yet" (which would be wrong).
  const [loadError, setLoadError] = useState<string | null>(null);
  const { flash, view } = useFlash();
  const load = useCallback(() => {
    api.allowRules(bot.id).then((r) => { setRules(r.rules); setLog(r.log); setLoadError(null); }).catch((e) => { setRules([]); setLoadError(e?.message ?? 'Could not load them.'); });
  }, [api, bot.id]);
  useEffect(() => { load(); }, [load]);
  const remove = (r: AllowRule) => api.deleteAllowRule(r.id).then(() => { flash(`${bot.name} will ask again`); load(); }).catch((e) => flash(e?.message ?? 'Could not remove it.', true));
  // The simple view shows this only once there is something to undo.
  if (simple && !rules?.length) return null;
  return (
    <Section title="Always allowed" hint="Added with “Always allow” on an approval, for this bot and that one action only. ⚠ marks rules that let it do something risky without asking.">
      {view}
      <Card>
        {rules === null ? <Row title="Loading…" last /> : loadError ? <Row title="Couldn't load them" detail={loadError} last right={<SmallButton title="Try again" onPress={load} />} /> : rules.length === 0 ? (
          <Row title="Nothing yet" detail={`${bot.name} asks before anything that isn't read-only.`} last />
        ) : rules.map((r, i) => (
          <Row key={r.id} title={r.risk ? `⚠ ${r.label}` : r.label} last={i === rules.length - 1}
            detail={`Added by ${r.createdBy} on the ${r.createdVia}, ${shortDate(r.createdAt)} · ${r.uses ? `used ${r.uses}×, last ${shortDate(r.lastUsedAt ?? r.createdAt)}` : 'not used yet'}`}
            right={<SmallButton title="Ask again" onPress={() => remove(r)} />} />
        ))}
      </Card>
      {log.length > 0 && (
        <Text style={[type.caption, { fontSize: 13, marginTop: 8, marginHorizontal: 4 }]}>
          Last allowed without asking: {log.slice(0, 3).map((u) => `${u.label} (${shortDate(u.at)} ${new Date(u.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`).join(', ')}
        </Text>
      )}
    </Section>
  );
}

type Draft = { name: string; label: string; description: string; instructions: string; effort: Effort; mode: 'personal' | 'teammate' };
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label ?? '', description: b.description ?? '', instructions: b.instructions ?? '', effort: b.effort ?? 'medium', mode: b.mode ?? 'personal' });

function General({ api, bot, onBot, onDeleted, onLook, onSignOut, onDeviceLink, onDevices, simple, onHub }: { api: Client; bot: Bot; onBot: (b: Bot) => void; onDeleted: () => void; onLook: () => void; onSignOut?: () => void; onDeviceLink?: () => void; onDevices?: () => void; simple?: boolean; onHub?: (tab: 'today' | 'reminders' | 'ideas') => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [saving, setSaving] = useState(false);
  const { flash, view } = useFlash();
  const base = draftOf(bot);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!changed.length || !nameOk) return;
    setSaving(true);
    try {
      const patch: BotPatch = {};
      for (const k of changed) (patch as any)[k] = k === 'name' ? draft.name.trim() : draft[k];
      onBot((await api.updateBot(bot.id, patch)).bot);
      flash('Saved');
    } catch (e: any) { flash(e?.message ?? 'Could not save.', true); }
    finally { setSaving(false); }
  };

  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel="Change look" onPress={onLook}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 16, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.fill, marginBottom: 22 })}>
        <BotAvatar bot={bot} size={64} server={api.server} auth={api.authHeader} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.name}>{bot.name}</Text>
          <Text style={type.caption}>{bot.avatarImageUrl ? 'Picture and poses' : 'Change shape or make a picture'}</Text>
        </View>
        <Icon name="chevron" size={18} color={color.timestamp} />
      </Pressable>

      {!simple && <ChatColorSection api={api} bot={bot} onBot={onBot} />}

      <VisualsSection api={api} bot={bot} onBot={onBot} simple={simple} />

      {!bot.outside && <BusySendSection api={api} bot={bot} onBot={onBot} />}

      {bot.kind !== 'room' && !bot.outside && <WebSearchSection api={api} bot={bot} onBot={onBot} />}
      {bot.kind !== 'room' && !bot.outside && <PhoneSection api={api} bot={bot} onBot={onBot} />}

      {!simple && !bot.isPrimary && <HideFromListSection api={api} bot={bot} onBot={onBot} />}

      {/* A scoped sign-in finds its bot by name (SCOPED_PEOPLE), so the simple view does not offer renaming it. */}
      {!simple && (
        <Section title="Name" hint="A scoped sign-in (SCOPED_PEOPLE) finds its bot by this name. Renaming it hides it from that sign-in until the server is told the new name.">
          <TextInput value={draft.name} onChangeText={(v) => put('name', v)} maxLength={60} style={input()} accessibilityLabel="Name" />
        </Section>
      )}
      {!simple && (
        <Section title="Label" hint={'Shown next to the name, like "Research" or "Inbox".'}>
          <TextInput value={draft.label} onChangeText={(v) => put('label', v)} maxLength={60} placeholder="Add a label" placeholderTextColor={color.timestamp} style={input()} accessibilityLabel="Label" />
        </Section>
      )}
      {!simple && (
        <Section title="About">
          <TextInput value={draft.description} onChangeText={(v) => put('description', v)} maxLength={500} multiline placeholder={`What is ${bot.name} for?`} placeholderTextColor={color.timestamp}
            style={[input(), { minHeight: 70, textAlignVertical: 'top' }]} accessibilityLabel="About" />
        </Section>
      )}
      <Section title={simple ? `How ${bot.name} should help you` : 'Instructions'} hint={simple
        ? `Anything ${bot.name} should always keep in mind: how you like answers, foods to avoid, stores you prefer.`
        : `Standing guidance ${draft.name || bot.name} always follows, like tone, priorities or things to avoid.`}>
        <TextInput value={draft.instructions} onChangeText={(v) => put('instructions', v)} maxLength={8000} multiline placeholder={simple ? 'e.g. Keep it short. We shop at H-E-B on Saturdays.' : 'e.g. Keep updates to three bullets.'} placeholderTextColor={color.timestamp}
          style={[input(), { minHeight: simple ? 110 : 150, textAlignVertical: 'top' }]} accessibilityLabel={simple ? `How ${bot.name} should help you` : 'Instructions'} />
      </Section>
      {!simple && (
        <Section title="Thinking effort" hint={EFFORTS.find((e) => e.value === draft.effort)?.hint}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {EFFORTS.map((e) => <Chip key={e.value} title={e.label} selected={draft.effort === e.value} onPress={() => put('effort', e.value)} />)}
          </View>
        </Section>
      )}
      {!simple && (
        <Section title="Used as">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip title="Personal assistant" selected={draft.mode === 'personal'} onPress={() => put('mode', 'personal')} />
            <Chip title="Teammate" selected={draft.mode === 'teammate'} onPress={() => put('mode', 'teammate')} />
          </View>
        </Section>
      )}

      <BusySendSection api={api} bot={bot} onBot={onBot} />

      {view}
      {changed.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 24 }}>
          <PillButton title="Discard" kind="secondary" onPress={() => setDraft(draftOf(bot))} disabled={saving} style={{ flex: 1 }} />
          <PillButton title={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving || !nameOk} style={{ flex: 1 }} />
        </View>
      )}

      {background.notifyAvailable && <Section title="Notifications"><Card><MuteRow api={api} bot={bot} /></Card></Section>}
      <FreeRunSection api={api} botId={bot.id} compact />
      <AlwaysAllowed api={api} bot={bot} simple={simple} />
      <Section title="Conversation">
        <Card>
          <Row title="New conversation" detail={simple ? `Clears the chat. What ${bot.name} remembers and your reminders stay. You can undo it for a few seconds.` : 'Clears the chat. Memories, skills and routines stay.'} last={bot.isPrimary || !!onSignOut}
            right={<SmallButton title="Start new" onPress={() => { startFresh(api, bot).catch((e) => flash(e?.message ?? 'Could not start fresh.', true)); }} />} />
          {!bot.isPrimary && !onSignOut && (
            <Row title="Make primary" detail="Your go-to bot. It reaches out first and keeps the others on track." last
              right={<SmallButton title="Make primary" onPress={() => api.makePrimary(bot.id).then(() => { onBot({ ...bot, isPrimary: true }); flash(`${bot.name} is now your primary bot`); }).catch((e) => flash(e?.message ?? 'Could not change it.', true))} />} />
          )}
        </Card>
      </Section>
      {simple && onHub && (
        <Section title={`With ${bot.name}`}>
          <Card>
            <Row title="Today" detail="What needs you, today's reminders and your lists." onPress={() => onHub('today')} />
            <Row title="Reminders" detail="Make, pause or remove a reminder." onPress={() => onHub('reminders')} />
            <Row title="Things to ask" detail="Ideas by subject, and your own shortcuts." last onPress={() => onHub('ideas')} />
          </Card>
        </Section>
      )}
      {onSignOut ? (
        <Section title="This phone">
          <View style={{ marginBottom: 12 }}><BackgroundSettings api={api} bots={[bot]} simple={simple} /></View>
          <Card>
            {onDeviceLink && <Row title="Sign in another device" detail="A one-time code for another phone or a computer, good for 15 minutes."
              right={<SmallButton title="Show code" onPress={onDeviceLink} />} />}
            {onDevices && <Row title="Where you’re signed in" detail="Every phone and computer signed in as you. Sign one out from here." onPress={onDevices} />}
            <Row title="Sign out" detail="Signs this phone out. You'll need a new sign-in code to come back." last
              right={<SmallButton title="Sign out" danger onPress={() => confirm('Sign out of this phone?', 'You will need a new sign-in code to come back.', 'Sign out', onSignOut)} />} />
          </Card>
          <Text selectable style={[type.caption, { fontSize: 12.5, textAlign: 'center', marginTop: 14 }]}>{appName} {Constants.expoConfig?.version ?? ''}</Text>
        </Section>
      ) : (
      <Section title="Danger zone">
        <Card>
          <Row title={`Delete ${bot.name}`} detail={bot.isPrimary ? 'Make another bot primary first.' : 'Removes its chat, memories, skills and routines for good.'} last
            right={<SmallButton title="Delete" danger disabled={bot.isPrimary} onPress={() => confirm(`Delete ${bot.name}?`, 'Its chat, memories, skills and routines go for good.', 'Delete', () => api.deleteBot(bot.id).then(onDeleted).catch((e) => flash(e?.message ?? 'Could not delete.', true)))} />} />
        </Card>
      </Section>
      )}
    </View>
  );
}


type VisualsLevel = NonNullable<Bot['visuals']>;
const VISUALS_OPTS: { value: VisualsLevel; label: string; hint: string }[] = [
  { value: 'minimal', label: 'Minimal', hint: 'Mostly plain text. Charts, calculators and Pages only when you ask; tap buttons still offered for quick questions.' },
  { value: 'balanced', label: 'Balanced', hint: 'Charts, calculators, checklists and Pages when they are clearly easier than text.' },
  { value: 'rich', label: 'Rich', hint: 'Looks for every chance to show rather than tell: tables and charts, calculators for money and what-ifs, progress bars, tap buttons and Pages.' },
];

/**
 * How often the bot answers with views, calculators, tap choices and Pages (server visuals-level.ts).
 * A tap saves. How this phone draws them is the separate Answer visuals switch under Appearance.
 */
function VisualsSection({ api, bot, onBot, simple }: { api: Client; bot: Bot; onBot: (b: Bot) => void; simple?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current: VisualsLevel = bot.visuals ?? 'rich';
  const pick = (v: VisualsLevel) => {
    if (v === current) return;
    setBusy(true); setError(null);
    api.updateBot(bot.id, { visuals: v }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change it.')).finally(() => setBusy(false));
  };
  return (
    <Section title={simple ? 'Pictures and charts in answers' : 'Visuals in replies'} hint={`${VISUALS_OPTS.find((o) => o.value === current)?.hint}${simple ? '' : ' A tap on a view is a reply, never an approval.'}`}>
      <View accessibilityRole="radiogroup" accessibilityLabel={`How often ${bot.name} uses visuals`} style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {VISUALS_OPTS.map((o) => <Chip key={o.value} title={o.label} selected={current === o.value} onPress={busy ? undefined : () => pick(o.value)} />)}
      </View>
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

type BusySend = NonNullable<Bot['busySend']>;
const BUSY_OPTS: { value: BusySend; label: string; hint: (name: string, group: boolean) => string }[] = [
  { value: 'steer', label: 'Steer', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working joins the reply in progress at the next step, marked "Steering". Nothing stops; approval cards stay open.` },
  { value: 'queue', label: 'Queue', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working waits until the reply is finished, then gets its own reply.` },
  { value: 'interrupt', label: 'Interrupt', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working stops the reply in progress and starts over with your message.` },
];

/** What a message sent while the bot works does (server steer-mode.ts). A tap saves. Stop works the same in every mode. */
function BusySendSection({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current: BusySend = bot.busySend ?? 'steer';
  const group = bot.kind === 'room';
  const pick = (v: BusySend) => {
    if (v === current) return;
    setBusy(true); setError(null);
    api.updateBot(bot.id, { busySend: v }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change it.')).finally(() => setBusy(false));
  };
  return (
    <Section title={group ? 'Messages while members work' : 'Messages while it works'} hint={`${BUSY_OPTS.find((o) => o.value === current)?.hint(bot.name, group)} Stop still stops it.`}>
      <View accessibilityRole="radiogroup" accessibilityLabel={`What a message sent while ${bot.name} is working does`} style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {BUSY_OPTS.map((o) => <Chip key={o.value} title={o.label} selected={current === o.value} onPress={busy ? undefined : () => pick(o.value)} />)}
      </View>
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

/**
 * "Hide from my list" (server Bot.ownerHidden): off Home, its counts and the group pickers, and no notifications
 * on this phone, the website or Windows. The bot keeps working and talking to the other bots; groups it is in
 * stay. Not in the simple view (a scoped sign-in keeps its bot) and not for the primary bot.
 */
function HideFromListSection({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = !!bot.ownerHidden;
  const flip = (v: boolean) => {
    setBusy(true); setError(null);
    api.updateBot(bot.id, { ownerHidden: v }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change it.')).finally(() => setBusy(false));
  };
  return (
    <Section>
      <Card>
        <Row title="Hide from my list" last
          detail={on ? `Hidden: ${bot.name} is not on your Bots screen and sends you no notifications. It still works and talks to your other bots.` : `Takes ${bot.name} off your Bots screen and stops its notifications on this phone, the website and Windows. It keeps working.`}
          right={<Switch value={on} disabled={busy} onValueChange={flip} accessibilityLabel={`Hide ${bot.name} from my list`} />} />
      </Card>
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

/**
 * Web search by API (server web-search.ts): on, the bot looks things up with web_search and reads pages
 * with web_extract instead of a search engine in its browser. Saves on tap; a bot the app runs restarts its
 * agent to pick it up. The service and this month's use are under Connections.
 */
function WebSearchSection({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = bot.webSearch !== false;
  const flip = (v: boolean) => {
    setBusy(true); setError(null);
    api.updateBot(bot.id, { webSearch: v }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change it.')).finally(() => setBusy(false));
  };
  return (
    <Section>
      <Card>
        <Row title="Search the web" last
          detail={on ? `${bot.name} looks things up with a search service and reads pages as text, without opening a browser. The browser is kept for sites that need a sign-in.` : `Off: ${bot.name} can only look things up in its browser.`}
          right={<Switch value={on} disabled={busy} onValueChange={flip} accessibilityLabel={`${bot.name} searches the web`} />} />
      </Card>
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

/**
 * Phone timers and alarms (server phone.ts): on, the bot can set timers and alarms in this phone's Clock app
 * through the background link, with no card. Android only lets an app open the Clock app from the background
 * when it may draw over other apps; without that, each one waits for a tap on a notification. The second row
 * opens that Android setting.
 */
function PhoneSection({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noTap, setNoTap] = useState(() => background.canStartInBackground());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setNoTap(background.canStartInBackground()); });
    return () => sub.remove();
  }, []);
  const on = bot.phoneActions === true;
  const flip = (v: boolean) => {
    setBusy(true); setError(null);
    api.updateBot(bot.id, { phoneActions: v }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change it.')).finally(() => setBusy(false));
  };
  const showNoTap = on && background.phoneActionsAvailable;
  return (
    <Section>
      <Card>
        <Row title="Phone timers and alarms" last={!showNoTap}
          detail={on ? `${bot.name} can set timers and alarms in this phone's Clock app, with no card. Each one shows a line in the chat.` : `Off: ${bot.name} can't reach your Clock app. Reminders still ring on every app.`}
          right={<Switch value={on} disabled={busy} onValueChange={flip} accessibilityLabel={`${bot.name} sets phone timers and alarms`} />} />
        {showNoTap && (
          <Row title="Allow without a tap" last onPress={() => background.openOverlaySettings()}
            detail={noTap ? 'On: timers and alarms are set even while YBots is in the background.' : 'Off: when YBots is in the background, each one waits for a tap on a notification. Turn on "Display over other apps" for YBots to skip the tap.'} />
        )}
      </Card>
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

/**
 * The bot's colour in chats (chatColors.ts): its name, bar and bubble tint where it writes in another
 * bot's chat or a group. A tap saves; "Use automatic" goes back to the colour picked for it.
 */
function ChatColorSection({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (c: ChatColor | null) => {
    setBusy(true); setError(null);
    api.updateBot(bot.id, { chatColor: c }).then((r) => onBot(r.bot)).catch((e) => setError(e?.message ?? 'Could not change the colour.')).finally(() => setBusy(false));
  };
  const current = bot.chatColor ?? null;
  const ink = chatInk(current, currentScheme());
  return (
    <Section title="Color in chats" hint={bot.chatColorAuto ? 'Picked automatically so no two bots match. Tap a color to choose your own.' : 'Chosen by you.'}>
      <View style={{ marginBottom: 12, gap: 4 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: ink.ink }}>{bot.name}</Text>
        <View style={{ alignSelf: 'flex-start', backgroundColor: ink.tint, borderLeftWidth: 3, borderLeftColor: ink.bar, borderRadius: 18, borderTopLeftRadius: 6, borderBottomLeftRadius: 6, paddingVertical: 9, paddingHorizontal: 14 }}>
          <Text style={{ fontSize: 15, lineHeight: 21, color: color.ink }}>How {bot.name}'s messages look in other chats and groups.</Text>
        </View>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${bot.name}'s color in chats`} style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {CHAT_COLOR_ORDER.map((c) => {
          const on = c === current;
          return (
            <Pressable key={c} accessibilityRole="radio" accessibilityLabel={c} accessibilityState={{ checked: on, disabled: busy }} disabled={busy} onPress={() => pick(c)}
              style={{ width: `${100 / 9}%`, minWidth: 40, alignItems: 'center', paddingVertical: 5 }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, borderWidth: on ? 2 : 0, borderColor: color.ink, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: on ? 26 : 30, height: on ? 26 : 30, borderRadius: 15, backgroundColor: CHAT_COLORS[c][currentScheme()].bar }} />
              </View>
            </Pressable>
          );
        })}
      </View>
      {!bot.chatColorAuto && <Pressable accessibilityRole="button" disabled={busy} onPress={() => pick(null)} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 6 }}><Text style={{ fontSize: 15, color: color.link }}>Use automatic</Text></Pressable>}
      {!!error && <Text style={[type.caption, { color: color.danger, marginTop: 6 }]}>{error}</Text>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// A group chat's own settings: what it is for and the instructions its members follow in it.

type GroupDraft = { name: string; label: string; description: string; instructions: string; avatarShape: string; avatarColor: string };
const groupDraftOf = (b: Bot): GroupDraft => ({ name: b.name, label: b.label ?? '', description: b.description ?? '', instructions: b.instructions ?? '', avatarShape: b.avatarShape, avatarColor: b.avatarColor });

function GroupGeneral({ api, bot, onBot, onDeleted, onLook }: { api: Client; bot: Bot; onBot: (b: Bot) => void; onDeleted: () => void; onLook: () => void }) {
  const [draft, setDraft] = useState<GroupDraft>(() => groupDraftOf(bot));
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const { flash, view } = useFlash();
  const base = groupDraftOf(bot);
  const changed = (Object.keys(draft) as (keyof GroupDraft)[]).filter((k) => draft[k] !== base[k]);
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof GroupDraft>(k: K, v: GroupDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!changed.length || !nameOk) return;
    setSaving(true);
    try {
      const patch: BotPatch = {};
      for (const k of changed) (patch as any)[k] = k === 'name' ? draft.name.trim() : draft[k];
      onBot((await api.updateBot(bot.id, patch)).bot);
      flash('Saved');
    } catch (e: any) { flash(e?.message ?? 'Could not save.', true); }
    finally { setSaving(false); }
  };

  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel="Change icon" accessibilityState={{ expanded: picker }} onPress={() => setPicker(!picker)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 16, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.fill, marginBottom: picker ? 14 : 22 })}>
        <BotAvatar bot={draft.avatarShape === bot.avatarShape && draft.avatarColor === bot.avatarColor ? bot : { ...bot, avatarShape: draft.avatarShape, avatarColor: draft.avatarColor, avatarImageUrl: null } as Bot} size={64} server={api.server} auth={api.authHeader} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.name}>{draft.name || bot.name}</Text>
          <Text style={type.caption}>{picker ? 'Done' : 'Change icon'}</Text>
        </View>
        <Icon name="chevron" size={18} color={color.timestamp} />
      </Pressable>
      {picker && <View style={{ marginBottom: 22 }}><ShapePicker shape={draft.avatarShape} tint={draft.avatarColor} onShape={(v) => put('avatarShape', v)} onTint={(v) => put('avatarColor', v)} /></View>}
      <View style={{ alignItems: 'flex-start', marginTop: -12, marginBottom: 18 }}>
        <SmallButton title={bot.avatarImageUrl ? 'Change picture' : 'Make a group picture instead'} onPress={onLook} />
      </View>

      <Section title="Group name" hint="Bots use this name to post here.">
        <TextInput value={draft.name} onChangeText={(v) => put('name', v)} maxLength={60} style={input()} accessibilityLabel="Group name" />
      </Section>
      <Section title="Label" hint={'Shown next to the name, like "Family" or "Planning".'}>
        <TextInput value={draft.label} onChangeText={(v) => put('label', v)} maxLength={60} placeholder="Add a label" placeholderTextColor={color.timestamp} style={input()} accessibilityLabel="Label" />
      </Section>
      <Section title="About" hint="What this group is for. Every member is told this when it answers here.">
        <TextInput value={draft.description} onChangeText={(v) => put('description', v)} maxLength={500} multiline placeholder="What is this group for?" placeholderTextColor={color.timestamp}
          style={[input(), { minHeight: 70, textAlignVertical: 'top' }]} accessibilityLabel="About" />
      </Section>
      <Section title="Instructions" hint="How the bots should behave in this group, like who leads, how long replies are, or what to leave alone. Each bot still follows its own instructions too.">
        <TextInput value={draft.instructions} onChangeText={(v) => put('instructions', v)} maxLength={8000} multiline placeholder="e.g. One bot answers unless I ask for everyone." placeholderTextColor={color.timestamp}
          style={[input(), { minHeight: 150, textAlignVertical: 'top' }]} accessibilityLabel="Instructions" />
      </Section>

      {view}
      {changed.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 24 }}>
          <PillButton title="Discard" kind="secondary" onPress={() => setDraft(groupDraftOf(bot))} disabled={saving} style={{ flex: 1 }} />
          <PillButton title={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving || !nameOk} style={{ flex: 1 }} />
        </View>
      )}

      {background.notifyAvailable && <Section title="Notifications"><Card><MuteRow api={api} bot={bot} /></Card></Section>}
      <Section title="Conversation">
        <Card>
          <Row title="New conversation" detail="Clears the group chat. Members, instructions and skills stay." last
            right={<SmallButton title="Start new" onPress={() => { startFresh(api, bot).catch((e) => flash(e?.message ?? 'Could not start fresh.', true)); }} />} />
        </Card>
      </Section>
      <Section title="Danger zone">
        <Card>
          <Row title={`Delete ${bot.name}`} detail="Removes the group chat, its instructions and skills. The bots in it stay." last
            right={<SmallButton title="Delete" danger onPress={() => confirm(`Delete ${bot.name}?`, 'The group chat goes for good. The bots in it stay.', 'Delete', () => api.deleteBot(bot.id).then(onDeleted).catch((e) => flash(e?.message ?? 'Could not delete.', true)))} />} />
        </Card>
      </Section>
    </View>
  );
}

// ---------------------------------------------------------------------------

const TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Small talk, quick asks, teammate replies' },
  { id: 'standard', label: 'Standard', hint: 'Most requests' },
  { id: 'heavy', label: 'Heavy', hint: 'Planning, analysis, code, long work' },
];
const DEFAULT_EFFORT: Record<ModelTier, Effort> = { light: 'low', standard: 'medium', heavy: 'high' };
type Tiers = Partial<Record<ModelTier, { model: string; effort: Effort }>>;
const sameTiers = (a: Tiers | null, b: Tiers | null) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * A section that folds away (the phone's take on the web Engine section's fold): a header with a chevron,
 * a one-line summary and a problem count while closed. Open or closed is remembered on this phone; closed at first.
 */
function Fold({ title, summary, problems, storeKey, children }: { title: string; summary: string; problems: number; storeKey: string; children: React.ReactNode }) {
  const [open, setOpenState] = useState(() => { try { return SecureStore.getItem(storeKey) === '1'; } catch { return false; } });
  const setOpen = (v: boolean) => { setOpenState(v); SecureStore.setItemAsync(storeKey, v ? '1' : '0').catch(() => {}); };
  const problemText = `${problems} ${problems === 1 ? 'problem' : 'problems'}`;
  return (
    <View style={{ marginBottom: 18 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${open ? 'open' : 'closed'}${problems ? `, ${problemText}` : ''}`}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.fill, marginBottom: open ? 14 : 0 })}>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron" size={16} color={color.inkMuted} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
          {!open && <Text numberOfLines={1} style={[type.caption, { fontSize: 13 }]}>{summary}</Text>}
        </View>
        {problems > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 12, backgroundColor: color.problemFill }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.danger }} />
            <Text style={{ fontSize: 12, color: color.problemInk }}>{problemText}</Text>
          </View>
        )}
      </Pressable>
      {open && children}
    </View>
  );
}

function Model({ api, bot, onBot, onComputer }: { api: Client; bot: Bot; onBot: (b: Bot) => void; onComputer: () => void }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [tiers, setTiers] = useState<Tiers>({});
  const [lock, setLock] = useState(false);
  /** The one-time "I understand" for picking an opt-in provider (the Claude subscription) that is off for this bot. */
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { flash, view } = useFlash();
  const botRef = useRef(bot);
  botRef.current = bot;

  const apply = useCallback((e: EngineInfo) => {
    setEngine(e); setPhase('ok');
    setProvider(e.provider ?? ''); setModel(e.model ?? ''); setMode(e.modelMode); setTiers(e.modelTiers ?? {}); setLock(!!e.providerLock); setAck(false);
    const b = botRef.current;
    if (e.model !== b.model || e.provider !== b.provider) onBot({ ...b, model: e.model, provider: e.provider });
  }, [onBot]);
  const load = useCallback((quiet = false) => {
    if (!quiet) setPhase('loading');
    api.engine(bot.id).then((r) => apply(r.engine)).catch(() => { if (!quiet) setPhase('unavailable'); });
  }, [api, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (engine?.status !== 'starting') return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [engine?.status, load]);

  if (phase !== 'ok' || !engine) {
    return phase === 'loading' ? <ActivityIndicator color={color.ink} style={{ marginTop: 30 }} />
      : <View style={{ gap: 12 }}><Notice tone="problem">The model settings are not available right now.</Notice><PillButton title="Try again" kind="secondary" onPress={() => load()} /></View>;
  }

  const providers = [...engine.providers].sort((a, b) => Number(b.connected) - Number(a.connected));
  const selected = providers.find((p) => p.id === provider) ?? null;
  const listed = engine.catalog?.find((c) => c.id === selected?.id) ?? null;
  const known = selected?.models.length ? selected.models : listed?.models ?? [];
  // Picking the Claude subscription while it is off for this bot switches it on in the same save, once the warning is accepted.
  const needsOptIn = !!selected?.optIn && !selected.enabled && provider !== (engine.provider ?? '');
  const preset = provider ? engine.tierPresets?.[provider] : undefined;
  const wantLock = lock ? (provider || null) : null;
  const changed = provider !== (engine.provider ?? '') || model.trim() !== (engine.model ?? '') || mode !== engine.modelMode
    || !sameTiers(tiers, engine.modelTiers) || wantLock !== (engine.providerLock ?? null);
  // The Claude subscription route has no sign-in here: it uses the bots' own Claude login on the server.
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected && !selected.optIn ? selected : null;

  const pickProvider = (id: string) => {
    setProvider(id); setAck(false);
    const next = providers.find((p) => p.id === id);
    const list = next?.models.length ? next.models : engine.catalog?.find((c) => c.id === id)?.models ?? [];
    if (list.length && !list.includes(model.trim())) setModel(list[0]);
  };
  const setTier = (t: ModelTier, patch: Partial<{ model: string; effort: Effort }>) => setTiers((cur) => {
    const next = { ...(cur[t] ?? { model: '', effort: DEFAULT_EFFORT[t] }), ...patch };
    const out = { ...cur };
    if (next.model.trim()) out[t] = next; else delete out[t];
    return out;
  });
  const run = async (what: string, fn: () => Promise<{ engine: EngineInfo } | unknown>, done?: string) => {
    setBusy(what);
    try { const r: any = await fn(); if (r?.engine) apply(r.engine); if (done) flash(done); }
    catch (e: any) { flash(e?.message ?? 'The agent did not answer.', true); }
    finally { setBusy(null); }
  };
  const save = () => run('save', async () => {
    const p: Parameters<Client['setEngine']>[1] = {};
    if (provider && provider !== (engine.provider ?? '')) p.provider = provider;
    if (model.trim() && model.trim() !== (engine.model ?? '')) p.model = model.trim();
    if (mode !== engine.modelMode) p.modelMode = mode;
    if (!sameTiers(tiers, engine.modelTiers)) p.modelTiers = Object.keys(tiers).length ? (tiers as EngineInfo['modelTiers']) : null;
    if (wantLock !== (engine.providerLock ?? null)) p.providerLock = wantLock;
    if (needsOptIn) { p.allowSubscription = true; p.acknowledgeSubscriptionTerms = true; }
    const r = await api.setEngine(bot.id, p);
    if (r.notes?.length) setTimeout(() => flash(r.notes!.join(' '), true), 1600);
    return r;
  }, 'Saved');
  const signIn = () => run('signin', async () => { await api.engineLogin(bot.id, signInTo?.id); onComputer(); });

  const STATUS = { ready: 'Ready', starting: 'Starting…', stopped: 'Stopped', error: 'Problem' } as const;
  const sum = engineSummary(engine, bot.effort);
  return (
    <View>
      <Card>
        <Row title={sum.line} detail={sum.providerName ?? 'Default provider'} />
        <Row title={STATUS[engine.status] ?? engine.status} detail={`Hermes${engine.version ? ` ${engine.version}` : ''} · profile ${engine.profile}`} last
          right={(engine.status === 'error' || engine.status === 'stopped') ? <SmallButton title={busy === 'restart' ? 'Restarting…' : 'Restart'} disabled={!!busy} onPress={() => run('restart', () => api.restartEngine(bot.id))} /> : undefined} />
      </Card>
      {engine.status === 'error' && !!engine.error && <View style={{ marginTop: 10 }}><Notice tone="problem">{engine.error}</Notice></View>}
      {sum.problems.length > 0 && <View style={{ marginTop: 10 }}><Notice tone="problem">{sum.problems.length === 1 ? sum.problems[0] : sum.problems.map((p) => `• ${p}`).join('\n')}</Notice></View>}
      <View style={{ height: 22 }} />

      <Section title="Provider">
        <View style={{ gap: 8 }}>
          {providers.map((p) => (
            <Pressable key={p.id} accessibilityRole="radio" accessibilityState={{ selected: provider === p.id }} onPress={() => pickProvider(p.id)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, backgroundColor: provider === p.id ? color.primary : pressed ? color.pressed : color.fill })}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '500', color: provider === p.id ? color.onPrimary : color.ink }}>{p.name}</Text>
                <Text style={{ fontSize: 13, color: provider === p.id ? color.onPrimaryMuted : color.inkMuted }}>{p.optIn && !p.enabled ? 'Off for this bot, choose to switch on' : `${p.kind === 'subscription' ? 'Subscription' : 'API key'} · ${p.connected ? 'Connected' : 'Not connected'}`}</Text>
              </View>
              {provider === p.id && <Icon name="check" size={18} color={color.onPrimary} />}
            </Pressable>
          ))}
        </View>
        {needsOptIn && (
          <View style={{ marginTop: 10, gap: 8 }}>
            {!!listed?.warning && <Notice>{listed.warning}</Notice>}
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: ack }} onPress={() => setAck((a) => !a)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 4 }}>
              <Switch value={ack} onValueChange={setAck} />
              <Text style={[type.body, { flex: 1, fontSize: 14 }]}>I understand the warning and want {bot.name} to be able to use my Claude subscription. Saving switches it on for {bot.name}.</Text>
            </Pressable>
          </View>
        )}
        {signInTo && <View style={{ marginTop: 10 }}><PillButton title={busy === 'signin' ? 'Opening sign-in…' : `Sign in to ${signInTo.name}`} icon="monitor" kind="secondary" onPress={signIn} disabled={!!busy} /></View>}
        {signInTo && <Text style={[type.caption, { fontSize: 13, marginTop: 6, marginHorizontal: 4 }]}>Sign-in opens on {bot.name}'s computer. Finish it there, then hand back.</Text>}
      </Section>

      <Section title={mode === 'auto' ? 'Fallback model' : 'Model'}>
        {known.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
            {known.map((m) => <Chip key={m} title={m} selected={model.trim() === m} onPress={() => setModel(m)} />)}
          </ScrollView>
        )}
        <TextInput value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} placeholder={known[0] ?? 'Model id'} placeholderTextColor={color.timestamp}
          style={[input(), { fontFamily: 'monospace', fontSize: 15 }]} accessibilityLabel="Model id" />
      </Section>

      <Section title="Model choice" hint={mode === 'auto' ? 'Each turn picks a tier from how hard it looks, on the same provider. Empty tiers use the next one up, then the model above.' : 'Every turn uses the model above.'}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip title="Manual" selected={mode === 'manual'} onPress={() => setMode('manual')} />
          <Chip title="Auto" selected={mode === 'auto'} onPress={() => { setMode('auto'); if (preset && !Object.keys(tiers).length) setTiers({ ...preset.tiers }); }} />
        </View>
      </Section>
      {mode === 'auto' && (
        <Section>
          {preset && <View style={{ marginBottom: 12 }}><PillButton title={`Use suggested ${preset.label} tiers`} kind="secondary" onPress={() => setTiers({ ...preset.tiers })} /></View>}
          <View style={{ gap: 14 }}>
            {TIERS.map((t) => {
              const c = tiers[t.id];
              return (
                <View key={t.id} style={{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 10 }}>
                  <View>
                    <Text style={[type.body, { fontWeight: '600' }]}>{t.label}</Text>
                    <Text style={[type.caption, { fontSize: 13 }]}>{t.hint}</Text>
                  </View>
                  <TextInput value={c?.model ?? ''} onChangeText={(v) => setTier(t.id, { model: v })} autoCapitalize="none" autoCorrect={false} placeholder="Model id (empty = next tier up)" placeholderTextColor={color.timestamp}
                    style={[input(), { backgroundColor: color.surface, fontFamily: 'monospace', fontSize: 14, paddingVertical: 10 }]} accessibilityLabel={`${t.label} model`} />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {EFFORTS.map((e) => <Chip key={e.value} onCard title={e.label} selected={(c?.effort ?? DEFAULT_EFFORT[t.id]) === e.value} onPress={() => setTier(t.id, { model: c?.model ?? '', effort: e.value })} />)}
                  </View>
                </View>
              );
            })}
          </View>
        </Section>
      )}
      {!!provider && (
        <Card>
          <Row title={`Only ever use ${selected?.name ?? provider}`} last right={<Switch value={lock} onValueChange={setLock} />} />
        </Card>
      )}
      <View style={{ height: 18 }} />
      {view}
      {changed && (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 18 }}>
          <PillButton title="Undo" kind="secondary" onPress={() => apply(engine)} disabled={!!busy} style={{ flex: 1 }} />
          <PillButton title={busy === 'save' ? 'Saving…' : 'Save'} onPress={save} disabled={!!busy || (needsOptIn && !ack)} style={{ flex: 1 }} />
        </View>
      )}
      {!!engine.catalog?.length && (
        <Fold title="Providers and fallbacks" storeKey="cleftbot.engineProvidersOpen"
          summary={`${engine.catalog.length} listed · ${engine.fallbacks?.length ? `${engine.fallbacks.length} fallback${engine.fallbacks.length === 1 ? '' : 's'}` : 'no fallbacks'}`}
          problems={sum.problems.length}>
          <ProviderCatalog api={api} engine={engine} onEngine={apply} flash={flash} />
        </Fold>
      )}
      {!!engine.restartNote && <View style={{ marginBottom: 18 }}><Notice>{engine.restartNote}</Notice></View>}
      {engine.ownScreen && (
        <View style={{ gap: 10, marginBottom: 18 }}>
          <Notice>{bot.name} also has a private screen of its own switched on. Desktop work it does there will not show on the computer view.</Notice>
          <PillButton title={busy === 'screen' ? 'Switching…' : 'Use the shared screen'} kind="secondary" disabled={!!busy} onPress={() => run('screen', () => api.stopOwnScreen(bot.id))} />
        </View>
      )}
      {engine.lastRoute && (
        <Text style={[type.caption, { fontSize: 13 }]}>
          Last turn: {engine.lastRoute.tier ? `${engine.lastRoute.tier} · ` : ''}{engine.lastRoute.model ?? 'engine default'}{engine.lastRoute.ok ? '' : ' · failed'}. {engine.lastRoute.reason}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------

const FALLBACK_VOICES: VoiceOptions = {
  voices: [['af_heart', 'Heart'], ['af_bella', 'Bella'], ['am_michael', 'Michael'], ['am_adam', 'Adam']].map(([id, name]) => ({ id, name })),
  defaultVoice: 'af_heart',
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

type VoiceItem = VoiceOptions['voices'][number];

/** Voices under their headings ("American English", "British English", ...), in the server's order. */
// ---------------------------------------------------------------------------
// Tools: which connected servers (MCP apps and plugins, on this machine or others in the cluster) the
// bot can use. Same API and same propose-then-confirm as the web app's Tools tab and Plugins page.

function accessLine(p: PluginInfo): string {
  if (p.status !== 'ready') return p.error ? `${p.status}: ${p.error}` : p.status === 'disabled' ? 'Turned off for every bot' : 'Not running';
  const reads = p.reads ?? 0;
  const usable = p.tools - (p.blocked ?? 0);
  if (p.readOnly) return `Reads only · ${reads} of ${p.tools} tools`;
  if (usable > reads) return `Reads run, changes ask you first · ${usable} of ${p.tools} tools`;
  return `${usable} of ${p.tools} tools, all reads`;
}

function Tools({ api, bot }: { api: Client; bot: Bot }) {
  const [data, setData] = useState<{ owner: boolean; plugins: PluginInfo[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { flash, view } = useFlash();
  const sw = usePluginSwitch<{ owner: boolean; plugins: PluginInfo[] } | null>(api, setData as never, (m) => flash(m, true), false);
  const load = useCallback(() => {
    api.plugins().then((d) => { setData(d); setProblem(null); }).catch((e) => setProblem(e?.message ?? 'Could not load tools.'));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  if (problem) return <View style={{ gap: 12 }}><Notice tone="problem">{problem}</Notice><PillButton title="Try again" kind="secondary" onPress={load} /></View>;
  if (!data) return <ActivityIndicator color={color.ink} style={{ marginTop: 30 }} />;
  const rows = data.plugins.map((p) => ({ p, me: p.bots.find((b) => b.id === bot.id) })).filter((r) => r.me);
  const list = (items: typeof rows) => (
    <Card>
      {items.map(({ p, me }, i) => (
        <Row key={p.id} last={i === items.length - 1} title={`${p.name}${p.readOnly ? ' · read only' : ''}`}
          detail={`${accessLine(p)}${me!.fromDefault ? ' · default' : ''}${p.description ? `\n${p.description}` : ''}`}
          right={<Switch value={me!.enabled} disabled={!data.owner || sw.pending === `${p.id}:${bot.id}`} onValueChange={(v) => sw.flip(p.id, bot.id, v)} accessibilityLabel={`${p.name} for ${bot.name}`} />} />
      ))}
    </Card>
  );
  const on = rows.filter((r) => r.me!.enabled);
  const off = rows.filter((r) => !r.me!.enabled);

  return (
    <View>
      {view}
      {sw.toast}
      <Section hint={`What ${bot.name} can reach. Add new ones from your profile › Connections. Reads run on their own; anything that changes data, spends money or touches a computer asks you on a card first, and a bot can never answer one.`}>
        {null}
      </Section>
      {!data.owner && <View style={{ marginBottom: 14 }}><Notice tone="note">Only the owner of this server can change which tools a bot has.</Notice></View>}
      {!rows.length && <Notice tone="note">Nothing is connected yet. Add a connection from your profile › Connections.</Notice>}
      {on.length > 0 && <Section title={`On for ${bot.name}`}>{list(on)}</Section>}
      {off.length > 0 && <Section title="Off">{list(off)}</Section>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers: short-lived sub-agents the bot's agent may start for a job (server/src/helpers.ts).

const HELPER_TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'light', label: 'Fast', hint: 'Lookups, status checks, summaries, simple edits.' },
  { id: 'standard', label: 'Standard', hint: 'Most jobs: multi-step checks and ordinary fixes.' },
  { id: 'heavy', label: 'Deep', hint: 'Hard debugging and risky changes. Costs the most.' },
];
const TIER_RANK: Record<ModelTier, number> = { light: 0, standard: 1, heavy: 2 };
const RUN_STATE: Record<string, string> = { running: 'Working', completed: 'Done', failed: 'Failed', interrupted: 'Stopped', timeout: 'Timed out', unknown: 'Unknown' };
const helperDraft = (h: HelperSettings): HelperSettings => ({
  enabled: h.enabled, maxAtOnce: h.maxAtOnce, stepLimit: h.stepLimit, maxTier: h.maxTier, defaultTier: h.defaultTier,
  routes: Object.fromEntries(Object.entries(h.routes).map(([k, r]) => [k, { model: r!.model, effort: r!.effort }])),
});

function Stepper({ value, min, max, step = 1, onChange, disabled, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean; label: string }) {
  const btn = (title: string, next: number) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${title === '+' ? 'more' : 'fewer'}`} disabled={disabled || next < min || next > max} onPress={() => onChange(next)}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface, opacity: disabled || next < min || next > max ? 0.4 : pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 20, color: color.ink }}>{title}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {btn('−', value - step)}
      <Text style={[type.body, { minWidth: 36, textAlign: 'center', fontWeight: '600' }]}>{value}</Text>
      {btn('+', value + step)}
    </View>
  );
}

function Helpers({ api, bot }: { api: Client; bot: Bot }) {
  const [data, setData] = useState<HelpersBundle | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<HelperSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const { flash, view } = useFlash();
  const load = useCallback(() => {
    api.helpers(bot.id).then((d) => { setData(d); setDraft(helperDraft(d.helpers)); setProblem(null); }).catch((e) => setProblem(e?.message ?? 'Could not load helper settings.'));
  }, [api, bot.id]);
  useEffect(() => { load(); }, [load]);

  if (problem) return <View style={{ gap: 12 }}><Notice tone="problem">{problem}</Notice><PillButton title="Try again" kind="secondary" onPress={load} /></View>;
  if (!data || !draft) return <ActivityIndicator color={color.ink} style={{ marginTop: 30 }} />;
  const h = data.helpers;
  const ro = !data.canEdit;
  const put = (p: Partial<HelperSettings>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const setRoute = (t: ModelTier, model: string | null, effort?: Effort | null) => setDraft((d) => {
    if (!d) return d;
    const routes = { ...d.routes };
    if (!model) delete routes[t];
    else routes[t] = { model, effort: effort !== undefined ? effort : routes[t]?.effort ?? null };
    return { ...d, routes };
  });
  const models = [...new Set([...data.models, ...Object.values(draft.routes).map((r) => r!.model)])];
  const allowed = HELPER_TIERS.filter((t) => TIER_RANK[t.id] <= TIER_RANK[draft.maxTier] && draft.routes[t.id]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(helperDraft(h));
  const save = () => {
    setSaving(true);
    api.setHelpers(bot.id, draft)
      .then((d) => { setData(d); setDraft(helperDraft(d.helpers)); flash('Saved to the agent\'s settings'); })
      .catch((e) => flash(e?.message ?? 'Could not save.', true))
      .finally(() => setSaving(false));
  };

  return (
    <View>
      {view}
      <Section hint={`For a big job, ${bot.name} can hand parts to short-lived helpers that work on their own and report back. They can only use tools ${bot.name} has, can't talk to you or change memory, and can never approve anything.`}>
        <Card>
          <Row title="Use helpers" detail={draft.enabled ? `${bot.name} may start helpers.` : `${bot.name} does all work itself.`} last
            right={<Switch value={draft.enabled} disabled={ro} onValueChange={(v) => put({ enabled: v })} accessibilityLabel="Use helpers" />} />
        </Card>
      </Section>
      {ro && <View style={{ marginBottom: 14 }}><Notice tone="note">Only the owner of this server can change these settings.</Notice></View>}
      <Section title="Limits">
        <Card>
          <Row title="Helpers at once" detail="1 to 10" right={<Stepper label="Helpers at once" value={draft.maxAtOnce} min={1} max={10} disabled={ro} onChange={(v) => put({ maxAtOnce: v })} />} />
          <Row title="Steps per helper" detail="10 to 250" last right={<Stepper label="Steps per helper" value={draft.stepLimit} min={10} max={250} step={10} disabled={ro} onChange={(v) => put({ stepLimit: v })} />} />
        </Card>
      </Section>
      <Section title="Strongest model a helper may use" hint="Tiers above this are not offered to the bot at all.">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {HELPER_TIERS.map((t) => <Chip key={t.id} title={t.label} selected={draft.maxTier === t.id} onPress={() => !ro && put({ maxTier: t.id })} />)}
        </View>
      </Section>
      <Section title={`Models helpers may run on${h.provider ? ` (${h.provider})` : ''}`}
        hint={!h.perJobChoice ? 'This bot\'s agent doesn\'t have the per-job model plugin, so every helper uses the default below.' : !data.models.length ? 'The agent didn\'t report a model list just now, so only models already set can be kept.' : 'Only this bot\'s own models (from its Model tab) are offered.'}>
        <View style={{ gap: 14 }}>
          {HELPER_TIERS.map((t) => {
            const r = draft.routes[t.id];
            const over = TIER_RANK[t.id] > TIER_RANK[draft.maxTier];
            return (
              <View key={t.id} style={{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 10, opacity: over ? 0.5 : 1 }}>
                <View>
                  <Text style={[type.body, { fontWeight: '600' }]}>{t.label}{over ? ' · above the cap' : ''}</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>{t.hint}</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Chip onCard title="Not offered" selected={!r} onPress={() => !ro && !over && setRoute(t.id, null)} />
                  {models.map((m) => <Chip key={m} onCard title={m} selected={r?.model === m} onPress={() => !ro && !over && setRoute(t.id, m)} />)}
                </View>
                {r && !over && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <Chip onCard title="Bot default" selected={!r.effort} onPress={() => !ro && setRoute(t.id, r.model, null)} />
                    {EFFORTS.map((e) => <Chip key={e.value} onCard title={e.label} selected={r.effort === e.value} onPress={() => !ro && setRoute(t.id, r.model, e.value)} />)}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </Section>
      {allowed.length > 0 && (
        <Section title="When the bot doesn't pick">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {allowed.map((t) => <Chip key={t.id} title={t.label} selected={(allowed.some((a) => a.id === draft.defaultTier) ? draft.defaultTier : allowed[0].id) === t.id} onPress={() => !ro && put({ defaultTier: t.id })} />)}
          </View>
        </Section>
      )}
      {!ro && dirty && (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 22 }}>
          <PillButton title="Undo" kind="secondary" onPress={() => setDraft(helperDraft(h))} disabled={saving} style={{ flex: 1 }} />
          <PillButton title={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving} style={{ flex: 1 }} />
        </View>
      )}
      <Section title="Recent helpers">
        {data.runs.length === 0 ? <Text style={[type.caption, { marginHorizontal: 4 }]}>No helpers have run yet.</Text> : (
          <Card>{data.runs.map((r, i) => <HelperRunRow key={r.id} r={r} last={i === data.runs.length - 1} />)}</Card>
        )}
        <View style={{ marginTop: 10 }}><PillButton title="Refresh" kind="secondary" onPress={load} /></View>
      </Section>
    </View>
  );
}

function HelperRunRow({ r, last }: { r: HelperRun; last: boolean }) {
  const when = new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const took = r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))} s` : null;
  const detail = [RUN_STATE[r.state] ?? r.state, when, took, r.models.join(', ')].filter(Boolean).join(' · ') + (r.summary ? `\n${r.summary}` : '');
  return <Row title={`${r.goals[0] ?? 'Helper job'}${r.goals.length > 1 ? ` and ${r.goals.length - 1} more` : ''}`} detail={detail} last={last} />;
}

function voiceGroups(voices: VoiceItem[]): { group: string; voices: VoiceItem[] }[] {
  const out: { group: string; voices: VoiceItem[] }[] = [];
  for (const v of voices) {
    const g = v.group ?? 'Voices';
    const at = out.find((x) => x.group === g);
    if (at) at.voices.push(v); else out.push({ group: g, voices: [v] });
  }
  return out;
}

/** One voice: a play button for its sample, and the rest of the row picks it. */
function VoiceRow({ v, selected, playing, onPlay, onPick, last }: { v: VoiceItem; selected: boolean; playing: boolean; onPlay: () => void; onPick: () => void; last: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline }}>
      <Pressable accessibilityRole="button" accessibilityLabel={playing ? `Stop ${v.name}` : `Play ${v.name}`} onPress={onPlay} hitSlop={6}
        style={({ pressed }) => ({ width: 36, height: 36, marginLeft: 10, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: playing ? color.primary : color.surface, opacity: pressed ? 0.75 : 1 })}>
        <Icon name={playing ? 'stop' : 'play'} size={playing ? 14 : 16} color={playing ? color.onPrimary : color.ink} strokeWidth={1.2} />
      </Pressable>
      <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPick}
        style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingLeft: 12, paddingRight: 16, backgroundColor: pressed ? color.pressed : 'transparent' })}>
        <Text style={[type.body, { flex: 1, fontWeight: selected ? '600' : '400' }]}>{v.name.replace(/\s*\(.*\)$/, '')}</Text>
        {!!v.gender && <Text style={[type.caption, { fontSize: 13, color: color.inkMuted }]}>{v.gender}</Text>}
        <View style={{ width: 20, alignItems: 'flex-end' }}>{selected && <Icon name="check" size={20} color={color.ink} />}</View>
      </Pressable>
    </View>
  );
}

function Voice({ api, bot, onBot }: { api: Client; bot: Bot; onBot: (b: Bot) => void }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK_VOICES);
  const { flash, view } = useFlash();
  const samples = useVoiceSamples(api);
  useEffect(() => { api.voiceOptions().then(setOpts).catch(() => {}); }, [api]);
  useEffect(() => { if (samples.error) flash(samples.error, true); }, [samples.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: BotPatch) => {
    const prev = bot;
    onBot({ ...bot, ...patch });
    try { onBot((await api.updateBot(bot.id, patch)).bot); }
    catch (e: any) { onBot(prev); flash(e?.message ?? 'Could not save.', true); }
  };
  const voice = opts.voices.some((v) => v.id === bot.voice) ? bot.voice : opts.defaultVoice ?? opts.voices[0]?.id;
  const current = opts.voices.find((v) => v.id === voice);
  const speed = bot.voiceSpeed ?? 1;
  const speeds = opts.speeds.includes(speed) ? opts.speeds : [...opts.speeds, speed].sort((a, b) => a - b);
  const lang = bot.voiceLanguage ?? 'auto';
  return (
    <View>
      {view}
      <Section title="Voice" hint={`Tap play to hear a voice, and tap its name to give it to ${bot.name}.`}>
        {!!voice && (
          <View style={{ marginBottom: 14 }}>
            <PillButton title={samples.playing === voice ? 'Stop' : opts.speeds.length > 1 ? `Hear ${current?.name ?? voice} at ${Number(speed.toFixed(2))}x` : `Hear ${current?.name ?? voice}`} icon={samples.playing === voice ? 'stop' : 'play'} kind="secondary"
              onPress={() => samples.play(voice, speed)} />
          </View>
        )}
        <View style={{ gap: 14 }}>
          {voiceGroups(opts.voices).map(({ group, voices }) => (
            <View key={group}>
              <Text style={[type.caption, { fontSize: 13, color: color.inkMuted, marginBottom: 6, marginHorizontal: 4 }]}>{group}</Text>
              <Card>
                {voices.map((v, i) => (
                  <VoiceRow key={v.id} v={v} selected={voice === v.id} playing={samples.playing === v.id} last={i === voices.length - 1}
                    onPlay={() => samples.play(v.id)} onPick={() => save({ voice: v.id })} />
                ))}
              </Card>
            </View>
          ))}
        </View>
      </Section>
      {/* A voice with one pace (Phonon) has no Speed setting: the server offers only 1x. */}
      {opts.speeds.length > 1 && (
        <Section title="Speed">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {speeds.map((s) => <Chip key={s} title={`${Number(s.toFixed(2))}x`} selected={speed === s} onPress={() => save({ voiceSpeed: s })} />)}
          </View>
        </Section>
      )}
      <Section title="Language">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {opts.languages.map((l) => <Chip key={l.code} title={l.name} selected={lang === l.code} onPress={() => save({ voiceLanguage: l.code })} />)}
        </View>
      </Section>
      <Text style={type.caption}>Changes save as you tap.</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

/** App-only skills: for groups (every member reads them there), and bots whose agent the app can't reach. */
function Skills({ api, bot, skills, onChange, notice }: { api: Client; bot: Bot; skills: Skill[] | undefined; onChange: () => void; notice?: string }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <View>
      <Text style={[type.caption, { marginBottom: 14 }]}>Step-by-step how-tos {bot.kind === 'room' ? 'everyone in this group follows here. Members can propose new ones after working on something together; you save them from the card' : `${bot.name} follows for specific jobs`}. Ask for one by name in chat.</Text>
      {!!notice && <View style={{ marginBottom: 12 }}><Notice>{notice}</Notice></View>}
      {editing === 'new' ? <SkillEditor api={api} botId={bot.id} onDone={() => { setEditing(null); onChange(); }} />
        : <View style={{ marginBottom: 16 }}><PillButton title="New skill" icon="plus" kind="secondary" onPress={() => setEditing('new')} /></View>}
      {!skills ? <ActivityIndicator color={color.ink} />
        : skills.length === 0 && editing !== 'new' ? <Notice>No skills yet. Write down how you like something done, and {bot.name} will follow it every time.</Notice>
        : (
          <View style={{ gap: 10 }}>
            {skills.map((k) => editing === k.id ? <SkillEditor key={k.id} api={api} botId={bot.id} skill={k} onDone={() => { setEditing(null); onChange(); }} /> : (
              <Pressable key={k.id} onPress={() => setEditing(k.id)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.fill })}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.body, { fontWeight: '500' }]}>{k.name}</Text>
                  <Text numberOfLines={2} style={[type.caption, { fontSize: 13 }]}>{k.description || k.body.split('\n')[0]}</Text>
                </View>
                <IconButton icon="close" label={`Delete ${k.name}`} onPress={() => confirm(`Delete "${k.name}"?`, `${bot.name} will stop following it.`, 'Delete', () => api.deleteSkill(k.id).then(onChange).catch((e: any) => toast(e?.message ?? 'Could not delete it.')))} />
              </Pressable>
            ))}
          </View>
        )}
    </View>
  );
}

function SkillEditor({ api, botId, skill, onDone }: { api: Client; botId: string; skill?: Skill; onDone: () => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = !!name.trim() && !!body.trim() && !busy;
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (skill) await api.updateSkill(skill.id, { name, description, body });
      else await api.createSkill(botId, { name, description, body });
      onDone();
    } catch (e: any) { setError(e?.message ?? 'Could not save.'); setBusy(false); }
  };
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: 18, backgroundColor: color.fill, marginBottom: 12 }}>
      <TextInput value={name} onChangeText={setName} maxLength={80} placeholder="Skill name, e.g. Weekly report" placeholderTextColor={color.timestamp} style={[input(), { backgroundColor: color.surface }]} accessibilityLabel="Skill name" />
      <TextInput value={description} onChangeText={setDescription} maxLength={300} placeholder="When to use it (optional)" placeholderTextColor={color.timestamp} style={[input(), { backgroundColor: color.surface }]} accessibilityLabel="When to use it" />
      <TextInput value={body} onChangeText={setBody} multiline placeholder={'Write the steps to follow:\n1. …\n2. …'} placeholderTextColor={color.timestamp}
        style={[input(), { backgroundColor: color.surface, minHeight: 160, textAlignVertical: 'top' }]} accessibilityLabel="Skill steps" />
      {error && <Notice tone="problem">{error}</Notice>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <PillButton title="Cancel" kind="secondary" onPress={onDone} style={{ flex: 1 }} />
        <PillButton title={busy ? 'Saving…' : skill ? 'Save' : 'Add skill'} onPress={save} disabled={!can} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------

function Memories({ api, bot, data, onChange, simple, onAsk }: { api: Client; bot: Bot; data: SettingsBundle | null; onChange: () => void; simple?: boolean; onAsk?: (text: string) => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { flash, view } = useFlash();
  const list = (data?.memories ?? []).filter((m) => !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase())));
  const forget = (id: string) => {
    setHidden((h) => new Set(h).add(id));
    api.deleteMemory(id).then(() => { flash('Forgotten'); onChange(); }).catch((e) => { setHidden((h) => { const n = new Set(h); n.delete(id); return n; }); flash(e?.message ?? 'Could not forget it. Try again.', true); });
  };
  const fill = data ? Math.min(100, Math.round((data.memory.historyChars / Math.max(1, data.memory.compactAtChars)) * 100)) : 0;
  return (
    <View>
      <Text style={[type.caption, { marginBottom: 14 }]}>What {bot.name} remembers about you. It saves things when you share them, and picks up more once a chat goes quiet.{simple && !onAsk ? ` To add one, tell ${bot.name} "remember that…".` : ''}</Text>
      {simple && onAsk && <PillButton title={`Tell ${bot.name} something to remember`} icon="plus" kind="secondary" style={{ marginBottom: 14 }} onPress={() => onAsk('Remember that ')} />}
      {view}
      {(data?.memories.length ?? 0) > 6 && (
        <TextInput value={q} onChangeText={setQ} placeholder="Search memories" placeholderTextColor={color.timestamp} style={[input(), { marginBottom: 12 }]} accessibilityLabel="Search memories" />
      )}
      {!data ? <ActivityIndicator color={color.ink} /> : list.length === 0 ? <Notice>{q ? 'No memories match.' : `Nothing yet. Tell ${bot.name} about yourself, or just chat.`}</Notice> : (
        <View style={{ gap: 10 }}>
          {list.map((m) => (
            <View key={m.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 14, borderRadius: 18, backgroundColor: color.fill }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Text selectable style={[type.body, { fontSize: 15 }]}>{m.text}</Text>
                <Text style={[type.caption, { fontSize: 12 }]}>{m.source === 'learned' ? 'Picked up' : 'Saved in chat'} · {shortDate(m.createdAt)}</Text>
              </View>
              <IconButton icon="close" label="Forget this" onPress={() => confirm('Forget this?', m.text.slice(0, 160), 'Forget', () => forget(m.id))} />
            </View>
          ))}
        </View>
      )}
      {data && !simple && (
        <View style={{ marginTop: 22, gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={type.caption}>Conversation memory</Text>
            <Text style={type.caption}>{fill}% full</Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: color.fill, overflow: 'hidden' }}>
            <View style={{ width: `${Math.max(2, fill)}%`, height: 6, backgroundColor: color.inkMuted }} />
          </View>
          <Text style={[type.caption, { fontSize: 13 }]}>When it fills up, older messages get summarized so {bot.name} can keep going.{data.memory.lastCompaction ? ` Last summarized ${shortDate(data.memory.lastCompaction.created_at)}.` : ''}</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------

function nextRun(ms: number | null, tz: string) {
  if (!ms) return '';
  try { return `Next ${new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz })}`; }
  catch { return `Next ${new Date(ms).toLocaleString()}`; }
}

function Routines({ api, bot, initial, simple, onHub }: { api: Client; bot: Bot; initial: Routine[] | undefined; simple?: boolean; onHub?: (tab: 'today' | 'reminders' | 'ideas') => void }) {
  const [list, setList] = useState<Routine[] | undefined>(initial);
  const { flash, view } = useFlash();
  const load = useCallback(() => { api.routines(bot.id).then((r) => setList(r.routines)).catch((e) => flash(e?.message ?? 'Could not load the routines.', true)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [api, bot.id]);
  useEffect(() => { load(); }, [load]);
  const toggleQuiet = (r: Routine, on: boolean) => {
    setList((l) => l?.map((x) => (x.id === r.id ? { ...x, quiet: on } : x)));
    api.setRoutineQuiet(r.id, on).then(() => flash(on ? 'Posts only when something is found' : 'Posts every run')).catch((e) => { setList((l) => l?.map((x) => (x.id === r.id ? { ...x, quiet: !on } : x))); flash(e?.message ?? 'Could not change it.', true); });
  };
  const toggle = (r: Routine, on: boolean) => {
    setList((l) => l?.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)));
    api.setRoutine(r.id, on).then(() => flash(on ? 'Resumed' : 'Paused')).catch((e) => { setList((l) => l?.map((x) => (x.id === r.id ? { ...x, enabled: !on } : x))); flash(e?.message ?? 'Could not change it.', true); });
  };
  return (
    <View>
      <Text style={[type.caption, { marginBottom: 14 }]}>{simple ? `Reminders and regular check-ins ${bot.name} does for you.${onHub ? '' : ` To add or change one, just ask ${bot.name}.`}` : `Recurring jobs ${bot.name} runs on a schedule. To add or change one, ask in chat.`}</Text>
      {simple && onHub && <PillButton title="New reminder" icon="plus" kind="secondary" style={{ marginBottom: 14 }} onPress={() => onHub('reminders')} />}
      {view}
      {!list ? <ActivityIndicator color={color.ink} /> : list.length === 0 ? <Notice>{simple && onHub ? `No reminders yet. Tap New reminder, or ask ${bot.name}: "every Friday at 9am, remind me to order groceries".` : simple ? `No reminders yet. Try asking ${bot.name}: "every Friday at 9am, remind me to order groceries".` : `No routines yet. Try asking ${bot.name}: "every Friday at 4pm, recap my week".`}</Notice> : (
        <View style={{ gap: 10 }}>
          {list.map((r) => (
            <View key={r.id} style={{ padding: 14, borderRadius: 18, backgroundColor: color.fill, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.body, { fontWeight: '500' }]}>{r.name}</Text>
                  <Text style={[type.caption, { fontSize: 13 }]}>{r.enabled ? [r.description || r.schedule, nextRun(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : 'Paused'}</Text>
                </View>
                <Switch value={r.enabled} onValueChange={(v) => toggle(r, v)} accessibilityLabel={`${r.name} ${r.enabled ? 'on' : 'paused'}`} />
              </View>
              {/* A reminder made from the form says only what it is; its wording to the assistant is not for reading. */}
              {!(simple && /^\[(reminder|brief)\]/i.test(r.prompt)) && <>
              <Text numberOfLines={3} style={[type.caption, { fontSize: 13, color: color.inkSecondary }]}>{r.prompt.replace(/^\[reminder\]\s*/i, '')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={[type.caption, { flex: 1, fontSize: 13 }]}>{simple ? 'Only message me when there is something to tell' : 'Post only when something is found'}</Text>
                <Switch value={r.quiet !== false} onValueChange={(v) => toggleQuiet(r, v)} accessibilityLabel={`${r.name}: post only when something is found`} />
              </View>
              </>}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <SmallButton title="Run now" onPress={() => api.runRoutine(r.id).then(() => flash('Running now')).catch((e) => flash(e?.message ?? 'Could not run it.', true))} />
                <SmallButton title="Delete" danger onPress={() => confirm(`Delete "${r.name}"?`, 'It stops running for good.', 'Delete', () => api.deleteRoutine(r.id).then(() => { flash('Deleted'); load(); }).catch((e) => flash(e?.message ?? 'Could not delete it.', true)))} />
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
