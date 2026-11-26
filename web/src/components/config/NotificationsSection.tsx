import { useEffect, useState, type ComponentType } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api, type NotifyPatch, type NotifyPrefs } from '../../lib/api';
import { askToNotify, notifyPermission, type NotifyPermission } from '../../lib/notify';
import { useStore } from '../../store';
import { Switch } from './ui';

const CHANNELS = [
  { id: 'messages', title: 'Messages', sub: 'Replies from your Bots and messages in your groups.' },
  { id: 'approvals', title: 'Approvals and questions', sub: 'A Bot is waiting on you to allow something or answer.' },
  { id: 'jobs', title: 'Finished work', sub: 'Pictures, new looks and documents a Bot finished.' },
] as const;

const ampm = (t: string) => {
  const h = Number(t.slice(0, 2)), m = t.slice(3, 5);
  return `${h % 12 === 0 ? 12 : h % 12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'AM' : 'PM'}`;
};
const until = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const nextAt = (hour: number) => { const d = new Date(); d.setHours(hour, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); };
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } };

/**
 * Notification settings for the website and the Windows app. The server keeps them (notify.ts) and
 * the YBots phone app shares them, so a Bot muted here is muted on the phone too.
 */
export function NotificationsSection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const bots = useStore((s) => s.bots);
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermission());
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.notifyPrefs().then((r) => setPrefs(r.prefs)).catch((e) => setErr(e?.message ?? 'Could not load.')); }, []);
  const save = (patch: NotifyPatch) => { setErr(null); api.setNotifyPrefs(patch).then((r) => setPrefs(r.prefs)).catch((e) => setErr(e?.message ?? 'Could not save.')); };
  const now = Date.now();
  const tz = localTz();
  const mutedUntil = (id: string) => { const u = prefs?.muted[id]; return u !== undefined && (u === 0 || u > now) ? u : null; };

  return (
    <>
      <PageHead title="Notifications" sub="Replies, Bots waiting on you, and finished work, while this window is in the background. The same settings apply to the YBots phone app." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{perm === 'app' ? 'Windows notifications' : 'Browser notifications'}</div>
              <div className="cfg-row__sub">
                {perm === 'app' ? 'On. YBots keeps running in the tray when you close the window, so notifications still come.'
                  : perm === 'granted' ? 'On while a YBots tab is open. Closing every tab stops them; the phone app and the Windows app keep going.'
                  : perm === 'denied' ? 'Blocked by this browser. Allow notifications for this site in the browser’s site settings.'
                  : perm === 'unsupported' ? 'This browser cannot show notifications.'
                  : 'Off. Turn them on to hear about replies while you are in another tab.'}
              </div>
            </div>
            {perm === 'default' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => { void askToNotify().then(setPerm); }}>Turn on</button>}
          </div>
        </div>
      </section>

      {prefs && (
        <>
          <section className="cfg-section">
            <div className="cfg-section__label">What to hear about</div>
            <div className="cfg-card">
              {CHANNELS.map((c) => (
                <div key={c.id} className="cfg-row">
                  <div className="cfg-row__text"><div className="cfg-row__title">{c.title}</div><div className="cfg-row__sub">{c.sub}</div></div>
                  <Switch on={prefs.channels[c.id]} label={c.title} onChange={(v) => save({ channels: { [c.id]: v } })} />
                </div>
              ))}
              <div className="cfg-row">
                <div className="cfg-row__text"><div className="cfg-row__title">Show message text</div><div className="cfg-row__sub">{prefs.preview ? 'Notifications show what the Bot said.' : 'Notifications only say there is a new message.'}</div></div>
                <Switch on={prefs.preview} label="Show message text" onChange={(v) => save({ preview: v })} />
              </div>
            </div>
            <div className="cfg-field__hint">Allow and Deny right in the notification are on Android only, for low-risk requests. Here, clicking a notification opens the card.</div>
          </section>

          <section className="cfg-section">
            <div className="cfg-section__label">Do not disturb</div>
            <div className="cfg-card">
              <div className="cfg-row">
                <div className="cfg-row__text"><div className="cfg-row__title">{prefs.dndUntil > now ? `Paused until ${until(prefs.dndUntil)}` : 'Off'}</div><div className="cfg-row__sub">Pause every notification, here and on the phone.</div></div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button type="button" className={`cfg-chip${prefs.dndUntil <= now ? ' is-active' : ''}`} onClick={() => save({ dndUntil: 0 })}>Off</button>
                  <button type="button" className="cfg-chip" onClick={() => save({ dndUntil: now + 3600_000 })}>1 hour</button>
                  <button type="button" className="cfg-chip" onClick={() => save({ dndUntil: now + 4 * 3600_000 })}>4 hours</button>
                  <button type="button" className="cfg-chip" onClick={() => save({ dndUntil: nextAt(8) })}>Until 8 AM</button>
                </div>
              </div>
              <div className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">Quiet hours</div>
                  <div className="cfg-row__sub">Every day from {ampm(prefs.quiet.start)} to {ampm(prefs.quiet.end)} ({prefs.quiet.tz.replace(/_/g, ' ')}), notifications come without sound.</div>
                </div>
                <Switch on={prefs.quiet.on} label="Quiet hours" onChange={(v) => save({ quiet: { on: v, tz } })} />
              </div>
              {prefs.quiet.on && (
                <div className="cfg-row">
                  <div className="cfg-row__text" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <label>From <input type="time" className="text-input cfg-time-input" value={prefs.quiet.start} onChange={(e) => e.target.value && save({ quiet: { start: e.target.value, tz } })} /></label>
                    <label>To <input type="time" className="text-input cfg-time-input" value={prefs.quiet.end} onChange={(e) => e.target.value && save({ quiet: { end: e.target.value, tz } })} /></label>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Switch on={prefs.quiet.approvalsRing} label="Let approvals ring during quiet hours" onChange={(v) => save({ quiet: { approvalsRing: v } })} /> Let approvals ring
                    </label>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="cfg-section">
            <div className="cfg-section__label">Bots and groups</div>
            <div className="cfg-card notify-bots">
              {bots.map((b) => {
                const u = mutedUntil(b.id);
                // Hidden from the list (Bot.ownerHidden): no notifications at all until it is shown again.
                if (b.ownerHidden) return (
                  <div key={b.id} className="cfg-row">
                    <BotAvatarFor bot={b} size={28} still />
                    <div className="cfg-row__text">
                      <div className="cfg-row__title">{b.name}</div>
                      <div className="cfg-row__sub">Hidden from your list, so no notifications. It still works and talks to your other Bots.</div>
                    </div>
                    <button type="button" className="cfg-btn" onClick={() => { setErr(null); useStore.getState().setOwnerHidden(b.id, false).catch((e) => setErr(e?.message ?? 'Could not show it.')); }}>Show</button>
                  </div>
                );
                return (
                  <div key={b.id} className="cfg-row">
                    <BotAvatarFor bot={b} size={28} still />
                    <div className="cfg-row__text">
                      <div className="cfg-row__title">{b.name}</div>
                      <div className="cfg-row__sub">{u === null ? 'Notifications on' : u === 0 ? 'Muted until you turn it back on' : `Muted until ${until(u)}`}</div>
                    </div>
                    <select className="text-input cfg-compact-select" aria-label={`Notifications for ${b.name}`} value={u === null ? 'on' : u === 0 ? 'off' : 'timed'}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'on') save({ unmute: b.id });
                        else if (v === 'off') save({ mute: { botId: b.id, until: 0 } });
                        else if (v === '1h') save({ mute: { botId: b.id, until: Date.now() + 3600_000 } });
                        else if (v === '8h') save({ mute: { botId: b.id, until: Date.now() + 8 * 3600_000 } });
                      }}>
                      <option value="on">On</option>
                      {u !== null && u !== 0 && <option value="timed">Muted for now</option>}
                      <option value="1h">Mute 1 hour</option>
                      <option value="8h">Mute 8 hours</option>
                      <option value="off">Mute</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
      {err && <div className="cfg-error">{err}</div>}
    </>
  );
}
