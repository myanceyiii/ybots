import { redact } from './lib/redact.js';
import { onShutdown } from './shutdown.js';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { invalidateApps, MAX_APP_ID, type AppConfig } from './local-apps.js';
import { isOwner } from './plugins/owner.js';
import { audit } from './plugins/registry.js';
import { ConnectorError } from './connectors.js';

/**
 * "Connect Google account" in Connectors (web, Windows, Android). A person signs in to Google on
 * Google's own page; the browser comes back to /api/connectors/google/callback and Cleft keeps the
 * account's keys in data/google/<id>/ (mode 600, never sent to any app). Each account gets its own
 * Google Workspace MCP server (taylorwilsdon/google_workspace_mcp, MIT), started and watched here,
 * so a bot given one account can't reach another. Read only unless the person ticks "Allow changes";
 * even then drafts and changes ask on a card, and no tool can send mail.
 *
 * The OAuth client is a Google Cloud "Web application" client the owner uploads once
 * (data/google/client.json); its redirect URI is APP_URL + /api/connectors/google/callback.
 */

const root = () => new URL('../../', import.meta.url).pathname;
/** data/google lives in the repo's data folder, or in GOOGLE_ACCOUNTS_DIR (tests point it at a throwaway folder). */
const abs = (p: string) => {
  const own = process.env.GOOGLE_ACCOUNTS_DIR;
  const rel = path.relative(path.join('data', 'google'), p);
  return own && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.resolve(own, rel) : path.resolve(root(), p);
};
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const CLIENT_FILE = 'data/google/client.json';
const FIRST_PORT = 18100;

export const SCOPES = {
  read: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/tasks.readonly'],
  write: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/tasks'],
};
/**
 * workspace-mcp's levels for each service. Tasks "manage" lists, reads, creates, updates (completes) and
 * moves tasks, but cannot delete tasks or clear completed ones (workspace-mcp auth/permissions.py).
 */
const PERMISSIONS = { read: ['gmail:readonly', 'calendar:readonly', 'drive:readonly', 'tasks:readonly'], write: ['gmail:readonly+drafts+send', 'calendar:full', 'drive:full', 'tasks:manage'] };
export const TASKS_SCOPES = { read: 'https://www.googleapis.com/auth/tasks.readonly', write: 'https://www.googleapis.com/auth/tasks' };
/** Tools that change something: asked on a card even when changes are allowed. */
const ASK = ['*draft*', '*manage*', '*create*', '*update*', '*delete*', '*share*', '*move*', '*copy*', '*upload*', '*modify*', '*import*', '*send*'];

interface Client { client_id: string; client_secret: string; auth_uri: string; token_uri: string; redirect_uris: string[]; project_id?: string }
/** `sub` is Google's own unchanging id for the account, kept so a connector is never reused for another account. */
export interface Account { email: string; write: boolean; port: number; sub?: string }

function writeSecret(file: string, data: unknown) {
  const f = abs(file);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** The uploaded client, or null. Accepts Google's download ({web: {...}}) or the bare object. */
export function parseClient(text: string): Client {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new ConnectorError("That isn't the JSON file Google gave you. Download it again from Credentials."); }
  const c = j?.web ?? j?.installed ?? j;
  if (j?.installed) throw new ConnectorError('That is a Desktop client. Make a "Web application" client instead, with the redirect address shown here.');
  const id = String(c?.client_id ?? ''), secret = String(c?.client_secret ?? '');
  if (!/\.apps\.googleusercontent\.com$/.test(id) || !secret) throw new ConnectorError('That file has no Google client id and secret in it.');
  return { client_id: id, client_secret: secret, auth_uri: String(c.auth_uri ?? 'https://accounts.google.com/o/oauth2/auth'), token_uri: String(c.token_uri ?? 'https://oauth2.googleapis.com/token'), redirect_uris: Array.isArray(c.redirect_uris) ? c.redirect_uris.map(String) : [], ...(c.project_id ? { project_id: String(c.project_id) } : {}) };
}

