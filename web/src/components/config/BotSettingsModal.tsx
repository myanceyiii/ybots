import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AvatarColor, AvatarShape, Bot, Memory, Routine } from '@shared/types';
import { BotAvatar, BotAvatarFor, PICKER_SHAPES } from '../../avatar/BotAvatar';
import { COLOR_ORDER, botVars, palette, whoVars } from '../../lib/colors';
import { CHAT_COLORS, CHAT_COLOR_ORDER, type ChatColor } from '@shared/chat-colors';
import type { VisualsLevel } from '@shared/visuals-level';
import type { BusySend } from '@shared/steer-mode';
import { configApi, type BotSettingsBundle } from '../../lib/configApi';
import { useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { Glyph } from './glyphs';
import { HelpersTab } from './HelpersTab';
import { ToolsTab } from './ToolsTab';
import { SkillsTab } from './SkillsTab';
import { LookTab } from './LookTab';
import { FreeRunSection } from './FreeRunSection';
import { MembersCard } from '../MembersCard';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel, shortDate } from './ui';
import { useSimple } from '../../lib/simple';
import { composeInto } from '../../lib/compose';
import { VoiceSettings } from '../VoiceSettings';

const EFFORTS: { value: Bot['effort']; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

const EFFORT_HINT: Record<Bot['effort'], string> = {
  low: 'Fastest replies. Good for quick lookups and chit-chat.',
  medium: 'A good balance for most work.',
  high: 'Thinks longer before acting. Better for tricky, multi-step work.',
  xhigh: 'Thinks the longest. Slowest, for the hardest problems.',
};

export function BotSettingsModal() {
  const target = useConfigUI((s) => s.botSettings);
  const close = useConfigUI((s) => s.closeBotSettings);
  const setTab = (tab: BotSettingsTab) => target && useConfigUI.setState({ botSettings: { ...target, tab } });
  const bot = useStore((s) => s.bots.find((b) => b.id === target?.botId));
  const routines = useStore((s) => (target ? s.routines[target.botId] : undefined));
  const memVersion = useVersion(`memories:${target?.botId ?? ''}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onClose = useCallback(() => close(), [close]);
  // Sam's view (lib/simple.ts): her assistant's look, voice, memories and reminders, not the model,
  // helpers, connections and skills that Alex looks after (the server refuses those for her anyway).
  const simple = useSimple();

  const reload = useCallback(() => {
    if (!target) return;
    configApi.settings(target.botId).then((d) => { setData(d); setLoadError(null); }).catch((e) => setLoadError(e.message));
  }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload, memVersion]);
  useEffect(() => { if (target) useStore.getState().loadRoutines(target.botId).catch(() => {}); }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bot deleted while open (or bad id): close.
  useEffect(() => { if (target && !bot && useStore.getState().bots.length) close(); }, [bot, target, close]);
  if (!target || !bot) return null;

  // A group has no agent of its own: no picture or poses, memories, routines or helpers. Its members bring theirs.
  const isGroup = bot.kind === 'room';
  const tabs: { id: BotSettingsTab; label: string; count?: number }[] = simple && !isGroup ? [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Look' },
    { id: 'memories', label: 'Remembers', count: data?.memories.length },
    { id: 'routines', label: 'Reminders', count: (routines ?? data?.routines)?.length },
  ] : isGroup ? [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Picture' },
    { id: 'members', label: 'Members' },
    { id: 'skills', label: 'Skills', count: data?.skills.length },
  ] : [
    { id: 'general', label: 'General' },
    { id: 'look', label: 'Look' },
    { id: 'skills', label: 'Skills' },
    { id: 'memories', label: 'Memories', count: data?.memories.length },
    { id: 'routines', label: 'Routines', count: (routines ?? data?.routines)?.length },
    { id: 'helpers', label: 'Helpers' },
    { id: 'tools', label: 'Connections' },
  ];
  const tab = tabs.some((t) => t.id === target.tab) ? target.tab : 'general';

  return (
    <Modal onClose={onClose} className="bot-settings" label={`${bot.name} settings`}>
      <div className="modal__header">
        <div className="bot-settings__title">
          <BotAvatarFor bot={bot} size={24} />
          <span className="modal__title">{bot.name}</span>
        </div>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="bot-settings__body" style={botVars(bot.avatarColor)}>
        <nav className="cfg-nav" aria-label={isGroup ? 'Group settings sections' : 'Bot settings sections'}>
          {tabs.map((t) => (
            <button key={t.id} type="button" className={`cfg-nav__item${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id || undefined}>
              <span>{t.label}</span>
              {t.count ? <span className="cfg-nav__count">{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="cfg-content">
          {loadError && <div className="cfg-error">Couldn’t load settings: {loadError}</div>}
          {tab === 'general' && (isGroup ? <GroupGeneralTab bot={bot} onClose={onClose} /> : <GeneralTab bot={bot} onClose={onClose} simple={simple} />)}
          {tab === 'members' && <GroupMembersTab bot={bot} />}
          {tab === 'look' && <LookTab bot={bot} />}
          {tab === 'skills' && <SkillsTab bot={bot} appSkills={data?.skills} onChange={reload} />}
          {tab === 'memories' && <MemoriesTab bot={bot} data={data} onChange={reload} simple={simple} onClose={onClose} />}
          {tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} simple={simple} onClose={onClose} />}
          {tab === 'helpers' && <HelpersTab bot={bot} />}
          {tab === 'tools' && <ToolsTab bot={bot} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

type Draft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode'>;
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor, effort: b.effort, mode: b.mode });

function GeneralTab({ bot, onClose, simple }: { bot: Bot; onClose: () => void; simple?: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  useEffect(() => { setDraft(draftOf(bot)); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = draftOf(bot);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: Partial<Draft> = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      flash('Saved');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          {bot.avatarImageUrl && draft.avatarShape === bot.avatarShape && draft.avatarColor === bot.avatarColor
            ? <BotAvatarFor bot={bot} size={72} />
            : <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={72} />}
          <div className="cfg-look__text">
            <div className="cfg-look__name">{draft.name || 'New Bot'}</div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {picker ? 'Done' : 'Change shape'}
            </button>
            <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.setState((st) => (st.botSettings ? { botSettings: { ...st.botSettings, tab: 'look' } } : {}))}>
              {bot.avatarImageUrl ? 'Picture and poses' : 'Make a picture instead'}
            </button>
          </div>
        </div>
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} />}
      </section>

      {!simple && <ChatColorSection bot={bot} />}

      <VisualsSection bot={bot} simple={simple} />
      {!bot.outside && <BusySendSection bot={bot} />}
      {bot.kind !== 'room' && <FreeRunSection botId={bot.id} compact />}

      {bot.kind !== 'room' && !bot.outside && <WebSearchSection bot={bot} />}
      {bot.kind !== 'room' && !bot.outside && <PhoneSection bot={bot} />}

      {/* A scoped sign-in finds its bot by name (SCOPED_PEOPLE), so the simple view does not offer renaming it. */}
      {!simple && (
        <section className="cfg-section cfg-grid">
          <Field label="Name" htmlFor="cfg-name" hint="A scoped sign-in (SCOPED_PEOPLE) finds its bot by this name. Renaming it hides it from that sign-in until the server is told the new name.">
            <input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
          </Field>
          <Field label="Label" htmlFor="cfg-label" hint="Shown next to the name, like “Research” or “Inbox”.">
            <input id="cfg-label" className="text-input" value={draft.label} maxLength={60} placeholder="Add a label" onChange={(e) => put('label', e.target.value)} />
          </Field>
        </section>
      )}

      <section className="cfg-section">
        {!simple && (
          <Field label="About" htmlFor="cfg-about">
            <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder="What is this Bot for?" onChange={(e) => put('description', e.target.value)} />
          </Field>
        )}
        <Field label={simple ? `How ${bot.name} should help you` : 'Instructions'} htmlFor="cfg-instructions" hint={simple
          ? `Anything ${bot.name} should always keep in mind: how you like answers, foods to avoid, stores you prefer.`
          : `Standing guidance ${draft.name || 'this Bot'} always follows, like tone, priorities or things to avoid. It also learns from chat, skills and memories.`}>
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={simple ? 5 : 7} value={draft.instructions} maxLength={8000} placeholder={simple ? 'e.g. Keep it short. We shop at H-E-B on Saturdays.' : 'e.g. Keep updates to three bullets. Never email anyone outside the team without asking.'} onChange={(e) => put('instructions', e.target.value)} />
        </Field>
        {!simple && (
          <Field label="Thinking effort" hint={EFFORT_HINT[draft.effort]}>
            <Segmented label="Thinking effort" value={draft.effort} options={EFFORTS} onChange={(v) => put('effort', v)} />
          </Field>
        )}
        {!simple && (
          <Field label="Used as">
            <Segmented label="Bot type" value={draft.mode} options={[{ value: 'personal', label: 'Personal assistant' }, { value: 'teammate', label: 'Teammate' }]} onChange={(v) => put('mode', v)} />
          </Field>
        )}
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(draftOf(bot))}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Conversation</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">New conversation</div>
              <div className="cfg-row__sub">{simple ? `Clears the chat. What ${bot.name} remembers and your reminders stay.` : 'Clears the chat. Memories, skills and routines stay.'}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { useStore.getState().startFresh(bot.id).catch((e) => flash((e as Error).message, 'error')); }}>
              Start new
            </button>
          </div>
          {!bot.isPrimary && !simple && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">Make primary</div>
                <div className="cfg-row__sub">Your go-to Bot. It reaches out first and keeps the others on track.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.makePrimary(bot.id).then(() => flash(`${bot.name} is now your primary Bot`)).catch((e) => flash(e.message, 'error'))}>Make primary</button>
            </div>
          )}
          <HideFromListRow bot={bot} onError={(m) => flash(m, 'error')} />
        </div>
      </section>

      {simple && (
        <section className="cfg-section">
          <div className="cfg-section__label">Voice chat</div>
          <VoiceSettings bot={bot} />
        </section>
      )}

      {!simple && <section className="cfg-section">
        <div className="cfg-section__label">Danger zone</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete {bot.name}</div>
              <div className="cfg-row__sub">{bot.isPrimary ? 'Make another Bot primary first.' : 'Removes its chat, memories, skills and routines for good.'}</div>
            </div>
            <ConfirmButton
              disabled={bot.isPrimary}
              confirmLabel={`Delete ${bot.name}`}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  st.loadBots().catch(() => {});
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              Delete…
            </ConfirmButton>
          </div>
        </div>
      </section>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A group chat's own settings: what it is for and the rules its members follow in it.

type GroupDraft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor'>;
const groupDraftOf = (b: Bot): GroupDraft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor });

