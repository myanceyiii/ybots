import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { appendRow, emitBot, getBotRow, getRow, updateRow } from './store.js';
import { workspaceRoot } from './files.js';
import { cookieFacts, pushPublishState, readPost, setPublishHooks, type GuardNote, type PublishState } from './browser-guard.js';
import { noteRuleUse, ruleFor } from './allow-rules.js';
import type { PostingPlanOnCard, PlanDayOnCard } from './types.js';

/**
 * Posting from a bot's own browser (docs/posting.md), built for Raj taking over Alex's social media.
 *
 *  - The publish hold (browser-guard-page.ts): for bots with `publish_guard` on, every Post / Share /
 *    Publish / Schedule / Reply press on a social site is held unless the composer's text matches a caption
 *    on an approved posting plan, once per listed post.
 *  - request_posting_approval: one card lists each day (video, cover, captions and times per platform) with
 *    a switch per day; one Approve covers exactly the days left on. Editing a day's video or cover afterwards
 *    cancels that day; a changed caption simply no longer matches, so its press is held.
 *  - posting_dry_run: while on, every final press is held and reported, so a recipe can be walked to its
 *    last button without anything going out.
 *  - check_signins: which platforms the bot's browser is signed in to, from cookie names and expiry only.
 *
 * A bot message is never an approval. Answers come only from the card in the app (web, Windows, phone).
 */