export function googleClient(): Client | null {
  try { return parseClient(fs.readFileSync(abs(CLIENT_FILE), 'utf8')); } catch { return null; }
}

/** Where the test-user list lives for the uploaded client's project. */
export function audienceUrl(): string {
  const p = googleClient()?.project_id;
  return `https://console.cloud.google.com/auth/audience${p ? `?project=${encodeURIComponent(p)}` : ''}`;
}

export const redirectUri = (appUrl: string) => `${appUrl.replace(/\/+$/, '')}/api/connectors/google/callback`;

/**
 * Which of this server's addresses Google should send people back to. If the uploaded client
 * lists one of ours, use it; otherwise prefer a public https address over a tailnet or local one,
 * so phones off the tailnet can finish signing in.
 */
export function googleBase(origins: string[]): string {
  const ours = origins.map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean);
  const listed = googleClient()?.redirect_uris ?? [];
  const match = ours.find((o) => listed.includes(redirectUri(o)));
  if (match) return match;
  const isPublic = (o: string) => o.startsWith('https://') && !/\.ts\.net$|localhost|127\.0\.0\.1/.test(new URL(o).hostname);
  return ours.find(isPublic) ?? ours[0] ?? origins[0];
}

function mustBePerson(userId: string, agent: string | null) {
  if (agent) throw new ConnectorError(`Only a person can connect a Google account. This sign-in belongs to ${agent}.`, 403);
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can connect Google accounts.', 403);
}

export function saveClient(userId: string, agent: string | null, text: unknown): void {
  mustBePerson(userId, agent);
  const c = parseClient(String(text ?? ''));
  writeSecret(CLIENT_FILE, { web: c });
  audit(userId, 'google-client', c.client_id.split('-')[0], null, {});
}

interface Pending { userId: string; verifier: string; redirect: string; write: boolean; expiresAt: number; replaces?: string }
const pending = new Map<string, Pending>();

/**
 * Called when a sign-in started from an older Google connection (Reconnect on it, in Connections)
 * finishes: connections.ts moves that connection's bots to the new sign-in. Set there, so this
 * module does not import it.
 */
let replaced: (userId: string, oldId: string, newId: string) => Promise<void> | void = () => {};
export function onGoogleReplaced(fn: typeof replaced) { replaced = fn; }

/**
 * Start a Google sign-in. `hint` (an address) opens Google's page on that account, for Reconnect;
 * `replaces` is an older Google connection whose bots move to this sign-in once it is finished.
 */
export function startGoogle(userId: string, agent: string | null, write: boolean, appUrl: string, opts: { hint?: string; replaces?: string } = {}): { signInUrl: string } {
  mustBePerson(userId, agent);
  const c = googleClient();
  if (!c) throw new ConnectorError('Google sign-in is not set up yet. Upload the Web client file first.');
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k);
  const redirect = redirectUri(appUrl);
  pending.set(state, { userId, verifier, redirect, write, expiresAt: Date.now() + 15 * 60 * 1000, ...(opts.replaces ? { replaces: opts.replaces } : {}) });
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.client_id, redirect_uri: redirect, state, scope: SCOPES[write ? 'write' : 'read'].join(' '),
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
    ...(opts.hint && /^[^@\s]+@[^@\s]+$/.test(opts.hint) ? { login_hint: opts.hint } : {}),
  });
  return { signInUrl: `${c.auth_uri}?${q}` };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
/**
 * The connector (and app) id of an account. An app id may be 31 characters at most (local-apps.ts), and a
 * longer one is skipped there, so no bot would ever get the account's tools. `google-<address>` is kept
 * when it fits; a longer address becomes the part before the @ plus a short hash of the whole address.
 */
