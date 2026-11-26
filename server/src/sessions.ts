import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { db, now } from './db.js';
import { currentSession, displayName } from './lib/auth.js';
import { scopeFor } from './lib/scope.js';

/**
 * Signed-in devices: every phone, browser and PC that holds a sign-in to the account, with when it signed
 * in and when it was last used, and a way to sign one of them out from another (a lost phone, an old
 * laptop). Signing a device out deletes its session, so its next request is refused.
 *
 * A session is named here by a hash of its token, never the token itself. Only a person may sign devices
 * out; a script's session can list them and nothing more. A person who sees only some bots (SCOPED_PEOPLE)
 * sees and signs out only their own devices.
 */

export interface DeviceSession {
  id: string;
  /** What the device said it was when it signed in, or null for one from before this was kept. */
  device: string | null;
  /** Whose device: the person's name when the session knows, else the account's. */
  who: string;
  kind: 'person' | 'script';
  current: boolean;
  createdAt: number;
  /** Last use, to the day; null when it has not been used since this was kept. */
  lastSeenAt: number | null;
  expiresAt: number;
}

const idOf = (token: string) => crypto.createHash('sha256').update(`session:${token}`).digest('hex').slice(0, 24);

/** A short name for the app or browser behind a request, from what it says about itself. */
export function deviceLabel(userAgent: string | undefined, hint?: string | undefined): string | null {
  const clean = (s: string) => s.replace(/[^\p{L}\p{N} ._()'/-]/gu, '').trim().slice(0, 60);
  if (hint && clean(hint)) return clean(hint);
  const ua = userAgent ?? '';
  if (!ua) return null;
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iPhone or iPad' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /CrOS/i.test(ua) ? 'Chromebook' : /Linux/i.test(ua) ? 'Linux' : '';
  if (/Electron|CleftBot|YanceyBot|YBots/i.test(ua) && !/okhttp|Expo|Dalvik/i.test(ua)) return `YBots app${os ? ` on ${os}` : ''}`;
  if (/okhttp|Expo|Dalvik|ReactNative/i.test(ua)) return 'Phone app (Android)';
  if (/curl|node|python|undici|wget|Go-http/i.test(ua)) return 'A script';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

const noted = new Set<string>();
/** Remember what a session's device is, once, for sessions that do not know yet (called on signed-in requests). */
export function noteDevice(token: string | undefined, c: Context) {
  if (!token || noted.has(token)) return;
  noted.add(token);
  if (noted.size > 5000) noted.clear();
  const label = deviceLabel(c.req.header('user-agent'), c.req.header('x-cleft-device'));
  if (!label) return;
  // A sign-in a script made and then handed to a browser or app takes the name of what really uses it.
  try { db.prepare("UPDATE auth_sessions SET device=?, last_seen_at=COALESCE(last_seen_at, ?) WHERE token=? AND (device IS NULL OR (device='A script' AND ?<>'A script'))").run(label, now(), token, label); } catch { /* next time */ }
}

type Row = { token: string; created_at: number; expires_at: number; last_seen_at: number | null; device: string | null; person: string | null; agent: string | null };

function listFor(userId: string, mine: { token: string; person: string | null }, user: { email: string; name: string }): DeviceSession[] {
  const scoped = !!scopeFor(userId, mine.person);
  const rows = db.prepare('SELECT token, created_at, expires_at, last_seen_at, device, person, agent FROM auth_sessions WHERE user_id=? AND expires_at>? ORDER BY COALESCE(last_seen_at, created_at) DESC').all(userId, now()) as Row[];
  return rows
    // A person who sees only some bots sees only their own devices, not the rest of the account's.
    .filter((r) => !scoped || (r.person ?? '') === (mine.person ?? ''))
    .map((r) => ({
      id: idOf(r.token), device: r.device, who: r.agent ?? displayName(user, r.person), kind: r.agent ? 'script' as const : 'person' as const,
      current: r.token === mine.token, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Helper programs sign in again whenever they need to, so a sign-in one of them left behind is only a key
 * lying around. Those not used for two weeks are removed (index.ts, daily). People's devices are never
 * removed here: they end by themselves 30 days after their last use.
 */
export function pruneScriptSessions(): number {
  const cut = now() - 14 * 86_400_000;
  try { return db.prepare('DELETE FROM auth_sessions WHERE agent IS NOT NULL AND COALESCE(last_seen_at, created_at) < ?').run(cut).changes; } catch { return 0; }
}

export const sessionsApi = new Hono();

// These live under /api/auth/, which is open, so each checks the session itself.
sessionsApi.get('/auth/sessions', (c) => {
  const s = currentSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  noteDevice(s.token, c);
  return c.json({ sessions: listFor(s.user.id, s, s.user) });
});

/** Sign one device out. `id` is from the list; the device making the request signs itself out with Log out instead. */
sessionsApi.delete('/auth/sessions/:id', (c) => {
  const s = currentSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  if (s.agent) return c.json({ error: `Only a person can sign devices out. This sign-in belongs to ${s.agent}.`, code: 'agent_session' }, 403);
  const target = listFor(s.user.id, s, s.user).find((x) => x.id === c.req.param('id'));
  if (!target) return c.json({ error: 'That device is no longer signed in.' }, 404);
  if (target.current) return c.json({ error: 'This is the device you are using. Use Log out instead.' }, 400);
  const rows = db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').all(s.user.id) as { token: string }[];
  const hit = rows.find((r) => idOf(r.token) === target.id);
  if (hit) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(hit.token);
  console.log(`[auth] ${target.who}'s device signed out (${target.device ?? 'unknown device'}) by ${displayName(s.user, s.person)}`);
  return c.json({ ok: true, sessions: listFor(s.user.id, s, s.user) });
});

/** Sign out every other device this person can see. Scripts' sessions are kept unless `scripts` is true; `only: 'scripts'` signs out just those. */
sessionsApi.post('/auth/sessions/sign-out-others', async (c) => {
  const s = currentSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  if (s.agent) return c.json({ error: `Only a person can sign devices out. This sign-in belongs to ${s.agent}.`, code: 'agent_session' }, 403);
  const body = await c.req.json<{ scripts?: unknown; only?: unknown }>().catch(() => ({} as { scripts?: unknown; only?: unknown }));
  const others = listFor(s.user.id, s, s.user).filter((x) => !x.current && (body.only === 'scripts' ? x.kind === 'script' : x.kind === 'person' || body.scripts === true));
  const ids = new Set(others.map((x) => x.id));
  const rows = db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').all(s.user.id) as { token: string }[];
  const del = db.prepare('DELETE FROM auth_sessions WHERE token=?');
  let n = 0;
  db.transaction(() => { for (const r of rows) if (ids.has(idOf(r.token))) n += del.run(r.token).changes; })();
  if (n) console.log(`[auth] ${n} other device(s) signed out by ${displayName(s.user, s.person)}`);
  return c.json({ ok: true, signedOut: n, sessions: listFor(s.user.id, s, s.user) });
});

