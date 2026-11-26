import fs from 'node:fs';
import WebSocket from 'ws';
import { db, now } from './db.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { checkOutgoing, formatOutgoing, outsideBots, outsideFor, parseIncoming, START, STOP, type OutsideBot } from './outside.js';
import type { OutsideExchange } from './types.js';

/**
 * The Slack link for outside members (see outside.ts).
 *
 * Out: a message to an outside member is posted in its channel with the owner's Slack user token, so
 * Slack shows it under the owner's name, tagged "Sent using <app>" (the channel's rule 5: such a post
 * is a bot and never counts as approval). A real mention of the member goes with every post, because
 * a ChatGPT agent wakes at once on its owner's mentions and otherwise only on its hourly check.
 *
 * In: one Socket Mode connection (outbound WebSocket, no public URL) delivers the channel's messages.
 * The member's replies in a thread we started go back to whoever asked; its own posts written as
 * "[Sheldon]>@Leonard …" go to the bot named. Everything arrives as information only: the trigger is
 * 'external', which never answers or expires an approval.
 *
 * Tokens: SLACK_USER_TOKEN (user scopes chat:write, channels:history, channels:read), SLACK_APP_TOKEN
 * (Socket Mode). SLACK_BOT_TOKEN is optional and only used for permalinks when set. The app should have
 * NO bot user: Slack tags user-token posts from an app with a bot user with bot_id, and ChatGPT agents
 * did not start a turn for those posts (seen live 2026-11-22), while posts without bot_id did.
 * A fresh app with no bot user still got bot_id. Posts sent through Slack's own MCP server
 * (mcp.slack.com, "Sent using <app>") carry no bot_id and did wake Sheldon, so with SLACK_POST_VIA=mcp
 * (needs "Slack MCP server access" on in the app's Agents & AI Apps page) posts go that way, and fall
 * back to chat.postMessage if the MCP call fails. SLACK_MCP_URL is only for tests.
 * and SLACK_APP_TOKEN (connections:write, Socket Mode), each also as *_FILE. SLACK_API_URL is only for tests.
 */

const API = () => (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '');

function token(name: string): string {
  if (process.env[name]) return String(process.env[name]).trim();
  const f = process.env[`${name}_FILE`];
  if (!f) return '';
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
}

/** Tables are made on import, so anything that lists bots works before the link starts. */
export function initSlackLink() {}

db.exec(`
    CREATE TABLE IF NOT EXISTS outside_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outside_id TEXT NOT NULL,
      direction TEXT NOT NULL,            -- 'out' | 'in'
      bot_id TEXT,                        -- out: who asked (NULL = the owner); in: who it went to
      room_id TEXT,                       -- out: asked from this group chat
      type TEXT,
      text TEXT NOT NULL,
      slack_ts TEXT,
      thread_ts TEXT,
      link TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,                -- out: sending | sent | answered | no-answer | failed; in: delivered | logged
      error TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS outside_messages_ts ON outside_messages(slack_ts);
    CREATE TABLE IF NOT EXISTS outside_state (outside_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
`);

// ---------- status the app shows ----------

let socketState: 'off' | 'connecting' | 'connected' | 'error' = 'off';
let socketError: string | null = null;

export const isPaused = (outsideId: string) => !!(db.prepare('SELECT paused FROM outside_state WHERE outside_id=?').get(outsideId) as any)?.paused;

export function setPaused(outsideId: string, paused: boolean) {
  db.prepare('INSERT INTO outside_state(outside_id, paused, updated_at) VALUES (?,?,?) ON CONFLICT(outside_id) DO UPDATE SET paused=excluded.paused, updated_at=excluded.updated_at').run(outsideId, paused ? 1 : 0, now());
  emitBot(outsideId);
}

export function linkStatus(outsideId: string): 'ready' | 'paused' | 'offline' | 'not-set-up' {
  if (!token('SLACK_USER_TOKEN') || !token('SLACK_APP_TOKEN')) return 'not-set-up';
  if (isPaused(outsideId)) return 'paused';
  return socketState === 'connected' ? 'ready' : 'offline';
}

export const linkError = () => socketError;

