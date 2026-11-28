import type { Context } from 'hono';
import { env } from '../env.js';
import { db } from '../db.js';
import type { ServerEvent } from '../types.js';
import { ownerName } from '../people.js';

const safeDecode = (v: string): string | undefined => { try { return decodeURIComponent(v); } catch { return undefined; } };

/**
 * A scoped sign-in (SCOPED_PEOPLE in .env): a person who shares the account but sees only some bots.
 * Sam signs in to the shared team account and should see only Robin, not Leonard, Howard, Sheldon or
 * Alex's groups. Enforced here on the server, so no app can show more than it is given:
 *  - every /api request from a scoped session passes `scopeGate` (an allowlist; anything not listed is 403),
 *  - lists and live streams are filtered with `inScope` / `eventInScope`.
 * The bots are not scoped: Robin still messages the other bots through the team's own channels.
 */
export type Scope = { names: string[]; bots: Set<string> };

/** The bots (and their side chats and helpers) a person may see, or null when the person sees everything. */
export function scopeFor(userId: string, person: string | null | undefined): Scope | null {
  const names = person ? env.scopedPeople.get(person.toLowerCase()) : undefined;
  if (!names) return null;
  const bots = new Set<string>();
  const own = db.prepare("SELECT id, name FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND side_of IS NULL").all(userId) as { id: string; name: string }[];
  for (const b of own) if (names.includes(String(b.name).trim().toLowerCase())) bots.add(b.id);
  if (bots.size) {
    const ids = [...bots];
    const marks = ids.map(() => '?').join(',');
    // Side chats always; helpers (sub-bots) only where the database has them.
    const cols = (db.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).map((r) => r.name);
    const q = `SELECT id FROM bots WHERE user_id=? AND (side_of IN (${marks})${cols.includes('parent_bot_id') ? ` OR parent_bot_id IN (${marks})` : ''})`;
    const args = cols.includes('parent_bot_id') ? [userId, ...ids, ...ids] : [userId, ...ids];
    for (const r of db.prepare(q).all(...args) as { id: string }[]) bots.add(r.id);
  }
  return { names, bots };
}

/** The scope of the request's session (set by requireUser), or null. */
export const requestScope = (c: Context): Scope | null => (c.get('scope' as never) as Scope | null | undefined) ?? null;

export const inScope = (scope: Scope | null, botId: string | null | undefined) => !scope || (!!botId && scope.bots.has(botId));

/** Whether a live event may reach a scoped session. Events about other bots, PCs, connections or the shared computer may not. */
export function eventInScope(scope: Scope | null, ev: ServerEvent): boolean {
  if (!scope) return true;
  switch (ev.type) {
    case 'hello': case 'ping': case 'roster': case 'notify-clear': case 'restarting': return true;
    case 'live': return scope.bots.has(ev.state.botId);
    case 'bot': return scope.bots.has(ev.bot.id);
    case 'notify': return scope.bots.has(ev.n.botId);
    case 'computer': case 'connections': case 'machines': return false;
    default: return 'botId' in ev && typeof (ev as any).botId === 'string' && scope.bots.has((ev as any).botId);
  }
}

const id = '([^/]+)';
/** Routes a scoped session may use at all. Bot-specific ones are then checked against the scope. */
const BOT_ROUTE = new RegExp(`^/api/bots/${id}(?:/.*)?$`);
const SIDE_ROUTE = new RegExp(`^/api/side-chats/${id}(?:/.*)?$`);
const ROUTINE_ROUTE = new RegExp(`^/api/routines/${id}(?:/.*)?$`);
const MEMORY_ROUTE = new RegExp(`^/api/memories/${id}$`);
// `/secret`: the value typed into a secure input card (browser-cards.ts), which is that card's answer.
// `/login`: Sign in on a saved-login card (vault.ts checks it is this person's own login).
const APPROVAL_ROUTE = new RegExp(`^/api/approvals/${id}(?:/secret|/login)?$`);
/** "Always allow" rules: a scoped person sees and removes (never adds) the rules of their own bot. */
const ALLOW_RULE_ROUTE = new RegExp(`^/api/allow-rules/${id}$`);
const OPEN = new Set(['/api/bots', '/api/events', '/api/tasks', '/api/notify/stream', '/api/notify/prefs', '/api/notify/recent',
  // The Needs you board (needs-you.ts) lists only the items of the bots the session can see.
  '/api/needs-you',
  // Search answers only from the chats the session can see (chat-extras.ts); the version line names no bot.
  '/api/search', '/api/version',
  // Download my data gives a scoped person only the bots they can see (account-export.ts).
  '/api/export/account',
  // The picture styles a look card offers (avatars.ts): the same list for everyone, nothing about other bots.
  '/api/looks/options',
  // The Windows app's update check (desktop-updates.ts): the same answer for everyone, nothing about any bot.
  '/api/desktop/latest']);
