import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { currentSession, requireUser, type AuthVars } from './lib/auth.js';
import { scopeFor } from './lib/scope.js';
import { firstNameOf, ownerName } from './people.js';
import { isSilo } from './silo.js';
import { chatOwner, getBotRow, getRow } from './store.js';
import type { LoginView } from './vault-types.js';
export type { LoginInput, LoginView } from './vault-types.js';

/**
 * Saved logins (docs/saved-logins.md). A person saves a site's username and password once; when a bot's
 * browser reaches that site's sign-in page, the bot asks with use_saved_login and the person presses
 * Sign in on a card. The server then types the saved values into the page (browser-cards.ts), the same
 * way a secure input card does. The bot only ever sees the site, a label and an opaque id.
 *
 *  - Sealed at rest with AES-256-GCM. The key is a file next to the database (or VAULT_KEY_FILE), made on
 *    the first save, readable by the server only. Each row's site, owner and id are bound into its seal,
 *    so a sealed value copied onto another row or site does not open.
 *  - Each login belongs to one person: the account's owner ('' here) or a scoped family member (their
 *    address, SCOPED_PEOPLE). Only that person sees it, changes it, or answers its card. A scoped person's
 *    bot (Robin) can use only that person's logins; the owner's logins are for the owner's other bots.
 *  - Siloed bots (Sheldon) never use the vault.
 *  - Values are never returned by any route, put on a card, written to a log, or given to a bot.
 *    There is no "show password": change it or delete it.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS vault_logins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  person TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_hint TEXT NOT NULL DEFAULT '',
  has_user INTEGER NOT NULL DEFAULT 0,
  has_pass INTEGER NOT NULL DEFAULT 0,
  sealed TEXT NOT NULL,
  bots TEXT,
  connector_first INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS vault_logins_owner ON vault_logins(user_id, person, site);
`);

// ------------------------------------------------------------------ the key and the seal

let cachedKey: Buffer | null = null;
const keyFile = () => process.env.VAULT_KEY_FILE || path.join(path.dirname(env.dbPath), 'vault', 'key');

/** The vault's key. Made on first use when `create`; null when there is none yet (nothing saved). */
function vaultKey(create: boolean): Buffer | null {
  if (cachedKey) return cachedKey;
  const file = keyFile();
  try {
    const raw = fs.readFileSync(file);
    const k = raw.length === 32 ? raw : Buffer.from(raw.toString('utf8').trim(), 'base64');
    if (k.length !== 32) throw new Error(`The vault key in ${file} is not 32 bytes.`);
    cachedKey = k;
    return k;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  if (!create) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const k = crypto.randomBytes(32);
  // 'wx': never overwrite a key that appeared meanwhile (that would make every saved login unreadable).
  try { fs.writeFileSync(file, k.toString('base64') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (e: any) { if (e?.code === 'EEXIST') return vaultKey(false); throw e; }
  cachedKey = k;
  return k;
}

interface Secret { u?: string; p?: string }
const aad = (id: string, person: string, site: string) => Buffer.from(`ybots-vault-v1|${id}|${person}|${site}`);

function seal(id: string, person: string, site: string, s: Secret): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', vaultKey(true)!, iv);
  c.setAAD(aad(id, person, site));
  const ct = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

function unseal(row: LoginRow): Secret {
  const k = vaultKey(false);
  if (!k) throw new Error('The vault key is missing, so saved logins cannot be opened.');
  const buf = Buffer.from(String(row.sealed).replace(/^v1\./, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAAD(aad(row.id, row.person, row.site));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as Secret;
}

// ------------------------------------------------------------------ sites

/** A site as saved: the host in lower case without "www.", from "example.com" or a whole address. Null if not a site. */
export function siteOf(input: unknown): string | null {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s || s.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || !(host.includes('.') || host === 'localhost')) return null;
  if (!/^[a-z0-9.-]+$/.test(host) && !/^\[[0-9a-f:]+\]$/.test(host)) return null;
  return host;
}

/** Whether a page on `pageHost` is the saved site or one of its subdomains (login.example.com for example.com). */
export function siteMatches(saved: string, pageHost: string): boolean {
  const h = String(pageHost ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return !!h && (h === saved || h.endsWith(`.${saved}`));
}

const PRIVATE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/;
/** Why a page may not get a saved login over its connection, or null: https, or plain http on this machine or the home network. */
export function originRefusal(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return 'The page has no address the app can check.'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && PRIVATE.test(u.hostname)) return null;
  return `The page (${origin}) is not a secure (https) page, so a saved login is not typed into it.`;
}

/** Mail, calendar and money sites, which the bots reach through connected apps first (connectors-first rule). */
const CONNECTOR_FIRST = /(^|\.)(gmail\.com|mail\.google\.com|calendar\.google\.com|accounts\.google\.com|outlook\.(com|live\.com|office\.com|office365\.com)|login\.(live|microsoftonline)\.com|icloud\.com|mail\.yahoo\.com|proton\.me|fastmail\.com|paypal\.com|venmo\.com|plaid\.com|chase\.com|wellsfargo\.com|bankofamerica\.com|capitalone\.com|americanexpress\.com|citi\.com|usaa\.com|discover\.com|schwab\.com|fidelity\.com|vanguard\.com|ally\.com|sofi\.com)$|bank|credit-?union|creditunion|\bfcu\b/;
export const guessConnectorFirst = (site: string) => CONNECTOR_FIRST.test(site);

// ------------------------------------------------------------------ who

interface LoginRow {
  id: string; user_id: string; person: string; site: string; label: string; user_hint: string;
  has_user: number; has_pass: number; sealed: string; bots: string | null; connector_first: number;
  created_at: number; updated_at: number; last_used_at: number | null; uses: number;
}

/** Who a request is for: '' for the account's owner, else the scoped person's address. */
export function personOfRequest(c: Context): string {
  const s = currentSession(c);
  const user = (c as any).get('user');
  return s && user && scopeFor(user.id, s.person) ? String(s.person).trim().toLowerCase() : '';
}

/** The person whose logins a bot (or its side chat) may use: '' for the owner, a scoped person's address, or null for none. */
export function personOfBot(botId: string): string | null {
  const root = chatOwner(botId);
  const b = getBotRow(root);
  if (!b || b.kind === 'room' || isSilo(root)) return null;
  const name = String(b.name ?? '').trim().toLowerCase();
  for (const [email, names] of env.scopedPeople) if (names.includes(name)) return email;
  return '';
}

const personName = (person: string) => (person ? firstNameOf(env.displayNames.get(person)) ?? 'the person it belongs to' : ownerName('the owner'));

/** The bots a person may let use their logins: their own top-level agent bots. */
export function botChoices(userId: string, person: string): { id: string; name: string }[] {
  const rows = db.prepare("SELECT id, name FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND side_of IS NULL ORDER BY is_primary DESC, created_at").all(userId) as { id: string; name: string }[];
  return rows.filter((b) => personOfBot(b.id) === person).map((b) => ({ id: b.id, name: b.name }));
}

const botsOf = (r: LoginRow): string[] | null => { if (r.bots === null) return null; try { const v = JSON.parse(r.bots); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const mayUse = (r: LoginRow, botId: string) => {
  const person = personOfBot(botId);
  if (person === null || r.person !== person) return false;
  const bots = botsOf(r);
  return bots === null || bots.includes(chatOwner(botId));
};

// ------------------------------------------------------------------ what apps and bots see

const view = (r: LoginRow): LoginView => ({
  id: r.id, site: r.site, label: r.label, userHint: r.user_hint, hasUsername: !!r.has_user, hasPassword: !!r.has_pass,
  bots: botsOf(r), connectorFirst: !!r.connector_first, createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at, uses: r.uses,
});

/** "a•••@example.com", "al•••": enough to tell two logins apart, never the whole name. */
export function hintOf(username: string): string {
  const u = username.trim();
  if (!u) return '';
  const at = u.indexOf('@');
  if (at > 0) return `${u.slice(0, Math.min(2, at))}•••${u.slice(at)}`.slice(0, 80);
  return `${u.slice(0, Math.min(2, Math.max(1, u.length - 2)))}•••`;
}

const rowById = (id: string) => db.prepare('SELECT * FROM vault_logins WHERE id=?').get(id) as LoginRow | undefined;

/** The logins a bot may use, as the bot sees them (no usernames, no values). */
export function loginsForBot(userId: string, botId: string): LoginRow[] {
  const person = personOfBot(botId);
  if (person === null) return [];
  return (db.prepare('SELECT * FROM vault_logins WHERE user_id=? AND person=? ORDER BY site, label').all(userId, person) as LoginRow[]).filter((r) => mayUse(r, botId));
}
export const botView = (r: LoginRow) => ({ login: r.id, site: r.site, label: r.label || r.site, username: !!r.has_user, password: !!r.has_pass });

/** One login for a bot's card, or why not. */
export function loginForUse(userId: string, botId: string, id: string): LoginRow | null {
  const r = rowById(id);
  return r && r.user_id === userId && mayUse(r, botId) ? r : null;
}
export const ownerOfLogin = (r: LoginRow) => ({ person: r.person, name: personName(r.person) });

/** Open a login's values for the fill that a card allowed. The caller types them and drops them. */
export function openLogin(r: LoginRow): Secret { return unseal(r); }

export function noteUse(id: string) { db.prepare('UPDATE vault_logins SET uses = uses + 1, last_used_at=? WHERE id=?').run(now(), id); }

// ------------------------------------------------------------------ saving

function cleanText(v: unknown, max: number) { return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max); }

function writeLogin(r: Omit<LoginRow, 'sealed'>, s: Secret) {
  const sealed = seal(r.id, r.person, r.site, s);
  db.prepare(`INSERT INTO vault_logins(id,user_id,person,site,label,user_hint,has_user,has_pass,sealed,bots,connector_first,created_at,updated_at,last_used_at,uses)
    VALUES (@id,@user_id,@person,@site,@label,@user_hint,@has_user,@has_pass,@sealed,@bots,@connector_first,@created_at,@updated_at,@last_used_at,@uses)
    ON CONFLICT(id) DO UPDATE SET site=@site,label=@label,user_hint=@user_hint,has_user=@has_user,has_pass=@has_pass,sealed=@sealed,bots=@bots,connector_first=@connector_first,updated_at=@updated_at`)
    .run({ ...r, sealed });
}

/**
 * Save a value typed on a secure input card ("Save to my logins"), after it was filled. A username or email
 * goes on the person's one login for that site that has none yet, a password on the one that has none yet,
 * else the site's newest login; otherwise a new login is made.
 */
export function saveFromCard(userId: string, person: string, siteIn: string, kind: string, value: string): 'saved' | 'no' {
  const site = siteOf(siteIn);
  const field = kind === 'password' ? 'p' : kind === 'username' || kind === 'email' ? 'u' : null;
  if (!site || !field || !value) return 'no';
  const rows = db.prepare('SELECT * FROM vault_logins WHERE user_id=? AND person=? AND site=? ORDER BY updated_at DESC').all(userId, person, site) as LoginRow[];
  const target = rows.find((r) => !(field === 'p' ? r.has_pass : r.has_user)) ?? (rows.length === 1 ? rows[0] : undefined);
  const t = now();
  if (target) {
    const s = unseal(target);
    s[field] = value;
    writeLogin({ ...target, user_hint: field === 'u' ? hintOf(value) : target.user_hint, has_user: s.u ? 1 : 0, has_pass: s.p ? 1 : 0, updated_at: t }, s);
  } else {
    const s: Secret = { [field]: value };
    writeLogin({
      id: newId('login'), user_id: userId, person, site, label: '', user_hint: field === 'u' ? hintOf(value) : '', has_user: field === 'u' ? 1 : 0, has_pass: field === 'p' ? 1 : 0,
      bots: null, connector_first: guessConnectorFirst(site) ? 1 : 0, created_at: t, updated_at: t, last_used_at: null, uses: 0,
    }, s);
  }
  return 'saved';
}

// ------------------------------------------------------------------ cards waiting on their owner

/**
 * Whether this person may press Sign in on a saved-login card: only the login's owner. Read from the card
 * itself (its login id) and the login's row, so nothing about it lives only in memory.
 */
export function mayAnswerCard(approvalId: string, person: string): boolean {
  const ap = db.prepare('SELECT bot_id, row_seq, tool FROM approvals WHERE id=?').get(approvalId) as { bot_id: string; row_seq: number; tool: string } | undefined;
  if (ap?.tool !== 'saved_login') return false;
  const card = getRow(ap.bot_id, ap.row_seq);
  const login = String((card?.body as any)?.vault?.login ?? '');
  const r = login ? rowById(login) : undefined;
  return !!r && r.person === person;
}

/** "Save to my logins" ticked on a secure input card: who it is saved for. Taken once by the fill. */
const saveAsks = new Map<string, string>();
export function askToSave(approvalId: string, person: string) { saveAsks.set(approvalId, person); setTimeout(() => saveAsks.delete(approvalId), 30_000).unref?.(); }
export function takeSaveAsk(approvalId: string): string | undefined { const p = saveAsks.get(approvalId); saveAsks.delete(approvalId); return p; }

// ------------------------------------------------------------------ routes (/api/vault)

export const vaultApi = new Hono<AuthVars>();
vaultApi.use('*', requireUser);
// Only people manage their logins: not a script session (a Claude thread), not a bot.
vaultApi.use('*', async (c, next) => {
  const agent = (c as any).get('agent');
  if (agent) return c.json({ error: `Saved logins are managed by people only. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  await next();
});

const mine = (c: Context, id: string): LoginRow | null => {
  const r = rowById(id);
  return r && r.user_id === (c as any).get('user').id && r.person === personOfRequest(c) ? r : null;
};

function pickBots(userId: string, person: string, v: unknown): string[] | null | 'bad' {
  if (v === null || v === undefined || v === 'all') return null;
  if (!Array.isArray(v)) return 'bad';
  const allowed = new Set(botChoices(userId, person).map((b) => b.id));
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string'))];
  return ids.every((id) => allowed.has(id)) ? ids : 'bad';
}

vaultApi.get('/logins', (c) => {
  const user = (c as any).get('user');
  const person = personOfRequest(c);
  const rows = db.prepare('SELECT * FROM vault_logins WHERE user_id=? AND person=? ORDER BY site, label').all(user.id, person) as LoginRow[];
  return c.json({ logins: rows.map(view), bots: botChoices(user.id, person) });
});

vaultApi.post('/logins', async (c) => {
  const user = (c as any).get('user');
  const person = personOfRequest(c);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const site = siteOf(b.site);
  if (!site) return c.json({ error: 'Type the site, like example.com.' }, 400);
  const username = typeof b.username === 'string' ? b.username.slice(0, 512) : '';
  const password = typeof b.password === 'string' ? b.password.slice(0, 512) : '';
  if (!password && !username.trim()) return c.json({ error: 'Type a username, a password, or both.' }, 400);
  const bots = pickBots(user.id, person, b.bots);
  if (bots === 'bad') return c.json({ error: 'Pick only your own bots.' }, 400);
  const t = now();
  const id = newId('login');
  const s: Secret = { ...(username.trim() ? { u: username.trim() } : {}), ...(password ? { p: password } : {}) };
  writeLogin({
    id, user_id: user.id, person, site, label: cleanText(b.label, 60), user_hint: hintOf(username), has_user: s.u ? 1 : 0, has_pass: s.p ? 1 : 0,
    bots: bots === null ? null : JSON.stringify(bots), connector_first: (typeof b.connectorFirst === 'boolean' ? b.connectorFirst : guessConnectorFirst(site)) ? 1 : 0,
    created_at: t, updated_at: t, last_used_at: null, uses: 0,
  }, s);
  return c.json({ ok: true, login: view(rowById(id)!) });
});

vaultApi.patch('/logins/:id', async (c) => {
  const user = (c as any).get('user');
  const person = personOfRequest(c);
  const r = mine(c, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const s = unseal(r);
  const site = b.site === undefined ? r.site : siteOf(b.site);
  if (!site) return c.json({ error: 'Type the site, like example.com.' }, 400);
  if (typeof b.username === 'string') { const u = b.username.trim().slice(0, 512); if (u) s.u = u; else delete s.u; }
  if (typeof b.password === 'string' && b.password) s.p = b.password.slice(0, 512);
  if (b.clearPassword === true) delete s.p;
  if (!s.u && !s.p) return c.json({ error: 'A login needs a username or a password.' }, 400);
  const bots = b.bots === undefined ? botsOf(r) : pickBots(user.id, person, b.bots);
  if (bots === 'bad') return c.json({ error: 'Pick only your own bots.' }, 400);
  writeLogin({
    ...r, site, label: b.label === undefined ? r.label : cleanText(b.label, 60), user_hint: typeof b.username === 'string' ? hintOf(s.u ?? '') : r.user_hint,
    has_user: s.u ? 1 : 0, has_pass: s.p ? 1 : 0, bots: bots === null ? null : JSON.stringify(bots),
    connector_first: typeof b.connectorFirst === 'boolean' ? (b.connectorFirst ? 1 : 0) : r.connector_first, updated_at: now(),
  }, s);
  return c.json({ ok: true, login: view(rowById(r.id)!) });
});

vaultApi.delete('/logins/:id', (c) => {
  const r = mine(c, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM vault_logins WHERE id=?').run(r.id);
  return c.json({ ok: true });
});
