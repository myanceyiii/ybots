import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBack } from '../back';
import { ActivityIndicator, Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { AgentSkill, AgentSkillDetail, AgentSkillList, AgentSkillSource, Bot, Client, Skill } from '../api';
import { Chip, Notice, PillButton } from '../components/ui';
import { color, type } from '../theme';
import { toast } from '../toast';
import { useTeach } from './TeachReview';

/**
 * Bot settings → Skills on the phone, the same as the web's Skills tab (web/src/components/config/SkillsTab.tsx):
 * the bot's real Hermes skill library, searchable, filtered and grouped by topic. With 150+ skills the groups
 * start folded and a long group shows 40 at a time, so the screen stays quick inside the settings scroll view.
 * Changes made here are the person's own and apply right away; skills the bot wrote since you last looked
 * are marked New. Groups and bots without a reachable agent keep app-only skills (`fallback`).
 */

type Filter = 'all' | 'new' | 'own' | 'builtin' | 'off';
const SOURCE_LABEL: Record<AgentSkillSource, string> = { own: 'Written here', builtin: 'Built-in', hub: 'From the hub', external: 'Shared folder' };
const COLLAPSE_OVER = 40;
const PAGE = 40;
const input = () => ({ borderRadius: 18, backgroundColor: color.surface, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16, color: color.ink } as const);

export function SkillsScreen({ api, bot, appSkills, onAppChange, fallback, onTeach }: {
  api: Client; bot: Bot; appSkills: Skill[] | undefined; onAppChange: () => void; fallback: (notice?: string) => React.ReactNode;
  /** Teach a bot by showing it: open its screen to record (false) or the review (true). */
  onTeach?: (review: boolean) => void;
}) {
  const [list, setList] = useState<AgentSkillList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((fresh = false) => {
    if (bot.kind === 'room') { setList({ available: false, skills: [] }); return Promise.resolve(); }
    return api.agentSkills(bot.id, fresh).then((r) => { setList(r); setError(null); }).catch((e) => setError(e?.message ?? 'Could not read skills.'));
  }, [api, bot.id, bot.kind]);
  useEffect(() => { setList(null); void load(); }, [load]);

  if (list && !list.available) return <>{fallback(list.reason)}</>;
  return <>{onTeach && <TeachRow api={api} bot={bot} onTeach={onTeach} />}<AgentSkillsList api={api} bot={bot} list={list} error={error} reload={load} appSkills={appSkills} onAppChange={onAppChange} /></>;
}

/** Teach by showing (server/src/teach.ts), as on the web's Skills tab: open the screen to record, or review a recording that waits. */
function TeachRow({ api, bot, onTeach }: { api: Client; bot: Bot; onTeach: (review: boolean) => void }) {
  const { state } = useTeach(api, bot.id);
  if (!state || state.blocked) return null;
  const rec = state.recording;
  const waiting = !!rec && rec.status !== 'recording';
  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 10, marginBottom: 14 }}>
      <Text style={type.name}>{waiting ? 'A recording is waiting for review' : rec ? 'Recording now' : 'Teach by showing'}</Text>
      <Text style={type.caption}>{waiting
        ? `${bot.name} ${rec.status === 'drafting' ? 'is writing it up as a skill.' : 'wrote it up as a skill. Check it, then save it.'}`
        : `Take control of ${bot.name}’s screen, tap Record, do the task once in its browser and tap Stop. ${bot.name} writes it up as a skill for you to check.`}</Text>
      <PillButton title={waiting ? 'Review' : rec ? 'Open screen' : 'Show it'} kind="secondary" icon={waiting ? undefined : 'record'} onPress={() => onTeach(waiting)} />
    </View>
  );
}

