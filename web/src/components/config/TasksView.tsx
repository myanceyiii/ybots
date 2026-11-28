import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type RemovedTask } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { useStore } from '../../store';
import { Glyph } from './glyphs';
import './ui';
import { currentLayout } from '../../lib/useLayout';

type Filter = 'all' | 'open' | 'done';

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };
const chipLabel = (t: Task) => (t.stale ? 'Stalled' : STATE_LABEL[t.state]);

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  const ago = r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
  if (t.stale) return `No update since ${ago}`;
  return t.state === 'done' ? `Completed ${ago}` : t.state === 'needs_input' ? `Asked ${ago}` : `Updated ${ago}`;
}

/** Delete with a 10-second Undo, shared by the Tasks page and a bot's Tasks tab. */
function useTaskActions() {
  const [undo, setUndo] = useState<{ botId: string; task: RemovedTask } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } };
  const edit = (t: Task, b: { title?: string; note?: string; state?: Task['state'] }) => run(() => configApi.editTask(t.botId, t.id, b));
  const remove = (t: Task) => run(async () => {
    const r = await configApi.deleteTask(t.botId, t.id);
    setUndo({ botId: t.botId, task: r.removed });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setUndo(null), 10_000);
  });
  const undoDelete = () => { if (!undo) return; const u = undo; setUndo(null); run(() => configApi.restoreTask(u.botId, u.task)); };
  const banner = (undo || error) ? (
    <div className="pages-undo" role="status">
      {error ? <span>{error}</span> : <><span>Deleted “{undo!.task.title}”</span><button type="button" className="link-btn link-btn--small" onClick={undoDelete}>Undo</button></>}
    </div>
  ) : null;
  return { edit, remove, banner };
}

type Actions = ReturnType<typeof useTaskActions>;

function TaskEditor({ t, onDone, actions }: { t: Task; onDone: () => void; actions: Actions }) {
  const [title, setTitle] = useState(t.title);
  const [note, setNote] = useState(t.note);
  const [state, setState] = useState<Task['state']>(t.state);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await actions.edit(t, { title: title.trim(), note: note.trim(), state });
    onDone();
  };
  return (
    <form className="task-edit" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}>
      <input className="page-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" autoFocus maxLength={300} />
      <textarea className="page-input task-edit__note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" placeholder="Note (optional)" rows={2} maxLength={2000} />
      <div className="task-edit__row">
        <div className="segmented" role="radiogroup" aria-label="State">
          {(['working', 'needs_input', 'done'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={state === s} className={state === s ? 'is-active' : ''} onClick={() => setState(s)}>{STATE_LABEL[s]}</button>
          ))}
        </div>
        <span className="task-edit__spacer" />
        <button type="button" className="link-btn link-btn--small" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!title.trim()}>Save</button>
      </div>
    </form>
  );
}

function TaskRow({ t, bot, showBot, actions }: { t: Task; bot?: Bot; showBot: boolean; actions: Actions }) {
  const [editing, setEditing] = useState(false);
  const open = () => { if (bot) { useStore.getState().selectBot(bot.id); useConfigUI.getState().setView('chat'); } };
  if (editing) return <div className={`task-row task-row--editing is-${t.state}`}><TaskEditor t={t} actions={actions} onDone={() => setEditing(false)} /></div>;
  return (
    <div className={`task-row is-${t.state}${t.stale ? ' is-stale' : ''}`}>
      <button type="button" className="task-row__open" onClick={open} disabled={!bot} title={bot ? `Open ${bot.name}` : undefined}>
        <span className={`task-row__check is-${t.state}`} aria-hidden>{t.state === 'done' ? <Glyph name="check_circle" size={18} /> : <span className="task-row__ring" />}</span>
        <span className="task-row__text">
          <span className="task-row__title">{t.title}</span>
          {t.note && <span className="task-row__note">{t.note}</span>}
          {t.stale && <span className="task-row__note">{bot?.name ?? 'The bot'} isn’t working on this now. Mark it done or delete it if it’s finished.</span>}
          <span className="task-row__meta">
            {showBot && bot && <><BotAvatarFor bot={bot} size={14} still /><span>{bot.name}</span><span aria-hidden>·</span></>}
            <span>{when(t)}</span>
          </span>
        </span>
        <span className={`task-chip is-${t.stale ? 'stale' : t.state}`}>{chipLabel(t)}</span>
      </button>
      <span className="task-row__actions">
        {t.state !== 'done' && <button type="button" className="icon-btn icon-btn--plain" onClick={() => actions.edit(t, { state: 'done' })} title="Mark done" aria-label={`Mark “${t.title}” done`}><Glyph name="check_circle" size={15} /></button>}
        <button type="button" className="icon-btn icon-btn--plain" onClick={() => setEditing(true)} title="Edit" aria-label={`Edit “${t.title}”`}><Glyph name="pencil" size={15} /></button>
        <button type="button" className="icon-btn icon-btn--plain" onClick={() => actions.remove(t)} title="Delete" aria-label={`Delete “${t.title}”`}><Glyph name="trash" size={15} /></button>
      </span>
    </div>
  );
}

