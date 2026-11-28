import { isMailSend, noteRuleUse } from './allow-rules.js';
import { gateBrowserTool, notesText, scrubList, takeNotes } from './browser-guard.js';
import { teachRecording } from './teach.js';
import { maintainerAudit, redactCommand } from './maintainer-guard.js';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isLocalRequest } from './lib/auth.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { chatsOf } from './side-chats.js';
import { appInfo, appRule, ensureApps, findAppTool } from './local-apps.js';
import { toolsForBot } from './plugins/registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { engineHome, engineKind, mcpToken, primaryBotId, restartEngine } from './engine.js';
import { chatForCall, claimSteers, claimToolCall, enqueueBotMessage, expireApproval, isAnyChatBusy, markSilent, noteMailResult, noteToolOutcome, requestApproval, turnDepth } from './agent/loop.js';
import { policyFor, runAppTool, toolFor, toolMap, TOOLS, type ToolCtx } from './agent/tools.js';
import { hermesPolicy, hermesTitle } from './plugins/hermes-gate.js';
import { summarizing } from './list-summary.js';
import { isPcTool, pcToolsFor, runPcTool } from './machines.js';
import { awaitResult, logActivity } from './activity.js';

/** How a card was answered, for the activity trail: "Asked on its card, answered by Alex (phone app)". */
const cardHow = (answer: string, meta: { answeredBy?: string; answeredVia?: string }) =>
  answer === 'expired' ? 'Asked on its card, nobody answered in time'
    : `Asked on its card${meta.answeredBy ? `, answered by ${meta.answeredBy}${meta.answeredVia ? ` (${meta.answeredVia})` : ''}` : ''}`;
/** A short, redacted hint of what a call did (the command, the page), never its full arguments. */
function argHint(tool: string, args: any): string | null {
  const a = args && typeof args === 'object' ? args : {};
  if (tool === 'terminal' || tool === 'execute_code') return redactCommand(String(a.command ?? a.code ?? '')).slice(0, 200) || null;
  if (tool === 'write_file' || tool === 'patch' || tool === 'read_file') return String(a.path ?? a.file_path ?? '').slice(0, 200) || null;
  if (tool === 'browser_navigate') return String(a.url ?? '').slice(0, 200) || null;
  return null;
}

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *   POST /mcp/primary     the primary engine, whichever bot it is bound to (so that agent's config
 *                         can be written before the bot exists)
 *
 * Every call is stateless: the URL says which bot is calling. Besides the app's own tools the list
 * carries the tools of the local apps in apps.json (local-apps.ts), so connected apps (and the
 * approvals around them) work the same for every engine.
 *
 * The engines run on this machine and reach the endpoint on a loopback address (MCP_BASE_URL), so
 * calls from anywhere else are refused before the token is looked at (see isLocalRequest).
 */

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/**
 * A connected app's failure (Actual Budget down, say) is told to the bot in words but not flagged as a
 * protocol error. Hermes pauses a whole MCP server after 3 flagged errors in a row, and every app tool,
 * send_to_bot and the rest of the team tools share this one server: one broken app must not cut a bot
 * off from its other tools. The activity row still shows the call as failed.
 */
function appFailure(name: string, body: string): CallResult {
  const app = findAppTool(name);
  const appName = (app && appInfo(app.appId)?.name) ?? app?.appId ?? 'The connected app';
  return text(`[FAILED: ${appName} returned an error. This call did not work; nothing below is a result. Your other tools are not affected.]\n${body}`);
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. `botId` is null for /mcp/primary before a bot is bound to it. */
function caller(slug: string, auth: string | undefined): { botId: string | null } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  if (slug === 'primary') return { botId: primaryBotId() };
  return getBotRow(slug) ? { botId: slug } : null;
}

async function listTools(botId: string | null) {
  const own = [...TOOLS.filter((t) => toolFor(t, botId)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })), ...pcToolsFor(botId)];
  const bot = botId ? getBotRow(botId) : null;
  if (!bot) return own;
  // Only the plugins this bot has on (plugins/registry.ts).
  const apps = (await toolsForBot(bot.id))
    .filter((t) => !toolMap.has(t.name))
    // A tool that can never run here (blocked, or a write on a read-only server) is not offered at all.
    .filter((t) => { const r = appRule(t); return !(r.fixed && r.decision === 'block'); })
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return [...own, ...apps];
}