function AgentSkillsList({ api, bot, list, error, reload, appSkills, onAppChange }: {
  api: Client; bot: Bot; list: AgentSkillList | null; error: string | null; reload: (fresh?: boolean) => Promise<void>; appSkills: Skill[] | undefined; onAppChange: () => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const skills = list?.skills ?? [];
  // The phone's back button closes an open skill (or the new-skill form) before it leaves the settings.
  useBack(!!open, () => setOpen(null));
  useBack(!open && creating, () => setCreating(false));

  const counts = useMemo(() => ({
    all: skills.length,
    new: skills.filter((s) => s.isNew).length,
    own: skills.filter((s) => s.source === 'own').length,
    builtin: skills.filter((s) => s.source !== 'own').length,
    off: skills.filter((s) => !s.enabled).length,
  }), [skills]);
  useEffect(() => { if (filter === 'new' && counts.new === 0) setFilter('all'); }, [filter, counts.new]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = skills.filter((s) =>
      (filter === 'all' || (filter === 'new' ? s.isNew : filter === 'own' ? s.source === 'own' : filter === 'builtin' ? s.source !== 'own' : !s.enabled))
      && (!needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle) || s.category.toLowerCase().includes(needle)));
    const by = new Map<string, AgentSkill[]>();
    for (const s of rows) by.set(s.category, [...(by.get(s.category) ?? []), s]);
    return [...by.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [skills, q, filter]);
  const total = groups.reduce((n, [, g]) => n + g.length, 0);
  const collapsible = !q.trim() && filter !== 'new' && total > COLLAPSE_OVER;
  const categories = useMemo(() => [...new Set(skills.map((s) => s.category).filter(Boolean))].sort(), [skills]);

  if (open) return <SkillDetail api={api} bot={bot} name={open} onBack={(changed) => { setOpen(null); if (changed) void reload(true); }} />;

  return (
    <View>
      <Text style={[type.caption, { marginBottom: 14 }]}>How-tos {bot.name}’s agent keeps and picks up on its own for specific jobs. It writes and improves its own; changes you make here apply right away.</Text>
      {list && <AutoSave api={api} bot={bot} list={list} reload={reload} />}
      {creating ? <AgentSkillEditor api={api} bot={bot} categories={categories} onDone={(name) => { setCreating(false); if (name) { void reload(true); setOpen(name); } }} />
        : <View style={{ marginBottom: 14 }}><PillButton title="New skill" icon="plus" kind="secondary" onPress={() => setCreating(true)} /></View>}
      {!!appSkills?.length && <AppOnly api={api} bot={bot} skills={appSkills} onChange={() => { onAppChange(); void reload(true); }} />}
      {error && <View style={{ marginBottom: 12, gap: 8 }}><Notice tone="problem">Couldn't read {bot.name}'s skills: {error}</Notice><PillButton title="Try again" kind="secondary" onPress={() => void reload(true)} /></View>}
      {!list && !error ? <ActivityIndicator color={color.ink} /> : list && (
        <View style={{ gap: 12 }}>
          {counts.new > 0 && (
            <View style={{ padding: 14, borderRadius: 18, backgroundColor: color.fill, gap: 8 }}>
              <Text style={type.body}><Text style={{ fontWeight: '600' }}>{counts.new} new</Text> from {bot.name} since you last looked. Open one to review it.</Text>
              <Pressable accessibilityRole="button" onPress={() => void api.markAgentSkillsSeen(bot.id).then(() => reload(true))} hitSlop={6}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: color.ink, textDecorationLine: 'underline' }}>Mark all as seen</Text>
              </Pressable>
            </View>
          )}
          <TextInput value={q} onChangeText={setQ} placeholder={`Search ${skills.length} skills`} placeholderTextColor={color.timestamp} style={[input(), { backgroundColor: color.fill }]} accessibilityLabel="Search skills" autoCorrect={false} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <Chip title={`All ${counts.all}`} selected={filter === 'all'} onPress={() => setFilter('all')} />
            {counts.new > 0 && <Chip title={`New ${counts.new}`} selected={filter === 'new'} onPress={() => setFilter('new')} />}
            <Chip title={`Written here ${counts.own}`} selected={filter === 'own'} onPress={() => setFilter('own')} />
            <Chip title={`Built-in ${counts.builtin}`} selected={filter === 'builtin'} onPress={() => setFilter('builtin')} />
            {counts.off > 0 && <Chip title={`Off ${counts.off}`} selected={filter === 'off'} onPress={() => setFilter('off')} />}
          </ScrollView>
          {total === 0 ? <Notice>{q ? 'No skills match.' : `${bot.name} has no skills here yet.`}</Notice> : groups.map(([cat, rows]) => {
            const isOpen = !collapsible || expanded.has(cat);
            const limit = shown[cat] ?? PAGE;
            return (
              <View key={cat || '_'} style={{ gap: 8 }}>
                <Pressable disabled={!collapsible} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}
                  onPress={() => setExpanded((e) => { const n = new Set(e); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: color.inkMuted }}>{cat ? cat.replace(/[-_]/g, ' ') : 'General'}</Text>
                  <Text style={{ fontSize: 13, color: color.inkMuted }}>{rows.length}</Text>
                  {collapsible && <Text style={{ marginLeft: 'auto', fontSize: 18, color: color.inkMuted, transform: [{ rotate: isOpen ? '90deg' : '0deg' }] }}>›</Text>}
                </Pressable>
                {isOpen && rows.slice(0, limit).map((s) => (
                  <Pressable key={s.name} onPress={() => setOpen(s.name)} accessibilityRole="button" accessibilityLabel={`${s.name}${s.isNew ? ', new' : ''}`}
                    style={({ pressed }) => ({ padding: 14, borderRadius: 18, gap: 4, backgroundColor: pressed ? color.pressed : color.fill, opacity: s.enabled ? 1 : 0.6 })}>
                    <Text style={[type.body, { fontWeight: '500' }]}>{s.name}</Text>
                    <Text numberOfLines={2} style={[type.caption, { fontSize: 13 }]}>{s.description || 'No description'}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      {s.isNew && <Tag text={`New: ${bot.name} ${s.botAction === 'created' ? 'wrote it' : 'improved it'}`} strong />}
                      <Tag text={SOURCE_LABEL[s.source]} />
                      {!s.enabled && <Tag text="Off" />}
                      {s.uses > 0 && <Text style={{ fontSize: 12, color: color.inkMuted }}>Used {s.uses} {s.uses === 1 ? 'time' : 'times'}</Text>}
                    </View>
                  </Pressable>
                ))}
                {isOpen && rows.length > limit && <PillButton title={`Show ${Math.min(PAGE, rows.length - limit)} more`} kind="secondary" onPress={() => setShown((m) => ({ ...m, [cat]: limit + PAGE }))} />}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** The owner's switch: this bot saves the skills it writes without an approval card (deleting still asks). */
function AutoSave({ api, bot, list, reload }: { api: Client; bot: Bot; list: AgentSkillList; reload: (fresh?: boolean) => Promise<void> }) {
  const [on, setOn] = useState(!!list.autoSave);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOn(!!list.autoSave); }, [list.autoSave]);
  const change = async (next: boolean) => {
    setOn(next); setError(null);
    try { await api.setAgentSkillsAutoSave(bot.id, next); await reload(); } catch (e: any) { setOn(!next); setError(e?.message ?? 'Could not change it.'); }
  };
  return (
    <View style={{ marginBottom: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, backgroundColor: color.fill }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>Save its own skills without asking</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{on
            ? `${bot.name} writes and improves skills as it learns, with no card. New ones are marked New here. Deleting one still asks.`
            : `${bot.name} asks on a card before it saves a skill it wrote in chat.`}{!list.canChangeAutoSave ? ' Only the owner of this server can change this.' : ''}</Text>
        </View>
        <Switch value={on} onValueChange={(v) => void change(v)} disabled={!list.canChangeAutoSave} accessibilityLabel="Save its own skills without asking" />
      </View>
      {error && <Notice tone="problem">{error}</Notice>}
    </View>
  );
}

function Tag({ text, strong }: { text: string; strong?: boolean }) {
  return (
    <View style={{ height: 22, paddingHorizontal: 8, borderRadius: 11, justifyContent: 'center', backgroundColor: strong ? color.primary : color.surface }}>
      <Text style={{ fontSize: 12, fontWeight: '500', color: strong ? color.onPrimary : color.inkMuted }}>{text}</Text>
    </View>
  );
}

function SkillDetail({ api, bot, name, onBack }: { api: Client; bot: Bot; name: string; onBack: (changed: boolean) => void }) {
  const [skill, setSkill] = useState<AgentSkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<false | 'simple' | 'file'>(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.agentSkill(bot.id, name).then((r) => setSkill(r.skill)).catch((e) => setError(e?.message ?? 'Could not open it.')); }, [api, bot.id, name]);

  const toggle = async (on: boolean) => {
    if (!skill) return;
    setBusy(true); setError(null);
    try { await api.setAgentSkillEnabled(bot.id, name, on); setSkill({ ...skill, enabled: on }); setChanged(true); } catch (e: any) { setError(e?.message ?? 'Could not change it.'); } finally { setBusy(false); }
  };
  const remove = () => Alert.alert(`Delete "${name}"?`,
    skill?.source === 'own' ? `It goes from ${bot.name}'s agent.` : 'This one came with Hermes, which may put it back when it updates. Turning it off is the lasting way to stop it.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { api.deleteAgentSkill(bot.id, name).then(() => onBack(true)).catch((e) => setError(e?.message ?? 'Could not delete.')); } }]);

  return (
    <View style={{ gap: 14 }}>
      <Pressable accessibilityRole="button" onPress={() => onBack(changed)} hitSlop={8} style={{ minHeight: 36, justifyContent: 'center' }}>
        <Text style={{ fontSize: 15, color: color.inkMuted }}>‹ All skills</Text>
      </Pressable>
      <View style={{ gap: 6 }}>
        <Text style={[type.body, { fontSize: 20, lineHeight: 26, fontWeight: '600' }]}>{name}</Text>
        {skill && <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Tag text={SOURCE_LABEL[skill.source]} />{!!skill.category && <Text style={type.caption}>{skill.category.replace(/[-_]/g, ' ')}</Text>}</View>}
      </View>
      {error && <Notice tone="problem">{error}</Notice>}
      {!skill ? (!error && <ActivityIndicator color={color.ink} />) : editing ? (
        <AgentSkillEditor api={api} bot={bot} skill={skill} mode={editing} onMode={setEditing}
          onDone={(saved, next) => { setEditing(false); if (saved && next) { setSkill(next); setChanged(true); } }} />
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, backgroundColor: color.fill }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.body, { fontWeight: '500' }]}>Use this skill</Text>
              <Text style={[type.caption, { fontSize: 13 }]}>{skill.enabled ? `${bot.name} can pick it up when it fits.` : `Off: ${bot.name} won't see it until you turn it back on.`}</Text>
            </View>
            <Switch value={skill.enabled} onValueChange={toggle} disabled={busy} accessibilityLabel="Use this skill" />
          </View>
          <View style={{ gap: 4 }}>
            <Text style={[type.caption, { fontWeight: '600' }]}>When to use it</Text>
            <Text style={type.body}>{skill.description || 'No description'}</Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text style={[type.caption, { fontWeight: '600' }]}>Steps</Text>
            <Text selectable style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 19, color: color.ink, padding: 12, borderRadius: 14, backgroundColor: color.fill }}>{skill.body}</Text>
          </View>
          {skill.files.length > 0 && <Text style={type.caption}>Files that come with it: {skill.files.join(' · ')}</Text>}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <PillButton title="Edit" kind="secondary" onPress={() => setEditing('simple')} style={{ flex: 1 }} />
            <PillButton title="Delete" kind="secondary" onPress={remove} style={{ flex: 1 }} />
          </View>
        </>
      )}
    </View>
  );
}

function AgentSkillEditor({ api, bot, skill, categories = [], mode = 'simple', onMode, onDone }: {
  api: Client; bot: Bot; skill?: AgentSkillDetail; categories?: string[]; mode?: 'simple' | 'file'; onMode?: (m: 'simple' | 'file') => void;
  onDone: (saved: string | null, next?: AgentSkillDetail) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = !busy && (mode === 'file' ? !!content.trim() : !!description.trim() && !!body.trim() && (!!skill || !!name.trim()));
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      const r = skill
        ? await api.saveAgentSkill(bot.id, skill.name, mode === 'file' ? { content } : { description, body })
        : await api.createAgentSkill(bot.id, { name, category: category.trim() || undefined, description, body });
      onDone(r.skill.name, r.skill);
    } catch (e: any) { setError(e?.message ?? 'Could not save.'); setBusy(false); }
  };
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: 18, backgroundColor: color.fill, marginBottom: 12 }}>
      {!skill && (
        <>
          <TextInput value={name} onChangeText={setName} maxLength={64} placeholder="Skill name, e.g. Weekly report" placeholderTextColor={color.timestamp} style={input()} accessibilityLabel="Skill name" />
          <TextInput value={category} onChangeText={setCategory} maxLength={64} placeholder="Group (optional), e.g. productivity" placeholderTextColor={color.timestamp} style={input()} accessibilityLabel="Skill group" autoCapitalize="none" />
          {categories.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {categories.map((c) => <Chip key={c} title={c} onCard selected={category === c} onPress={() => setCategory(category === c ? '' : c)} />)}
            </ScrollView>
          )}
        </>
      )}
      {mode === 'file' ? (
        <>
          <Text style={[type.caption, { fontSize: 13 }]}>The whole SKILL.md file, including the part between the --- lines.</Text>
          <TextInput value={content} onChangeText={setContent} multiline autoCapitalize="none" autoCorrect={false} style={[input(), { minHeight: 260, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 13 }]} accessibilityLabel="Skill file" />
        </>
      ) : (
        <>
          <TextInput value={description} onChangeText={setDescription} multiline maxLength={1024} placeholder={`When should ${bot.name} use it?`} placeholderTextColor={color.timestamp} style={[input(), { minHeight: 64, textAlignVertical: 'top' }]} accessibilityLabel="When to use it" />
          <TextInput value={body} onChangeText={setBody} multiline placeholder={'Write the steps to follow:\n1. …\n2. …'} placeholderTextColor={color.timestamp}
            style={[input(), { minHeight: 200, textAlignVertical: 'top' }]} accessibilityLabel="Skill steps" />
        </>
      )}
      {error && <Notice tone="problem">{error}</Notice>}
      {skill && onMode && (
        <Pressable accessibilityRole="button" onPress={() => onMode(mode === 'file' ? 'simple' : 'file')} hitSlop={6}>
          <Text style={{ fontSize: 14, color: color.inkMuted, textDecorationLine: 'underline' }}>{mode === 'file' ? 'Simple editor' : 'Edit the whole file'}</Text>
        </Pressable>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <PillButton title="Cancel" kind="secondary" onPress={() => onDone(null)} style={{ flex: 1 }} />
        <PillButton title={busy ? 'Saving…' : skill ? 'Save' : 'Add skill'} onPress={save} disabled={!can} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/** Older skills saved only in the app: still sent with each message, and movable into the agent. */
function AppOnly({ api, bot, skills, onChange }: { api: Client; bot: Bot; skills: Skill[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const move = async (s: Skill) => {
    setBusy(s.id); setError(null);
    try { await api.moveSkillToAgent(s.id); onChange(); } catch (e: any) { setError(e?.message ?? 'Could not move it.'); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 8, marginBottom: 16 }}>
      <Text style={[type.caption, { fontWeight: '600' }]}>Saved in the app only</Text>
      <Text style={[type.caption, { fontSize: 13 }]}>{bot.name} still gets these with every message. Move one into its agent to keep everything in one place.</Text>
      {error && <Notice tone="problem">{error}</Notice>}
      {skills.map((s) => (
        <View key={s.id} style={{ padding: 14, borderRadius: 18, backgroundColor: color.fill, gap: 8 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>{s.name}</Text>
          <Text numberOfLines={2} style={[type.caption, { fontSize: 13 }]}>{s.description || s.body.split('\n')[0]}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <PillButton title={busy === s.id ? 'Moving…' : 'Move to agent'} kind="secondary" disabled={busy === s.id} onPress={() => void move(s)} style={{ flex: 1 }} />
            <PillButton title="Delete" kind="secondary" onPress={() => Alert.alert(`Delete "${s.name}"?`, `${bot.name} will stop following it.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { api.deleteSkill(s.id).then(onChange).catch((e: any) => toast(e?.message ?? 'Could not delete it.')); } }])} style={{ flex: 1 }} />
          </View>
        </View>
      ))}
    </View>
  );
}