/** Exchanges still waiting for the outside member, by who asked (a bot or a group chat). */
export function waitingFor(botOrRoomId: string): { id: string; name: string; since: number }[] {
  const rows = db.prepare("SELECT outside_id, created_at FROM outside_messages WHERE direction='out' AND state='sent' AND (bot_id=? OR room_id=?) ORDER BY created_at").all(botOrRoomId, botOrRoomId) as any[];
  return rows.map((r) => ({ id: r.outside_id, name: getBotRow(r.outside_id)?.name ?? 'outside member', since: r.created_at }));
}

export function waitingCount(outsideId: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM outside_messages WHERE outside_id=? AND direction='out' AND state='sent'").get(outsideId) as any).n;
}

/** Every exchange with an outside member, newest first, for its page in the app. */
export function listExchanges(outsideId: string, limit = 100): OutsideExchange[] {
  const outs = db.prepare("SELECT * FROM outside_messages WHERE outside_id=? AND (direction='out' OR thread_ts IS NULL) ORDER BY id DESC LIMIT ?").all(outsideId, limit) as any[];
  const name = (id: string | null) => (id ? getBotRow(id)?.name ?? 'a deleted Bot' : null);
  return outs.map((r) => {
    const replies = r.direction === 'out' && r.slack_ts
      ? (db.prepare("SELECT text, link, created_at FROM outside_messages WHERE outside_id=? AND direction='in' AND thread_ts=? ORDER BY id").all(outsideId, r.slack_ts) as any[])
      : [];
    return {
      id: r.id,
      direction: r.direction,
      botId: r.bot_id,
      botName: name(r.bot_id) ?? (r.room_id ? name(r.room_id) : null),
      roomId: r.room_id,
      type: r.type,
      text: r.text,
      link: r.link,
      state: r.state,
      error: r.error,
      createdAt: r.created_at,
      answeredAt: r.answered_at,
      replies: replies.map((x) => ({ text: x.text, link: x.link, createdAt: x.created_at })),
    };
  });
}

// ---------- Slack Web API ----------