/** Run an approval request whose card expires if the agent's HTTP call goes away (Hermes restarted, a proxy timed out). */
async function expiringOnAbort<T>(signal: AbortSignal | undefined, meta: { approvalId?: string }, run: () => Promise<T>): Promise<T> {
  const gone = () => { if (meta.approvalId) expireApproval(meta.approvalId); };
  signal?.addEventListener('abort', gone, { once: true });
  try { return await run(); } finally { signal?.removeEventListener('abort', gone); }
}

async function callTool(botId: string | null, rawName: string, args: any, signal?: AbortSignal): Promise<CallResult> {
  const bot = botId ? getBotRow(botId) : null;
  if (!botId || !bot) return text('The team app has no bot for this agent yet. Ask the user to open the app once, then try again.', true);
  const userId: string = bot.user_id;
  // A paired PC's tools (machines.ts): their own checks, approval cards bound to the exact call.
  if (isPcTool(rawName)) {
    const name = rawName.toLowerCase();
    // The engine is shared by the bot's main chat and its side chats: the call's row says which chat it is in.
    const claim = await claimToolCall(botId, name, args);
    const chat = claim?.chat ?? botId;
    const rowSeq = claim?.seq ?? null;
    let asked: { answer: string; meta: { answeredBy?: string; answeredVia?: string } } | null = null;
    try {
      const r = await runPcTool(userId, botId, name, args, {
        requestApproval: async (pol, a, meta) => { const m: { approvalId?: string; digest?: string; answeredBy?: string; answeredVia?: string } = meta ?? {}; const answer = await expiringOnAbort(signal, m, () => requestApproval({ userId, botId: chat }, pol, a, rowSeq, m)); asked = { answer, meta: m }; return answer; },
        chatId: chat,
      });
      noteToolOutcome(chat, rowSeq, { status: r.status, summary: r.status === 'denied' ? 'Not allowed' : r.status === 'error' ? r.output.slice(0, 200) : undefined });
      const q = asked as { answer: string; meta: { answeredBy?: string; answeredVia?: string } } | null;
      logActivity({ botId, chatId: chat, tool: name, title: name.replace(/_/g, ' '), source: 'pc', outcome: r.status === 'done' ? 'allowed' : r.status === 'denied' ? 'refused' : 'failed',
        how: q ? cardHow(q.answer, q.meta) : r.status === 'denied' ? 'Not allowed on that PC' : null, detail: r.status === 'done' ? null : r.output.slice(0, 300) });
      return text(r.output, r.status === 'error');
    } catch (e: any) {
      noteToolOutcome(chat, rowSeq, { status: 'error', summary: String(e?.message ?? e).slice(0, 200) });
      logActivity({ botId, chatId: chat, tool: name, title: name.replace(/_/g, ' '), source: 'pc', outcome: 'failed', detail: String(e?.message ?? e) });
      return text(`Tool error: ${String(e?.message ?? e)}`, true);
    }
  }
  // The app's own tools by their exact name; everything else is a local app's tool. One spelling for
  // the approval check and for the call keeps the two from disagreeing.
  const own = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase());
  // An agent may call an app tool it listed before this server restarted: start the apps first.
  if (!own && !findAppTool(rawName)) await ensureApps();
  const name = own ?? findAppTool(rawName)?.name ?? rawName;
  // Which of the bot's chats (main or a side chat, side-chats.ts) made this call: its cards and approval go there.
  const claim = await claimToolCall(botId, name, args);
  const chat = claim?.chat ?? botId;
  const rowSeq = claim?.seq ?? null;
  const ctx: ToolCtx = { userId, botId, chatId: chat, enqueueBotMessage, depth: turnDepth(chat) };
  let approvedBy = '';
  let mailApproval = '';
  try {
    const ownTool = toolMap.get(name);
    if (ownTool && !toolFor(ownTool, botId)) {
      noteToolOutcome(chat, rowSeq, { status: 'denied', summary: 'Not allowed' });
      logActivity({ botId, chatId: chat, tool: name, title: ownTool.label ?? name, source: 'tool', outcome: 'refused', how: 'For the admin bot only' });
      return text('That tool is for the admin bot only.', true);
    }
    if (ownTool) {
      const r = await ownTool.impl(args, ctx);
      if (r.endTurn) markSilent(chat);
      // A tool that says it failed is shown as failed, as app tools are below.
      const outcome = r.summary === 'failed' ? { status: 'error' as const, summary: 'Failed' } : r.summary === 'Not allowed' ? { status: 'denied' as const, summary: r.summary } : { status: 'done' as const, summary: r.summary };
      noteToolOutcome(chat, rowSeq, outcome);
      // A refused hand-off (send_to_bot says "… refused"; a walled bot's message outside its allow-list) is a refused row.
      const refused = outcome.status === 'denied' || /\brefused\b/i.test(r.summary ?? '');
      logActivity({ botId, chatId: chat, tool: name, title: r.summary && r.summary !== 'failed' ? r.summary : ownTool.label ?? name, source: name === 'send_to_bot' ? 'handoff' : 'tool',
        outcome: refused ? 'refused' : outcome.status === 'error' ? 'failed' : 'allowed', detail: refused || outcome.status === 'error' ? r.output.slice(0, 300) : null });
      // A failure or refusal is marked as an error in the protocol too, not only in the activity row.
      return text(r.output, outcome.status !== 'done');
    }

    const pol = policyFor(userId, name, args, botId, chat);
    let how: string | null = pol.viaRule ? (pol.viaRule.startsWith('app:') ? 'Allowed in app settings' : pol.viaRule.startsWith('conv:') ? 'Allowed for this conversation' : 'Always allow') : null;
    if (pol.decision === 'block') {
      noteToolOutcome(chat, rowSeq, { status: 'denied', summary: 'Not allowed' });
      logActivity({ botId, chatId: chat, tool: name, title: pol.title, source: 'tool', outcome: 'refused', how: "Set to Don't allow" });
      return text(DECLINED, true);
    }
    // Who answered the card is passed on with the result, so a bot (or its helper, which never sees the
    // card) reports what happened instead of guessing whether a card appeared.
    if (pol.decision === 'ask') {
      const meta: { approvalId?: string; answeredBy?: string; answeredVia?: string } = {};
      const answer = await expiringOnAbort(signal, meta, () => requestApproval({ userId, botId: chat }, pol, args, rowSeq, meta));
      const by = meta.answeredBy ? ` (${meta.answeredBy}${meta.answeredVia ? `, ${meta.answeredVia}` : ''})` : '';
      how = cardHow(answer, meta);
      if (answer !== 'allow') logActivity({ botId, chatId: chat, tool: name, title: pol.title, source: 'card', outcome: 'refused', how });
      if (answer !== 'allow') return text(answer === 'deny' ? DECLINED.replace('The user declined this action.', `The user declined this action on its approval card${by}.`) : SKIPPED, true);
      approvedBy = `[Approval card shown and allowed${by}.]\n`;
      mailApproval = meta.approvalId && isMailSend(pol.key) ? meta.approvalId : '';
    }
    if (pol.viaRule) noteRuleUse(pol.viaRule, botId, pol.key, args, pol.title);
    const r = await runAppTool(name, args);
    if (mailApproval) noteMailResult(mailApproval, r.summary !== 'failed', r.output);
    if (r.card) {
      const t = findAppTool(name);
      appendRow(chat, 'card', { type: 'card', card: 'plugin', pluginId: t?.appId ?? '', pluginName: (t && appInfo(t.appId)?.name) ?? name, view: r.card });
      emitBot(chat);
    }
    noteToolOutcome(chat, rowSeq, { status: r.summary === 'failed' ? 'error' : 'done', summary: r.summary === 'failed' ? 'Failed' : undefined });
    logActivity({ botId, chatId: chat, tool: name, title: pol.title, source: approvedBy ? 'card' : 'tool', outcome: r.summary === 'failed' ? 'failed' : 'allowed', how, detail: r.summary === 'failed' ? r.output.slice(0, 300) : null });
    return r.summary === 'failed' ? appFailure(name, approvedBy + r.output) : text(approvedBy + r.output);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    noteToolOutcome(chat, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    logActivity({ botId, chatId: chat, tool: name, title: toolMap.get(name)?.label ?? name, source: toolMap.has(name) ? 'tool' : approvedBy ? 'card' : 'tool', outcome: 'failed', detail: msg });
    if (mailApproval) noteMailResult(mailApproval, false, msg);
    if (!own && findAppTool(name)) return appFailure(name, `${approvedBy}Tool error: ${msg}`);
    return text(`${approvedBy}Tool error: ${msg}`, true);
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * New tools reach a running agent without a restart.
 *
 * Hermes lists an MCP server's tools when it connects and keeps that list; this server answers each call on
 * its own and cannot push "tools changed" to it. So each connection gets a session id (Mcp-Session-Id) that
 * remembers the tool list it was last given. Hermes pings an idle connection every few minutes
 * (tools/mcp_tool_health.py keepalive). When the list has changed since (a deploy added a tool, a plugin
 * or app was switched on or off) or the session is from before this server started, the ping is answered
 * 404, the streamable-HTTP way to say "session gone". Hermes then reconnects, lists the tools again, and
 * adds the new ones to its running conversations between turns. Tool calls are never refused for this, so
 * nothing in flight fails; only the idle keepalive triggers it.
 */
const BOOT = crypto.randomBytes(4).toString('hex');
const SESSIONS_MAX = 500;
/** session id -> fingerprint of the tool list it was last given ('' until it asks). */
const sessions = new Map<string, string>();
const fingerprint = (tools: unknown) => crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);

function newSession(): string {
  const sid = `${BOOT}${crypto.randomBytes(12).toString('hex')}`;
  sessions.set(sid, '');
  while (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value as string);
  return sid;
}

/** For tests and the status line: how many sessions are known, and whether this one is. */
export const mcpSessionInfo = (sid?: string) => ({ count: sessions.size, known: !!sid && sessions.has(sid), boot: BOOT });

/** Whether a keepalive on this session should be told to reconnect (its tool list is out of date). */
async function staleSession(sid: string, botId: string | null): Promise<boolean> {
  if (!sessions.has(sid)) return true;
  const seen = sessions.get(sid)!;
  if (!seen) return false;
  return seen !== fingerprint(await listTools(botId));
}

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: any, botId: string | null, sid?: string, signal?: AbortSignal): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response to something we never asked; nothing to do with it.
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hq', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: connected apps, files for the user, tasks, routines, other agents on the team.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const tools = await listTools(botId);
      if (botId) noteListed(botId, fingerprint(tools));
      if (sid) {
        sessions.delete(sid);
        sessions.set(sid, fingerprint(tools));
        while (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value as string);
      }
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    case 'tools/call': {
      if (botId) lastUse.set(botId, Date.now());
      const name = params?.name;
      if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Missing tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return { jsonrpc: '2.0', id, result: await callTool(botId, name, args, signal) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------- tool-list refresh for the bots' own Hermes ----------

/**
 * Hermes keeps the tool list it got when it connected. Seen 2026-11-23: after a deploy that added tools,
 * Leonard's Hermes reconnected (the keepalive 404 above) but kept its old list, so update_view and
 * offer_choices stayed unknown to it until its gateway restarted. Hermes re-reads the list only when it
 * starts or revives a parked server. So the app remembers, per managed bot, the fingerprint of the list
 * its Hermes last fetched (in the engine home, since gateways outlive app restarts), and when the list it
 * would get now differs, restarts that bot's gateway once it is idle: no turn queued in any of its chats,
 * no approval card waiting, and no tool call in the last two minutes. At most once per ten minutes per bot.
 * The computer's own agent (primary) and siloed agents are never restarted from here.
 */
const lastUse = new Map<string, number>();
const lastRestart = new Map<string, number>();
const QUIET_MS = 2 * 60_000;
const COOLDOWN_MS = 10 * 60_000;
const FP_FILE = '.hq-tools-fp';

function fpPath(botId: string): string | null {
  const home = engineHome(botId);
  return home && engineKind(botId) === 'managed' ? path.join(home, FP_FILE) : null;
}

function noteListed(botId: string, fp: string) {
  lastUse.set(botId, Date.now());
  const p = fpPath(botId);
  if (!p) return;
  try { if (fs.existsSync(path.dirname(p))) fs.writeFileSync(p, fp); } catch { /* best effort */ }
}

/** The fingerprint this bot's Hermes last fetched, or null when unknown. */
export function listedFingerprint(botId: string): string | null {
  const p = fpPath(botId);
  try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null; } catch { return null; }
}

export async function toolListFingerprint(botId: string): Promise<string> {
  return fingerprint(await listTools(botId));
}

/** Why this bot's gateway cannot be restarted right now, or null when it can. */
export function refreshBlocker(botId: string, t = Date.now()): string | null {
  if (engineKind(botId) !== 'managed') return 'not a managed engine';
  if (isAnyChatBusy(botId)) return 'a turn is running';
  // Cards in its side chats count too: they wait on the same gateway.
  const waiting = db.prepare("SELECT count(*) n FROM approvals WHERE bot_id IN (SELECT value FROM json_each(?)) AND status='pending'").get(JSON.stringify(chatsOf(botId))) as { n: number };
  if (waiting.n) return 'an approval card is waiting';
  if (t - (lastUse.get(botId) ?? 0) < QUIET_MS) return 'it used a tool in the last two minutes';
  if (t - (lastRestart.get(botId) ?? 0) < COOLDOWN_MS) return 'it was restarted for this in the last ten minutes';
  return null;
}

/** One pass: restart each idle managed bot whose Hermes has an out-of-date tool list. Returns who was restarted. */
export async function refreshStaleToolLists(restart: (botId: string) => Promise<void> = restartEngine): Promise<string[]> {
  const done: string[] = [];
  for (const b of db.prepare("SELECT id, name FROM bots WHERE engine='managed'").all() as { id: string; name: string }[]) {
    if (!fpPath(b.id) || !fs.existsSync(path.dirname(fpPath(b.id)!))) continue;
    const want = await toolListFingerprint(b.id);
    if (listedFingerprint(b.id) === want) continue;
    const why = refreshBlocker(b.id);
    if (why) continue;
    lastRestart.set(b.id, Date.now());
    console.log(`[mcp] ${b.name}'s agent has an out-of-date tool list; restarting its gateway so it loads the current tools`);
    try { await restart(b.id); done.push(b.id); } catch (e: any) { console.warn(`[mcp] restart of ${b.name}'s gateway failed: ${e?.message ?? e}`); }
  }
  return done;
}

let refreshTimer: NodeJS.Timeout | null = null;
/** Check now and then every minute (the first pass waits for the gateways to come up). */
export function startToolRefresh() {
  if (refreshTimer) return;
  const tick = () => { refreshStaleToolLists().catch((e) => console.warn('[mcp] tool refresh pass failed', e)); };
  setTimeout(tick, 90_000).unref();
  refreshTimer = setInterval(tick, 60_000);
  refreshTimer.unref();
}

export const mcpApi = new Hono();

let warnedRemote = false;

mcpApi.post('/:bot', async (c) => {
  if (!isLocalRequest(c)) {
    // Said once: an agent set up to call from elsewhere would otherwise just seem to have lost its tools.
    if (!warnedRemote) console.warn(`[mcp] refused a call that did not come straight from this machine (peer ${getConnInfo(c).remote.address ?? 'unknown'}). Agents must reach /mcp on a loopback address; check MCP_BASE_URL.`);
    warnedRemote = true;
    return c.json(rpcError(null, -32001, 'Forbidden: /mcp only answers calls made on the machine the app runs on'), 403);
  }
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  const given = c.req.header('mcp-session-id')?.trim() || undefined;
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId, given, c.req.raw.signal)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  // A keepalive on a connection whose tools are out of date: "session gone", so the agent reconnects.
  if (given && body?.method === 'ping' && await staleSession(given, who.botId)) {
    sessions.delete(given);
    return c.json(rpcError(body?.id, -32001, 'Session not found: the tool list changed, reconnect to get the new one'), 404);
  }
  if (body?.method === 'initialize') {
    const answer = await handle(body, who.botId);
    return c.json(answer, 200, { 'Mcp-Session-Id': newSession() });
  }
  const answer = await handle(body, who.botId, given, c.req.raw.signal);
  return answer ? c.json(answer) : c.body(null, 202);
});