export function googleId(email: string): string {
  const full = `google-${slug(email)}`;
  if (full.length <= MAX_APP_ID) return full;
  const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 4);
  return `google-${slug(email.split('@')[0]).slice(0, MAX_APP_ID - 12).replace(/-+$/, '')}-${hash}`;
}
/**
 * The connector id for this Google account: its usual id, unless that id already belongs to a different
 * account (two addresses can shorten to the same id), in which case the next free numbered id. A
 * different account never takes over another's connector, keys, port or bots.
 */
export function idForAccount(email: string, sub: string): string {
  const same = (a: Account) => a.email.trim().toLowerCase() === email.trim().toLowerCase() && (!a.sub || !sub || a.sub === sub);
  const base = googleId(email);
  let id = base;
  for (let n = 2; n < 100; n++) {
    const a = account(id);
    if (!a || same(a)) return id;
    const suffix = `-${n}`;
    id = `${base.slice(0, MAX_APP_ID - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  throw new ConnectorError('Too many Google accounts share that name. Remove an old one under Connectors first.', 409);
}
const dirOf = (id: string) => path.join('data', 'google', id);
export function account(id: string): Account | null {
  try { return JSON.parse(fs.readFileSync(abs(path.join(dirOf(id), 'account.json')), 'utf8')); } catch { return null; }
}
const googleIds = () => (db.prepare("SELECT id FROM connectors WHERE source='google'").all() as { id: string }[]).map((r) => r.id);

/** Google sent the browser back: keep the keys, make or update the account's connector, start its server. */
export async function finishGoogle(q: { code?: string; state?: string; error?: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (q.state && q.error) pending.delete(q.state);
  if (q.error === 'access_denied') throw new ConnectorError(`Google didn't let this account in. Either the sign-in was cancelled, or the account isn't on the app's test-user list: add it in Google Cloud under Google Auth Platform, Audience, Test users (${audienceUrl()}), then try Connect Google again.`, 400);
  const p = q.state ? pending.get(q.state) : undefined;
  if (!p || p.expiresAt < Date.now()) throw new ConnectorError('That sign-in expired. Start it again from Connectors.', 400);
  pending.delete(q.state!);
  if (q.error || !q.code) throw new ConnectorError(`The sign-in was not finished${q.error ? ` (${q.error})` : ''}.`, 400);
  const c = googleClient();
  if (!c) throw new ConnectorError('Google sign-in is not set up any more.', 400);
  const r = await fetchImpl(c.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: p.redirect, client_id: c.client_id, client_secret: c.client_secret, code_verifier: p.verifier }).toString(),
  });
  if (!r.ok) throw new ConnectorError(`Google didn't accept the sign-in (HTTP ${r.status}). Try again.`, 400);
  const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
  if (!t.access_token || !t.refresh_token) throw new ConnectorError('Google sent no lasting key. Remove YBots from your Google account permissions, then try again.', 400);
  let email = '';
  let sub = '';
  try {
    const claims = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString());
    email = String(claims.email ?? '');
    sub = String(claims.sub ?? '');
  } catch { /* checked below */ }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new ConnectorError('Google did not say which account signed in.', 400);
  const granted = String(t.scope ?? '').split(/\s+/);
  const missing = SCOPES[p.write ? 'write' : 'read'].filter((s) => s.startsWith('https://') && !granted.includes(s));
  if (missing.length) throw new ConnectorError(`Some boxes were left unticked on Google's page (${missing.map((s) => s.split('/').pop()).join(', ')}). Try again and tick them all.`, 400);

  const id = idForAccount(email, sub);
  const old = account(id);
  const used = new Set(googleIds().map((g) => account(g)?.port).filter(Boolean));
  let port = old?.port ?? FIRST_PORT;
  while (!old && used.has(port)) port++;
  const dir = dirOf(id);
  const expiry = new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString().slice(0, 19);
  writeSecret(path.join(dir, 'creds', `${email}.json`), { token: t.access_token, refresh_token: t.refresh_token, token_uri: c.token_uri, client_id: c.client_id, client_secret: c.client_secret, scopes: granted, expiry });
  writeSecret(path.join(dir, 'account.json'), { email, write: p.write, port, ...(sub ? { sub } : {}) } satisfies Account);

  const template: Omit<AppConfig, 'id'> = { name: `Google (${email})`, url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 120000, ...(p.write ? { ask: ASK } : { readOnly: true }) };
  const desc = describe(email, p.write, granted.includes(SEND_SCOPE), hasTasks(granted, p.write));
  const at = now();
  db.prepare(`INSERT INTO connectors(id,name,machine,transport,address,access,auth,reach,description,notes,firm,status,source,template,first_seen,last_seen,updated_at)
    VALUES (?,?,NULL,'http',?,?,'oauth','cleft',?,NULL,0,'active','google',?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, access=excluded.access, description=excluded.description, status='active', template=excluded.template, last_seen=excluded.last_seen, updated_at=excluded.updated_at`).run(
    id, template.name, template.url, p.write ? null : 'read', desc, JSON.stringify(template), at, at, at,
  );
  audit(p.userId, 'google-connect', id, null, { write: p.write });
  void restartServer(id);
  invalidateApps();
  if (p.replaces) {
    try { await replaced(p.userId, p.replaces, id); } catch (e) { noteLog(id, `moving bots from ${p.replaces} failed: ${(e as Error).message}`); }
  }
  return email;
}

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Whether Google granted the Tasks scope this account's mode needs (full Tasks also covers reading). */
function hasTasks(granted: string[], write: boolean): boolean {
  return granted.includes(TASKS_SCOPES.write) || (!write && granted.includes(TASKS_SCOPES.read));
}

