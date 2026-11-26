import fs from 'node:fs';
import path from 'node:path';

/**
 * OAuth for HTTP apps whose server sits behind an OAuth front (authorization code + PKCE, rotating
 * refresh tokens), such as the Claude Finance front on Server One. The one-time sign-in happens
 * outside Cleft (see docs/cluster-mcp.md); Cleft keeps the token file and refreshes it:
 *
 *   "oauth": { "tokenUrl": "http://127.0.0.1:18813/token", "clientId": "...", "tokenFile": "data/oauth/finance.json" }
 *
 * The token file holds { access_token, refresh_token, expires_at (ms) }. It is written with mode 600
 * and never sent anywhere but the token URL and the app's own URL. A refresh revokes the old refresh
 * token, so the new pair is saved before it is used.
 */
export interface AppOAuth { tokenUrl: string; clientId: string; tokenFile: string; /** RFC 8707 resource, sent with refreshes when the server asked for one. */ resource?: string }
interface TokenFile { access_token: string; refresh_token: string; expires_at: number }

const root = () => new URL('../../', import.meta.url).pathname;
export const tokenPath = (o: AppOAuth) => path.resolve(root(), o.tokenFile);

export function oauthProblem(o: unknown): string | null {
  if (!o || typeof o !== 'object') return '"oauth" must be an object';
  const v = o as Record<string, unknown>;
  for (const k of ['tokenUrl', 'clientId', 'tokenFile']) if (typeof v[k] !== 'string' || !v[k]) return `"oauth.${k}" is required`;
  try { const u = new URL(String(v.tokenUrl)); if (!/^https?:$/.test(u.protocol)) return '"oauth.tokenUrl" must be http(s)'; } catch { return '"oauth.tokenUrl" is not a URL'; }
  return null;
}

function read(o: AppOAuth): TokenFile {
  const t = JSON.parse(fs.readFileSync(tokenPath(o), 'utf8')) as TokenFile;
  if (!t.refresh_token) throw new Error(`no refresh token in ${o.tokenFile}; sign in again`);
  return t;
}

function write(o: AppOAuth, t: TokenFile) {
  const file = tokenPath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const inflight = new Map<string, Promise<string>>();

async function refresh(o: AppOAuth, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = tokenPath(o);
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const cur = read(o);
    const res = await fetchImpl(o.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cur.refresh_token, client_id: o.clientId, ...(o.resource ? { resource: o.resource } : {}) }).toString(),
    });
    if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status}); the app needs signing in again`);
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('token refresh returned no access token');
    const next: TokenFile = { access_token: j.access_token, refresh_token: j.refresh_token || cur.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 };
    write(o, next);
    return next.access_token;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

/** A current access token, refreshed when it has under five minutes left. */
export async function accessToken(o: AppOAuth, fetchImpl: typeof fetch = fetch): Promise<string> {
  const t = read(o);
  if (t.access_token && t.expires_at - Date.now() > 5 * 60 * 1000) return t.access_token;
  return refresh(o, fetchImpl);
}

/** fetch for the app's transport: adds the bearer token, and on a 401 refreshes once and retries. */
export function oauthFetch(o: AppOAuth, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const send = (token: string) => {
      const h = new Headers(init?.headers);
      h.set('Authorization', `Bearer ${token}`);
      return fetchImpl(input, { ...init, headers: h });
    };
    const res = await send(await accessToken(o, fetchImpl));
    if (res.status !== 401) return res;
    return send(await refresh(o, fetchImpl));
  }) as typeof fetch;
}

/** fetch that adds the headers kept in a JSON file ({ "Authorization": "Bearer ..." }), re-read when the file changes. */
export function headersFileFetch(file: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  const full = path.resolve(root(), file);
  let cached: { mtime: number; headers: Record<string, string> } | null = null;
  const current = () => {
    const mtime = fs.statSync(full).mtimeMs;
    if (!cached || cached.mtime !== mtime) {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
      cached = { mtime, headers: Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> };
    }
    return cached.headers;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(current())) h.set(k, v);
    return fetchImpl(input, { ...init, headers: h });
  }) as typeof fetch;
}