// The agent closing its connection (streamable HTTP session end).
mcpApi.delete('/:bot', (c) => {
  if (!isLocalRequest(c)) return c.body(null, 403);
  if (!caller(c.req.param('bot'), c.req.header('authorization'))) return c.body(null, 401);
  const sid = c.req.header('mcp-session-id')?.trim();
  if (sid) sessions.delete(sid);
  return c.body(null, 204);
});

/**
 * The Hermes gate (plugins/hermes-gate.ts): the cleft-bot-gate plugin in a bot's Hermes home asks
 * here before Hermes runs one of its own tools. Same loopback check and token as /mcp. The answer is
 * {action: "allow"} or {action: "block", message}; anything else, or no answer, blocks on that side.
 */
mcpApi.post('/:bot/gate', async (c) => {
  if (!isLocalRequest(c)) return c.json({ action: 'block', message: 'Forbidden' }, 403);
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who?.botId) return c.json({ action: 'block', message: 'Unauthorized' }, 401);
  const bot = getBotRow(who.botId);
  if (!bot) return c.json({ action: 'block', message: 'No such bot' }, 404);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ action: 'block', message: 'Bad request' }, 400); }
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  // The primary Hermes is shared with other front-ends that also use its API server. Only work done
  // while the app has a turn running for this bot is the app's to approve; the rest keeps Hermes' own rules.
  // A chat-list summary running on this Hermes (list-summary.ts) never uses tools: whatever it tries is refused.
  if (summarizing(bot.id)) return c.json({ action: 'block', message: 'A chat list summary never uses tools. Reply with the one line only.' });
  // Every decision below is one row of the activity trail (activity.ts), under the chat whose turn made the call.
  const chat = chatForCall(bot.id, tool, args);
  const hint = argHint(tool, args);
  const trail = (outcome: 'allowed' | 'refused', how: string | null, source: 'gate' | 'card' | 'browser' = 'gate', detail: string | null = hint) => {
    const id = logActivity({ botId: bot.id, chatId: chat, tool: `hermes__${tool}`, title: hermesTitle(tool), outcome, how, detail, source });
    if (outcome === 'allowed') awaitResult(chat, tool, id);
  };
  // The browser guard (browser-guard.ts): connect to the bot's Chrome before it browses, so pay buttons are
  // held from the first page; on a page that can take a payment, acting browser tools wait for an approval.
  // (The chat above is also whose "Allow for this conversation" answers count.)
  // Teach a bot (teach.ts): while the person records a lesson on this browser, only their steps count.
  if ((tool.startsWith('browser_') || tool === 'computer_use') && teachRecording(bot.id)) {
    return c.json({ action: 'block', message: 'The person is recording a lesson on your browser right now. Wait until they finish, then carry on.' });
  }
  if (tool.startsWith('browser_') || tool === 'computer_use') {
    const guard = await gateBrowserTool(bot.id, tool, args, chat).catch(() => null);
    if (guard) { trail('refused', 'Browser guard', 'browser', guard.block.split(/(?<=\.)\s/)[0]); return c.json({ action: 'block', message: guard.block }); }
  }
  // Work on the shared primary Hermes from its other front-ends is not the app's, so it is not on the trail either.
  if (bot.engine === 'primary' && !isAnyChatBusy(bot.id)) return c.json({ action: 'allow', note: 'not an app turn' });
  const pol = hermesPolicy(bot.user_id, bot.id, tool, args, { danger: body?.danger }, chat);
  if (pol.decision === 'allow') {
    if (pol.viaRule) noteRuleUse(pol.viaRule, bot.id, pol.key, args, pol.title);
    trail('allowed', pol.freeRun ? 'Free-run' : pol.viaRule ? (pol.viaRule.startsWith('app:') ? 'Allowed in app settings' : pol.viaRule.startsWith('conv:') ? 'Allowed for this conversation' : 'Always allow') : 'Look-only or allowed without asking');
    if (pol.freeRun) {
      const shown = redactCommand(pol.freeRun.command);
      noteRuleUse('free:terminal', bot.id, pol.key, args, shown);
      maintainerAudit(`${bot.name} (free-run)`, 'terminal', 'allowed', `${pol.freeRun.risky.length ? `[${pol.freeRun.risky.join('; ')}] ` : ''}${shown}`);
      // The plugin redacts this command's output before the model or the chat sees it.
      return c.json(pol.freeRun.secret ? { action: 'allow', redact: true } : { action: 'allow' });
    }
    return c.json({ action: 'allow' });
  }
  if (pol.decision === 'block') { trail('refused', "Set to Don't allow"); return c.json({ action: 'block', message: DECLINED }); }
  // The card goes to the chat whose turn made the call: the main chat or one of its side chats.
  // If Hermes stops waiting (its hook limit, a restart, Stop), the card expires instead of staying open for
  // a tap that would do nothing.
  const meta: { approvalId?: string; answeredBy?: string; answeredVia?: string } = {};
  const gone = () => { if (meta.approvalId) expireApproval(meta.approvalId); };
  c.req.raw.signal?.addEventListener('abort', gone, { once: true });
  const answer = await requestApproval({ userId: bot.user_id, botId: chat }, pol, args, null, meta);
  c.req.raw.signal?.removeEventListener('abort', gone);
  trail(answer === 'allow' ? 'allowed' : 'refused', cardHow(answer, meta), 'card');
  return c.json(answer === 'allow' ? { action: 'allow' } : { action: 'block', message: answer === 'deny' ? DECLINED : SKIPPED });
});