/** What the Connectors row says the account allows, from what was ticked and what Google granted. */
function describe(email: string, write: boolean, send: boolean, tasks: boolean): string {
  const what = !write ? 'Read only.'
    : send ? 'Reads run; drafts and changes ask on a card. Sending mail shows the whole email on a card in the chat, and it goes only when you press Send.'
      : 'Reads run; drafts and changes ask on a card. Cannot send mail: it was connected before sending was added, so press Connect Google again for this account to add it.';
  const services = tasks ? 'Gmail, Calendar, Drive and Tasks' : 'Gmail, Calendar and Drive';
  const later = tasks ? '' : ' No Tasks yet: it was connected before Tasks was added, so press Connect Google again for this account to add it.';
  return `${services} for ${email}. ${what}${later} Connected in the app.`;
}

/** The scopes Google granted this account, from its stored sign-in. */
function grantedScopes(id: string): string[] {
  const a = account(id);
  if (!a) return [];
  try { return (JSON.parse(fs.readFileSync(path.join(abs(dirOf(id)), 'creds', `${a.email}.json`), 'utf8')).scopes ?? []) as string[]; } catch { return []; }
}

/**
 * The server's permissions: an account signed in before sending was added keeps drafts only, and one
 * signed in before Tasks was added runs without Tasks, so no tool asks for a scope it lacks.
 */
export function permissionsFor(id: string, write: boolean): string[] {
  const granted = grantedScopes(id);
  const tasks = hasTasks(granted, write);
  const base = write && !granted.includes(SEND_SCOPE) ? PERMISSIONS.write.map((x) => (x.startsWith('gmail:') ? 'gmail:readonly+drafts' : x)) : PERMISSIONS[write ? 'write' : 'read'];
  return tasks ? base : base.filter((x) => !x.startsWith('tasks:'));
}

/**
 * How one account is set up, for the admin view (connector-admin.ts): the scopes Cleft asks for, the
 * ones Google granted, the ones still missing (only a new Connect Google by a person adds them), and
 * the server's permission levels. Never a key or token.
 */
