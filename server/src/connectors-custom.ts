import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { isLoopback, invalidateApps, MAX_APP_ID, type AppConfig } from './local-apps.js';
import { isOwner } from './plugins/owner.js';
import { audit } from './plugins/registry.js';
import { ConnectorError } from './connectors.js';
import { forgetGoogle } from './google-accounts.js';

/**
 * Connect a server by its address, from the app (Settings → Connectors on web and Windows, the
 * Connectors screen on Android). The owner gives an MCP URL and how to sign in:
 *  - none: the server needs no key;
 *  - key: a header (usually Authorization) whose value is kept in a file only the server reads
 *    (data/connectors/<id>.headers.json, mode 600) and is never sent back to any app;
 *  - sign-in: the server's own OAuth (MCP authorization: discovery, dynamic registration, PKCE). The
 *    app opens the server's sign-in page; it comes back to /api/connectors/oauth/callback and the
 *    token is kept in data/oauth/<id>.json and refreshed by app-oauth.ts.
 * The result is a catalog entry with a template, so giving it to bots is the usual propose → confirm
 * "Add to Bots", and each bot's Tools tab switches it after that.
 */

const root = () => new URL('../../', import.meta.url).pathname;
const rel = (...p: string[]) => path.join(...p);
const abs = (p: string) => path.resolve(root(), p);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server';
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function writeSecret(file: string, data: unknown) {
  const f = abs(file);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export type CustomAuth = 'none' | 'key' | 'oauth';
export interface CustomBody { name?: unknown; url?: unknown; auth?: unknown; headerName?: unknown; headerValue?: unknown; remote?: unknown; readOnly?: unknown }

interface Pending { connectorId: string; verifier: string; redirectUri: string; tokenUrl: string; clientId: string; resource?: string; expiresAt: number }
const pendingSignIns = new Map<string, Pending>();

function checkUrl(raw: string, remote: boolean): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectorError('That address is not a URL. It looks like http://127.0.0.1:3000/mcp or https://example.com/mcp.'); }
  if (!/^https?:$/.test(u.protocol)) throw new ConnectorError('The address must start with http:// or https://.');
  if (u.username || u.password) throw new ConnectorError('Put keys in the key field, not in the address.');
  if (!remote && !isLoopback(u.href)) throw new ConnectorError('That address is not on this computer. Tick "On another machine or the internet" if sending data there is fine.');
  return u;
}

/** Create a connector from an address. Returns its id and, for sign-in servers, the page to open. */
export async function createCustom(userId: string, body: CustomBody, origin: string): Promise<{ connectorId: string; signInUrl?: string }> {
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can connect servers.', 403);
  const name = String(body.name ?? '').trim().slice(0, 60);
  if (!name) throw new ConnectorError('Give it a name.');
  const remote = body.remote === true;
  const readOnly = body.readOnly === true;
  const auth = (['none', 'key', 'oauth'] as const).find((a) => a === body.auth) ?? 'none';
  const url = checkUrl(String(body.url ?? '').trim(), remote);
  // An app id may be 31 characters at most (local-apps.ts); a longer one would be skipped there.
  const base = slug(name).slice(0, MAX_APP_ID - 7).replace(/-+$/, '') || 'server';
  let id = `custom-${base}`;
  for (let i = 2; db.prepare('SELECT 1 FROM connectors WHERE id=?').get(id); i++) id = `custom-${base.slice(0, MAX_APP_ID - 11).replace(/-+$/, '')}-${i}`;

  const template: Omit<AppConfig, 'id'> = { name, url: url.href, ...(remote ? { remote: true } : {}), ...(readOnly ? { readOnly: true } : {}), timeoutMs: 120000 };
  let signInUrl: string | undefined;
  if (auth === 'key') {
    const headerName = String(body.headerName ?? 'Authorization').trim() || 'Authorization';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw new ConnectorError('The header name can only have letters, digits and dashes.');
    const value = String(body.headerValue ?? '').trim();
    if (!value) throw new ConnectorError('Paste the key.');
    if (/[\r\n]/.test(value)) throw new ConnectorError('The key has a line break in it.');
    const file = rel('data', 'connectors', `${id}.headers.json`);
    writeSecret(file, { [headerName]: value });
    template.headersFile = file;
  }
  if (auth === 'oauth') {
    const tokenFile = rel('data', 'oauth', `${id}.json`);
    const s = await startSignIn(id, url, origin);
    template.oauth = { tokenUrl: s.tokenUrl, clientId: s.clientId, tokenFile, ...(s.resource ? { resource: s.resource } : {}) };
    if (!remote && !isLoopback(s.tokenUrl)) template.remote = true;
    signInUrl = s.signInUrl;
  }
  const t = now();
  db.prepare(`INSERT INTO connectors(id,name,machine,transport,address,access,auth,reach,description,notes,firm,status,source,template,first_seen,last_seen,updated_at)
    VALUES (?,?,?,?,?,?,?,'cleft',?,NULL,0,?,'custom',?,?,?,?)`).run(
    id, name, remote ? url.hostname : null, 'http', url.href, readOnly ? 'read' : null, auth === 'none' ? 'none' : auth === 'key' ? 'key' : 'oauth',
    'Connected by address in the app.', auth === 'oauth' ? 'unknown' : 'active', JSON.stringify(template), t, t, t,
  );
  audit(userId, 'connector-create', id, null, { url: url.href, auth, remote, readOnly });
  invalidateApps();
  return { connectorId: id, signInUrl };
}

