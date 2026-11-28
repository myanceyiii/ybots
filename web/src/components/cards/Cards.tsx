import { ArgsDetails } from './ArgsDetails';
import { useEffect, useState } from 'react';
import type { CardBody, Row } from '@shared/types';
import { api, openPopup } from '../../lib/api';
import { useSelectedBot, useStore } from '../../store';
import { Icon } from '../Icon';
import { IconTile, ToolkitLogo } from '../ToolkitLogo';
import { cardIcon } from '@shared/card-icon';
import { PluginCardView } from './PluginCardView';
import { ViewCard } from './ViewCard';
import { PluginPlanCard, PluginReviewCard } from './PluginBuilderCards';
import { LookCard, LookRevealCard } from './LookCards';
import { FileGlyph, downloadBotFile, kindOf, openFile } from '../files/FilePane';
import { Download } from 'lucide-react';
import { formatBytes } from '../config/ui';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const prettyTool = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const KNOWN: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', clickup: 'ClickUp', googledocs: 'Google Docs', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googletasks: 'Google Tasks', googlemeet: 'Google Meet' };
/** "googlecalendar" → "Google Calendar", "slack" → "Slack". */
export const humanizeToolkit = (slug: string) => KNOWN[slug.toLowerCase()] ?? slug.replace(/^(google|microsoft)(?=\w)/i, '$1 ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: 'Allowed once', always: 'Always allowed', conversation: 'Allowed for this conversation', denied: 'Not allowed', expired: 'Expired' };

/** An HTML email body as plain text for reading on the card (the server sends `text`, with link addresses; this is for older cards). */
const mailText = (m: NonNullable<Card<'approval'>['mail']>) => typeof m.text === 'string' ? m.text : !m.html ? m.body : m.body
  .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

/** The whole email a send card shows: who it is from and to, the subject, every word of the body and the attachments. */
function MailView({ mail }: { mail: NonNullable<Card<'approval'>['mail']> }) {
  const row = (label: string, v: string) => v ? <div className="mail-card__row"><span className="mail-card__label">{label}</span><span>{v}</span></div> : null;
  return (
    <div className="card__body mail-card">
      {row('From', mail.from)}
      {row('To', mail.to || (mail.replyAll ? 'Everyone on the thread (reply all)' : mail.threadId ? "The thread's last sender (reply)" : '(nobody)'))}
      {row('Cc', mail.cc)}
      {row('Bcc', mail.bcc)}
      {row('Subject', mail.subject || (mail.threadId ? "(the thread's subject)" : mail.forwardOf ? '(Fwd: the original subject)' : '(no subject)'))}
      {mail.forwardOf && <div className="card__note">Forwards an earlier email, with its text below this note.</div>}
      <div className="mail-card__text">{mailText(mail) || '(empty)'}</div>
      {mail.attachments.length > 0 && <div className="card__note">📎 {mail.attachments.join(', ')}</div>}
      {(mail.other ?? []).map((o) => row(o.name, o.value))}
      {mail.incomplete && <div className="card__error">{mail.incomplete}</div>}
    </div>
  );
}

/** Where a browser card's site is shown: big, so a look-alike domain stands out. */
function SiteLine({ origin, frameOrigin }: { origin: string; frameOrigin?: string }) {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* as given */ }
  const https = origin.startsWith('https://');
  return (
    <div className="browser-card__site">
      <span className="browser-card__host">{host}</span>
      <span className={`browser-card__scheme${https ? '' : ' is-warn'}`}>{https ? 'secure page' : 'not https'}</span>
      {frameOrigin && <div className="card__note">The field is in a frame from {frameOrigin}</div>}
    </div>
  );
}

/**
 * A saved-login card (server/src/vault.ts): a Bot asks to sign in with a login someone saved. Only that
 * person's sign-in can press Sign in (the server checks too); the server types the login into the page.
 */