function GroupGeneralTab({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [draft, setDraft] = useState<GroupDraft>(() => groupDraftOf(bot));
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  useEffect(() => { setDraft(groupDraftOf(bot)); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = groupDraftOf(bot);
  const changed = (Object.keys(draft) as (keyof GroupDraft)[]).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof GroupDraft>(k: K, v: GroupDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: Partial<GroupDraft> = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      flash('Saved');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          {bot.avatarImageUrl && draft.avatarShape === bot.avatarShape && draft.avatarColor === bot.avatarColor
            ? <BotAvatarFor bot={bot} size={72} />
            : <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={72} />}
          <div className="cfg-look__text">
            <div className="cfg-look__name">{draft.name || 'New group'}</div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {picker ? 'Done' : 'Change icon'}
            </button>
            <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.setState((st) => (st.botSettings ? { botSettings: { ...st.botSettings, tab: 'look' } } : {}))}>
              {bot.avatarImageUrl ? 'Change picture' : 'Make a group picture instead'}
            </button>
          </div>
        </div>
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} />}
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Group name" htmlFor="cfg-name" hint="Bots use this name to post here, so renaming it is fine but keep it unique.">
          <input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
        </Field>
        <Field label="Label" htmlFor="cfg-label" hint="Shown next to the name, like “Family” or “Planning”.">
          <input id="cfg-label" className="text-input" value={draft.label} maxLength={60} placeholder="Add a label" onChange={(e) => put('label', e.target.value)} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="About" htmlFor="cfg-about" hint="What this group is for. Every member is told this when it answers here.">
          <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder="What is this group for?" onChange={(e) => put('description', e.target.value)} />
        </Field>
        <Field label="Instructions" htmlFor="cfg-instructions" hint="How the Bots should behave in this group, like who leads, how long replies are, or what to leave alone. Each Bot still follows its own instructions too.">
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={7} value={draft.instructions} maxLength={8000} placeholder="e.g. One Bot answers unless I ask for everyone. Keep replies to a few lines." onChange={(e) => put('instructions', e.target.value)} />
        </Field>
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(groupDraftOf(bot))}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      <BusySendSection bot={bot} />

      <section className="cfg-section">
        <div className="cfg-section__label">Conversation</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">New conversation</div>
              <div className="cfg-row__sub">Clears the group chat. Members, instructions and skills stay.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { useStore.getState().startFresh(bot.id).catch((e) => flash((e as Error).message, 'error')); }}>
              Start new
            </button>
          </div>
          <HideFromListRow bot={bot} onError={(m) => flash(m, 'error')} />
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Danger zone</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete {bot.name}</div>
              <div className="cfg-row__sub">Removes the group chat, its instructions and skills. The Bots in it stay.</div>
            </div>
            <ConfirmButton
              confirmLabel={`Delete ${bot.name}`}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  st.loadBots().catch(() => {});
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              Delete…
            </ConfirmButton>
          </div>
        </div>
      </section>
    </div>
  );
}

