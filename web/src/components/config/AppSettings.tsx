import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type AllowRule, type AllowRuleUse, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { ConfirmButton, Switch } from './ui';
import { api, type ListSummaryInfo, type ListSummaryPrefs } from '../../lib/api';
import { PcsSection } from './PcsSection';
import { TEXT_SIZES, usePrefs } from '../../lib/prefs';
import { keyHint } from '../../lib/keys';
import { ConnectionsSection } from './ConnectionsSection';
import { NotificationsSection } from './NotificationsSection';
import { FreeRunSection } from './FreeRunSection';
import { SystemSection } from './SystemSection';
import { UsageSection } from './UsageSection';
import { LoginsSection } from './LoginsSection';
import { ActivitySection } from './ActivitySection';
import { downloadText } from '../ChatView';
import type { DeviceSession } from '../../lib/api';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'computer', label: 'Computer' },
  { id: 'pcs', label: 'Your PCs' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'connections', label: 'Connections' },
  { id: 'logins', label: 'Saved logins' },
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage' },
  { id: 'system', label: 'System' },
  { id: 'account', label: 'Account' },
];

// Saved logins are each person's own (server/src/vault.ts), so a scoped sign-in has them too.
const SCOPED_SECTIONS: AppSection[] = ['general', 'notifications', 'logins', 'account'];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  // A sign-in that sees only some bots (user.scope) has no team-wide settings: the server refuses them.
  const scoped = useStore((s) => !!s.user?.scope);
  const sections = scoped ? SECTIONS.filter((s) => SCOPED_SECTIONS.includes(s.id)) : SECTIONS;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {sections.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'notifications' && <NotificationsSection PageHead={PageHead} />}
          {!scoped && section === 'computer' && <ComputerSection />}
          {!scoped && section === 'pcs' && <PcsSection PageHead={PageHead} />}
          {!scoped && section === 'permissions' && <PermissionsSection />}
          {!scoped && section === 'connections' && <ConnectionsSection PageHead={PageHead} />}
          {!scoped && section === 'activity' && <ActivitySection PageHead={PageHead} />}
          {!scoped && section === 'usage' && <UsageSection PageHead={PageHead} />}
          {!scoped && section === 'system' && <SystemSection PageHead={PageHead} />}
          {section === 'logins' && <LoginsSection PageHead={PageHead} />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const visuals = useConfigUI((s) => s.answerVisuals);
  const setVisuals = useConfigUI((s) => s.setAnswerVisuals);
  const textSize = usePrefs((s) => s.textSize);
  const setTextSize = usePrefs((s) => s.setTextSize);
  const enterSends = usePrefs((s) => s.enterSends);
  const setEnterSends = usePrefs((s) => s.setEnterSends);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Text size in chats</div>
        <div className="cfg-seg" role="radiogroup" aria-label="Text size in chats">
          {TEXT_SIZES.map((t) => <button key={t.id} type="button" role="radio" aria-checked={textSize === t.id} className={textSize === t.id ? 'is-active' : ''} onClick={() => setTextSize(t.id)}>{t.label}</button>)}
        </div>
        <div className="cfg-field__hint">Makes messages and the message box larger or smaller on this device. Lists and menus stay as they are.</div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Enter key</div>
        <div className="cfg-seg" role="radiogroup" aria-label="Enter key">
          <button type="button" role="radio" aria-checked={enterSends} className={enterSends ? 'is-active' : ''} onClick={() => setEnterSends(true)}>Enter sends</button>
          <button type="button" role="radio" aria-checked={!enterSends} className={!enterSends ? 'is-active' : ''} onClick={() => setEnterSends(false)}>Enter adds a line</button>
        </div>
        <div className="cfg-field__hint">{enterSends ? 'Enter sends the message. Shift+Enter starts a new line.' : `Enter starts a new line. ${keyHint('Enter')} sends the message.`} <button type="button" className="link-btn" onClick={() => useStore.getState().setModal('shortcuts')}>All keyboard shortcuts</button></div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Answer visuals</div>
        <div className="cfg-seg" role="radiogroup" aria-label="Answer visuals">
          <button type="button" role="radio" aria-checked={visuals === 'rich'} className={visuals === 'rich' ? 'is-active' : ''} onClick={() => setVisuals('rich')}>Rich</button>
          <button type="button" role="radio" aria-checked={visuals === 'simple'} className={visuals === 'simple' ? 'is-active' : ''} onClick={() => setVisuals('simple')}>Simple</button>
        </div>
        <div className="cfg-field__hint">Rich shows charts, checklists and calculators when a Bot answers with a view. Simple shows the same answer as plain text. Any single view can still be switched. This is how this device draws them; how often each Bot uses them is in that Bot’s settings.</div>
      </section>
      <ChatListSection />
      <AboutLine />
    </>
  );
}