export function googleSetup(id: string): { email: string; write: boolean; port: number; wanted: string[]; granted: string[]; missing: string[]; permissions: string[] } | null {
  const a = account(id);
  if (!a) return null;
  const granted = grantedScopes(id);
  const wanted = SCOPES[a.write ? 'write' : 'read'].filter((s) => s.startsWith('https://'));
  return { email: a.email, write: a.write, port: a.port, wanted, granted: granted.filter((s) => s.startsWith('https://')), missing: wanted.filter((s) => !granted.includes(s)), permissions: permissionsFor(id, a.write) };
}

/** Recent lines from one account's server (its own log, keys removed), newest last. */
export function googleLog(id: string): string[] { return [...(logs.get(id) ?? [])]; }
const logs = new Map<string, string[]>();
function noteLog(id: string, line: string) {
  const l = logs.get(id) ?? [];
  l.push(`${new Date().toISOString().slice(0, 19)}Z ${redact(line).slice(0, 400)}`);
  if (l.length > 200) l.splice(0, l.length - 200);
  logs.set(id, l);
}

// ---------- one Google Workspace MCP server per account ----------

const procs = new Map<string, ChildProcess>();
const stopping = new Set<string>();
/** One pending restart per account, and how often its server has stopped in a row. */
const retries = new Map<string, NodeJS.Timeout>();
const fails = new Map<string, number>();
const bin = () => process.env.GOOGLE_WORKSPACE_MCP || '/opt/workspace-mcp/venv/bin/workspace-mcp';
const RETRY_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Servers of ours that an earlier run of the app left behind. The service is restarted without its
 * child processes being stopped, so an old server keeps the account's port and the new one can never
 * start. One is ours when it listens on this account's port with its keys under data/google/.
 */
export function staleServers(port: number, googleRoot = abs(path.join('data', 'google'))): number[] {
  const own = new Set([...procs.values()].map((p) => p.pid));
  const out: number[] = [];
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    const n = Number(pid);
    if (n === process.pid || own.has(n)) continue;
    try {
      const vars = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (vars.includes(`WORKSPACE_MCP_PORT=${port}`) && vars.some((v) => v.startsWith(`WORKSPACE_MCP_CREDENTIALS_DIR=${googleRoot}${path.sep}`))) out.push(n);
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

function ensure(id: string) {
  const waiting = retries.get(id);
  if (waiting) { clearTimeout(waiting); retries.delete(id); }
  if (procs.has(id) || stopping.has(id)) return;
  const a = account(id), c = googleClient();
  if (!a || !c || !fs.existsSync(bin())) return;
  const stale = staleServers(a.port);
  if (stale.length) {
    for (const pid of stale) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    console.log(`[google] ${id}: stopped ${stale.length} server(s) left from an earlier run`);
    retries.set(id, setTimeout(() => ensure(id), 2000).unref());
    return;
  }
  const dir = abs(dirOf(id));
  const child = spawn(bin(), ['--single-user', '--transport', 'streamable-http', '--permissions', ...permissionsFor(id, a.write)], {
    cwd: dir, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8',
      GOOGLE_OAUTH_CLIENT_ID: c.client_id, GOOGLE_OAUTH_CLIENT_SECRET: c.client_secret,
      WORKSPACE_MCP_CREDENTIALS_DIR: path.join(dir, 'creds'), WORKSPACE_MCP_HOST: '127.0.0.1', WORKSPACE_MCP_PORT: String(a.port),
      WORKSPACE_MCP_BASE_URI: 'http://127.0.0.1', WORKSPACE_MCP_DISABLED_TOOLS: 'start_google_auth', USER_GOOGLE_EMAIL: a.email,
    },
  });
  let tail = '';
  const startedAt = Date.now();
  child.stderr?.on('data', (d) => {
    tail = (tail + d).slice(-600);
    for (const line of String(d).split('\n')) if (line.trim()) noteLog(id, line);
  });
  noteLog(id, `started (permissions ${permissionsFor(id, a.write).join(' ')})`);
  procs.set(id, child);
  child.on('exit', (code) => {
    if (procs.get(id) === child) procs.delete(id);
    if (stopping.has(id)) { stopping.delete(id); return; }
    // A server that ran for a while and then stopped starts the count again; one that keeps failing waits longer each time.
    const n = Date.now() - startedAt > 60_000 ? 1 : (fails.get(id) ?? 0) + 1;
    fails.set(id, n);
    const wait = Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS);
    noteLog(id, `stopped (${code})`);
    if (n <= 3 || n % 10 === 0) console.warn(`[google] ${id} stopped (${code}); starting it again in ${Math.round(wait / 1000)}s${n > 1 ? ` (${n} times in a row)` : ''}. ${redact(tail.split('\n').filter(Boolean).pop() ?? '')}`);
    const old = retries.get(id);
    if (old) clearTimeout(old);
    retries.set(id, setTimeout(() => ensure(id), wait).unref());
  });
}