function GroupMembersTab({ bot }: { bot: Bot }) {
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Members</div>
          <div className="cfg-page__sub">The Bots in this group. When you don’t @mention anyone, each member gets the message and answers only if it has something to add. A group needs at least two.</div>
        </div>
      </div>
      <MembersCard room={bot} />
    </div>
  );
}


const VISUALS_OPTS: { value: VisualsLevel; label: string; hint: string }[] = [
  { value: 'minimal', label: 'Minimal', hint: 'Mostly plain text. Charts, calculators and Pages only when you ask; tap buttons still offered for quick questions.' },
  { value: 'balanced', label: 'Balanced', hint: 'Charts, calculators, checklists and Pages when they are clearly easier than text.' },
  { value: 'rich', label: 'Rich', hint: 'Looks for every chance to show rather than tell: tables and charts for comparisons, calculators for money and what-ifs, progress bars, tap buttons and Pages.' },
];

/**
 * How often the bot answers with views, calculators, tap choices and Pages (server/src/visuals-level.ts).
 * Saves on tap; it changes the bot's guidance from its next message. How a device draws them is the
 * separate Answer visuals switch in Settings › General.
 */
function VisualsSection({ bot, simple }: { bot: Bot; simple?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = bot.visuals ?? 'rich';
  const pick = async (v: VisualsLevel) => {
    if (v === current) return;
    setBusy(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { visuals: v });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    } catch (e) { setError((e as Error).message || 'Could not change it.'); } finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">{simple ? 'Pictures and charts in answers' : 'Visuals in replies'}</div>
      <div className="cfg-seg" role="radiogroup" aria-label={`How often ${bot.name} uses visuals`}>
        {VISUALS_OPTS.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={current === o.value} className={current === o.value ? 'is-active' : ''} disabled={busy} onClick={() => pick(o.value)}>{o.label}</button>
        ))}
      </div>
      <div className="cfg-field__hint">{VISUALS_OPTS.find((o) => o.value === current)?.hint}{simple ? '' : ' A tap on a view is a reply, never an approval.'}</div>
      {error && <div className="cfg-row__sub is-error" role="alert">{error}</div>}
    </section>
  );
}