addColumnOnce('bots', 'publish_guard', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS posting_plans (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  approval_id TEXT,
  status TEXT NOT NULL,            -- pending | approved | denied | expired
  plan TEXT NOT NULL,              -- PostingPlanOnCard JSON (days as shown)
  approved_days TEXT,              -- JSON string[] of dates
  approved_by TEXT,
  via_rule TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS posting_plans_bot ON posting_plans(bot_id, status);
CREATE TABLE IF NOT EXISTS posting_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES posting_plans(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  time TEXT NOT NULL,
  hashes TEXT NOT NULL,            -- JSON string[]: caption, and title when there is one
  preview TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_where TEXT,
  cancelled TEXT                   -- why the day's approval was cancelled
);
CREATE INDEX IF NOT EXISTS posting_items_bot ON posting_items(bot_id, used_at);
CREATE TABLE IF NOT EXISTS posting_files (
  plan_id TEXT NOT NULL REFERENCES posting_plans(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
`);

function addColumnOnce(table: string, col: string, ddl: string) {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

export const PLATFORMS = ['facebook', 'instagram', 'youtube', 'x', 'tiktok', 'linkedin', 'threads'] as const;
const PLATFORM_NAME: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X', tiktok: 'TikTok', linkedin: 'LinkedIn', threads: 'Threads' };
const TZ = process.env.POSTING_TZ || 'America/Chicago';

// ------------------------------------------------------------------ the hold's switch and caption hash

export function publishGuardOn(botId: string): boolean {
  const r = db.prepare('SELECT publish_guard FROM bots WHERE id=?').get(botId) as { publish_guard?: number } | undefined;
  return r?.publish_guard === 1;
}

export function setPublishGuard(botId: string, on: boolean) {
  db.prepare('UPDATE bots SET publish_guard=? WHERE id=?').run(on ? 1 : 0, botId);
  void pushPublishState(botId);
}

/** Must match browser-guard-page.ts norm() + hash(). */
export function normCaption(s: string): string {
  return String(s ?? '').normalize('NFKC').replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function captionHash(s: string): string {
  const str = normCaption(s);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ dry runs and state

const dryUntil = new Map<string, number>();
const dryNotes = new Map<string, GuardNote[]>();
const DRY_MS = 45 * 60_000;

/** End of a calendar day in the posting time zone, as epoch ms. */
export function endOfDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  // The zone's offset at that moment (handles CST/CDT).
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(guess));
  const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-06:00';
  const mm = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = mm ? (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] ?? 0)) : -360;
  return guess - mins * 60_000;
}

let lastFileCheck = new Map<string, number>();

/** The bot's state for its browser's publish hold. Called on every page load, so it stays cheap. */
export function publishState(botId: string): PublishState {
  const on = publishGuardOn(botId);
  if (!on) return { on: false, dry: false, allow: [] };
  const t = Date.now();
  if ((lastFileCheck.get(botId) ?? 0) < t - 5000) { lastFileCheck.set(botId, t); checkFiles(botId); }
  const dry = (dryUntil.get(botId) ?? 0) > t;
  const allow: { h: string; p: string }[] = [];
  if (!dry) {
    const rows = db.prepare('SELECT platform, hashes FROM posting_items WHERE bot_id=? AND used_at IS NULL AND cancelled IS NULL AND expires_at>?').all(botId, t) as { platform: string; hashes: string }[];
    for (const r of rows) for (const h of JSON.parse(r.hashes) as string[]) allow.push({ h, p: r.platform });
  }
  return { on, dry, allow: allow.slice(0, 200) };
}

/** A press went through, was held, or a dry run reached the end: record it and tell the chat. */
function onEvent(botId: string, n: GuardNote) {
  if (n.kind === 'pub_dry') {
    const list = dryNotes.get(botId) ?? [];
    list.push(n);
    dryNotes.set(botId, list.slice(-20));
    return;
  }
  if (n.kind !== 'published' || !n.h) return;
  // Mark the first open item with this caption, preferring the page's own platform (Business Suite posts
  // Facebook and Instagram from facebook.com).
  const rows = db.prepare('SELECT id, platform, hashes, date, kind FROM posting_items WHERE bot_id=? AND used_at IS NULL AND cancelled IS NULL AND expires_at>? ORDER BY date, time').all(botId, Date.now()) as any[];
  const hits = rows.filter((r) => (JSON.parse(r.hashes) as string[]).includes(n.h!));
  const hit = hits.find((r) => r.platform === n.platform) ?? hits[0];
  if (!hit) return;
  // One Business Suite press schedules the Facebook post and its Instagram twin with the same caption.
  const twin = n.platform === 'facebook' ? hits.find((r) => r !== hit && r.date === hit.date && r.platform === (hit.platform === 'facebook' ? 'instagram' : 'facebook')) : undefined;
  const used = twin ? [hit, twin] : [hit];
  for (const r of used) db.prepare('UPDATE posting_items SET used_at=?, used_where=? WHERE id=?').run(now(), `${n.label ?? 'Post'} on ${n.origin}`, r.id);
  const what = used.map((r) => `${PLATFORM_NAME[r.platform] ?? r.platform}${r.kind !== 'post' ? ` ${r.kind}` : ''}`).join(' and ');
  appendRow(botId, 'notice', { type: 'notice', tone: 'info', text: `${getBotRow(botId)?.name ?? 'The bot'} pressed "${n.label ?? 'Post'}" on ${hostOf(n.origin)} for ${hit.date} ${what} (approved on the posting plan).` });
  emitBot(botId);
  void pushPublishState(botId);
}

setPublishHooks(publishState, onEvent);

const hostOf = (o: string) => { try { return new URL(o).host; } catch { return o; } };

// ------------------------------------------------------------------ files on a plan

const inside = (root: string, rel: string): string | null => {
  const clean = String(rel ?? '').replace(/^\/+/, '');
  if (!clean) return null;
  const abs = path.resolve(root, clean.startsWith(root + '/') ? clean.slice(root.length + 1) : clean);
  return abs === root || abs.startsWith(root + '/') ? abs : null;
};

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

async function fileOnCard(botId: string, rel: string | undefined): Promise<{ path: string; name: string; size: number; ok: boolean; sha?: string; mtime?: number } | null> {
  if (!rel) return null;
  const root = workspaceRoot(botId);
  const abs = inside(root, rel);
  if (!abs) return { path: String(rel).slice(0, 200), name: path.basename(String(rel)).slice(0, 120), size: 0, ok: false };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    return { path: path.relative(root, abs), name: path.basename(abs), size: st.size, ok: true, sha: await sha256(abs), mtime: Math.floor(st.mtimeMs) };
  } catch {
    return { path: path.relative(root, abs), name: path.basename(abs), size: 0, ok: false };
  }
}

/** A day whose video or cover changed (or went missing) after approval loses its approval. */
function checkFiles(botId: string) {
  const root = workspaceRoot(botId);
  const rows = db.prepare(`SELECT f.*, p.bot_id FROM posting_files f JOIN posting_plans p ON p.id=f.plan_id
    WHERE p.bot_id=? AND p.status='approved' AND EXISTS (SELECT 1 FROM posting_items i WHERE i.plan_id=f.plan_id AND i.date=f.date AND i.used_at IS NULL AND i.cancelled IS NULL AND i.expires_at>?)`).all(botId, Date.now()) as any[];
  for (const f of rows) {
    let changed = '';
    try {
      const st = fs.statSync(path.join(root, f.path));
      if (st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtime) changed = `${path.basename(f.path)} changed`;
    } catch { changed = `${path.basename(f.path)} is gone`; }
    if (changed) cancelDay(botId, f.plan_id, f.date, changed);
  }
}

function cancelDay(botId: string, planId: string, date: string, why: string) {
  const n = db.prepare('UPDATE posting_items SET cancelled=? WHERE plan_id=? AND date=? AND used_at IS NULL AND cancelled IS NULL').run(why.slice(0, 200), planId, date).changes;
  if (!n) return;
  appendRow(botId, 'notice', { type: 'notice', tone: 'warn', text: `The approval for ${date} was cancelled: ${why}. ${n} unposted ${n === 1 ? 'post needs' : 'posts need'} a new posting plan card.` });
  emitBot(botId);
  void pushPublishState(botId);
}

// ------------------------------------------------------------------ the posting plan card

/** Answers waiting for their tool: the days left switched on, set by routes.ts just before the card resolves. */
const chosen = new Map<string, string[]>();
export function handPlanDays(approvalId: string, days: string[]) { chosen.set(approvalId, days); setTimeout(() => chosen.delete(approvalId), 30_000).unref?.(); }

export interface Ctx { userId: string; botId: string; chatId?: string }
type Out = { output: string; summary?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

export async function requestPostingPlan(a: any, ctx: Ctx): Promise<Out> {
  if (!publishGuardOn(ctx.botId)) return { output: 'Posting plans are only for bots whose browser holds Post buttons (publish guard). Ask the owner to turn it on for you.', summary: 'failed' };
  const daysIn = Array.isArray(a?.days) ? a.days.slice(0, 14) : [];
  if (!daysIn.length) return { output: 'List at least one day, each with its posts.', summary: 'failed' };
  const days: PlanDayOnCard[] = [];
  const files: { date: string; path: string; size: number; mtime: number; sha256: string }[] = [];
  const seen = new Set<string>();
  for (const d of daysIn) {
    const date = s(d?.date, 10);
    if (!DATE.test(date)) return { output: `"${date}" is not a date (use YYYY-MM-DD).`, summary: 'failed' };
    if (seen.has(date)) return { output: `${date} is listed twice; put all of a day's posts under one entry.`, summary: 'failed' };
    seen.add(date);
    if (endOfDay(date) < Date.now()) return { output: `${date} is already over.`, summary: 'failed' };
    const warnings: string[] = [];
    const video = await fileOnCard(ctx.botId, d?.video);
    const cover = await fileOnCard(ctx.botId, d?.cover);
    if (!video) warnings.push('No video named for this day.');
    else if (!video.ok) warnings.push(`The video ${video.name} is not in the bot's files.`);
    if (cover && !cover.ok) warnings.push(`The cover ${cover.name} is not in the bot's files.`);
    for (const f of [video, cover]) if (f?.ok && f.sha) files.push({ date, path: f.path, size: f.size, mtime: f.mtime!, sha256: f.sha });
    const posts = (Array.isArray(d?.posts) ? d.posts : []).slice(0, 12).map((p: any) => ({
      platform: PLATFORMS.includes(String(p?.platform ?? '').toLowerCase() as any) ? String(p.platform).toLowerCase() : 'other',
      time: s(p?.time, 20), kind: ['post', 'reply', 'comment'].includes(p?.kind) ? p.kind : 'post',
      caption: s(p?.caption, 5000), title: s(p?.title, 200) || undefined,
    }));
    if (!posts.length) return { output: `${date} has no posts.`, summary: 'failed' };
    for (const p of posts) {
      if (p.platform === 'other') return { output: `Platform must be one of ${PLATFORMS.join(', ')}.`, summary: 'failed' };
      if (!normCaption(p.caption)) return { output: `The ${p.platform} post on ${date} has no caption. List the exact text you will paste.`, summary: 'failed' };
    }
    days.push({
      date, label: s(d?.label, 120),
      video: video ? { path: video.path, name: video.name, size: video.size, ok: video.ok, sha: video.sha?.slice(0, 12) } : null,
      cover: cover ? { path: cover.path, name: cover.name, size: cover.size, ok: cover.ok } : null,
      posts, warnings,
    });
  }
  days.sort((x, y) => x.date.localeCompare(y.date));
  const plan: PostingPlanOnCard = { days, why: s(a?.why, 300), expires: endOfDay(days[days.length - 1].date), tz: TZ };
  const planId = newId('pln');
  db.prepare('INSERT INTO posting_plans(id,bot_id,status,plan,created_at) VALUES (?,?,?,?,?)').run(planId, ctx.botId, 'pending', JSON.stringify(plan), now());
  const insF = db.prepare('INSERT INTO posting_files(plan_id,date,path,size,mtime,sha256) VALUES (?,?,?,?,?,?)');
  for (const f of files) insF.run(planId, f.date, f.path, f.size, f.mtime, f.sha256);
  const bot = getBotRow(ctx.botId);
  const count = days.reduce((n, d) => n + d.posts.length, 0);
  const pretty = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const span = days.length === 1 ? pretty(days[0].date) : `${pretty(days[0].date)} to ${pretty(days[days.length - 1].date)}`;

  // A standing rule counts only once a person has pressed Approve on a posting plan for this bot before.
  const rule = ruleFor(ctx.botId, 'posting_plan');
  const pressedBefore = !!db.prepare("SELECT 1 FROM approvals WHERE bot_id IN (?, ?) AND tool='posting_plan' AND status IN ('allowed','always') AND answered_by IS NOT NULL LIMIT 1").get(ctx.botId, ctx.chatId ?? ctx.botId);
  let approved: string[] = [];
  let approvedBy = '';
  if (rule && pressedBefore && days.every((d) => !d.warnings.length)) {
    approved = days.map((d) => d.date);
    approvedBy = 'Always allow';
    noteRuleUse(rule, ctx.botId, 'posting_plan', { span, count }, `Posting plan ${span}, ${count} posts`);
    appendRow(ctx.chatId ?? ctx.botId, 'notice', { type: 'notice', tone: 'info', text: `Posting plan for ${span} (${count} posts) approved by your Always allow rule. Remove it under Settings, Permissions.` });
    emitBot(ctx.chatId ?? ctx.botId);
    db.prepare('UPDATE posting_plans SET via_rule=? WHERE id=?').run(rule, planId);
  } else {
    const { requestApproval } = await import('./agent/loop.js');
    const meta: { approvalId?: string; answeredBy?: string } = {};
    const answer = await requestApproval(
      { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
      {
        decision: 'ask', key: 'posting_plan', title: `posting_plan: ${span}`, asks: ['posting_plan'], detail: '',
        posting: { title: `${bot?.name ?? 'The bot'} wants to post ${count} ${count === 1 ? 'post' : 'posts'}, ${span}`, plan },
      },
      { plan: planId, days: days.map((d) => ({ date: d.date, video: d.video?.sha ?? null, posts: d.posts.map((p) => [p.platform, p.time, p.kind, captionHash(p.caption), p.title ? captionHash(p.title) : '']) })) },
      null, meta,
    );
    db.prepare('UPDATE posting_plans SET approval_id=? WHERE id=?').run(meta.approvalId ?? null, planId);
    if (answer !== 'allow' || !meta.approvalId) {
      db.prepare('UPDATE posting_plans SET status=?, resolved_at=? WHERE id=?').run(answer === 'deny' ? 'denied' : 'expired', now(), planId);
      return { output: answer === 'deny' ? 'The person did not approve this posting plan. Post nothing from it; ask what they want changed.' : 'Nobody answered the posting plan card in time; nothing may be posted from it.', summary: 'Not approved' };
    }
    approved = (chosen.get(meta.approvalId) ?? []).filter((d) => seen.has(d));
    chosen.delete(meta.approvalId);
    approvedBy = meta.answeredBy ?? 'the person';
  }
  if (!approved.length) {
    db.prepare('UPDATE posting_plans SET status=?, resolved_at=? WHERE id=?').run('denied', now(), planId);
    return { output: 'No day was left switched on, so nothing is approved.', summary: 'Not approved' };
  }
  // A new approval for a date replaces older unposted ones for that date.
  for (const date of approved) {
    db.prepare("UPDATE posting_items SET cancelled='replaced by a newer posting plan' WHERE bot_id=? AND date=? AND used_at IS NULL AND cancelled IS NULL").run(ctx.botId, date);
  }
  const ins = db.prepare('INSERT INTO posting_items(id,plan_id,bot_id,date,platform,kind,time,hashes,preview,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const d of days) {
      if (!approved.includes(d.date)) continue;
      for (const p of d.posts) {
        const hashes = [captionHash(p.caption), ...(p.title ? [captionHash(p.title)] : [])];
        ins.run(newId('pit'), planId, ctx.botId, d.date, p.platform, p.kind, p.time, JSON.stringify(hashes), p.caption.slice(0, 120), endOfDay(d.date));
      }
    }
  })();
  db.prepare("UPDATE posting_plans SET status='approved', approved_days=?, approved_by=?, resolved_at=? WHERE id=?").run(JSON.stringify(approved), approvedBy, now(), planId);
  patchPlanCard(planId, { result: { days: approved, at: now() } });
  await pushPublishState(ctx.botId);
  const off = days.filter((d) => !approved.includes(d.date)).map((d) => d.date);
  return {
    output: [
      `Approved by ${approvedBy}: ${approved.join(', ')}${off.length ? `. Switched off (do NOT post): ${off.join(', ')}` : ''}.`,
      'Your browser now lets the Post / Share / Schedule press through once per approved post, only when the text in the box matches the approved caption (or YouTube title) exactly. Paste the captions exactly as listed; any edit means the press is held and you must ask again.',
      'Changing or replacing a day\'s video or cover cancels that day. Approvals end at the end of each day (' + TZ + ').',
      'After scheduling, check each platform\'s scheduled list and tell the person what is queued on each platform (call posting_status).',
    ].join(' '),
    summary: `Approved ${approved.length} ${approved.length === 1 ? 'day' : 'days'}`,
  };
}

function patchPlanCard(planId: string, patch: Record<string, unknown>) {
  const p = db.prepare('SELECT approval_id FROM posting_plans WHERE id=?').get(planId) as { approval_id?: string } | undefined;
  if (!p?.approval_id) return;
  const ap = db.prepare('SELECT bot_id, row_seq FROM approvals WHERE id=?').get(p.approval_id) as { bot_id: string; row_seq: number } | undefined;
  if (!ap) return;
  const row = getRow(ap.bot_id, ap.row_seq);
  if (!row || row.body.type !== 'card' || row.body.card !== 'approval' || !(row.body as any).postingPlan) return;
  updateRow(ap.bot_id, ap.row_seq, { ...row.body, postingPlan: { ...(row.body as any).postingPlan, ...patch } } as any);
  emitBot(ap.bot_id);
}

// ------------------------------------------------------------------ dry runs

export async function postingDryRun(a: any, ctx: Ctx): Promise<Out> {
  if (!publishGuardOn(ctx.botId)) return { output: 'Dry runs need the publish guard, which is off for you.', summary: 'failed' };
  const action = String(a?.action ?? 'start');
  if (action === 'start') {
    dryUntil.set(ctx.botId, Date.now() + DRY_MS);
    dryNotes.set(ctx.botId, []);
    await pushPublishState(ctx.botId);
    return { output: `Dry run on for 45 minutes. Every Post / Share / Publish / Schedule / Reply press in your browser is held, even for approved posts, and reported. Walk the recipe to the end and press the final button; then call posting_dry_run with action "finish" for the report. Close the composer without saving afterwards unless the recipe says to keep a private draft.`, summary: 'Dry run on' };
  }
  const notes = dryNotes.get(ctx.botId) ?? [];
  const post = await readPost(ctx.botId).catch(() => null);
  dryUntil.delete(ctx.botId);
  dryNotes.delete(ctx.botId);
  await pushPublishState(ctx.botId);
  const lines = notes.map((n) => `- ${PLATFORM_NAME[n.platform ?? ''] ?? n.platform ?? ''} ${hostOf(n.origin)}: held "${n.label}"${n.preview ? ` (box showed: ${n.preview})` : ''}`);
  return {
    output: notes.length
      ? `Dry run finished. Final presses that were held (nothing was published):\n${lines.join('\n')}${post?.texts.length ? `\nThe composer now shows: ${post.texts.map((t) => t.slice(0, 120)).join(' / ')}` : ''}`
      : 'Dry run finished, but no final Post / Share / Schedule press was seen. The recipe did not reach its last button (or the button label is one the guard does not know: say which).',
    summary: notes.length ? `Reached ${notes.length} final ${notes.length === 1 ? 'button' : 'buttons'}` : 'No final press',
  };
}

// ------------------------------------------------------------------ status

export function postingStatus(_a: any, ctx: Ctx): Out {
  const items = db.prepare('SELECT date, platform, kind, time, preview, expires_at, used_at, used_where, cancelled FROM posting_items WHERE bot_id=? AND expires_at>? ORDER BY date, time').all(ctx.botId, Date.now() - 7 * 86400_000) as any[];
  const dry = (dryUntil.get(ctx.botId) ?? 0) > Date.now();
  if (!items.length) return { output: `No approved posts in the last week or ahead.${dry ? ' A dry run is on.' : ''}`, summary: 'Nothing approved' };
  const fmt = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = items.map((r) => `- ${r.date} ${r.time} ${PLATFORM_NAME[r.platform] ?? r.platform}${r.kind !== 'post' ? ` ${r.kind}` : ''}: ${r.used_at ? `pressed ${fmt(r.used_at)} (${r.used_where})` : r.cancelled ? `cancelled (${r.cancelled})` : r.expires_at < Date.now() ? 'approval ended unused' : 'approved, not pressed yet'} — "${String(r.preview).slice(0, 60)}"`);
  return { output: `${dry ? 'A dry run is on (nothing can be published until it finishes).\n' : ''}${lines.join('\n')}`, summary: `${items.filter((r) => r.used_at).length} of ${items.length} pressed` };
}

// ------------------------------------------------------------------ sign-in check

const SIGNIN: { platform: string; domain: RegExp; names: string[] }[] = [
  { platform: 'google', domain: /(^|\.)google\.com$/, names: ['SID', '__Secure-1PSID', '__Secure-3PSID'] },
  { platform: 'youtube', domain: /(^|\.)youtube\.com$/, names: ['LOGIN_INFO', '__Secure-1PSID', 'SID'] },
  { platform: 'facebook', domain: /(^|\.)facebook\.com$/, names: ['c_user', 'xs'] },
  { platform: 'instagram', domain: /(^|\.)instagram\.com$/, names: ['sessionid', 'ds_user_id'] },
  { platform: 'x', domain: /(^|\.)(x|twitter)\.com$/, names: ['auth_token'] },
  { platform: 'tiktok', domain: /(^|\.)tiktok\.com$/, names: ['sessionid', 'sid_tt', 'sessionid_ss'] },
  { platform: 'linkedin', domain: /(^|\.)linkedin\.com$/, names: ['li_at'] },
];

/**
 * Which platforms the browser is signed in to, read from cookie names and expiry dates only (never values).
 * A login kept only in a session cookie is lost when the browser restarts, so it is called out.
 */
export async function checkSignins(_a: any, ctx: Ctx): Promise<Out> {
  const all = await cookieFacts(ctx.botId, /(google|youtube|facebook|instagram|x|twitter|tiktok|linkedin)\.com$/);
  if (!all) return { output: 'Your browser is not running, so sign-ins could not be checked. Open any page first.', summary: 'failed' };
  const lines: string[] = [];
  const out: Record<string, unknown> = {};
  for (const p of SIGNIN) {
    const hits = all.filter((c) => p.domain.test(c.domain.replace(/^\./, '')) && p.names.includes(c.name));
    if (!hits.length) { lines.push(`- ${p.platform}: signed out`); out[p.platform] = { signedIn: false }; continue; }
    const persistent = hits.filter((c) => !c.session && c.expires > 0);
    const soonest = persistent.length ? Math.min(...persistent.map((c) => c.expires * 1000)) : 0;
    const days = soonest ? Math.round((soonest - Date.now()) / 86400_000) : 0;
    out[p.platform] = { signedIn: true, persistent: persistent.length === hits.length, expiresInDays: days };
    lines.push(`- ${p.platform}: signed in${persistent.length < hits.length ? ' (part of the login is a session cookie: it ends when the browser restarts)' : `, login kept for about ${days} days`}`);
  }
  return { output: `${lines.join('\n')}\nCookie names and dates only; no values were read.`, summary: `${Object.values(out).filter((v: any) => v.signedIn).length} signed in` };
}