/** Sign in again (a sign-in server whose token expired or was never finished). */
export async function restartSignIn(userId: string, id: string, origin: string): Promise<{ signInUrl: string }> {
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can sign servers in.', 403);
  const r = db.prepare("SELECT template FROM connectors WHERE id=? AND source='custom'").get(id) as { template: string } | undefined;
  const t = r ? (JSON.parse(r.template) as Omit<AppConfig, 'id'>) : null;
  if (!t?.oauth || !t.url) throw new ConnectorError('That server does not sign in.', 404);
  const s = await startSignIn(id, new URL(t.url), origin);
  t.oauth = { ...t.oauth, tokenUrl: s.tokenUrl, clientId: s.clientId, ...(s.resource ? { resource: s.resource } : {}) };
  db.prepare('UPDATE connectors SET template=?, updated_at=? WHERE id=?').run(JSON.stringify(t), now(), id);
  invalidateApps();
  return { signInUrl: s.signInUrl };
}

/** Remove a connector made in the app (by address, or a Google account): its bots lose it, its key or token file is deleted. */
export async function deleteCustom(userId: string, id: string): Promise<void> {
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can remove servers.', 403);
  const r = db.prepare("SELECT template, source FROM connectors WHERE id=? AND source IN ('custom','google')").get(id) as { template: string; source: string } | undefined;
  if (!r) throw new ConnectorError('Only servers connected in the app can be removed here.', 404);
  const t = JSON.parse(r.template) as Omit<AppConfig, 'id'>;
  for (const f of [t.headersFile, t.oauth?.tokenFile]) if (f) fs.rmSync(abs(f), { force: true });
  if (r.source === 'google') await forgetGoogle(id);
  db.prepare('DELETE FROM connector_apps WHERE connector_id=?').run(id);
  db.prepare('DELETE FROM plugin_bots WHERE plugin_id=?').run(id);
  db.prepare('DELETE FROM connectors WHERE id=?').run(id);
  audit(userId, 'connector-delete', id, null, {});
  invalidateApps();
}

/** Whether a sign-in server has a token yet. */
export function signedIn(template: Omit<AppConfig, 'id'>): boolean {
  return !template.oauth || fs.existsSync(abs(template.oauth.tokenFile));
}

// ---------- MCP authorization (discovery, registration, PKCE) ----------

async function getJson(u: string, fetchImpl: typeof fetch): Promise<any | null> {
  try {
    const r = await fetchImpl(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Address ranges a remote server's sign-in metadata may not point us at (this machine, the LAN, cloud metadata). */
const INTERNAL = new Set(['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'uniqueLocal', 'carrierGradeNat', 'reserved', 'ipv4Mapped', 'rfc6052', 'rfc6145', '6to4', 'teredo']);
const internalIp = (ip: string) => {
  try { const a = ipaddr.process(ip); return INTERNAL.has(a.range()); } catch { return true; }
};
type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true })).map((r) => r.address);

/**
 * An address taken from a server's sign-in metadata. Only http(s), and http only on this computer. A server on
 * another machine may not send us to an internal address (this computer, the LAN, 169.254.169.254) unless that
 * address is the server's own host: a hostile server must not use YBots to reach things only YBots can.
 */
export async function checkEndpoint(raw: unknown, server: URL, lookup: Lookup = dnsLookup): Promise<URL> {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new ConnectorError("That server's sign-in details are not valid addresses."); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.href))) throw new ConnectorError("That server's sign-in details point somewhere YBots won't go (only https).");
  if (u.username || u.password) throw new ConnectorError("That server's sign-in details carry a password in an address.");
  if (isLoopback(server.href) || u.hostname === server.hostname) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let ips: string[];
  try { ips = net.isIP(host) ? [host] : await lookup(host); } catch { throw new ConnectorError(`YBots could not find ${u.hostname}.`); }
  if (!ips.length || ips.some(internalIp)) throw new ConnectorError("That server's sign-in details point at an internal address, so YBots won't use them.");
  return u;
}