const BUSY_OPTS: { value: BusySend; label: string; hint: (name: string, group: boolean) => string }[] = [
  { value: 'steer', label: 'Steer', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working joins the reply in progress at the next step, marked “Steering”. Nothing stops; approval cards stay open.` },
  { value: 'queue', label: 'Queue', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working waits until the reply is finished, then gets its own reply.` },
  { value: 'interrupt', label: 'Interrupt', hint: (n, g) => `A message you send while ${g ? 'members are' : `${n} is`} working stops the reply in progress and starts over with your message.` },
];

/**
 * What a message sent while the bot works does (server/src/steer-mode.ts): Steer (default), Queue or
 * Interrupt. Saves on tap. Stop works the same in every mode.
 */
function BusySendSection({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = bot.busySend ?? 'steer';
  const group = bot.kind === 'room';
  const pick = async (v: BusySend) => {
    if (v === current) return;
    setBusy(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { busySend: v });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    } catch (e) { setError((e as Error).message || 'Could not change it.'); } finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Messages while {group ? 'members work' : 'it works'}</div>
      <div className="cfg-seg" role="radiogroup" aria-label={`What a message sent while ${bot.name} is working does`}>
        {BUSY_OPTS.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={current === o.value} className={current === o.value ? 'is-active' : ''} disabled={busy} onClick={() => pick(o.value)}>{o.label}</button>
        ))}
      </div>
      <div className="cfg-field__hint">{BUSY_OPTS.find((o) => o.value === current)?.hint(bot.name, group)} Stop still stops it.</div>
      {error && <div className="cfg-row__sub is-error" role="alert">{error}</div>}
    </section>
  );
}