// Form-encoded: Slack's read methods (chat.getPermalink) ignore a JSON body; every method accepts a form.
async function slack(method: string, tok: string, body: Record<string, unknown>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? 'failed'}`);
  return j;
}

// ---------- Slack MCP server (posting without a bot_id) ----------

const MCP_URL = () => process.env.SLACK_MCP_URL || 'https://mcp.slack.com/mcp';
let mcpSession: string | null = null;
let mcpId = 0;

async function mcpRpc(method: string, params: unknown, notify = false): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token('SLACK_USER_TOKEN')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (mcpSession) headers['Mcp-Session-Id'] = mcpSession;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++mcpId, method, params };
  const r = await fetch(MCP_URL(), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const sid = r.headers.get('mcp-session-id');
  if (sid) mcpSession = sid;
  if (notify) return null;
  const raw = await r.text();
  // Either plain JSON or an SSE stream whose data lines hold the JSON-RPC reply.
  const msgs = (r.headers.get('content-type') ?? '').includes('text/event-stream')
    ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean)
    : [JSON.parse(raw || '{}')];
  const j = msgs.find((m: any) => m && (m.result !== undefined || m.error)) ?? {};
  if (j.error) throw new Error(`Slack MCP ${method}: ${j.error.message ?? 'failed'}`);
  if (!r.ok) throw new Error(`Slack MCP ${method}: HTTP ${r.status}`);
  return j.result;
}

async function mcpReady() {
  if (mcpSession) return;
  await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cleft', version: '1' } });
  await mcpRpc('notifications/initialized', {}, true);
}

/** Posts through Slack's MCP server; returns the message ts. */
async function mcpPost(channel: string, text: string, threadTs: string | null): Promise<{ ts: string; link: string | null }> {
  const call = async () => {
    await mcpReady();
    return mcpRpc('tools/call', { name: 'slack_send_message', arguments: { channel_id: channel, message: text, ...(threadTs ? { thread_ts: threadTs } : {}) } });
  };
  let res: any;
  try { res = await call(); } catch (e) { mcpSession = null; res = await call(); }
  if (res?.isError) throw new Error(`Slack MCP send: ${String(res?.content?.[0]?.text ?? 'failed').slice(0, 200)}`);
  const txt = (res?.content ?? []).map((c: any) => c?.text ?? '').join('');
  let j: any = {};
  try { j = JSON.parse(txt); } catch {}
  const ts = j?.message_context?.message_ts ?? j?.message_ts ?? j?.ts ?? (txt.match(/\b\d{10}\.\d{6}\b/) ?? [])[0];
  if (!ts) throw new Error('Slack MCP send: no message ts in the reply');
  return { ts: String(ts), link: j?.message_link ? String(j.message_link) : null };
}

async function permalink(channel: string, ts: string): Promise<string | null> {
  try { return (await slack('chat.getPermalink', token('SLACK_BOT_TOKEN') || token('SLACK_USER_TOKEN'), { channel, message_ts: ts })).permalink ?? null; } catch { return null; }
}

// ---------- out ----------

/** One post at a time, at most one a second (Slack's guidance per channel), at most 20 per 5 minutes. */
let chain: Promise<unknown> = Promise.resolve();
let lastPost = 0;
const recent: number[] = [];
const WINDOW = 5 * 60_000;
const MAX_IN_WINDOW = 20;

function underCap(): boolean {
  const t = Date.now();
  while (recent.length && recent[0] < t - WINDOW) recent.shift();
  return recent.length < MAX_IN_WINDOW;
}

export interface OutRequest {
  outsideId: string;
  /** The asking bot, or null when the owner wrote it (on the member's page or in a group chat). */
  fromBotId: string | null;
  roomId?: string | null;
  text: string;
  type?: string | null;
  depth?: number;
  /** Recent group messages, already labelled by speaker, shown under the message (group chats only). */
  context?: string | null;
  /** Post in this Slack thread (a group conversation the member is part of). */
  threadTs?: string | null;
  /** With no fromBotId: who the post is from instead of the owner (a group's combined update names the group). */
  fromLabel?: string | null;
  /** What the group is told once the post is in Slack (default: "Delivered to <member> on Slack."). */
  deliveredNote?: string | null;
}

/**
 * Post a message to an outside member. Returns at once with what happened to the request; the post
 * itself happens in the background, so no bot ever waits on the outside member.
 */
export function sendOutside(req: OutRequest): { ok: true; id: number } | { ok: false; why: string } {
  const o = outsideFor(req.outsideId);
  const member = getBotRow(req.outsideId);
  if (!o || !member) return { ok: false, why: 'That is not an outside member.' };
  const status = linkStatus(req.outsideId);
  if (status === 'not-set-up') return { ok: false, why: `The Slack link for ${member.name} is not set up yet.` };
  if (status === 'paused') return { ok: false, why: `Messages to ${member.name} are paused ("Assistants, stop"). Your owner can turn them back on.` };
  if (!underCap()) return { ok: false, why: `Too many messages to ${member.name} in the last 5 minutes. Try again later.` };

  let type: string | null = null;
  let body = req.text.trim();
  let fromName: string;
  if (req.fromBotId) {
    const c = checkOutgoing(req.text, req.type ?? undefined);
    if (!c.ok) return { ok: false, why: c.why };
    type = c.type;
    body = c.body;
    fromName = getBotRow(req.fromBotId)?.name ?? 'Cleft';
  } else {
    // The owner's own words, typed in the app (or a group's combined update of its bots' posts).
    if (!body) return { ok: false, why: 'The message is empty.' };
    if (body.length > 3000) return { ok: false, why: 'At most 3,000 characters.' };
    type = req.type ?? null;
    fromName = req.fromLabel || o.ownerName || String((db.prepare('SELECT u.name FROM users u JOIN bots b ON b.user_id=u.id WHERE b.id=?').get(req.outsideId) as any)?.name ?? 'Owner').split(/\s+/)[0];
  }

  // An answer to the member's own question goes in its thread.
  let threadTs: string | null = req.threadTs ?? null;
  if (!threadTs && req.fromBotId && type === 'A') {
    threadTs = ((db.prepare("SELECT slack_ts FROM outside_messages WHERE outside_id=? AND direction='in' AND bot_id=? AND type='Q' AND thread_ts IS NULL ORDER BY id DESC LIMIT 1").get(req.outsideId, req.fromBotId) as any)?.slack_ts) ?? null;
  }

  recent.push(Date.now());
  const id = Number(db.prepare("INSERT INTO outside_messages(outside_id, direction, bot_id, room_id, type, text, thread_ts, depth, state, created_at) VALUES (?,?,?,?,?,?,?,?, 'sending', ?)")
    .run(req.outsideId, 'out', req.fromBotId, req.roomId ?? null, type, body, threadTs, req.depth ?? 0, now()).lastInsertRowid);
  const ctx = String(req.context ?? '').trim();
  const how = req.roomId ? `\n\n${groupHowTo(req.outsideId, member.name)}` : '';
  const text = formatOutgoing(fromName, member.name, type, `${body}${ctx ? `\n\nEarlier in the group:\n${ctx}` : ''}${how}`, o.slackUserId);
  chain = chain.then(() => post(id, o, text, threadTs, req.deliveredNote ?? null)).catch(() => {});
  emitBot(req.outsideId);
  return { ok: true, id };
}

async function post(id: number, o: OutsideBot, text: string, threadTs: string | null, deliveredNote: string | null = null) {
  const wait = lastPost + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPost = Date.now();
  const row = db.prepare('SELECT * FROM outside_messages WHERE id=?').get(id) as any;
  try {
    let r: { ts: string; link?: string | null } | null = null;
    let slow: string | null = null;
    if (process.env.SLACK_POST_VIA === 'mcp') {
      try { r = await mcpPost(o.channel, text, threadTs); } catch (e: any) {
        console.warn(`[slack-link] MCP post failed, using chat.postMessage: ${e?.message ?? e}`);
        slow = `Posted the slow way (Slack MCP failed: ${String(e?.message ?? e).slice(0, 120)}). ${getBotRow(row.outside_id)?.name ?? 'The outside member'} may not see it until a later check.`;
      }
    }
    const sent: { ts: string; link?: string | null } = r ?? await slack('chat.postMessage', token('SLACK_USER_TOKEN'), { channel: o.channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false });
    const link = sent.link || await permalink(o.channel, sent.ts);
    // An answer (A, FYI) expects nothing back; anything else waits for a reply.
    const state = row.type === 'A' || row.type === 'FYI' ? 'answered' : 'sent';
    db.prepare('UPDATE outside_messages SET slack_ts=?, link=?, state=?, error=? WHERE id=?').run(sent.ts, link, state, slow, id);
    if (slow && row.bot_id && state === 'sent') notify(row.bot_id, slow);
    // A group sees what happened to each of its posts to an outside member.
    if (row.room_id) {
      const who = getBotRow(row.outside_id)?.name ?? 'the outside member';
      appendRow(row.room_id, 'notice', slow
        ? { type: 'notice', text: `Posted to ${who} on Slack, but the slow way: ${who} may not see it until a later check.`, tone: 'warn' }
        : { type: 'notice', text: deliveredNote || `Delivered to ${who} on Slack.`, tone: 'info' });
    }
  } catch (e: any) {
    const why = String(e?.message ?? e);
    db.prepare("UPDATE outside_messages SET state='failed', error=? WHERE id=?").run(why.slice(0, 300), id);
    console.warn(`[slack-link] post ${id} failed: ${why}`);
    if (row.bot_id) notify(row.bot_id, `Your message to ${getBotRow(row.outside_id)?.name ?? 'the outside member'} could not be posted in Slack (${why}). Tell your owner if it mattered.`);
    if (row.room_id) appendRow(row.room_id, 'notice', { type: 'notice', text: `Not delivered to ${getBotRow(row.outside_id)?.name ?? 'the outside member'}: Slack refused the post (${why.slice(0, 160)}).`, tone: 'warn' });
  }
  emitBot(row.outside_id);
}

// ---------- in ----------

type Waker = (botId: string, t: any) => void;
let wake: Waker = () => {};
const seen = new Set<string>();

/** One Slack message event from the channel. Exported for tests. */
export async function handleEvent(ev: any, opts: { wake?: Waker } = {}): Promise<string> {
  const w = opts.wake ?? wake;
  if (!ev || ev.type !== 'message' || ev.subtype === 'message_changed' || ev.subtype === 'message_deleted' || ev.hidden) return 'ignored: not a new message';
  const key = `${ev.channel}:${ev.ts}`;
  if (seen.has(key)) return 'ignored: duplicate';
  seen.add(key);
  if (seen.size > 5000) seen.delete(seen.values().next().value as string);

  const entries = Object.entries(outsideBots()).filter(([, o]) => o.channel === ev.channel);
  if (!entries.length) return 'ignored: other channel';
  // Slack escapes &, < and > in message text (its mentions stay as <@U…>).
  const text = String(ev.text ?? '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  // A person (no bot or app behind the post) can stop or restart all outside links in the channel.
  const person = !ev.bot_id && !ev.app_id && !ev.bot_profile && ev.subtype !== 'bot_message';
  if (person && (STOP.test(text) || START.test(text))) {
    for (const [key2] of entries) for (const id of idsFor(key2)) setPaused(id, STOP.test(text));
    return STOP.test(text) ? 'paused' : 'resumed';
  }

  const hit = entries.find(([, o]) => ev.user === o.slackUserId);
  if (!hit) return 'ignored: not from an outside member';
  const [cfgKey, o] = hit;
  const ids = idsFor(cfgKey);
  if (!ids.length) return 'ignored: no bot for this outside member';
  let result = 'logged';
  for (const outsideId of ids) result = await deliverIncoming(outsideId, o, ev, text, w);
  return result;
}

function idsFor(cfgKey: string): string[] {
  if (!cfgKey.toLowerCase().startsWith('name:')) return getBotRow(cfgKey) ? [cfgKey] : [];
  const name = cfgKey.slice(5).trim().toLowerCase();
  return (db.prepare("SELECT id FROM bots WHERE lower(name)=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").all(name) as any[]).map((r) => r.id);
}

async function deliverIncoming(outsideId: string, o: OutsideBot, ev: any, text: string, w: Waker): Promise<string> {
  const member = getBotRow(outsideId);
  const p = parseIncoming(text);
  const threadTs: string | null = ev.thread_ts && ev.thread_ts !== ev.ts ? ev.thread_ts : null;
  const link = await permalink(o.channel, ev.ts);
  const from = { kind: 'bot' as const, id: outsideId, name: member.name, via: 'slack' as const, link: link ?? undefined };

  // A reply in a thread we started goes back to whoever asked.
  let target: { botId: string | null; roomId: string | null; depth: number; outId: number; asker?: string | null } | null = null;
  if (threadTs) {
    const asked = db.prepare("SELECT * FROM outside_messages WHERE outside_id=? AND direction='out' AND slack_ts=?").get(outsideId, threadTs) as any;
    if (asked) target = { botId: asked.room_id ? null : asked.bot_id, roomId: asked.room_id, depth: asked.depth, outId: asked.id, asker: asked.room_id ? asked.bot_id : null };
    // A reply in the thread of a group conversation it started itself goes back to that group.
    const started = !asked && db.prepare("SELECT * FROM outside_messages WHERE outside_id=? AND direction='in' AND slack_ts=? AND room_id IS NOT NULL AND bot_id IS NULL").get(outsideId, threadTs) as any;
    if (started) target = { botId: null, roomId: started.room_id, depth: started.depth, outId: 0 };
  } else {
    // Its own top-level post to a group it belongs to, "[Sheldon]>@Household Huddle …", starts a group conversation.
    const g = groupAddressed(outsideId, member.user_id, text);
    if (g) {
      const body = g.body.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim();
      db.prepare("INSERT INTO outside_messages(outside_id, direction, bot_id, room_id, type, text, slack_ts, thread_ts, link, depth, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(outsideId, 'in', null, g.roomId, typeOfText(body), body.slice(0, 4000), ev.ts, null, link, 0, 'delivered', now());
      appendRow(outsideId, 'message', { type: 'message', role: 'assistant', text: body, from: { ...from, to: { id: g.roomId, name: g.name } } });
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(outsideId);
      emitBot(outsideId);
      appendRow(g.roomId, 'message', { type: 'message', role: 'assistant', text: body, from });
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(g.roomId);
      emitBot(g.roomId);
      return dispatchFromOutside(g.roomId, outsideId, body, ev.ts, 0, w);
    }
  }
  let toBotId: string | null = target?.botId ?? null;
  // Its own post, "[Sheldon]>@Leonard Q …", goes to the bot named (or to the bot an alias names).
  if (!target && p.to) {
    const wanted = o.aliases[p.to.toLowerCase()] ?? p.to;
    const b = db.prepare("SELECT id FROM bots WHERE user_id=? AND lower(name)=lower(?) AND COALESCE(kind,'agent')='agent' AND COALESCE(hidden,0)=0").get(member.user_id, wanted) as any;
    if (b && b.id !== outsideId) toBotId = b.id;
  }

  // A top-level post addressed "[Sheldon]>@Leonard Q …" is shown without the header.
  const clean = (p.to && !target ? p.body : text).replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim();
  const toName = toBotId && !target ? getBotRow(toBotId)?.name : null;

  const inId = Number(db.prepare("INSERT INTO outside_messages(outside_id, direction, bot_id, room_id, type, text, slack_ts, thread_ts, link, depth, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(outsideId, 'in', toBotId, target?.roomId ?? null, p.type, clean.slice(0, 4000), ev.ts, threadTs, link, (target?.depth ?? 0) + 1, toBotId || target?.roomId ? 'delivered' : 'logged', now()).lastInsertRowid);
  if (target) db.prepare("UPDATE outside_messages SET state='answered', answered_at=COALESCE(answered_at, ?) WHERE id=? AND state IN ('sent','no-answer')").run(now(), target.outId);

  // The member's page keeps a record of everything it said.
  appendRow(outsideId, 'message', { type: 'message', role: 'assistant', text: clean, from: toName && toBotId ? { ...from, to: { id: toBotId, name: toName } } : from });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(outsideId);
  emitBot(outsideId);

  if (target?.roomId) {
    appendRow(target.roomId, 'message', { type: 'message', role: 'assistant', text: clean, from });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(target.roomId);
    emitBot(target.roomId);
    // Its answer in a group conversation wakes only the members it @mentions (none if it mentions nobody).
    if (!toBotId) {
      // Hops count up through the thread: the deepest of our posts in it (bots' answers), plus one.
      const root = threadTs ?? ev.ts;
      const deepest = (db.prepare("SELECT MAX(depth) AS d FROM outside_messages WHERE outside_id=? AND direction='out' AND (thread_ts=? OR slack_ts=?)").get(outsideId, root, root) as any)?.d;
      return dispatchFromOutside(target.roomId, outsideId, clean, root, Math.max(Number(deepest ?? 0), target.depth ?? 0) + 1, w, target.asker ?? null);
    }
  }
  if (toBotId) {
    const depth = (target?.depth ?? 0) + 1;
    appendRow(toBotId, 'message', { type: 'message', role: 'user', text: clean, from });
    w(toBotId, { type: 'external', fromId: outsideId, fromName: member.name, via: 'slack', channel: o.channelName, kind: p.type, text: clean, depth });
    return `delivered to ${getBotRow(toBotId)?.name}`;
  }
  void inId;
  return target?.roomId ? 'posted to group' : 'logged';
}

/**
 * Passes an outside member's group message on to the members it @mentions (rooms.ts registers it; a
 * static import would make an import cycle).
 */
type GroupDispatch = (roomId: string, outsideId: string, text: string, threadTs: string, depth: number, enqueue: Waker, alsoWake?: string | null) => string;
let dispatchFromOutside: GroupDispatch = () => 'posted to group';
export function setGroupDispatch(fn: GroupDispatch) { dispatchFromOutside = fn; }

/** The groups an outside member belongs to, longest name first. */
function groupsOf(outsideId: string, userId: string): { id: string; name: string }[] {
  return (db.prepare("SELECT id, name, members FROM bots WHERE user_id=? AND kind='room'").all(userId) as any[])
    .filter((r) => (r.members ? JSON.parse(r.members) as string[] : []).includes(outsideId))
    .map((r) => ({ id: r.id, name: String(r.name) }))
    .sort((a, b) => b.name.length - a.name.length);
}

/** "[Sheldon]>@Household Huddle Q …": the group it names (one it belongs to) and the rest of the text. */
export function groupAddressed(outsideId: string, userId: string, text: string): { roomId: string; name: string; body: string } | null {
  const t = String(text ?? '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim();
  const m = /^\[[^\]]{1,40}\]\s*>\s*@(.+)$/s.exec(t);
  if (!m) return null;
  const rest = m[1];
  for (const g of groupsOf(outsideId, userId)) {
    if (rest.slice(0, g.name.length).toLowerCase() !== g.name.toLowerCase()) continue;
    const after = rest.slice(g.name.length);
    if (after && !/^[\s:,.-]/.test(after)) continue;
    const body = after.replace(/^[\s:,.-]+/, '').trim();
    return body ? { roomId: g.id, name: g.name, body } : null;
  }
  return null;
}

/** The one line every group post to an outside member carries, so it knows how to answer and whom it wakes. */
export function groupHowTo(outsideId: string, memberName: string): string {
  const member = getBotRow(outsideId);
  const groups = member ? groupsOf(outsideId, member.user_id).map((g) => g.name) : [];
  return `(How to answer: reply in this thread to post in the group. Only the bots you @mention by name answer, for example @Leonard; with no @mention nobody is woken. To start a group conversation yourself, post "[${memberName}]>@<group name> …"${groups.length ? ` (your groups: ${groups.join(', ')})` : ''}.)`;
}

const typeOfText = (s: string) => parseIncoming(s).type;

// ---------- no answer ----------

function notify(botId: string, text: string) {
  wake(botId, { type: 'system', text });
}

export function sweepNoAnswer(at = now()) {
  for (const [, o] of Object.entries(outsideBots())) {
    const cutoff = at - o.replyMinutes * 60_000;
    const late = db.prepare("SELECT * FROM outside_messages WHERE direction='out' AND state='sent' AND created_at < ?").all(cutoff) as any[];
    for (const r of late) {
      if (outsideFor(r.outside_id) !== o) continue;
      db.prepare("UPDATE outside_messages SET state='no-answer' WHERE id=?").run(r.id);
      const name = getBotRow(r.outside_id)?.name ?? 'The outside member';
      if (r.bot_id) notify(r.bot_id, `${name} has not answered your ${r.type ?? ''} message from ${o.replyMinutes} minutes ago ("${String(r.text).slice(0, 80)}"). Carry on without it; an answer that comes later will still reach you.`);
      if (r.room_id) appendRow(r.room_id, 'notice', { type: 'notice', text: `${name} has not answered in Slack yet.`, tone: 'warn' });
      emitBot(r.outside_id);
    }
  }
}

// ---------- Socket Mode ----------

let ws: WebSocket | null = null;
let stopped = false;
let backoff = 1000;

async function connect() {
  const appToken = token('SLACK_APP_TOKEN');
  if (!appToken || stopped) return;
  socketState = 'connecting';
  try {
    const { url } = await slack('apps.connections.open', appToken, {});
    ws = new WebSocket(url);
    ws.on('open', () => { socketState = 'connected'; socketError = null; backoff = 1000; for (const id of allOutsideIds()) emitBot(id); });
    ws.on('message', (data) => {
      let env: any;
      try { env = JSON.parse(String(data)); } catch { return; }
      if (env.envelope_id) ws?.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === 'disconnect') { ws?.close(); return; }
      if (env.type === 'events_api' && env.payload?.event) {
        handleEvent(env.payload.event).catch((e) => console.warn('[slack-link] event failed:', e?.message ?? e));
      }
    });
    ws.on('close', () => { ws = null; if (socketState === 'connected') socketState = 'connecting'; retry(); });
    ws.on('error', (e) => { socketError = String((e as any)?.message ?? e); });
  } catch (e: any) {
    socketState = 'error';
    socketError = String(e?.message ?? e);
    console.warn('[slack-link] connect failed:', socketError);
    retry();
  }
}

function retry() {
  if (stopped) return;
  for (const id of allOutsideIds()) emitBot(id);
  setTimeout(() => void connect(), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

function allOutsideIds(): string[] {
  return Object.keys(outsideBots()).flatMap(idsFor);
}

export function startSlackLink(w: Waker) {
  wake = w;
  if (!Object.keys(outsideBots()).length) return;
  if (!token('SLACK_APP_TOKEN')) { console.log('[slack-link] outside members configured, but no SLACK_APP_TOKEN: the link stays off'); return; }
  void connect();
  setInterval(() => sweepNoAnswer(), 60_000).unref();
  console.log(`[slack-link] on for ${allOutsideIds().length} outside member(s)`);
}

export function stopSlackLink() { stopped = true; ws?.close(); }