function useTasks(botId?: string): Task[] | null {
  const v = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => { if (alive) setTasks(r.tasks); }).catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [botId, v]);
  return tasks;
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt);
}

/** Full Tasks view in the main column (sidebar → Tasks). */
export function TasksView() {
  const bots = useStore((s) => s.bots);
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>('open');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const counts = useMemo(() => ({ open: tasks?.filter((t) => t.state !== 'done').length ?? 0, done: tasks?.filter((t) => t.state === 'done').length ?? 0 }), [tasks]);
  const actions = useTaskActions();
  const shown = useMemo(() => sortTasks((tasks ?? []).filter((t) => filter === 'all' || (filter === 'done' ? t.state === 'done' : t.state !== 'done'))), [tasks, filter]);

  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <div className="tasks-view__title">Tasks</div>
        <div className="segmented" role="tablist" aria-label="Filter tasks">
          {([['open', `In progress${counts.open ? ` ${counts.open}` : ''}`], ['done', 'Done'], ['all', 'All']] as [Filter, string][]).map(([f, label]) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {actions.banner}
          {tasks === null ? <div className="cfg-empty">Loading…</div> : shown.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">{filter === 'done' ? 'Nothing finished yet' : 'Nothing in progress'}</div>
              <div className="tasks-empty__sub">Give a Bot a multi-part request and every piece gets its own row here, so progress is easy to follow.</div>
            </div>
          ) : (
            <div className="task-list">{shown.map((t) => <TaskRow key={t.id} t={t} bot={byId.get(t.botId)} showBot actions={actions} />)}</div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry for the Tasks view, with a count of tasks waiting on the user. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const tasks = useTasks();
  const waiting = tasks?.filter((t) => t.state === 'needs_input').length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={openTasks} title="Tasks" aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">Tasks</span>
      {waiting > 0 && <span className="sidebar-island__count" aria-label={`${waiting} waiting on you`}>{waiting}</span>}
    </button>
  );
}

/** On a phone the island always opens Tasks; elsewhere it toggles between Tasks and the chat. */
function openTasks() {
  const view = useConfigUI.getState().view;
  useConfigUI.getState().setView(view === 'tasks' && currentLayout() !== 'compact' ? 'chat' : 'tasks');
  useStore.getState().set({ pane: 'content' });
}

/** Tasks for one bot (details panel → Tasks tab). */
export function BotTasks({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  const actions = useTaskActions();
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span>Tasks</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>See all</button>
        </div>
        {actions.banner}
        {tasks === null ? <div className="panel-card"><div className="panel-empty">Loading…</div></div> : sorted.length === 0 ? (
          <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div>
        ) : (
          <div className="panel-card task-list task-list--compact">{sorted.map((t) => <TaskRow key={t.id} t={t} bot={bot} showBot={false} actions={actions} />)}</div>
        )}
      </section>
    </div>
  );
}
