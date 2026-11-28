import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bot, HermesSkill, HermesSkillDetail, HermesSkillList, HermesSkillSource, Skill } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { ConfirmButton, Segmented, Switch, shortDate } from './ui';
import { useStore } from '../../store';
import { useTeach } from '../TeachRecord';

/**
 * Bot settings → Skills. For a bot with its own Hermes agent this is that agent's real skill library
 * (built-in, from the hub, or written by the bot or you), read and changed through Hermes itself.
 * Changes made here are yours, so they apply straight away; a bot changing a skill still asks first.
 * Skills saved only in the app (older ones) are listed too, with a way to move them into the agent.
 * Groups, and bots without an agent the app can reach, keep app-only skills.
 */

type Filter = 'all' | 'new' | 'own' | 'builtin' | 'off';
const SOURCE_LABEL: Record<HermesSkillSource, string> = { own: 'Written here', builtin: 'Built-in', hub: 'From the hub', external: 'Shared folder' };
const COLLAPSE_OVER = 40;

export function SkillsTab({ bot, appSkills, onChange }: { bot: Bot; appSkills: Skill[] | undefined; onChange: () => void }) {
  const [list, setList] = useState<HermesSkillList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((fresh = false) => {
    if (bot.kind === 'room') { setList({ available: false, skills: [] }); return Promise.resolve(); }
    return configApi.agentSkills(bot.id, fresh).then((r) => { setList(r); setError(null); }).catch((e) => setError((e as Error).message));
  }, [bot.id, bot.kind]);
  useEffect(() => { setList(null); void load(); }, [load]);

  if (list && !list.available) return <AppSkills bot={bot} skills={appSkills} onChange={onChange} notice={list.reason} />;
  return <AgentSkills bot={bot} list={list} error={error} reload={load} appSkills={appSkills} onAppChange={onChange} />;
}