function VaultCard({ body }: { body: Card<'approval'> }) {
  const v = body.vault!;
  const { busy, error, run } = useBusy();
  const scoped = useStore((s) => !!s.user?.scope);
  const mine = v.forScoped === scoped;
  const pending = body.status === 'pending';
  const what = v.fields.length === 2 ? 'username and password' : v.fields[0];
  return (
    <div className={`card approval-card browser-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <IconTile icon={cardIcon(body)} size={44} radius={12} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">The app types it into the page. The bot never sees it.</div>
        </div>
      </div>
      <div className="card__body mail-card">
        <SiteLine origin={v.origin} frameOrigin={v.frameOrigin} />
        <div className="mail-card__row"><span className="mail-card__label">Login</span><span>{v.label}{v.userHint ? ` · ${v.userHint}` : ''}{v.savedSite !== v.site ? ` (saved for ${v.savedSite})` : ''}</span></div>
        <div className="mail-card__row"><span className="mail-card__label">Fills</span><span>The {what}{v.fieldLabels.length ? ` ("${v.fieldLabels.join('", "')}")` : ''}</span></div>
        {v.why && <div className="mail-card__row"><span className="mail-card__label">For</span><span>{v.why} <em>(the bot's words)</em></span></div>}
        {v.connectorFirst && <div className="card__note card__note--warn">This is a mail, calendar or money site. Bots use the connected app for this. Sign in only if no connected app covers it, not because one failed.</div>}
      </div>
      {pending ? (
        mine ? (
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Don't sign in</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => run('login', () => api.useSavedLogin(body.approvalId, body.digest))}>Sign in</button>
          </div>
        ) : (
          <div className="card__actions">
            <span className="card__note">This is {v.owner}'s login. Only {v.owner} can press Sign in.</span>
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Don't sign in</button>
          </div>
        )
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'allowed' && v.result?.ok !== false ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'denied' ? 'Not signed in' : body.status === 'expired' ? 'Expired' : v.result ? (v.result.ok ? v.result.detail : `Not filled: ${v.result.detail}`) : 'Filling…'}
          {body.answeredBy && body.status !== 'expired' && ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}`}
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

/**
 * A secure input card (server/src/browser-cards.ts): the person types a password, code or card detail; the app
 * sends it once to the server, which types it into that field of the bot's browser. It is never shown in the
 * chat, kept in this page after sending, or offered to the browser's password manager to save.
 */
function SecretCard({ body }: { body: Card<'approval'> }) {
  const s = body.secret!;
  const { busy, error, run } = useBusy();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [save, setSave] = useState(false);
  const pending = body.status === 'pending';
  const send = () => run('fill', async () => { const v = value; setValue(''); await api.secretInput(body.approvalId, v, body.digest, save && !!s.canSave); });
  return (
    <div className={`card approval-card browser-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <IconTile icon={cardIcon(body)} size={44} radius={12} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{s.kind === 'service_key' ? 'Goes straight to your server. The bot never sees it.' : 'Goes straight into the page. The bot never sees it.'}</div>
        </div>
      </div>
      <div className="card__body mail-card">
        {s.kind === 'service_key' ? <div className="browser-card__site"><span className="browser-card__host">{s.site}</span><div className="card__note">Kept on your server for this bot only. The bot never sees it.</div></div> : <SiteLine origin={s.origin} frameOrigin={s.frameOrigin} />}
        <div className="mail-card__row"><span className="mail-card__label">Field</span><span>{s.fieldLabel}</span></div>
        {s.why && <div className="mail-card__row"><span className="mail-card__label">For</span><span>{s.why} <em>(the bot's words)</em></span></div>}
      </div>
      {pending ? (
        <form className="browser-card__form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (value) send(); }}>
          {s.kind === 'service_key' ? (
            <div className="browser-card__input">
              {/* A whole key file: pasted, never shown back (blurred until "Show"). */}
              <textarea
                className={`browser-card__key${show ? '' : ' is-hidden'}`} value={value} onChange={(e) => setValue(e.target.value)}
                placeholder="Paste the whole JSON key file" aria-label={`${s.kindLabel} for ${s.site}`} maxLength={8192} rows={4}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore data-form-type="other" disabled={!!busy}
              />
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
            </div>
          ) : (
          <div className="browser-card__input">
            <input
              type={s.masked && !show ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={s.kindLabel} aria-label={`${s.kindLabel} for ${s.site}`} maxLength={512}
              autoComplete={s.kind === 'one_time_code' ? 'one-time-code' : 'off'} autoCorrect="off" autoCapitalize="off" spellCheck={false}
              inputMode={s.numeric ? 'numeric' : undefined} data-lpignore="true" data-1p-ignore data-form-type="other" disabled={!!busy}
            />
            {s.masked && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>}
          </div>
          )}
          {s.canSave && (
            <label className="browser-card__save"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} disabled={!!busy} /> Save to my logins for {s.site}</label>
          )}
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Don't fill</button>
            <button type="submit" className="btn btn--primary" disabled={!!busy || !value}>Fill in</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </form>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'allowed' && s.result?.ok !== false ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'denied' ? 'Not filled' : body.status === 'expired' ? 'Expired' : s.result ? (s.result.ok ? 'Filled' : `Not filled: ${s.result.detail}`) : 'Filling…'}
          {body.answeredBy && body.status !== 'expired' && ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}`}
        </div>
      )}
    </div>
  );
}