export async function discover(url: URL, fetchImpl: typeof fetch = fetch, lookup: Lookup = dnsLookup): Promise<{ resource?: string; authServer: string; meta: any }> {
  // The server's 401 names its resource metadata; otherwise try the well-known places.
  let prm: any = null;
  try {
    const r = await fetchImpl(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cleft-bot', version: '1' } } }), signal: AbortSignal.timeout(15000) });
    const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') ?? '');
    if (m) prm = await getJson((await checkEndpoint(new URL(m[1], url).href, url, lookup)).href, fetchImpl);
  } catch { /* try the well-known paths */ }
  const p = url.pathname.replace(/\/+$/, '');
  prm ??= (p && p !== '/' ? await getJson(`${url.origin}/.well-known/oauth-protected-resource${p}`, fetchImpl) : null) ?? (await getJson(`${url.origin}/.well-known/oauth-protected-resource`, fetchImpl));
  const authServer = String(prm?.authorization_servers?.[0] ?? url.origin).replace(/\/+$/, '');
  const as = await checkEndpoint(authServer, url, lookup);
  const asPath = as.pathname.replace(/\/+$/, '');
  const meta = (await getJson(`${as.origin}/.well-known/oauth-authorization-server${asPath}`, fetchImpl)) ?? (await getJson(`${as.origin}/.well-known/openid-configuration${asPath}`, fetchImpl))
    ?? (asPath ? await getJson(`${authServer}/.well-known/openid-configuration`, fetchImpl) : null);
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new ConnectorError("That server doesn't offer a sign-in YBots can use. If it takes a key instead, choose Key.");
  // Every address the metadata names is checked before it is used or shown (a javascript: sign-in link, a
  // token endpoint on 169.254.169.254, ...). The sign-in page itself only needs to be http(s).
  let page: URL | null = null;
  try { page = new URL(String(meta.authorization_endpoint)); } catch { /* refused below */ }
  if (!page || !(page.protocol === 'https:' || (page.protocol === 'http:' && isLoopback(page.href)))) throw new ConnectorError("That server's sign-in page is not an https address.");
  meta.authorization_endpoint = page.href;
  meta.token_endpoint = (await checkEndpoint(meta.token_endpoint, url, lookup)).href;
  if (meta.registration_endpoint) meta.registration_endpoint = (await checkEndpoint(meta.registration_endpoint, url, lookup)).href;
  return { resource: prm?.resource, authServer, meta };
}

/**
 * The sign-in server may answer on a public name while Cleft reaches it through a tunnel: when the
 * server's own address is local and its sign-in endpoints are on another host, use the local origin.
 */
function local(endpoint: string, url: URL): string {
  const e = new URL(endpoint);
  if (isLoopback(url.href) && !isLoopback(e.href)) return `${url.origin}${e.pathname}${e.search}`;
  return e.href;
}

async function startSignIn(id: string, url: URL, origin: string, fetchImpl: typeof fetch = fetch) {
  const { resource, meta } = await discover(url, fetchImpl);
  const redirectUri = `${origin.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
  if (!meta.registration_endpoint) throw new ConnectorError("That server doesn't let new apps register for sign-in, so YBots can't sign in to it yet.");
  const reg = await fetchImpl(local(meta.registration_endpoint, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ client_name: 'YBots', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!reg.ok) throw new ConnectorError(`That server refused to register YBots for sign-in (HTTP ${reg.status}).`);
  const clientId = String(((await reg.json()) as any).client_id ?? '');
  if (!clientId) throw new ConnectorError('That server gave YBots no client id.');
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  const tokenUrl = local(meta.token_endpoint, url);
  for (const [k, v] of pendingSignIns) if (v.expiresAt < Date.now()) pendingSignIns.delete(k);
  pendingSignIns.set(state, { connectorId: id, verifier, redirectUri, tokenUrl, clientId, resource, expiresAt: Date.now() + 15 * 60 * 1000 });
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    ...(resource ? { resource } : {}),
    ...(Array.isArray(meta.scopes_supported) && meta.scopes_supported.length ? { scope: meta.scopes_supported.join(' ') } : {}),
  });
  // The sign-in page is opened in the person's browser, so it stays on the server's own (public) address.
  return { signInUrl: `${meta.authorization_endpoint}?${q}`, tokenUrl, clientId, resource };
}

/** The sign-in page sent the browser back with a code: exchange it and keep the token. */
export async function finishSignIn(q: { code?: string; state?: string; error?: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const p = q.state ? pendingSignIns.get(q.state) : undefined;
  if (!p || p.expiresAt < Date.now()) throw new ConnectorError('That sign-in expired. Start it again from Connectors.', 400);
  pendingSignIns.delete(q.state!);
  if (q.error || !q.code) throw new ConnectorError(`The sign-in was not finished${q.error ? ` (${q.error})` : ''}.`, 400);
  const r = await fetchImpl(p.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, ...(p.resource ? { resource: p.resource } : {}) }).toString(),
  });
  if (!r.ok) throw new ConnectorError(`The server didn't accept the sign-in (HTTP ${r.status}). Try again.`, 400);
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new ConnectorError('The server sent no token.', 400);
  const row = db.prepare('SELECT name, template FROM connectors WHERE id=?').get(p.connectorId) as { name: string; template: string } | undefined;
  if (!row) throw new ConnectorError('That connector was removed.', 404);
  const t = JSON.parse(row.template) as Omit<AppConfig, 'id'>;
  writeSecret(t.oauth!.tokenFile, { access_token: j.access_token, refresh_token: j.refresh_token ?? '', expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 });
  db.prepare("UPDATE connectors SET status='active', last_seen=?, updated_at=? WHERE id=?").run(now(), now(), p.connectorId);
  invalidateApps();
  return row.name;
}