function AgentSkills({ bot, list, error, reload, appSkills, onAppChange }: {
  bot: Bot; list: HermesSkillList | null; error: string | null; reload: (fresh?: boolean) => Promise<void>; appSkills: Skill[] | undefined; onAppChange: () => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const skills = list?.skills ?? [];

  const counts = useMemo(() => ({
    all: skills.length,
    new: skills.filter((s) => s.isNew).length,
    own: skills.filter((s) => s.source === 'own').length,
    builtin: skills.filter((s) => s.source !== 'own').length,
    off: skills.filter((s) => !s.enabled).length,
  }), [skills]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = skills.filter((s) =>
      (filter === 'all' || (filter === 'new' ? s.isNew : filter === 'own' ? s.source === 'own' : filter === 'builtin' ? s.source !== 'own' : !s.enabled))
      && (!needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle) || s.category.toLowerCase().includes(needle)));
    const by = new Map<string, HermesSkill[]>();
    for (const s of shown) by.set(s.category, [...(by.get(s.category) ?? []), s]);
    return [...by.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [skills, q, filter]);
  const shownCount = groups.reduce((n, [, g]) => n + g.length, 0);
  const collapsible = !q.trim() && shownCount > COLLAPSE_OVER;
  useEffect(() => { if (filter === 'new' && counts.new === 0) setFilter('all'); }, [filter, counts.new]);
  const categories = useMemo(() => [...new Set(skills.map((s) => s.category).filter(Boolean))].sort(), [skills]);

  if (open) return <SkillDetail bot={bot} name={open} onBack={(changed) => { setOpen(null); if (changed) void reload(true); }} />;

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Skills</div>
          <div className="cfg-page__sub">How-tos {bot.name}’s agent keeps and picks up on its own for specific jobs. It writes and improves its own; changes you make here apply right away.</div>
        </div>
        {!creating && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={12} /> New skill</button>}
      </div>
      <TeachRow bot={bot} />
      {list && <AutoSaveRow bot={bot} list={list} reload={reload} />}
      {creating && <AgentSkillEditor bot={bot} categories={categories} onDone={(name) => { setCreating(false); if (name) { void reload(true); setOpen(name); } }} />}
      {appSkills && appSkills.length > 0 && <AppOnlySection bot={bot} skills={appSkills} onChange={() => { onAppChange(); void reload(true); }} />}
      {error && <div className="cfg-error">Couldn’t read {bot.name}’s skills: {error} <button type="button" className="cfg-link" onClick={() => void reload(true)}>Try again</button></div>}
      {!list && !error ? <div className="cfg-empty">Reading {bot.name}’s skills…</div> : list && (
        <>
          <div className="cfg-skills__controls">
            <input className="text-input" type="search" placeholder={`Search ${skills.length} skills`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" />
            {counts.new > 0 && (
              <div className="cfg-skills__new">
                <span><strong>{counts.new} new</strong> from {bot.name} since you last looked. Open one to review it.</span>
                <button type="button" className="cfg-link" onClick={() => void configApi.markAgentSkillsSeen(bot.id).then(() => reload(true))}>Mark all as seen</button>
              </div>
            )}
            <Segmented<Filter> label="Show" value={filter} onChange={setFilter} options={[
              { value: 'all', label: `All ${counts.all}` },
              ...(counts.new ? [{ value: 'new' as const, label: `New ${counts.new}` }] : []),
              { value: 'own', label: `Written here ${counts.own}` },
              { value: 'builtin', label: `Built-in ${counts.builtin}` },
              ...(counts.off ? [{ value: 'off' as const, label: `Off ${counts.off}` }] : []),
            ]} />
          </div>
          {shownCount === 0 ? <div className="cfg-empty">{q ? 'No skills match.' : `${bot.name} has no skills here yet.`}</div> : (
            <div className="cfg-skills">
              {groups.map(([cat, rows]) => {
                const isOpen = !collapsible || expanded.has(cat);
                const label = cat ? cat.replace(/[-_]/g, ' ') : 'General';
                return (
                  <section key={cat || '_'} className="cfg-skills__group">
                    <button type="button" className="cfg-skills__head" aria-expanded={isOpen} disabled={!collapsible}
                      onClick={() => setExpanded((e) => { const n = new Set(e); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}>
                      <span className="cfg-skills__head-name">{label}</span>
                      <span className="cfg-nav__count">{rows.length}</span>
                      {collapsible && <span className={`cfg-skills__caret${isOpen ? ' is-open' : ''}`} aria-hidden>›</span>}
                    </button>
                    {isOpen && (
                      <div className="cfg-list">
                        {rows.map((s) => (
                          <button key={s.name} type="button" className={`cfg-item cfg-item--button${s.enabled ? '' : ' is-off'}`} onClick={() => setOpen(s.name)}>
                            <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
                            <div className="cfg-item__text">
                              <div className="cfg-item__title">{s.name}</div>
                              <div className="cfg-item__sub cfg-clamp-2">{s.description || 'No description'}</div>
                              <div className="cfg-item__meta">
                                {s.isNew && <span className="cfg-chip cfg-chip--new">New: {bot.name} {s.botAction === 'created' ? 'wrote it' : 'improved it'}</span>}
                                <span className={`cfg-chip${s.source === 'own' ? '' : ' cfg-chip--muted'}`}>{SOURCE_LABEL[s.source]}</span>
                                {!s.enabled && <span className="cfg-chip cfg-chip--muted">Off</span>}
                                {s.uses > 0 && <span>Used {s.uses} {s.uses === 1 ? 'time' : 'times'}</span>}
                                {s.lastUsedAt && <span>Last {shortDate(s.lastUsedAt)}</span>}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Teach by showing (server/src/teach.ts): open the bot's screen to record a task, or review a recording that waits. */
function TeachRow({ bot }: { bot: Bot }) {
  const set = useStore((s) => s.set);
  const { state } = useTeach(bot.id);
  if (!state || state.blocked) return null;
  const rec = state.recording;
  const waiting = rec && rec.status !== 'recording';
  return (
    <div className="cfg-teach">
      <span className="cfg-item__icon"><Icon name="record" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{waiting ? 'A recording is waiting for review' : rec ? 'Recording now' : 'Teach by showing'}</div>
        <div className="cfg-item__sub">{waiting
          ? `${bot.name} ${rec.status === 'drafting' ? 'is writing it up as a skill.' : 'wrote it up as a skill. Check it, then save it.'}`
          : `Take control of ${bot.name}’s screen, press Record, do the task once in its browser and press Stop. ${bot.name} writes it up as a skill for you to check.`}</div>
      </div>
      {waiting
        ? <button type="button" className="cfg-btn" onClick={() => set({ teachReview: bot.id })}>Review</button>
        : <button type="button" className="cfg-btn" onClick={() => set({ viewerOpen: true, viewerMode: 'control', viewerHint: 'Press Record, do the task once in the browser, then press Stop.' })}>{rec ? 'Open screen' : 'Show it'}</button>}
    </div>
  );
}

/** The owner's switch: this bot saves the skills it writes without an approval card (deleting still asks). */
function AutoSaveRow({ bot, list, reload }: { bot: Bot; list: HermesSkillList; reload: (fresh?: boolean) => Promise<void> }) {
  const [on, setOn] = useState(!!list.autoSave);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOn(!!list.autoSave); }, [list.autoSave]);
  const change = async (next: boolean) => {
    setOn(next); setError(null);
    try { await configApi.setAgentSkillsAutoSave(bot.id, next); await reload(); } catch (e) { setOn(!next); setError((e as Error).message); }
  };
  return (
    <div className="cfg-section">
      <div className="cfg-row" style={{ padding: 0 }}>
        <div className="cfg-row__text">
          <div className="cfg-row__title">Save its own skills without asking</div>
          <div className="cfg-row__sub">{on
            ? `${bot.name} writes and improves skills as it learns, with no card. New ones are marked New here so you can review them. Deleting one still asks.`
            : `${bot.name} asks on a card before it saves a skill it wrote in chat.`}
            {!list.canChangeAutoSave && ' Only the owner of this server can change this.'}</div>
        </div>
        <Switch on={on} onChange={(v) => void change(v)} label="Save its own skills without asking" disabled={!list.canChangeAutoSave} />
      </div>
      {error && <div className="cfg-error">{error}</div>}
    </div>
  );
}

function SkillDetail({ bot, name, onBack }: { bot: Bot; name: string; onBack: (changed: boolean) => void }) {
  const [skill, setSkill] = useState<HermesSkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<false | 'simple' | 'file'>(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { configApi.agentSkill(bot.id, name).then((r) => setSkill(r.skill)).catch((e) => setError((e as Error).message)); }, [bot.id, name]);

  const toggle = async (on: boolean) => {
    if (!skill) return;
    setBusy(true); setError(null);
    try { await configApi.setAgentSkillEnabled(bot.id, name, on); setSkill({ ...skill, enabled: on }); setChanged(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div style={{ minWidth: 0 }}>
          <button type="button" className="cfg-back" onClick={() => onBack(changed)}><Glyph name="arrow_left" size={14} /> All skills</button>
          <div className="cfg-page__title cfg-break">{name}</div>
          {skill && (
            <div className="cfg-item__meta">
              <span className={`cfg-chip${skill.source === 'own' ? '' : ' cfg-chip--muted'}`}>{SOURCE_LABEL[skill.source]}</span>
              {skill.category && <span>{skill.category.replace(/[-_]/g, ' ')}</span>}
            </div>
          )}
        </div>
        {skill && !editing && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing('simple')}><Icon name="edit" size={12} /> Edit</button>}
      </div>
      {error && <div className="cfg-error">{error}</div>}
      {!skill ? (!error && <div className="cfg-empty">Loading…</div>) : editing ? (
        <AgentSkillEditor bot={bot} skill={skill} mode={editing} onMode={setEditing}
          onDone={(saved, next) => { setEditing(false); if (saved && next) { setSkill(next); setChanged(true); } }} />
      ) : (
        <>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Use this skill</div>
              <div className="cfg-row__sub">{skill.enabled ? `${bot.name} can pick it up when it fits.` : `Off: ${bot.name} won’t see it until you turn it back on.`}</div>
            </div>
            <Switch on={skill.enabled} onChange={toggle} label="Use this skill" disabled={busy} />
          </div>
          <div className="cfg-field">
            <div className="cfg-field__label">When to use it</div>
            <div className="cfg-skill__desc">{skill.description || 'No description'}</div>
          </div>
          <div className="cfg-field">
            <div className="cfg-field__label">Steps</div>
            <pre className="cfg-skill__body">{skill.body}</pre>
          </div>
          {skill.files.length > 0 && (
            <div className="cfg-field">
              <div className="cfg-field__label">Files that come with it</div>
              <div className="cfg-field__hint">{skill.files.join(' · ')}</div>
            </div>
          )}
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete skill</div>
              <div className="cfg-row__sub">{skill.source === 'own'
                ? `Removes it from ${bot.name}’s agent.`
                : 'This one came with Hermes, which may put it back when it updates. Turning it off is the lasting way to stop it.'}</div>
            </div>
            <ConfirmButton title="Delete" onConfirm={async () => {
              try { await configApi.deleteAgentSkill(bot.id, name); onBack(true); } catch (e) { setError((e as Error).message); }
            }}>Delete</ConfirmButton>
          </div>
        </>
      )}
    </div>
  );
}

function AgentSkillEditor({ bot, skill, categories = [], mode = 'simple', onMode, onDone }: {
  bot: Bot; skill?: HermesSkillDetail; categories?: string[]; mode?: 'simple' | 'file'; onMode?: (m: 'simple' | 'file') => void;
  onDone: (saved: string | null, next?: HermesSkillDetail) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = !busy && (mode === 'file' ? content.trim() : description.trim() && body.trim() && (skill || name.trim()));
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      const r = skill
        ? await configApi.saveAgentSkill(bot.id, skill.name, mode === 'file' ? { content } : { description, body })
        : await configApi.createAgentSkill(bot.id, { name, category: category.trim() || undefined, description, body });
      onDone(r.skill.name, r.skill);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {!skill && (
        <>
          <input className="text-input" placeholder="Skill name, e.g. Weekly report" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Skill name" />
          <input className="text-input" placeholder="Group (optional), e.g. productivity" value={category} maxLength={64} list="cfg-skill-groups" onChange={(e) => setCategory(e.target.value)} aria-label="Skill group" />
          <datalist id="cfg-skill-groups">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </>
      )}
      {mode === 'file' ? (
        <>
          <div className="cfg-field__hint">The whole SKILL.md file, including the part between the --- lines.</div>
          <textarea className="text-input cfg-textarea cfg-textarea--tall cfg-mono" rows={16} value={content} onChange={(e) => setContent(e.target.value)} aria-label="Skill file" spellCheck={false} />
        </>
      ) : (
        <>
          <textarea className="text-input cfg-textarea" rows={2} placeholder={`When should ${bot.name} use it? e.g. “When asked for the Friday report.”`} value={description} maxLength={1024} onChange={(e) => setDescription(e.target.value)} aria-label="When to use it" />
          <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={12} placeholder={'Write the steps to follow:\n1. …\n2. …'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
        </>
      )}
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-editor__actions">
        {skill && onMode && (
          <button type="button" className="cfg-link" style={{ marginRight: 'auto' }} onClick={() => onMode(mode === 'file' ? 'simple' : 'file')}>
            {mode === 'file' ? 'Simple editor' : 'Edit the whole file'}
          </button>
        )}
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving…' : skill ? 'Save skill' : 'Add skill'}</button>
      </div>
    </form>
  );
}

/** Skills saved only in the app (from before they lived in the agent): still used, and movable. */
function AppOnlySection({ bot, skills, onChange }: { bot: Bot; skills: Skill[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const move = async (s: Skill) => {
    setBusy(s.id); setError(null);
    try { await configApi.moveSkillToAgent(s.id); onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="cfg-section">
      <div className="cfg-section__label">Saved in the app only</div>
      <div className="cfg-field__hint">{bot.name} still gets these with every message. Move one into its agent to keep everything in one place.</div>
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-list">
        {skills.map((s) => (
          <div key={s.id} className="cfg-item">
            <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
            <div className="cfg-item__text">
              <div className="cfg-item__title">{s.name}</div>
              <div className="cfg-item__sub">{s.description || s.body.split('\n')[0]}</div>
            </div>
            <div className="cfg-item__actions">
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy === s.id} onClick={() => void move(s)}>{busy === s.id ? 'Moving…' : 'Move to agent'}</button>
              <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={async () => { await configApi.deleteSkill(s.id); onChange(); }}><Glyph name="trash" size={14} /></ConfirmButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Groups and bots without a reachable agent: skills kept in the app and sent with each message. */
function AppSkills({ bot, skills, onChange, notice }: { bot: Bot; skills: Skill[] | undefined; onChange: () => void; notice?: string }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Skills</div>
          <div className="cfg-page__sub">Step-by-step how-tos {bot.kind === 'room' ? 'everyone in this group follows here. Members can propose new ones after working on something together; you save them from the card in the chat' : `${bot.name} follows for specific jobs`}. Ask for one by name in chat.</div>
        </div>
        {editing !== 'new' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New skill</button>}
      </div>
      {notice && <div className="cfg-field__hint">{notice}</div>}
      {editing === 'new' && <AppSkillEditor botId={bot.id} onDone={() => { setEditing(null); onChange(); }} />}
      {!skills ? <div className="cfg-empty">Loading…</div> : skills.length === 0 && editing !== 'new' ? (
        <div className="cfg-empty">
          No skills yet. Write down how you like something done, like “Prep for a sales call”, and {bot.name} will follow it every time.
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <AppSkillEditor key={s.id} botId={bot.id} skill={s} onDone={() => { setEditing(null); onChange(); }} />
          ) : (
            <div key={s.id} className="cfg-item">
              <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
              <div className="cfg-item__text">
                <div className="cfg-item__title">{s.name}</div>
                <div className="cfg-item__sub">{s.description || s.body.split('\n')[0]}</div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`} title="Edit"><Icon name="edit" size={14} /></button>
                <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={async () => { await configApi.deleteSkill(s.id); onChange(); }}><Glyph name="trash" size={14} /></ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AppSkillEditor({ botId, skill, onDone }: { botId: string; skill?: Skill; onDone: () => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = name.trim() && body.trim() && !busy;
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (skill) await configApi.updateSkill(skill.id, { name, description, body });
      else await configApi.createSkill(botId, { name, description, body });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="text-input" placeholder="Skill name, e.g. Weekly report" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Skill name" />
      <input className="text-input" placeholder="When to use it (optional)" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label="Skill description" />
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={'Write the steps to follow:\n1. …\n2. …'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving…' : skill ? 'Save skill' : 'Add skill'}</button>
      </div>
    </form>
  );
}
