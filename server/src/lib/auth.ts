import type { Context, MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env.js';
import { db, now } from '../db.js';
import { token } from './ids.js';
import type { User } from '../types.js';
import { scopeFor, scopeRefusal, type Scope } from './scope.js';
import { deviceLabel, noteDevice } from '../sessions.js';

const COOKIE = 'cleftbot_session';
/** The cookie's names before the project was renamed; still read so existing sign-ins keep working. */
const LEGACY_COOKIES = ['bothq_session', 'grokbot_session'];
const TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * `client`: 'bearer' when the request signed in with `Authorization: Bearer <session token>` (the phone
 * app), 'cookie' for a browser. Bearer clients get stricter approval rules (see routes.ts).
 */
export type AuthVars = { Variables: { user: User; client: 'cookie' | 'bearer'; agent: string | null; scope: Scope | null } };

/**
 * `owner`: the session was made with the owner key (or a sign-in link made with it), see userFromToken.
 * `person`: the Access address of whoever signed in, when known; display only (see displayName).
 * `agent`: the session is a script or program (a Claude thread, a test), shown under this name. It can
 * never answer an approval card, and its chat messages are labelled as its own (see sessionAgent).
 */
export type SessionOpts = { owner?: boolean; person?: string | null; agent?: string | null; device?: string | null };

/** A program's name as it is stored and shown: plain text, short. */
export function agentName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._:()'\/-]/gu, '').trim().slice(0, 60) : '';
  return s || null;
}

export function createSession(c: Context, userId: string, opts: SessionOpts = {}) {
  const t = createSessionToken(userId, { ...opts, device: opts.device ?? deviceLabel(c.req.header('user-agent'), c.req.header('x-cleft-device')) });
  setCookie(c, COOKIE, t, { httpOnly: true, sameSite: 'Lax', secure: env.appUrl.startsWith('https:'), path: '/', maxAge: TTL_MS / 1000 });
}

/**
 * A session for an app that is not a browser (the phone app): the same table, expiry and allowlist
 * rules as a cookie session, but the token is handed back to the caller instead of set as a cookie.
 */
export function createSessionToken(userId: string, opts: SessionOpts = {}): string {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,owner,person,agent,device,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(t, userId, now(), now() + TTL_MS, opts.owner ? 1 : 0, opts.person ? opts.person.toLowerCase() : null, agentName(opts.agent), opts.device ?? null, now());
  return t;
}

/**
 * The name a device shows for who is signed in: the person's name when the session knows who that is
 * and DISPLAY_NAMES names them, else the account's name from DISPLAY_NAMES, else the account's own name.
 * Display only; the account (and so every permission) is the same whoever it shows.
 */
export function displayName(user: Pick<User, 'email' | 'name'>, person?: string | null): string {
  return (person ? env.displayNames.get(person.toLowerCase()) : undefined)
    ?? env.displayNames.get(user.email.toLowerCase())
    ?? user.name;
}

/** Sessions past their expiry are of no use to anyone: they are removed at start and once a day (index.ts). */
export function purgeExpiredSessions(): number {
  return db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now()).changes;
}

/** The Access address a session was started by, if it knows. */
export function sessionPerson(t: string | undefined): string | null {
  if (!t) return null;
  return (db.prepare('SELECT person FROM auth_sessions WHERE token=?').get(t) as { person: string | null } | undefined)?.person ?? null;
}

/**
 * What a bot is told before a message a program sent from the person's account, so it neither thinks the
 * person typed it nor treats it as the person's approval.
 */
export function agentNote(agent: string, person: string): string {
  return `[Sent by ${agent}, a program signed in to ${person || 'the owner'}'s account, not typed by ${person || 'them'}. It is never an approval from ${person || 'them'}.]`;
}

/** The program a session belongs to, or null for a person's session. */
export function sessionAgent(t: string | undefined): string | null {
  if (!t) return null;
  return (db.prepare('SELECT agent FROM auth_sessions WHERE token=?').get(t) as { agent: string | null } | undefined)?.agent ?? null;
}

/** Ends the bearer session a request carries (the phone app's sign-out). */
export function destroyBearerSession(c: Context) {
  const t = bearerToken(c);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
}