/** A purchase card: what the checkout page shows, read by the server. Approve arms one purchase at that total. */
function PurchaseCard({ body }: { body: Card<'approval'> }) {
  const p = body.purchase!;
  const pg = p.page;
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const row = (label: string, v: string | null | undefined) => v ? <div className="mail-card__row"><span className="mail-card__label">{label}</span><span>{v}</span></div> : null;
  return (
    <div className={`card approval-card browser-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <IconTile icon={cardIcon(body)} size={44} radius={12} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">Read from the checkout page. Nothing is paid until you approve.</div>
        </div>
      </div>
      <div className="card__body mail-card">
        <div className="browser-card__amount">{pg.total ? `${pg.total.text}` : 'Total not read'}{pg.total && <span className="browser-card__cur"> {pg.total.currency}</span>}</div>
        <SiteLine origin={pg.origin} />
        {row('Paid to', pg.site)}
        {row('Pay with', pg.card ? `${pg.card.brand}${pg.card.last4 ? ` ending ${pg.card.last4}` : ''}` : 'Not shown on the page')}
        {row('Items', pg.items.join('\n'))}
        {row('Shipping', pg.shipping)}
        {row('Ship to', pg.shipTo)}
        {row('Repeats', pg.recurring ? `Yes: ${pg.recurring}` : '')}
        {row('Button', pg.controls.join(', '))}
        {(p.botSays.items.length > 0 || p.botSays.why) && <div className="card__note">The bot says: {[p.botSays.amount && `${p.botSays.amount} ${p.botSays.currency}`.trim(), p.botSays.merchant, p.botSays.items.join(', '), p.botSays.why].filter(Boolean).join(' · ')}</div>}
        {p.warnings.map((w) => <div key={w} className="card__error">⚠ {w}</div>)}
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Don't buy</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => run('allow', () => api.approve(body.approvalId, 'allow', body.digest))}>Approve {pg.total?.text ?? 'purchase'}</button>
          </div>
          <div className="card__note">Approve lets the bot press pay once, within 3 minutes, at exactly this total. If anything changes it has to ask again.</div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'allowed' && p.result?.ok !== false ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'denied' ? 'Not bought' : body.status === 'expired' ? 'Expired, not bought' : p.result ? (p.result.ok ? 'Approved' : `Not armed: ${p.result.detail}`) : 'Approved'}
          {body.answeredBy && body.status !== 'expired' && ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}`}
        </div>
      )}
    </div>
  );
}