function stopServer(id: string): Promise<void> {
  const waiting = retries.get(id);
  if (waiting) { clearTimeout(waiting); retries.delete(id); }
  fails.delete(id);
  const p = procs.get(id);
  if (!p) return Promise.resolve();
  stopping.add(id);
  return new Promise((res) => { p.once('exit', () => res()); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000).unref(); });
}

export function restartServer(id: string): Promise<void> { return stopServer(id).then(() => { stopping.delete(id); ensure(id); }); }

/**
 * Accounts connected before ids were kept to 31 characters: give each a short id, moving its keys and
 * its rows, so its tools reach the bots. Nothing used the long id (the app was skipped), so no rule or
 * approval refers to it.
 */
function renameLongIds() {
  for (const id of googleIds()) {
    if (id.length <= MAX_APP_ID) continue;
    const a = account(id);
    if (!a) continue;
    const next = googleId(a.email);
    if (db.prepare('SELECT 1 FROM connectors WHERE id=?').get(next) || fs.existsSync(abs(dirOf(next)))) continue;
    try {
      fs.renameSync(abs(dirOf(id)), abs(dirOf(next)));
      try {
        db.transaction(() => {
          db.prepare('UPDATE connectors SET id=? WHERE id=?').run(next, id);
          db.prepare('UPDATE connector_apps SET connector_id=? WHERE connector_id=?').run(next, id);
          db.prepare('UPDATE plugin_bots SET plugin_id=? WHERE plugin_id=?').run(next, id);
        })();
      } catch (e) { fs.renameSync(abs(dirOf(next)), abs(dirOf(id))); throw e; }
      console.log(`[google] ${id} is now ${next} (app ids are at most ${MAX_APP_ID} characters)`);
    } catch (e) { console.warn(`[google] could not shorten the id of ${id}: ${(e as Error).message}`); }
  }
}

export function startGoogleServers() {
  renameLongIds();
  for (const id of googleIds()) {
    const a = account(id);
    // Keep each row's text in step with what the account can do now.
    if (a) { const g = grantedScopes(id); db.prepare("UPDATE connectors SET description=? WHERE id=? AND source='google'").run(describe(a.email, a.write, g.includes(SEND_SCOPE), hasTasks(g, a.write)), id); }
    ensure(id);
  }
  invalidateApps();
  // Stop the servers with the app. A plain 'exit' handler is not enough: the service is stopped with
  // SIGTERM, which ends Node without it, and the servers would live on holding their ports.
  const stop = () => { for (const p of procs.values()) p.kill('SIGTERM'); };
  process.once('exit', stop);
  onShutdown('google account servers', stop, 1000);
}

/** Remove an account: its server stops and its keys are deleted. The caller drops the connector row. */
export async function forgetGoogle(id: string): Promise<void> {
  await stopServer(id);
  fs.rmSync(abs(dirOf(id)), { recursive: true, force: true });
}