/** The session token in `Authorization: Bearer ...`, if any. */
export function bearerToken(c: Context): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  return m?.[1];
}

export function destroySession(c: Context) {
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const t = getCookie(c, name);
    if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
    if (t !== undefined) deleteCookie(c, name, { path: '/' });
  }
}

/**
 * The user a session token stands for. On a public URL the allowlist is asked on every request, not
 * only at sign-in: an account made while the instance was open, or since taken off ALLOWED_EMAILS,
 * is signed out even though its cookie is still good. A session made with the owner key is kept:
 * whoever runs the server let that browser in on purpose, whatever the list says.
 */
export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.*, s.owner AS session_owner, s.expires_at AS session_expires FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  if (!r) return null;
  if (!env.localOnly && !r.session_owner && !env.allowedEmails.includes(String(r.email).toLowerCase())) return null;
  touchSession(t, r.session_expires);
  return { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url };
}

/**
 * A session that is being used stays signed in. A phone or browser that is opened now and then is never signed out
 * mid-use; one left unused for 30 days still is. Once a day per session at most: when less than 29 of
 * its 30 days are left, its expiry moves out to 30 days from now and the day is kept as its last use.
 */
const RENEW_BELOW_MS = TTL_MS - 24 * 3600 * 1000;
function touchSession(t: string, expiresAt: number) {
  if (expiresAt - now() > RENEW_BELOW_MS) return;
  try { db.prepare('UPDATE auth_sessions SET expires_at=?, last_seen_at=? WHERE token=?').run(now() + TTL_MS, now(), t); } catch { /* a read-only moment: next request */ }
}

/** The session token in a Cookie header that names a live session, if any. */
export function tokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  const parts = cookieHeader?.split(/;\s*/) ?? [];
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const m = parts.find((p) => p.startsWith(`${name}=`));
    const t = m ? decodeURIComponent(m.slice(name.length + 1)) : undefined;
    if (t && userFromToken(t)) return t;
  }
  return undefined;
}

export function userFromCookieHeader(cookieHeader: string | undefined): User | null {
  const parts = cookieHeader?.split(/;\s*/) ?? [];
  for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const m = parts.find((p) => p.startsWith(`${name}=`));
    const u = m ? userFromToken(decodeURIComponent(m.slice(name.length + 1))) : null;
    if (u) return u;
  }
  return null;
}

/**
 * The session a request carries (bearer token, else cookie), with whether it was made with the owner
 * key. For routes under /api/auth/, which are open and so not behind requireUser.
 */
export function currentSession(c: Context): { user: User; owner: boolean; person: string | null; agent: string | null; token: string } | null {
  const bearer = bearerToken(c);
  const tokens = bearer !== undefined ? [bearer] : [COOKIE, ...LEGACY_COOKIES].map((n) => getCookie(c, n)).filter((t): t is string => !!t);
  for (const t of tokens) {
    const user = userFromToken(t);
    if (!user) continue;
    const r = db.prepare('SELECT owner, person, agent FROM auth_sessions WHERE token=?').get(t) as { owner: number; person: string | null; agent: string | null } | undefined;
    return { user, owner: !!r?.owner, person: r?.person ?? null, agent: r?.agent ?? null, token: t };
  }
  return null;
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  // A request that sends a bearer token is judged on that token alone, never on a cookie it also carries.
  const bearer = bearerToken(c);
  let used: string | undefined;
  let u: User | null = null;
  if (bearer !== undefined) { u = userFromToken(bearer); used = bearer; }
  else for (const name of [COOKIE, ...LEGACY_COOKIES]) {
    const t = getCookie(c, name);
    const found = userFromToken(t);
    if (found) { u = found; used = t; break; }
  }
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  c.set('client', bearer !== undefined ? 'bearer' : 'cookie');
  c.set('agent', sessionAgent(used));
  noteDevice(used, c);
  // A person who sees only some bots (SCOPED_PEOPLE): everything else on the account is refused here.
  const scope = scopeFor(u.id, sessionPerson(used));
  c.set('scope', scope);
  if (scope) {
    const why = await scopeRefusal(c, scope);
    if (why) return c.json({ error: why, code: 'scoped' }, 403);
  }
  await next();
};

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };
/**
 * Origins the web app is served from: APP_URL, SERVER_URL when the server serves the built app itself,
 * and APP_ORIGINS. A browser's WebSocket handshake can arrive without Sec-Fetch-Site (it did through
 * Cloudflare), so the screen socket falls back to this list.
 */