/** A needs-you card: a CAPTCHA or passkey on the bot's screen. Opens the screen; Done lets the bot carry on. */
function ScreenHelpCard({ body }: { body: Card<'approval'> }) {
  const h = body.screenHelp!;
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const set = useStore((st) => st.set);
  const open = () => set({ viewerOpen: true, viewerMode: 'control', viewerHint: null });
  return (
    <div className={`card approval-card browser-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <IconTile icon={cardIcon(body)} size={44} radius={12} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">Take over the bot's screen, do it, then press Done.</div>
        </div>
      </div>
      {h.note && <div className="card__body">{h.note}</div>}
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Skip</button>
            <button type="button" className="btn btn--secondary" onClick={open}>Open screen</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => run('allow', () => api.approve(body.approvalId, 'allow', body.digest))}>Done</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>{body.status === 'allowed' ? 'Done' : body.status === 'denied' ? 'Skipped' : 'Expired'}</div>
      )}
    </div>
  );
}

const PLATFORM: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X', tiktok: 'TikTok', linkedin: 'LinkedIn', threads: 'Threads' };
const dayName = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * A posting plan card (server/src/posting.ts): each day's video, cover and posts, with a switch per day.
 * One press approves exactly the days left on. Each post stays bound to its caption; changing a day's video
 * or cover cancels that day. "Always allow" is offered with a warning, like any risky tool.
 */
function PostingPlanCard({ body }: { body: Card<'approval'> }) {
  const plan = body.postingPlan!;
  const bot = useSelectedBot();
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(plan.days.map((d) => [d.date, true])));
  const [open, setOpen] = useState<string | null>(null);
  const days = plan.days.filter((d) => on[d.date]).map((d) => d.date);
  const posts = plan.days.filter((d) => on[d.date]).reduce((n, d) => n + d.posts.length, 0);
  const answer = (decision: 'allow' | 'always') => run(decision, () => api.postingPlan(body.approvalId, days, decision, body.digest));
  const approved = new Set(plan.result?.days ?? []);
  const until = new Date(plan.expires).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className={`card approval-card browser-card plan-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <IconTile icon={cardIcon(body)} size={44} radius={12} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">Each post is locked to its exact caption and video. Switch off any day you don't want.</div>
        </div>
      </div>
      <div className="card__body plan-card__days">
        {plan.why && <div className="card__note">{plan.why} <em>(the bot's words)</em></div>}
        {plan.days.map((d) => {
          const live = pending ? on[d.date] : approved.has(d.date);
          return (
            <div key={d.date} className={`plan-day${live ? '' : ' is-off'}`}>
              <div className="plan-day__head">
                {pending ? (
                  <label className="plan-day__switch">
                    <input type="checkbox" role="switch" checked={!!on[d.date]} disabled={!!busy} onChange={(e) => setOn({ ...on, [d.date]: e.target.checked })} aria-label={`Post on ${dayName(d.date)}`} />
                    <span className="plan-day__track" aria-hidden />
                  </label>
                ) : <span className="plan-day__mark" aria-hidden>{live ? '✓' : '–'}</span>}
                <div className="plan-day__title"><strong>{dayName(d.date)}</strong>{d.label && <span> · {d.label}</span>}</div>
              </div>
              <div className="plan-day__media">
                {d.cover?.ok && bot && <img className="plan-day__cover" alt="" src={`/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(d.cover.path)}`} />}
                <div>
                  {d.video && <div className="plan-day__file">🎬 {d.video.name}{d.video.ok ? ` · ${formatBytes(d.video.size)}` : ''}</div>}
                  {d.cover && <div className="plan-day__file">🖼 {d.cover.name}</div>}
                </div>
              </div>
              {d.warnings.map((w) => <div key={w} className="card__error">⚠ {w}</div>)}
              <ul className="plan-day__posts">
                {d.posts.map((p, i) => {
                  const k = `${d.date}:${i}`;
                  return (
                    <li key={k}>
                      <button type="button" className="plan-post" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
                        <span className="plan-post__platform">{PLATFORM[p.platform] ?? p.platform}{p.kind !== 'post' ? ` ${p.kind}` : ''}</span>
                        <span className="plan-post__time">{p.time}</span>
                        <span className={`plan-post__caption${open === k ? ' is-open' : ''}`}>{p.title ? <strong>{p.title}. </strong> : null}{p.caption}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('deny', () => api.approve(body.approvalId, 'deny', body.digest))}>Don't post</button>
            {body.canAlways && <button type="button" className="btn btn--secondary" disabled={!!busy || !days.length} onClick={() => answer('always')}>Always allow</button>}
            <button type="button" className="btn btn--primary" disabled={!!busy || !days.length} onClick={() => answer('allow')}>{days.length ? `Approve ${days.length} ${days.length === 1 ? 'day' : 'days'} · ${posts} ${posts === 1 ? 'post' : 'posts'}` : 'No days on'}</button>
          </div>
          <div className="card__note">Good until {until}. A changed caption is held; a changed video or cover cancels its day.</div>
          {body.canAlways && body.alwaysNote && <div className="card__note card__note--warn">⚠ {body.alwaysNote}</div>}
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'allowed' || body.status === 'always' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'denied' ? 'Not approved' : body.status === 'expired' ? 'Expired, nothing approved' : plan.result ? `Approved ${plan.result.days.map(dayName).join(', ')}${body.status === 'always' ? ' (Always allow)' : ''}` : 'Approved'}
          {body.answeredBy && body.status !== 'expired' && ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}`}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  if (body.postingPlan) return <PostingPlanCard body={body} />;
  if (body.secret) return <SecretCard body={body} />;
  if (body.vault) return <VaultCard body={body} />;
  if (body.purchase) return <PurchaseCard body={body} />;
  if (body.screenHelp) return <ScreenHelpCard body={body} />;
  return <PlainApprovalCard body={body} />;
}

function PlainApprovalCard({ body }: { body: Card<'approval'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const decide = (d: 'allow' | 'always' | 'conversation' | 'deny') => run(d, () => api.approve(body.approvalId, d, body.digest));
  // A card can ask about several actions at once (a batch). They are all listed, because "Always allow" covers each of them.
  const tools = body.tools ?? [body.tool];
  const many = tools.length > 1;
  // Cards made before "Always allow" became per bot carry no flag: offer it whenever the card lists its tools.
  const mail = body.mail;
  const handoff = !!body.handoff;
  const canAlways = !mail && !handoff && (body.canAlways ?? tools.length > 0);
  // "Allow for this conversation" (server/src/conversation-allows.ts): only where the server offered it.
  const canConversation = canAlways && !!body.canConversation;
  const name = body.toolkitName ?? (body.toolkit ? humanizeToolkit(body.toolkit) : many ? 'Connected apps' : prettyTool(body.tool));
  return (
    <div className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={name} logo={body.logo} icon={cardIcon(body)} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{name}{body.kindName && !mail && <span className="card__kind">{body.kindName}</span>}</div>
        </div>
      </div>
      {mail && <MailView mail={mail} />}
      {body.kindSays && !mail && !handoff && !(body.detail ?? '').includes(body.kindSays) && <div className="card__says">{body.kindSays}</div>}
      {many && !mail && <div className="card__body">{tools.map((t) => `• ${prettyTool(t)}`).join('\n')}</div>}
      {body.detail && <div className="card__body">{body.detail}</div>}
      {!mail && <ArgsDetails args={body.args} />}
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>{mail ? "Don't send" : handoff ? "Don't do it" : "Don't allow"}</button>
            {/* Only when every listed tool may have a standing rule; it covers this Bot and these tools only. */}
            {canAlways && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')} title="This Bot can do this from now on without asking. Undo it under Settings, Permissions.">{many ? 'Always allow all' : 'Always allow'}</button>}
            {canConversation && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('conversation')} title="This Bot can do this again in this conversation without asking. It ends with a new conversation, or Turn off above the message box.">Allow for this conversation</button>}
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('allow')}>{mail ? 'Send' : handoff ? 'I did it myself' : 'Allow once'}</button>
          </div>
          {body.alwaysNote && !mail && <div className="card__note card__note--warn">⚠ {body.alwaysNote}</div>}
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' || (mail && body.sendResult && !body.sendResult.ok) ? 'close' : 'check'} size={12} opacity={0.7} />
          {mail
            ? body.status === 'denied' ? 'Not sent' : body.status === 'expired' ? 'Expired, not sent' : body.sendResult ? (body.sendResult.ok ? 'Sent' : `Send failed: ${body.sendResult.detail}`) : 'Send pressed'
            : handoff ? (body.status === 'denied' ? 'Not done' : body.status === 'expired' ? 'Expired' : 'You did it yourself')
            : body.status === 'conversation' && body.convOff ? 'Allowed for this conversation, then turned off'
            : APPROVAL_OUTCOME[body.status] ?? body.status}
          {body.answeredBy && body.status !== 'expired' && ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}`}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return (
    <div className={`card question-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__q">{body.question}</div>
        <div className="question-card__hint">{pending ? 'Pick an option or reply in your own words' : body.status === 'dismissed' ? 'Skipped' : 'Answered'}</div>
      </div>
      <div className="question-card__options">
        {body.options.map((opt, i) => {
          const chosen = body.answer === opt;
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              onClick={() => run(String(i), () => api.answer(row.botId, row, opt))}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{opt}</span>
              {chosen && <Icon name="check" size={12} opacity={0.6} style={{ marginLeft: 'auto', marginTop: 6 }} />}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="question-card__foot">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row))}>Skip</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- a group skill a member proposed ----------------

export function SkillProposalCard({ row, body }: { row: Row; body: Card<'skill-proposal'> }) {
  const { busy, error, run } = useBusy();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(body.name);
  const [description, setDescription] = useState(body.description);
  const [steps, setSteps] = useState(body.body);
  const pending = body.status === 'pending';
  return (
    <div className={`card question-card skill-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__hint">{body.fromBotName} proposes a group skill</div>
        {editing ? (
          <div className="skill-card__edit">
            <input className="text-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Skill name" />
            <input className="text-input" value={description} maxLength={300} placeholder="When to use it" onChange={(e) => setDescription(e.target.value)} aria-label="When to use it" />
            <textarea className="text-input skill-card__steps-input" rows={8} value={steps} onChange={(e) => setSteps(e.target.value)} aria-label="Steps" />
          </div>
        ) : (
          <>
            <div className="question-card__q">{body.name}</div>
            {body.description && <div className="skill-card__when">{body.description}</div>}
            <pre className="skill-card__steps">{body.body}</pre>
          </>
        )}
      </div>
      {pending ? (
        <div className="skill-card__actions">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row))}>Dismiss</button>
          {!editing && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => setEditing(true)}>Edit</button>}
          <button type="button" className="btn btn--primary" disabled={!!busy || (editing && (!name.trim() || !steps.trim()))}
            onClick={() => run('save', () => api.saveProposedSkill(row.botId, row, editing ? { name, description, body: steps } : undefined))}>
            {busy === 'save' ? 'Saving…' : 'Save to group skills'}
          </button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`} style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'saved' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'saved' ? 'Saved to this group’s skills' : 'Dismissed'}
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- connect ----------------

export function ConnectCard({ row, body }: { row: Row; body: Card<'connect'> }) {
  const { busy, error, run } = useBusy();
  const [waiting, setWaiting] = useState(false);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const pending = body.status === 'pending';

  // Leave the "waiting" state once the server reports a connection change or the card resolves.
  useEffect(() => { setWaiting(false); }, [connectionsVersion, body.status]);

  const connect = () => run('connect', async () => {
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect(body.toolkit, row.botId, row.seq);
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setWaiting(true);
    } catch (e) { popup?.close(); throw e; }
  });

  return (
    <div className={`card connect-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={body.toolkitName} logo={body.logo} appId={body.toolkit} size={44} />
        <div className="card__titles">
          <div className="card__title">Connect {body.toolkitName}</div>
          <div className="card__sub">{body.reason}</div>
        </div>
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(row.botId, row))}>Skip</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={connect}>{waiting ? 'Waiting for sign-in…' : 'Connect'}</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'connected' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'connected' ? `${body.toolkitName} connected` : 'Skipped'}
        </div>
      )}
    </div>
  );
}

// ---------------- draft ----------------

const CHANNEL_LABEL: Record<string, string> = { email: 'Email', slack: 'Slack', message: 'Chat' };

export function DraftCard({ body }: { body: Card<'draft'> }) {
  const { busy, error, run } = useBusy();
  const user = useStore((s) => s.user);
  const pending = body.status === 'pending';
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(body.text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } };
  const handle = user?.email ? `@${user.email.split('@')[0]}` : '';
  return (
    <div className={`card draft-card${pending ? '' : ' is-resolved'}`}>
      <div className="draft-card__head">
        <span className="draft-card__tile"><Icon name="chat_filled" size={18} color="var(--color-on-primary)" /></span>
        <div className="draft-card__titles">
          <div className="draft-card__channel">{CHANNEL_LABEL[body.channel] ?? 'Message'}</div>
          <div className="draft-card__from">{handle}</div>
        </div>
        <button type="button" className="draft-card__copy" onClick={copy} aria-label="Copy draft" title={copied ? 'Copied' : 'Copy'}>
          <Icon name={copied ? 'check' : 'copy'} size={12} opacity={0.66} />
        </button>
      </div>
      <div className="draft-card__content">
        <div className="draft-card__to">
          <span className="draft-card__to-label">To</span>
          <span className="draft-card__to-avatar">{(body.to.trim()[0] ?? '?').toUpperCase()}</span>
          <span className="draft-card__to-name">{body.to}</span>
        </div>
        {body.subject && <div className="draft-card__subject">{body.subject}</div>}
        <div className="draft-card__text">{body.text}</div>
      </div>
      {pending ? (
        <div className="draft-card__actions">
          <button type="button" className="btn btn--secondary btn--grow" disabled={!!busy} onClick={() => run('discard', () => api.approve(body.approvalId, 'deny', body.digest))}>Discard</button>
          <button type="button" className="btn btn--primary btn--grow" disabled={!!busy} onClick={() => run('send', () => api.approve(body.approvalId, 'allow', body.digest))}>Send</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`} style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'sent' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'sent' ? 'Sent' : 'Discarded'}
        </div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{error}</div>}
    </div>
  );
}

/** Files the bot wrote in its workspace this turn; each chip opens the file pane on it. */
function FilesCard({ body }: { body: Card<'files'> }) {
  const bot = useSelectedBot();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dl = async (path: string, name: string) => {
    if (!bot) return;
    setBusy(path); setError(null);
    try { await downloadBotFile(bot.id, path, name); } catch (e) { setError(`Couldn’t download ${name}: ${(e as Error).message}`); } finally { setBusy(null); }
  };
  return (
    <>
      <div className="file-chips">
        {body.files.map((f) => (
          <div key={f.path} className="file-chip file-chip--split">
            <button type="button" className="file-chip__open" onClick={() => openFile(f.path)} title={`Open ${f.path}`}>
              <span className="file-chip__icon"><FileGlyph file={f} size={16} /></span>
              <span className="file-chip__text">
                <span className="file-chip__name">{f.name}</span>
                <span className="file-chip__meta">{f.name.includes('.') ? f.name.split('.').pop()!.toUpperCase() : 'File'} · {formatBytes(f.size)}</span>
              </span>
            </button>
            {/* A Page downloads from its own "Download as" menu (md, docx, pdf…), not as raw JSON. */}
            {bot && kindOf(f.name) !== 'page' && (
              <button type="button" className="file-chip__dl" onClick={() => dl(f.path, f.name)} disabled={busy === f.path} aria-label={`Download ${f.name}`} title="Download">
                {busy === f.path ? <span className="cfg-spinner" /> : <Download aria-hidden size={15} strokeWidth={2} />}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <div className="card__error" style={{ padding: '6px 0 0' }}>{error}</div>}
    </>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'connect': return <ConnectCard row={row} body={b} />;
    case 'draft': return <DraftCard body={b} />;
    case 'plugin': return <PluginCardView body={b} />;
    case 'plugin-plan': return <PluginPlanCard body={b} />;
    case 'plugin-review': return <PluginReviewCard body={b} />;
    case 'look': return <LookCard row={row} body={b} />;
    case 'look-reveal': return <LookRevealCard row={row} body={b} />;
    case 'skill-proposal': return <SkillProposalCard row={row} body={b} />;
    case 'files': return <FilesCard body={b} />;
    case 'view': return <ViewCard row={row} body={b} />;
    default: return null;
  }
}