/**
 * Steering (steer-mode.ts): at each tool step the cleft-bot-gate plugin asks whether the owner sent a
 * message for the reply in progress. Same loopback check and token as the gate. The answer is
 * {steer: text} for the plugin to hand to Hermes' own agent.steer(), or {steer: null}. It never touches
 * approvals: a steering note is not an answer to any card.
 */
mcpApi.post('/:bot/steer', async (c) => {
  if (!isLocalRequest(c)) return c.json({ steer: null }, 403);
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who?.botId) return c.json({ steer: null }, 401);
  const bot = getBotRow(who.botId);
  if (!bot) return c.json({ steer: null }, 404);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ steer: null }, 400); }
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const args = body?.args && typeof body.args === 'object' ? body.args : undefined;
  const sessionId = typeof body?.session_id === 'string' ? body.session_id.slice(0, 200) : '';
  if (!tool) return c.json({ steer: null });
  return c.json({ steer: claimSteers(bot.id, tool, args, sessionId, { shared: bot.engine === 'primary' }) });
});

// No server-to-client stream.
mcpApi.all('/:bot', (c) => (isLocalRequest(c) ? c.body(null, 405, { Allow: 'POST' }) : c.body(null, 403)));
/**
 * After a browser step (gate plugin's transform_tool_result): notes for the bot from the browser guard (a pay
 * button was held, a CAPTCHA showed) and the salted hashes of values typed from secure input cards, so the
 * plugin can mask them if the result echoes one. Same loopback check and token as the gate.
 */
mcpApi.post('/:bot/after', async (c) => {
  if (!isLocalRequest(c)) return c.json({}, 403);
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who?.botId) return c.json({}, 401);
  const note = notesText(takeNotes(who.botId));
  const scrub = scrubList(who.botId);
  return c.json({ ...(note ? { note } : {}), ...(scrub ? { scrub } : {}) });
});
mcpApi.all('/:bot/gate', (c) => (isLocalRequest(c) ? c.body(null, 405, { Allow: 'POST' }) : c.body(null, 403)));
mcpApi.all('/:bot/steer', (c) => (isLocalRequest(c) ? c.body(null, 405, { Allow: 'POST' }) : c.body(null, 403)));
mcpApi.all('/:bot/after', (c) => (isLocalRequest(c) ? c.body(null, 405, { Allow: 'POST' }) : c.body(null, 403)));