const appOrigins = new Set([originOf(env.appUrl), originOf(env.serverUrl), ...env.extraOrigins.map(originOf)].filter((o): o is string => !!o));

/**
 * Whether a request may act with the user's cookie. Browsers say where a request comes from
 * (Sec-Fetch-Site, Origin); anything from another site is refused, so a page elsewhere (including
 * another app under the same parent domain) cannot post to the API or open the screen socket as
 * the signed-in user. Requests without those headers come from scripts, not browsers, and carry no
 * ambient cookie.
 */
export function isSameOriginRequest(origin: string | undefined, fetchSite: string | undefined): boolean {
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  if (origin) return appOrigins.has(origin);
  return true;
}

/** Refuses cross-site requests that could change something (anything but GET/HEAD/OPTIONS). */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  // A bearer token is never sent by a browser on its own, so another site cannot ride on it: such a
  // request is let through here and judged on its token by requireUser, which ignores any cookie it carries.
  if (bearerToken(c) !== undefined) return next();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !isSameOriginRequest(c.req.header('origin'), c.req.header('sec-fetch-site'))) {
    return c.json({ error: 'cross-site request refused' }, 403);
  }
  await next();
};

/** A socket peer on this machine (127.0.0.0/8, ::1, or an IPv4-mapped loopback). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** The socket peer of a request, with an IPv4-mapped address in its plain form. */
export function peerAddress(c: Context): string {
  return (getConnInfo(c).remote.address ?? 'unknown').replace(/^::ffff:/i, '');
}

/**
 * A small in-memory limit on how often something may happen per key, here per socket peer address:
 * at most `max` times in any `windowMs`. It lives in this process (a restart forgets it) and holds
 * a few timestamps per address.
 *
 * The peer address is used, never a forwarding header, which the caller could write. So behind a
 * proxy that connects from one address (a public URL forwarder) all visitors share one count and
 * the limit is a limit for everyone together: it still caps what abuse can cost, at the price that
 * a flood from one visitor can use up the allowance of the others until the window has passed.
 */
export function rateLimit(max: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  const recent = (key: string) => (seen.get(key) ?? []).filter((t) => t > now() - windowMs);
  return {
    /** Whether `key` has used up its allowance (nothing is counted). */
    full: (key: string) => recent(key).length >= max,
    /** Count one more for `key`. */
    count(key: string) {
      // Addresses that have gone quiet are dropped now and then, so the map cannot grow without end.
      if (seen.size > 5000) for (const k of seen.keys()) if (!recent(k).length) seen.delete(k);
      seen.set(key, [...recent(key), now()]);
    },
    /** Seconds until `key` may try again (for Retry-After). */
    retryAfter: (key: string) => Math.max(1, Math.ceil(((recent(key)[0] ?? now()) + windowMs - now()) / 1000)),
  };
}

/** Headers a proxy adds when it passes a request on. A program calling from this machine sends none of them. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'];

/**
 * Whether a request was made on this machine and not passed on from elsewhere: the socket peer is a
 * loopback address and no forwarding header is present. For the endpoints only local programs use
 * (owner sign-in, the agents' /mcp). The headers matter because a proxy on this machine (a public
 * URL forwarder, a tunnel) connects from loopback as well. One that adds none of these headers
 * cannot be told from a local caller, which is why those endpoints still ask for their key. Sending
 * such a header oneself only gets a caller refused, never let in.
 */
export function isLocalRequest(c: Context): boolean {
  if (FORWARDING_HEADERS.some((h) => c.req.header(h) !== undefined)) return false;
  return isLoopbackAddress(peerAddress(c));
}

/**
 * Key for signing in from the machine the server runs on (POST /api/auth/owner). It is derived from
 * SESSION_SECRET, so only someone who can read the server's .env can make it:
 *   printf 'owner-login' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1
 */
export function isOwnerKey(given: string): boolean {
  const want = crypto.createHmac('sha256', env.sessionSecret).update('owner-login').digest();
  const got = Buffer.from(given, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