/**
 * Web search by API (server/src/web-search.ts): on, the bot looks things up with web_search and reads
 * pages with web_extract instead of a search engine in its browser. Saves on tap; a bot the app runs
 * restarts its agent to pick it up. The service and this month's use are in Settings › Connections.
 */
function WebSearchSection({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = bot.webSearch !== false;
  const flip = async (v: boolean) => {
    setBusy(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { webSearch: v });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    } catch (e) { setError((e as Error).message || 'Could not change it.'); } finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Search the web</div>
            <div className="cfg-row__sub">{on
              ? `${bot.name} looks things up with a search service and reads pages as text, without opening a browser. The browser is kept for sites that need a sign-in.`
              : `Off: ${bot.name} can only look things up in its browser.`}</div>
          </div>
          <Switch on={on} onChange={flip} label={`${bot.name} searches the web`} disabled={busy} />
        </div>
      </div>
      {error && <div className="cfg-row__sub is-error" role="alert">{error}</div>}
    </section>
  );
}

/**
 * Phone timers and alarms (server/src/phone.ts): on, the bot can set timers and alarms in the Clock app of
 * the phone running the YBots Android app, with no card. App reminders (create_routine once) work for every bot either
 * way and ring on every app. Saves on tap; a bot the app runs restarts its agent to pick it up.
 */
function PhoneSection({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = bot.phoneActions === true;
  const flip = async (v: boolean) => {
    setBusy(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { phoneActions: v });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    } catch (e) { setError((e as Error).message || 'Could not change it.'); } finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Phone timers and alarms</div>
            <div className="cfg-row__sub">{on
              ? `${bot.name} can set timers and alarms in your phone's Clock app (YBots for Android), with no card. Each one shows a line in the chat.`
              : `Off: ${bot.name} can't reach your phone's Clock app. Reminders still ring on every app.`}</div>
          </div>
          <Switch on={on} onChange={flip} label={`${bot.name} sets phone timers and alarms`} disabled={busy} />
        </div>
      </div>
      {error && <div className="cfg-row__sub is-error" role="alert">{error}</div>}
    </section>
  );
}

const SHAPE_ROWS = [PICKER_SHAPES.slice(0, 7), PICKER_SHAPES.slice(7)];

/**
 * The bot's colour in chats (server/src/chat-colors.ts): its name, bar and bubble tint where it writes in
 * another bot's chat or a group. Saves on tap; "Automatic" goes back to the colour picked for it.
 */
