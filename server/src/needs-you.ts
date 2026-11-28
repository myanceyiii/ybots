import { Hono } from 'hono';
import { answer } from './lib/contract.js';
import { db } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { inScope, type Scope } from './lib/scope.js';
import { taskStale } from './store.js';

/**
 * The "Needs you" board (Alex, 2026-11-28): one list of everything waiting on a person, across every bot and
 * group, the same on the web, Windows and Android apps. Before this the apps only marked a bot as waiting
 * (live.awaiting); a bot with three cards waiting showed as one row, and a task stuck on the person or a
 * form left unanswered showed nowhere but deep in its chat.
 *
 * It only reads. Every row opens the chat at the card (chatId + seq) or the bot's tasks, and the answer
 * still goes through that card's own path (approvals with their digest, questions, forms): nothing here
 * answers anything, and a bot cannot add to it except by posting a real card.
 *
 * A scoped sign-in (lib/scope.ts, Sam's app) gets only the items of the bots it can see. A bot the
 * owner hid from the list (owner_hidden) is left out of the owner's board, as it is from the list itself.
 *
 * The idea of one cross-agent "needs you" inbox comes from OpenBot's needs-you screen (MIT); nothing of its
 * code is used here. A handoff between bots (bot-handoffs.ts) stuck because its bot waits on the person shows too.
 */

import type { NeedsItem, NeedsKind } from './needs-you-types.js';
export type { NeedsItem, NeedsKind };

export const NEEDS_LIMITS = {
  /** A card left pending longer than this is treated as abandoned and left off the board. */
  cardMs: 14 * 24 * 60 * 60_000,
  /** Choice buttons and forms wait only this long, and only while the person has not written since. */
  formMs: 2 * 24 * 60 * 60_000,
  /** At most this many rows; the most recent first. */
  items: 60,
};