/** Changes to the team itself are not a scoped person's to make, even on their own bot. */
// Also the owner's own safety switches (free-run, the publish hold, skill auto-save) and the bot's engine:
// those routes check isOwner(), which a scoped person passes because they sign in to the owner's account.
const TEAM_CHANGES = [/^\/api\/bots\/[^/]+\/primary$/, /^\/api\/bots\/[^/]+\/engine(?:\/(?:login|restart))?$/, /^\/api\/bots\/[^/]+\/helpers$/,
  /^\/api\/bots\/[^/]+\/(?:free-terminal|publish-guard)$/, /^\/api\/bots\/[^/]+\/hermes-skills\/auto-save$/];

/** Why a scoped session may not make this request, or null when it may. */
export async function scopeRefusal(c: Context, scope: Scope): Promise<string | null> {
  const path = c.req.path.replace(/\/+$/, '') || '/';
  const method = c.req.method;
  const refuse = 'Not available on this sign-in.';
  if (OPEN.has(path)) return path === '/api/bots' && method !== 'GET' ? refuse : null;
  // Saved logins (vault.ts): every handler works only on the signed-in person's own logins.
  if (path === '/api/vault/logins' || /^\/api\/vault\/logins\/[^/]+$/.test(path)) return null;
  // A phone's answer to a timer or alarm it was sent (phone.ts); the route checks the action's bot against the scope.
  if (method === 'POST' && /^\/api\/phone\/actions\/[^/]+\/result$/.test(path)) return null;
  if (method === 'GET' && path.startsWith('/api/desktop/download/')) return null;
  if (path.startsWith('/api/voice/')) {
    if (path === '/api/voice/session') {
      const body = await c.req.json<{ botId?: string }>().catch(() => ({} as { botId?: string }));
      return scope.bots.has(String(body.botId ?? '')) ? null : refuse;
    }
    return null;
  }
  let m = BOT_ROUTE.exec(path);
  if (m) {
    if (!scope.bots.has(safeDecode(m[1]) ?? '')) return refuse;
    if (method === 'DELETE' && path.split('/').length === 4) return refuse;
    if (method !== 'GET' && TEAM_CHANGES.some((r) => r.test(path))) return refuse;
    // The scope finds the bot by its name (SCOPED_PEOPLE=addr=BotName), so renaming it would hide it from this
    // very sign-in. Everything else about the bot (instructions, voice, look) stays theirs to change.
    if (method === 'PATCH' && path.split('/').length === 4) {
      const body = await c.req.json<{ name?: unknown; ownerHidden?: unknown }>().catch(() => ({} as { name?: unknown; ownerHidden?: unknown }));
      // Hiding a bot is the owner's own view (Alex hid a bot): not this sign-in's to change.
      if (body && typeof body === 'object' && body.ownerHidden !== undefined) return refuse;
      const was = (db.prepare('SELECT name FROM bots WHERE id=?').get(safeDecode(m[1]) ?? '') as { name?: string } | undefined)?.name;
      if (body && typeof body === 'object' && typeof body.name === 'string' && body.name.trim() !== String(was ?? '').trim()) return `Only ${ownerName()} can rename this bot.`;
    }
    return null;
  }
  if ((m = SIDE_ROUTE.exec(path))) return scope.bots.has(safeDecode(m[1]) ?? '') ? null : refuse;
  if ((m = ROUTINE_ROUTE.exec(path))) return ownedBy('routines', m[1], scope) ? null : refuse;
  if ((m = MEMORY_ROUTE.exec(path))) return ownedBy('memories', m[1], scope) ? null : refuse;
  if ((m = APPROVAL_ROUTE.exec(path))) return ownedBy('approvals', m[1], scope) ? null : refuse;
  // A card says "Undo it in this bot's settings": a scoped person can list their bot's rules and make it ask again.
  if (path === '/api/allow-rules') return method === 'GET' && scope.bots.has(String(c.req.query('botId') ?? '')) ? null : refuse;
  if ((m = ALLOW_RULE_ROUTE.exec(path))) return method === 'DELETE' && ownedBy('allow_rules', m[1], scope) ? null : refuse;
  return refuse;
}

function ownedBy(table: 'routines' | 'memories' | 'approvals' | 'allow_rules', rowId: string, scope: Scope): boolean {
  try {
    const r = db.prepare(`SELECT bot_id FROM ${table} WHERE id=?`).get(safeDecode(rowId) ?? '') as { bot_id: string } | undefined;
    return !!r && scope.bots.has(r.bot_id);
  } catch { return false; }
}