function ChatColorSection({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (c: ChatColor | null) => {
    setBusy(true); setError(null);
    try {
      const { bot: next } = await configApi.updateBot(bot.id, { chatColor: c });
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    } catch (e) { setError((e as Error).message || 'Could not change the colour.'); } finally { setBusy(false); }
  };
  const current = bot.chatColor ?? null;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Color in chats</div>
      <div className="cfg-chatcolor">
        <div className="cfg-chatcolor__preview is-from-bot" style={whoVars(current)}>
          <span className="cfg-chatcolor__name">{bot.name}</span>
          <span className="cfg-chatcolor__bubble">How {bot.name}'s messages look in other chats and groups.</span>
        </div>
        <div className="swatches__row cfg-chatcolor__swatches" role="radiogroup" aria-label={`${bot.name}'s color in chats`}>
          {CHAT_COLOR_ORDER.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={current === c && !bot.chatColorAuto} aria-label={c} title={c} className="swatch-cell" disabled={busy} onClick={() => pick(c)}>
              <span className={`swatch${current === c ? ' is-selected' : ''}`} style={{ background: CHAT_COLORS[c].light.bar }} />
            </button>
          ))}
        </div>
        <div className="cfg-row__sub">
          {bot.chatColorAuto ? 'Picked automatically so no two bots match. Tap a color to choose your own.' : <>Chosen in settings. <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={() => pick(null)}>Use automatic</button></>}
        </div>
        {error && <div className="cfg-row__sub is-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}

function LookPicker({ shape, color, onShape, onColor }: { shape: AvatarShape; color: AvatarColor; onShape: (s: AvatarShape) => void; onColor: (c: AvatarColor) => void }) {
  return (
    <div className="cfg-picker">
      <div className="shape-grid" role="radiogroup" aria-label="Character shape">
        {SHAPE_ROWS.map((row, i) => (
          <div key={i} className="shape-grid__row">
            {row.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} aria-label={s} className="shape-cell" onClick={() => onShape(s)}>
                <BotAvatar shape={s} color={color} size={34} ring={shape === s} />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Character color">
        <div className="swatches__row">
          {COLOR_ORDER.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className="swatch-cell" onClick={() => onColor(c)}>
              <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: palette(c).fill }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MemoriesTab({ bot, data, onChange, simple, onClose }: { bot: Bot; data: BotSettingsBundle | null; onChange: () => void; simple?: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const memories = useMemo(() => (data?.memories ?? []).filter((m) => !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))), [data, hidden, q]);
  const remove = async (m: Memory) => {
    setHidden((h) => new Set(h).add(m.id));
    setProblem(null);
    try { await configApi.deleteMemory(m.id); onChange(); } catch (e) { setHidden((h) => { const n = new Set(h); n.delete(m.id); return n; }); setProblem((e as Error).message || 'Could not forget it. Try again.'); }
  };
  const fill = data ? Math.min(100, Math.round((data.memory.historyChars / data.memory.compactAtChars) * 100)) : 0;
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">{simple ? `What ${bot.name} remembers` : 'Memories'}</div>
          <div className="cfg-page__sub">What {bot.name} remembers about you. It saves things when you share them, and picks up more on its own once a chat goes quiet.</div>
        </div>
        {simple && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { composeInto(bot.id, 'Remember that '); onClose(); }}>Tell {bot.name} something to remember</button>}
      </div>
      {problem && <div className="cfg-error" role="alert">{problem}</div>}
      {(data?.memories.length ?? 0) > 6 && (
        <input className="text-input" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
      )}
      {!data ? <div className="cfg-empty">Loading…</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? 'No memories match.' : `Nothing yet. Tell ${bot.name} about yourself, or just chat. It’ll pick things up.`}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <div key={m.id} className="cfg-item">
              <div className="cfg-item__text">
                <div className="cfg-item__body">{m.text}</div>
                <div className="cfg-item__meta">
                  {m.source === 'learned' ? <span className="cfg-chip">Picked up</span> : <span className="cfg-chip cfg-chip--muted">Saved in chat</span>}
                  <span>{shortDate(m.createdAt)}</span>
                </div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => remove(m)} aria-label="Forget this" title="Forget"><Glyph name="trash" size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && !simple && (
        <div className="cfg-meter" title="Older messages are summarized automatically when this fills up.">
          <div className="cfg-meter__label"><span>Conversation memory</span><span>{fill}% full</span></div>
          <div className="cfg-meter__track"><span style={{ width: `${Math.max(2, fill)}%` }} /></div>
          <div className="cfg-field__hint">
            When it fills up, older messages get summarized so {bot.name} can keep going.
            {data.memory.lastCompaction ? ` Last summarized ${shortDate(data.memory.lastCompaction.created_at)}.` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoutinesTab({ bot, routines, simple }: { bot: Bot; routines: Routine[] | undefined; simple?: boolean; onClose: () => void }) {
  const [flash, setFlash] = useState<string | null>(null);
  const say = (t: string) => { setFlash(t); setTimeout(() => setFlash(null), 2200); };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">{simple ? 'Reminders' : 'Routines'}</div>
          <div className="cfg-page__sub">{simple ? `Reminders and regular check-ins ${bot.name} does for you.` : `Recurring jobs ${bot.name} runs on a schedule. To add or change one, ask in chat.`}</div>
        </div>
        {flash && <span className="cfg-savebar__note" role="status">{flash}</span>}
      </div>
      {!routines ? <div className="cfg-empty">Loading…</div> : routines.length === 0 ? (
        <div className="cfg-empty">{simple ? `No reminders yet. Use New reminder, or ask ${bot.name}: “every Friday at 9am, remind me to order groceries”.` : `No routines yet. Try asking ${bot.name}: “every Friday at 4pm, recap my week”.`}</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} simple={simple} />)}
        </div>
      )}
    </div>
  );
}

function RoutineItem({ r, onFlash, simple }: { r: Routine; onFlash: (t: string) => void; simple?: boolean }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await configApi.setRoutine(r.id, v); onFlash(v ? 'Resumed' : 'Paused'); } catch (e) { setEnabled(!v); onFlash((e as Error).message || 'Could not change it.'); }
  };
  const [quiet, setQuiet] = useState(r.quiet !== false);
  useEffect(() => setQuiet(r.quiet !== false), [r.quiet]);
  const autoOff = !enabled && !!r.autoOffAt;
  const toggleQuiet = async (v: boolean) => {
    setQuiet(v);
    try { await configApi.setRoutineQuiet(r.id, v); onFlash(v ? 'Posts only when something is found' : 'Posts every run'); } catch (e) { setQuiet(!v); onFlash((e as Error).message || 'Could not change it.'); }
  };
  return (
    <div className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? [r.description || r.schedule, nextRunLabel(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : autoOff ? 'Turned off after repeated failures' : 'Paused'}</div>
        {/* The fatigue rule (server routines.ts): 10 failures in a row switch it off; one tap turns it back on. */}
        {(autoOff || (enabled && (r.failCount ?? 0) > 0)) && (
          <div className="cfg-item__fail" role="status">
            <span>{autoOff ? `Failed ${r.failCount ?? 10} times in a row, so it was switched off.` : `The last ${r.failCount === 1 ? 'run' : `${r.failCount} runs`} failed. It switches off after 10 in a row.`}{r.lastError ? ` ${r.lastError}` : ''}</span>
            {autoOff && <button type="button" className="cfg-btn cfg-btn--secondary cfg-item__fail-btn" onClick={() => toggle(true)}>Turn back on</button>}
          </div>
        )}
        {/* A reminder made from the form says only what it is; its wording to the assistant is not for reading. */}
        {!(simple && /^\[(reminder|brief)\]/i.test(r.prompt)) && <>
          <div className="cfg-item__prompt">{r.prompt.replace(/^\[reminder\]\s*/i, '')}</div>
          <label className="cfg-item__check">
            <input type="checkbox" checked={quiet} onChange={(e) => toggleQuiet(e.target.checked)} />
            <span>{simple ? 'Only message me when there is something to tell' : 'Post only when something is found'}</span>
          </label>
        </>}
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" title="Run now" aria-label={`Run ${r.name} now`} onClick={() => configApi.runRoutine(r.id).then(() => onFlash('Running now')).catch((e) => onFlash(e.message))}>
          <Glyph name="play" size={13} />
        </button>
        <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={() => configApi.deleteRoutine(r.id).then(() => onFlash('Deleted'), (e) => onFlash((e as Error).message || 'Could not delete it.'))}><Glyph name="trash" size={14} /></ConfirmButton>
        <Switch on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'paused'}`} />
      </div>
    </div>
  );
}

/**
 * "Hide from my list" (Bot.ownerHidden): out of this account's list, pickers and unread counts, and no
 * notifications here or on the YBots phone app. The bot keeps working and talking to the others; groups
 * it is in stay. Not offered for the primary Bot, nor on a scoped sign-in (Sam's view is hers, not this).
 */
function HideFromListRow({ bot, onError }: { bot: Bot; onError: (m: string) => void }) {
  const scoped = useStore((s) => !!s.user?.scope);
  const [busy, setBusy] = useState(false);
  if (scoped || bot.isPrimary) return null;
  const hidden = !!bot.ownerHidden;
  const flip = (v: boolean) => {
    setBusy(true);
    useStore.getState().setOwnerHidden(bot.id, v).catch((e) => onError((e as Error).message || 'That did not work. Try again.')).finally(() => setBusy(false));
  };
  return (
    <div className="cfg-row">
      <div className="cfg-row__text">
        <div className="cfg-row__title">Hide from my list</div>
        <div className="cfg-row__sub">{hidden
          ? `Hidden: ${bot.name} is not in your list and sends you no notifications. It still works and talks to your other Bots.`
          : `Takes ${bot.name} off your list and stops its notifications, here and on your phone. It keeps working${bot.kind === 'room' ? '' : ' and talking to your other Bots'}.`}</div>
      </div>
      <Switch on={hidden} onChange={flip} label={`Hide ${bot.name} from my list`} disabled={busy} />
    </div>
  );
}