const line = (v: unknown, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The board item for one chat row, or null when it does not wait on the person. `laterPerson`: the person wrote after it. */
export function itemOfCard(body: any, base: { botId: string; chatId: string; seq: number; at: number; sideTitle: string | null }, now: number, laterPerson: boolean): NeedsItem | null {
  if (!body || body.type !== 'card') return null;
  const mk = (kind: NeedsKind, label: string, title: string, detail = ''): NeedsItem => ({
    id: `${base.chatId}:${base.seq}`, kind, label, title: line(title) || label, detail: line(detail, 200), ...base,
  });
  const age = now - base.at;
  if (body.card === 'view') {
    if (age > NEEDS_LIMITS.formMs || laterPerson) return null;
    const blocks: any[] = Array.isArray(body.blocks) ? body.blocks : [];
    const form = blocks.find((b) => b?.type === 'form' && !b.sentAt);
    if (form) return mk('form', 'Form', form.title || body.title || 'A form to fill in', Array.isArray(form.fields) ? form.fields.map((f: any) => line(f?.label, 40)).filter(Boolean).join(', ') : '');
    const choice = blocks.find((b) => b?.type === 'choice' && !b.sentAt && !(Array.isArray(b.picked) && b.picked.length) && !b.otherText);
    if (choice && body.checkin) return mk('choice', 'Check-in offer', choice.question || body.title, Array.isArray(choice.options) ? choice.options.map((o: unknown) => line(o, 40)).join(' · ') : '');
    if (choice && (body.quick || blocks.length === 1)) return mk('choice', 'Question', choice.question || body.title, Array.isArray(choice.options) ? choice.options.map((o: unknown) => line(o, 40)).join(' · ') : '');
    return null;
  }
  if (body.status !== 'pending' || age > NEEDS_LIMITS.cardMs) return null;
  switch (body.card) {
    case 'approval': {
      if (body.mail) return mk('email', 'Email to send', `To ${line(body.mail.to, 80) || 'someone'}`, body.mail.subject || '');
      if (body.secret) return mk('secret', 'Secure input', body.title || 'Type something in on the bot’s screen', body.detail || '');
      if (body.purchase) return mk('purchase', 'Purchase', body.title || 'A purchase to approve', body.detail || '');
      if (body.screenHelp) return mk('screen', 'Help on screen', body.title || body.screenHelp.reason || 'Help needed on the bot’s screen', body.screenHelp.site || '');
      if (body.postingPlan) return mk('plan', 'Posting plan', body.title || 'A posting plan to approve', body.detail || '');
      return mk('approval', 'Approval', body.title || 'Needs your OK', body.detail || '');
    }
    case 'question': return mk('question', 'Question', body.question || 'A question for you', Array.isArray(body.options) ? body.options.map((o: unknown) => line(o, 40)).join(' · ') : '');
    case 'connect': return mk('connect', 'Connect', `Connect ${line(body.toolkitName || body.toolkit, 60) || 'an app'}`, body.reason || '');
    case 'plugin-plan': return mk('plugin', 'Plugin plan', body.title || 'A plugin to build', body.purpose || '');
    case 'plugin-review': return mk('plugin', 'Plugin to install', body.title || 'A plugin to review', '');
    case 'look': return Array.isArray(body.candidates) && body.candidates.length ? mk('look', 'Pick a look', 'New pictures to choose from', body.description || '') : null;
    case 'skill-proposal': return mk('skill', 'Skill to save', body.name || 'A skill to save', body.description || '');
    case 'draft': return mk('draft', 'Draft to send', body.subject ? `${body.subject}` : `To ${line(body.to, 80) || 'someone'}`, body.subject ? `To ${line(body.to, 80)}` : body.text || '');
    default: return null;
  }
}

/** Whether a message row is the person's own (not a bot's post in a group, not a routine). */
const fromPerson = (b: any) => b?.type === 'message' && b.role === 'user' && (!b.from || b.from.kind === 'voice');

/** Everything waiting on the person for this account, newest first, limited to what the scope may see. */
export function needsYouFor(userId: string, scope: Scope | null, now = Date.now()): NeedsItem[] {
  const chats = db.prepare(`SELECT id, side_of, generation, chat_title, COALESCE(owner_hidden,0) AS owner_hidden, COALESCE(hidden,0) AS hidden
    FROM bots WHERE user_id=? AND chat_deleted_at IS NULL`).all(userId) as { id: string; side_of: string | null; generation: number; chat_title: string | null; owner_hidden: number; hidden: number }[];
  const byId = new Map(chats.map((c) => [c.id, c]));
  const out: NeedsItem[] = [];
  const cardRows = db.prepare(`SELECT seq, body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND created_at>?
    AND (body LIKE '%"status":"pending"%' OR body LIKE '%"card":"view"%') ORDER BY seq DESC LIMIT 200`);
  const lastPerson = db.prepare(`SELECT seq, body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND seq>? AND body LIKE '%"role":"user"%' ORDER BY seq DESC LIMIT 40`);
  for (const c of chats) {
    const owner = c.side_of ? byId.get(c.side_of) : c;
    if (!owner || (owner !== c && owner.hidden)) continue;
    // A helper or an internal chat that is not in any list (hidden, not a side chat) has no row to open.
    if (!c.side_of && c.hidden) continue;
    if (!inScope(scope, owner.id)) continue;
    if (!scope && owner.owner_hidden) continue;
    const rows = cardRows.all(c.id, c.generation, now - NEEDS_LIMITS.cardMs) as { seq: number; body: string; created_at: number }[];
    if (!rows.length) continue;
    const parsed = rows.map((r) => { try { return { ...r, b: JSON.parse(r.body) }; } catch { return null; } }).filter(Boolean) as { seq: number; created_at: number; b: any }[];
    // The newest message the person wrote after the oldest view, to tell an answered-in-words form from a waiting one.
    const views = parsed.filter((r) => r.b?.card === 'view');
    let personSeq = -1;
    if (views.length) {
      const from = Math.min(...views.map((v) => v.seq));
      for (const m of lastPerson.all(c.id, c.generation, from) as { seq: number; body: string }[]) {
        try { if (fromPerson(JSON.parse(m.body))) { personSeq = m.seq; break; } } catch { /* skip */ }
      }
    }
    const sideTitle = c.side_of ? c.chat_title || 'Side chat' : null;
    let viewSeen = false;
    for (const r of parsed) {
      // Only the newest view of a chat can be waiting: an earlier form the bot moved on from is not.
      if (r.b?.card === 'view') { if (viewSeen) continue; }
      const it = itemOfCard(r.b, { botId: owner.id, chatId: c.id, seq: r.seq, at: r.created_at, sideTitle }, now, personSeq > r.seq);
      if (r.b?.card === 'view') viewSeen = true;
      if (it) out.push(it);
    }
  }
  // Tasks the bot is stuck on without the person, and ones it left behind (taskStale, store.ts).
  const tasks = db.prepare(`SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? AND t.state IN ('needs_input','working') ORDER BY t.updated_at DESC LIMIT 300`).all(userId) as any[];
  for (const t of tasks) {
    const owner = byId.get(t.bot_id);
    if (!owner || owner.side_of || owner.hidden || !inScope(scope, owner.id) || (!scope && owner.owner_hidden)) continue;
    if (t.state === 'needs_input') out.push({ id: `task:${t.id}`, kind: 'task', label: 'Waiting on you', title: line(t.title) || 'A task', detail: line(t.note, 200), botId: owner.id, chatId: owner.id, taskId: t.id, sideTitle: null, at: t.updated_at });
    else if (taskStale(t, now)) out.push({ id: `task:${t.id}`, kind: 'stalled', label: 'Stalled', title: line(t.title) || 'A task', detail: line(t.note, 200) || 'Not touched in hours. Mark it done, or ask the bot to carry on.', botId: owner.id, chatId: owner.id, taskId: t.id, sideTitle: null, at: t.updated_at });
  }
  // Handoffs (bot-handoffs.ts) another bot is waiting on because the answering bot waits on the person. Its
  // own card is usually on the board already; a row here only when it is not, so nothing shows twice.
  let hops: any[] = [];
  try { hops = db.prepare("SELECT id, from_bot, to_bot, task, updated_at FROM bot_hops WHERE user_id=? AND status='waiting' ORDER BY updated_at DESC LIMIT 50").all(userId) as any[]; } catch { /* no handoffs table yet */ }
  for (const h of hops) {
    const to = byId.get(h.to_bot);
    const owner = to?.side_of ? byId.get(to.side_of) : to;
    if (!owner || owner.hidden || !inScope(scope, owner.id) || (!scope && owner.owner_hidden)) continue;
    if (out.some((i) => i.botId === owner.id)) continue;
    const asker = db.prepare('SELECT name FROM bots WHERE id=?').get(h.from_bot) as { name?: string } | undefined;
    out.push({ id: `hop:${h.id}`, kind: 'handoff', label: 'Handoff waiting', title: line(h.task) || 'An ask from another bot', detail: asker?.name ? `${asker.name} is waiting on this` : '', botId: owner.id, chatId: owner.id, sideTitle: null, at: h.updated_at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, NEEDS_LIMITS.items);
}

export const needsYouApi = new Hono<AuthVars>();
needsYouApi.use('*', requireUser);
needsYouApi.get('/', (c) => answer(c, 'GET /api/needs-you', { items: needsYouFor(c.get('user').id, c.get('scope')) }));