/** Which version of the app the server is running, for "is my update in yet?". */
function AboutLine() {
  const [v, setV] = useState<{ version: string; commit: string | null; startedAt: number } | null>(null);
  useEffect(() => { api.version().then(setV).catch(() => {}); }, []);
  if (!v) return null;
  return <div className="cfg-about">YBots {v.version !== '0' ? v.version : ''}{v.commit ? (v.version !== '0' ? ` (${v.commit.slice(0, 7)})` : `build ${v.commit.slice(0, 7)}`) : ''} · server running since {new Date(v.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>;
}

/** Chat list previews: the Bot's last words, or a short AI summary of the conversation (server/src/list-summary.ts). */
function ChatListSection() {
  const [info, setInfo] = useState<ListSummaryInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.listSummary().then(setInfo).catch((e) => setErr((e as Error).message)); }, []);
  const save = async (patch: Partial<ListSummaryPrefs>) => {
    if (!info) return;
    setInfo({ ...info, prefs: { ...info.prefs, ...patch } });
    try { const { prefs } = await api.setListSummary(patch); setInfo((i) => (i ? { ...i, prefs } : i)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  };
  const p = info?.prefs;
  const o = info?.options;
  const value = p?.model ? `${p.provider ?? ''}|${p.model}` : '';
  const known = !!o?.providers.some((x) => x.id === p?.provider && x.models.includes(p?.model ?? ''));
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Chat list</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">AI summary in the chat list</div>
            <div className="cfg-row__sub">{p?.on
              ? 'Each chat shows a few words on what the conversation is about. Made only after a chat changes, then saved.'
              : 'Each chat shows the Bot’s own last message, or who posted last, such as “You posted last.”'}</div>
          </div>
          <Switch on={!!p?.on} disabled={!info} label="AI summary in the chat list" onChange={(v) => save({ on: v })} />
        </div>
        {p?.on && (
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Summary model</div>
              <div className="cfg-row__sub">{o?.ready ? 'From the accounts your Hermes is signed in to. A small model is plenty.' : 'Your Hermes is not answering, so its models can’t be listed right now.'}</div>
            </div>
            <select className="text-input cfg-compact-select" aria-label="Summary model" value={value}
              onChange={(e) => { const v = e.target.value; if (!v) void save({ model: null }); else { const [provider, ...m] = v.split('|'); void save({ provider: provider || null, model: m.join('|') }); } }}>
              <option value="">Automatic{o?.auto.model ? ` (${o.auto.model})` : ''}</option>
              {p.model && !known && <option value={value}>{p.model}</option>}
              {o?.providers.map((pr) => (
                <optgroup key={pr.id} label={pr.name}>
                  {pr.models.map((m) => <option key={m} value={`${pr.id}|${m}`}>{m}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="cfg-field__hint">Sheldon’s chat and groups he is in never get an AI summary, so his work stays out of other engines.{info?.lastError && p?.on ? ` Last problem: ${info.lastError.error}` : ''}</div>
      {err && <div className="cfg-error">{err}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  // The server says how many screens the computer can hold; 4 until it does.
  const maxScreens = computer?.maxScreens ?? details?.computer.maxScreens ?? 4;

  return (
    <>
      <PageHead title="Computer" sub="Your Bots share one cloud computer. Each Bot works on its own screen." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details && maxScreens ? ` · ${details.screens.length} of ${maxScreens}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} still /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time.{maxScreens ? ` Up to ${maxScreens} Bots can have a screen at once${details && details.screens.length >= maxScreens ? '; reset one to free it for another Bot' : ''}.` : ''}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  // Local app tools are `<app>__<tool>`; the tool part may itself use - or _.
  const [app, ...rest] = slug.split('__');
  if (rest.length) return { app, action: rest.join('__').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) };
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

/** The risky classes in server/src/allow-rules.ts, as the Permissions list names them. */
const RISK_TEXT: Record<string, string> = {
  shell: 'Can run commands or code', files: 'Can write or change files', delete: 'Can delete things', message: 'Can send messages or mail',
  money: 'Can move money or change the budget', host: 'Can change a server or PC', install: 'Can install software',
  browser: 'Can click and type on websites', computer: 'Can control a computer', schedule: 'Can set up work that runs later',
};

function PermissionsSection() {
  const [data, setData] = useState<{ rules: AllowRule[]; log: AllowRuleUse[] } | null>(null);
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    configApi.allowRules().then(setData).catch(() => setData({ rules: [], log: [] }));
    configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const remove = (id: string) => { setError(null); configApi.deleteAllowRule(id).then(load).catch((e) => setError((e as Error).message)); };
  const byBot = new Map<string, AllowRule[]>();
  for (const r of data?.rules ?? []) byBot.set(r.botId, [...(byBot.get(r.botId) ?? []), r]);
  const ago = (t: number) => { const r = relativeShort(t); return r === 'now' ? 'just now' : /^\d/.test(r) ? `${r} ago` : r; };
  return (
    <>
      <PageHead title="Permissions" sub="What each Bot may do without asking first. Remove one and that Bot asks again next time." />
      {error && <div className="cfg-error">{error}</div>}
      <FreeRunSection />
      <section className="cfg-section">
        <div className="cfg-section__label">Always allowed</div>
        <div className="cfg-card">
          {data === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : data.rules.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. Choose “Always allow” on an approval and it shows up here, for that Bot only.</div>
          ) : [...byBot.values()].flatMap((rules) => rules.map((r) => (
            <div key={r.id} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{r.botName} · {r.label}</div>
                {r.risk && <div className="cfg-row__sub cfg-row__warn">⚠ {RISK_TEXT[r.risk] ?? 'Risky action'}</div>}
                <div className="cfg-row__sub">
                  Added by {r.createdBy} on the {r.createdVia}, {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {' · '}{r.uses ? `used ${r.uses} time${r.uses === 1 ? '' : 's'}, last ${ago(r.lastUsedAt ?? r.createdAt)}` : 'not used yet'}
                </div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => remove(r.id)}>Ask again</button>
            </div>
          )))}
        </div>
        <div className="cfg-field__hint">Each rule covers one Bot and one action. Rules marked with a warning let that Bot do something risky without asking, like running commands or sending messages. Sending an email always asks.</div>
      </section>
      {!!data?.log.length && (
        <section className="cfg-section">
          <div className="cfg-section__label">Recently allowed without asking</div>
          <div className="cfg-card">
            {data.log.slice(0, 15).map((u) => (
              <div key={u.id} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{u.botName} · {u.label}</div>
                  <div className="cfg-row__sub">{ago(u.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {policies.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-section__label">Older choices for every Bot</div>
          <div className="cfg-card">
            {policies.map((p) => {
              const h = humanizeTool(p.tool);
              return (
                <div key={p.tool} className="cfg-row">
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                    <div className="cfg-row__sub">
                      {p.mode === 'always_allow' ? 'Always allowed for every Bot' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code>
                    </div>
                  </div>
                  <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>{p.mode === 'blocked' ? 'Remove' : 'Ask again'}</button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const signOutError = useStore((s) => s.signOutError);
  const shown = user?.displayName ?? user?.name ?? user?.email ?? '?';
  // A placeholder address (such as the install's shared account) says nothing, so only a real one is shown.
  const address = user?.email && !/\.invalid$/i.test(user.email) ? user.email : null;
  const initials = shown.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{shown}</div>
              {address && <div className="cfg-row__sub">{address}</div>}
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); if (await useStore.getState().signOut()) setBusy(false); }}>
              {busy ? 'Signing out…' : signOutError ? 'Try again' : 'Sign out'}
            </button>
          </div>
          {signOutError && <div className="card__error" role="alert">{signOutError}</div>}
        </div>
      </section>
      <DevicesList />
      <DownloadData />
    </>
  );
}

/** Everything the account has said and set up, as one file to keep. */
function DownloadData() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setNote(null); setError(null);
    try {
      const data = await api.accountExport();
      downloadText(`ybots-${data.exportedAt.slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
      setNote(`Saved ${data.counts.conversations.toLocaleString()} conversation${data.counts.conversations === 1 ? '' : 's'} with ${data.counts.messages.toLocaleString()} message${data.counts.messages === 1 ? '' : 's'} from ${data.counts.bots} Bot${data.counts.bots === 1 ? '' : 's'} and groups.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Your data</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Download my data</div>
            <div className="cfg-row__sub">One file with every conversation, each Bot's instructions and its routines. Files in the Bots' folders, sign-ins and keys are left out.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void save()}>{busy ? 'Gathering…' : 'Download'}</button>
        </div>
        {note && <div className="cfg-row"><div className="cfg-row__sub" role="status">{note}</div></div>}
        {error && <div className="card__error" role="alert">{error}</div>}
      </div>
    </section>
  );
}

/** Where this account is signed in: each phone, browser and app, with a way to sign any of them out. */
function DevicesList() {
  const [list, setList] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showScripts, setShowScripts] = useState(false);
  useEffect(() => { api.sessions().then((r) => setList(r.sessions)).catch(() => setList([])); }, []);
  const act = (p: Promise<{ sessions: DeviceSession[] }>) => { setError(null); return p.then((r) => setList(r.sessions)).catch((e) => setError((e as Error).message)); };
  if (!list?.length) return null;
  const seen = (d: DeviceSession) => {
    if (d.current) return 'This device';
    const t = d.lastSeenAt ?? d.createdAt;
    const r = relativeShort(t);
    return `${d.lastSeenAt ? 'Last used' : 'Signed in'} ${r === 'now' ? 'just now' : /^\d/.test(r) ? `${r} ago` : r.toLowerCase()}`;
  };
  const others = list.filter((d) => !d.current && d.kind === 'person');
  // Helper programs (Claude threads, tests) sign in on their own and pile up: they are counted on one line
  // and listed only when asked for, so the person's own devices are what the list shows.
  const people = list.filter((d) => d.kind === 'person');
  const scripts = list.filter((d) => d.kind === 'script');
  const ends = (d: DeviceSession) => ` · signs out by itself ${new Date(d.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} if not used`;
  const row = (d: DeviceSession) => (
    <div key={d.id} className="cfg-row">
      <div className="cfg-row__text">
        <div className="cfg-row__title">{d.device ?? (d.kind === 'script' ? 'A script' : 'A device')}{d.kind === 'script' ? ` · ${d.who}` : ''}</div>
        <div className="cfg-row__sub">{seen(d)}{d.kind === 'person' && d.who ? ` · ${d.who}` : ''}{d.kind === 'person' && !d.current ? ends(d) : ''}</div>
      </div>
      {!d.current && <ConfirmButton confirmLabel="Sign it out" className="cfg-btn cfg-btn--secondary" onConfirm={() => act(api.signOutDevice(d.id))}>Sign out</ConfirmButton>}
    </div>
  );
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Signed-in devices</div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="cfg-card">
        {people.map(row)}
        {scripts.length > 0 && (
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{scripts.length} helper program{scripts.length === 1 ? '' : 's'}</div>
              <div className="cfg-row__sub">Claude threads and tests that signed in by themselves, not people. One that is not used for two weeks is signed out automatically.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" aria-expanded={showScripts} onClick={() => setShowScripts((v) => !v)}>{showScripts ? 'Hide' : 'Show'}</button>
          </div>
        )}
        {showScripts && scripts.map(row)}
      </div>
      {(others.length > 1 || scripts.length > 1) && (
        <div className="cfg-field__hint">
          {others.length > 1 && <><ConfirmButton confirmLabel={`Sign out ${others.length} devices`} className="cfg-link" onConfirm={() => act(api.signOutOthers())}>Sign out everywhere else</ConfirmButton>{' '}keeps this device and helper programs signed in.{' '}</>}
          {scripts.length > 1 && <><ConfirmButton confirmLabel={`Sign out ${scripts.length} helper programs`} className="cfg-link" onConfirm={() => act(api.signOutScripts())}>Sign out all helper programs</ConfirmButton>{' '}They sign in again when they next have work.</>}
        </div>
      )}
    </section>
  );
}
