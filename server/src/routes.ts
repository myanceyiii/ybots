import { redact } from './lib/redact.js';
import { dropSecret, handSecret } from './browser-cards.js';
import { handPlanDays, setPublishGuard } from './posting.js';
import { CHAT_COLOR_ORDER, isChatColor } from './chat-colors.js';
import { VISUALS_LEVELS } from './visuals-level.js';
import { BUSY_SEND_MODES } from './steer-mode.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub, hubBoot } from './lib/hub.js';
import { webBuild } from './build-info.js';
import { accessConfigured, accessEmail } from './lib/cf-access.js';
import { eventInScope, inScope, scopeFor } from './lib/scope.js';
import { checkEdit, editNote, markEdited } from './message-edit.js';
import { agentName, agentNote, createSession, createSessionToken, currentSession, displayName, destroyBearerSession, destroySession, isLocalRequest, isOwnerKey, peerAddress, rateLimit, requireUser, bearerToken, type AuthVars } from './lib/auth.js';
import { createMachine, machineRoutes, parsePublicKey } from './machines.js';
import { getSummaryPrefs, lastSummaryError, setSummaryPrefs } from './list-summary-store.js';
import { summaryOptions, sweepSoon } from './list-summary.js';
import { allLive, appendRow, chatOwner, clearConversation, restoreConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { applyViewOp, viewToPageBlocks, ViewError } from './views.js';
import { withPin } from './board-pin.js';
import { createPage } from './pages.js';
import { notePageOrigin } from './page-shelf.js';
import { ApprovalError, busySendFor, enqueue, interrupt, resolveApproval, sendFromOwner, steerRoomMember } from './agent/loop.js';
import { attachmentNote, checkAttachments, imagePaths } from './chat-extras.js';
import { deleteRule, listRules, ruleLog } from './allow-rules.js';
import { freeTerminal, isMaintainer, maintainerAudit, setFreeTerminal } from './maintainer-guard.js';
import { isOwner } from './plugins/owner.js';
import { computerState, ensureComputer, forgetBotFiles, readyScreen, refreshComputer, releaseScreen, suspendComputer } from './computer.js';
import { assignEngine, provisionEngine, removeEngine, restartEngine, syncPersona } from './engine.js';
import { deleteMemory, listMemories, memoryBot } from './engine-memory.js';
import { orgo } from './orgo.js';
import { appsStatus } from './local-apps.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { personReact } from './reaction-feedback.js';
import { isOutside } from './outside.js';
import { isSilo } from './silo.js';
import { linkError, listExchanges, setPaused } from './slack-link.js';
import { voiceApi } from './voice.js';
import { deviceLabel } from './sessions.js';
import { autoTitle, createSideChat, deleteSideChat, listSideChats, ownSideChat, removeSideChatsOf, renameSideChat, restoreSideChat, SIDE_UNDO_MS, sideChatsAllowed } from './side-chats.js';
import { forgetLooks, lookRoutes } from './avatars.js';
import { deliverable, getPrefs, lastNoticeId, noticesAfter, profileOf, setPrefs } from './notify.js';
import { addPhoneLink, phoneResult } from './phone.js';
import type { AvatarColor, AvatarShape, MessageBody, Row, ServerEvent, Toolkit, User } from './types.js';

export const api = new Hono<AuthVars>();

const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

/** JSON that is safe to embed inside an inline <script>: `<` can't close the tag and line separators can't break the statement. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Thrown for things the user can fix; the message is shown to them. */
class UserError extends Error {}

const agentCount = () => (db.prepare("SELECT COUNT(*) n FROM bots WHERE COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get() as any).n as number;

function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; isPrimary?: boolean }) {
  // Every bot needs a screen of its own on the one shared computer.
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full: the computer has room for ${env.maxBots} bots. Remove one to add another.`);
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  // The first bot is the agent that already runs on the computer; the others get an engine of their own,
  // and the same light / standard / heavy Auto tiers as the rest once that engine lists its models.
  if (assignEngine(id) === 'managed') {
    db.prepare('UPDATE bots SET tiers_seed=1 WHERE id=?').run(id);
    provisionEngine(id);
  }
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

/**
 * Who may sign in. Every account gets agents with a shell on the shared computer, so on a public URL
 * only ALLOWED_EMAILS get in, and with an empty list nobody does: having an account already is no
 * pass, or one made while the instance was open would get in forever. `owner` (the key that only
 * exists on the server's machine) is always let in. Sessions are held to the same list afterwards
 * (userFromToken).
 */
function maySignIn(email: string, owner: boolean): boolean {
  if (owner) return true;
  if (env.allowedEmails.length) return env.allowedEmails.includes(email.toLowerCase());
  return env.localOnly;
}

function findOrCreateUser(email: string, name?: string, opts: { owner?: boolean } = {}) {
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) as any;
  if (!maySignIn(email, !!opts.owner)) throw new UserError('This account is not allowed to sign in here.');
  if (existing) return { id: existing.id as string, isNew: false };
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name ?? email.split('@')[0], now());
  createBot(id, { name: env.primaryBotName, label: env.primaryBotLabel, description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

// ---------- auth ----------

/**
 * Signs the request in as the person Cloudflare Access let through, when Access sign-in is set up and
 * that address is on ALLOWED_EMAILS (see lib/cf-access.ts). Answers with the user, or with why not.
 */
async function accessSignIn(c: Context): Promise<{ user?: { id: string; email: string; name: string; avatarUrl: string | null; displayName: string }; refused?: string }> {
  if (!accessConfigured()) return {};
  const passed = await accessEmail(c.req.header('cf-access-jwt-assertion'));
  if (!passed) return {};
  // The account it stands for (CF_ACCESS_ACCOUNTS), which must be on the allowed list.
  const email = env.cfAccessAccounts.get(passed) ?? passed;
  if (!env.allowedEmails.includes(email)) return { refused: passed };
  try {
    const { id } = findOrCreateUser(email);
    createSession(c, id, { person: passed });
    const user = db.prepare('SELECT id, email, name, avatar_url AS avatarUrl FROM users WHERE id=?').get(id) as any;
    return { user: { ...user, displayName: displayName(user, passed) } };
  } catch (e) {
    console.warn(`[auth] Access sign-in for ${redact(email)} failed: ${redact((e as Error).message)}`);
    return { refused: email };
  }
}
/** Set by signing out, so a browser behind Access is not signed straight back in (see /auth/me). */
const SIGNED_OUT = 'cleftbot_signed_out';

api.get('/auth/me', async (c) => {
  const bearer = bearerToken(c);
  const s = currentSession(c);
  let user: (User & { displayName: string }) | null = s ? { ...s.user, displayName: displayName(s.user, s.person) } : null;
  // Behind Cloudflare Access, a browser that is not signed in yet is signed in here as the person Access
  // let through. Nothing to run or click. After "Log out" it waits for "Continue" instead (POST /auth/access).
  let accessRefused: string | undefined;
  let accessReady = false;
  if (!user && bearer === undefined && accessConfigured()) {
    if (getCookie(c, SIGNED_OUT)) {
      const passed = await accessEmail(c.req.header('cf-access-jwt-assertion'));
      accessReady = !!passed && env.allowedEmails.includes(env.cfAccessAccounts.get(passed) ?? passed);
      if (passed && !accessReady) accessRefused = passed;
    } else {
      const r = await accessSignIn(c);
      user = r.user ?? null;
      accessRefused = r.refused;
    }
  }
  // Which bots this sign-in may see, when it is scoped (lib/scope.ts); apps hide the rest of the menus.
  const scope = s ? scopeFor(s.user.id, s.person) : null;
  if (user && scope) user = Object.assign(user, { scope: { bots: [...scope.bots] } });
  return c.json({ user, devLogin: env.devLogin, signIn: { accessUrl: env.cfAccessAppUrl || undefined, accessRefused, accessReady } });
});

api.post('/auth/access', async (c) => {
  const r = await accessSignIn(c);
  if (!r.user) return c.json({ error: r.refused ? `${r.refused} is not allowed to sign in here.` : 'Cloudflare Access did not vouch for this request.' }, 403);
  deleteCookie(c, SIGNED_OUT, { path: '/' });
  return c.json({ ok: true });
});

// Limits on the sign-in routes, each counted per peer address (see rateLimit for what that means
// behind a proxy). The dev form can make a new account with an agent of its own, so starts are
// capped. For the owner key and sign-in links it is the wrong guesses that are capped. There is no
// Google sign-in in this fork: sign in with a link from scripts/sign-in-link.sh on the server.
const TEN_MINUTES = 10 * 60_000;
const devSignIns = rateLimit(10, TEN_MINUTES);
const ownerFailures = rateLimit(5, TEN_MINUTES);
const linkFailures = rateLimit(5, TEN_MINUTES);
const tooMany = (c: Context, limit: ReturnType<typeof rateLimit>, peer: string) => {
  c.header('Retry-After', String(limit.retryAfter(peer)));
  return c.text('Too many sign-in attempts from this address. Try again in a few minutes.', 429);
};

api.post('/auth/dev', async (c) => {
  // Email-only sign-in proves nothing about who is asking, so it only works for a local app and
  // only for requests made on this machine: not from the LAN when the server listens there, and not
  // passed on by a tunnel or proxy that says so (see isLocalRequest).
  if (!env.devLogin || !isLocalRequest(c)) return c.json({ error: 'disabled' }, 403);
  const peer = peerAddress(c);
  if (devSignIns.full(peer)) return tooMany(c, devSignIns, peer);
  devSignIns.count(peer);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

/**
 * One-time sign-in links, made by the owner endpoint or by a signed-in device for another one. Kept in
 * memory: a restart drops them. `owner`: the session the link starts counts as an owner session.
 */
const signInLinks = new Map<string, { userId: string; expires: number; owner: boolean; person: string | null; agent: string | null }>();
const LINK_TTL = 15 * 60_000;
function makeSignInLink(userId: string, owner: boolean, person: string | null = null, agent: string | null = null): { url: string; expiresAt: number } {
  for (const [t, l] of signInLinks) if (l.expires < Date.now()) signInLinks.delete(t);
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + LINK_TTL;
  signInLinks.set(token, { userId, expires: expiresAt, owner, person, agent });
  return { url: `${env.appUrl}/api/auth/link/${token}`, expiresAt };
}
const deviceLinks = rateLimit(10, TEN_MINUTES);

/** A person's phone Access token from CF_ACCESS_PHONE_TOKENS, or null (none listed, no public address, unreadable or malformed file). */
function phoneAccessFor(person: string): { id: string; secret: string; scheme: string | null } | null {
  const file = env.phoneAccess.get(person.toLowerCase());
  if (!file || !env.cfAccessAppUrl) return null;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const val = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  const id = val('CFA_ID'), secret = val('CFA_SECRET'), scheme = val('APP_SCHEME');
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(id) || !ok.test(secret)) return null;
  return { id, secret, scheme: /^cleftbot$/.test(scheme) ? scheme : null };
}

// Sign-in for whoever runs the server, without Google: the key only exists on the machine (see isOwnerKey),
// and the request has to come from the machine too, so nobody elsewhere gets to try keys (see isLocalRequest).
// With `link`, it answers with a link that signs one browser in, once (scripts/sign-in-link.sh).
api.post('/auth/owner', async (c) => {
  // A request from elsewhere is refused whatever key it carries, so it is not counted either: junk
  // sent through the public URL cannot use up the allowance of the script on this machine. Wrong
  // keys from this machine are counted, and past the limit no key is looked at until it has eased.
  if (!isLocalRequest(c)) return c.json({ error: 'forbidden' }, 403);
  const peer = peerAddress(c);
  if (ownerFailures.full(peer)) return tooMany(c, ownerFailures, peer);
  if (!isOwnerKey((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))) {
    ownerFailures.count(peer);
    return c.json({ error: 'forbidden' }, 403);
  }
  // `agent`: the name the script goes by (for example "Claude: helpers thread"). A session made here
  // without `link` is always a script's, named "Script on the server" when it gives no name; a link is
  // for a person to open in a browser, unless the script names itself, and then it stays the script's.
  const { email: asked, name, link, agent: askedAgent } = await c.req.json<{ email: string; name?: string; link?: boolean; agent?: string }>();
  const agent = agentName(askedAgent) ?? (link ? null : 'Script on the server');
  if (!asked?.includes('@')) return c.json({ error: 'email required' }, 400);
  // A person's address that CF_ACCESS_ACCOUNTS maps to a shared account signs in to that account, the same
  // way Cloudflare Access sign-in does, instead of getting a new, empty account of their own.
  const person = asked.trim().toLowerCase();
  const mapped = env.cfAccessAccounts.get(person);
  const email = mapped ?? asked;
  try {
    const { id } = findOrCreateUser(email, name, { owner: true });
    if (link) {
      return c.json({ ok: true, url: makeSignInLink(id, true, mapped ? person : null, agent).url });
    }
    createSession(c, id, { owner: true, agent, ...(mapped ? { person } : {}) });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

api.get('/auth/link/:token', (c) => {
  // Checked before the link is looked at, so a refused request does not use a link up.
  const peer = peerAddress(c);
  if (linkFailures.full(peer)) return tooMany(c, linkFailures, peer);
  const token = c.req.param('token');
  const l = signInLinks.get(token);
  signInLinks.delete(token);
  if (!l || l.expires < Date.now()) {
    linkFailures.count(peer);
    return c.text('This sign-in link was already used or has expired. Ask for a new one.', 410);
  }
  // A link made with the owner key starts an owner session; one made by a signed-in device starts the
  // same kind of session that device has. The phone app asks for JSON (it scanned the link as a QR code)
  // and keeps the token itself; a browser gets a cookie and is sent to the app.
  if ((c.req.header('accept') ?? '').includes('application/json')) {
    const user = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(l.userId) as { id: string; email: string; name: string };
    return c.json({ token: createSessionToken(l.userId, { owner: l.owner, person: l.person, agent: l.agent, device: deviceLabel(c.req.header('user-agent'), c.req.header('x-cleft-device')) }), user: { ...user, displayName: displayName(user, l.person) } });
  }
  createSession(c, l.userId, { owner: l.owner, person: l.person, agent: l.agent });
  return c.redirect('/');
});

// "Sign in another device": a device that is already signed in makes a one-time link (15 minutes, one
// use) for the same account, to open on a phone or another computer. It replaces running
// scripts/sign-in-link.sh on the server. It needs a live session, so it gives nobody more than they
// already have. Under /api/auth/ the routes are open, so the session is checked here.
api.post('/auth/device-link', (c) => {
  const s = currentSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  if (deviceLinks.full(s.user.id)) return tooMany(c, deviceLinks, s.user.id);
  deviceLinks.count(s.user.id);
  // A script's session can only make links for more of the same: it never signs in a person's device.
  const made = makeSignInLink(s.user.id, s.owner, s.person, s.agent);
  // The person's phone token (CF_ACCESS_PHONE_TOKENS), when there is one: the link goes to the public
  // address with the token in its #fragment, so a phone signed in with it works without Tailscale.
  // Never for a script's session, which has no phone.
  const phone = !s.agent && s.person ? phoneAccessFor(s.person) : null;
  const url = phone ? `${env.cfAccessAppUrl}${new URL(made.url).pathname}#cfa=${phone.id}:${phone.secret}` : made.url;
  const scheme = phone?.scheme ?? 'cleftbot';
  return c.json({ url, appLink: `${scheme}://sign-in?link=${encodeURIComponent(url)}`, expiresAt: made.expiresAt });
});

// Pairing a PC by QR code (the Windows app). The PC, signed out, asks for a pairing and gets an id, a
// short code and a secret that only it keeps. It shows a QR code for /pair/<id>; a signed-in person
// opens that on their phone, checks the short code matches the PC's screen, and taps Allow or Deny.
// The PC polls with its secret; once allowed it gets a one-time sign-in link for the account that
// allowed it, opens it, and the pairing is gone. Scanning the code alone gets nobody anything: the
// link only goes to the holder of the secret. Two minutes, one use, kept in memory.
// The same flow pairs a PC as a remote machine (docs/remote-pc.md): kind 'machine' with the PC's public
// key. Allowing it records the PC for that account (machines.ts) and the poll answers with its id only;
// no sign-in link is made, so pairing a machine never signs anything in.
type Pairing = { code: string; secretHash: Buffer; device: string; created: number; expires: number; state: 'waiting' | 'allowed' | 'denied'; userId?: string; owner?: boolean; person?: string | null; agent?: string | null; kind: 'sign-in' | 'machine'; publicKey?: string; machineId?: string };
const pairings = new Map<string, Pairing>();
const PAIR_TTL = 2 * 60_000;
const pairStarts = rateLimit(20, TEN_MINUTES);
const pairFailures = rateLimit(30, TEN_MINUTES);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function livePairing(id: string): Pairing | undefined {
  for (const [k, p] of pairings) if (p.expires < Date.now()) pairings.delete(k);
  return pairings.get(id);
}

api.post('/auth/pair', async (c) => {
  const peer = peerAddress(c);
  if (pairStarts.full(peer)) return tooMany(c, pairStarts, peer);
  pairStarts.count(peer);
  const body = await c.req.json<{ device?: string; kind?: string; publicKey?: string }>().catch(() => ({}) as { device?: string; kind?: string; publicKey?: string });
  const device = String(body.device ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || 'a computer';
  const kind = body.kind === 'machine' ? 'machine' : 'sign-in';
  const publicKey = kind === 'machine' ? parsePublicKey(body.publicKey) : null;
  if (kind === 'machine' && !publicKey) return c.json({ error: 'A PC pairing needs the PC\'s Ed25519 public key.' }, 400);
  const id = crypto.randomBytes(18).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const raw = Array.from(crypto.randomBytes(6), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
  const code = `${raw.slice(0, 3)}-${raw.slice(3)}`;
  const expiresAt = Date.now() + PAIR_TTL;
  pairings.set(id, { code, secretHash: sha256(secret), device, created: Date.now(), expires: expiresAt, state: 'waiting', kind, ...(publicKey ? { publicKey } : {}) });
  return c.json({ id, code, secret, expiresAt, url: `${env.appUrl}/pair/${id}` });
});

// The PC's poll. Only the secret it was given answers; anything else looks like a pairing that is gone.
api.get('/auth/pair/:id', (c) => {
  const peer = peerAddress(c);
  if (pairFailures.full(peer)) return tooMany(c, pairFailures, peer);
  const id = c.req.param('id');
  const p = livePairing(id);
  const secret = c.req.header('x-pair-secret') ?? '';
  if (!p || !crypto.timingSafeEqual(sha256(secret), p.secretHash)) {
    pairFailures.count(peer);
    return c.json({ state: 'gone' }, 404);
  }
  if (p.state === 'waiting') return c.json({ state: 'waiting', expiresAt: p.expires });
  pairings.delete(id);
  if (p.state === 'denied' || !p.userId) return c.json({ state: 'denied' });
  if (p.kind === 'machine') return p.machineId ? c.json({ state: 'allowed', machineId: p.machineId }) : c.json({ state: 'denied' });
  return c.json({ state: 'allowed', link: makeSignInLink(p.userId, !!p.owner, p.person ?? null, p.agent ?? null).url });
});

// What the approving phone shows: the PC's name and short code, so the person can match them.
api.get('/auth/pair/:id/info', (c) => {
  if (!currentSession(c)) return c.json({ error: 'unauthenticated' }, 401);
  const p = livePairing(c.req.param('id'));
  if (!p || p.state !== 'waiting') return c.json({ error: 'This code has expired or was already used. Make a new one on the computer.' }, 410);
  return c.json({ code: p.code, device: p.device, kind: p.kind, createdAt: p.created, expiresAt: p.expires });
});

// The same, found by the short code typed on a phone (the Android app has no scanner yet): signed in
// only, counted against the same failure limit, and only codes that are still waiting.
api.get('/auth/pair-code/:code', (c) => {
  if (!currentSession(c)) return c.json({ error: 'unauthenticated' }, 401);
  const peer = peerAddress(c);
  if (pairFailures.full(peer)) return tooMany(c, pairFailures, peer);
  const raw = c.req.param('code').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : '';
  livePairing('');
  const hit = code ? [...pairings].find(([, p]) => p.state === 'waiting' && p.code === code) : undefined;
  if (!hit) {
    pairFailures.count(peer);
    return c.json({ error: 'No computer is showing that code right now. Check it, or make a new one on the computer.' }, 404);
  }
  const [id, p] = hit;
  return c.json({ id, code: p.code, device: p.device, kind: p.kind, createdAt: p.created, expiresAt: p.expires });
});

// Allow or Deny, by a signed-in person only. The PC becomes that person's account, never another.
api.post('/auth/pair/:id/answer', async (c) => {
  const s = currentSession(c);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  // Pairing a PC is an approval, so only a person answers it: a script's session is refused.
  if (s.agent) return c.json({ error: `Only a person can allow a computer. This sign-in belongs to ${s.agent}.`, code: 'agent_session' }, 403);
  if (scopeFor(s.user.id, s.person) && livePairing(c.req.param('id'))?.kind === 'machine') return c.json({ error: 'Not available on this sign-in.', code: 'scoped' }, 403);
  const { allow } = await c.req.json<{ allow?: boolean }>().catch(() => ({}) as { allow?: boolean });
  const p = livePairing(c.req.param('id'));
  if (!p || p.state !== 'waiting') return c.json({ error: 'This code has expired or was already used. Make a new one on the computer.' }, 410);
  if (allow === true) {
    Object.assign(p, { state: 'allowed', userId: s.user.id, owner: s.owner, person: s.person });
    if (p.kind === 'machine' && p.publicKey) p.machineId = createMachine(s.user.id, s.person, p.device, p.publicKey);
  } else p.state = 'denied';
  return c.json({ ok: true, state: p.state, device: p.device });
});

api.post('/auth/logout', (c) => {
  destroyBearerSession(c);
  destroySession(c);
  if (accessConfigured() && bearerToken(c) === undefined) setCookie(c, SIGNED_OUT, '1', { httpOnly: true, sameSite: 'Lax', secure: env.appUrl.startsWith('https:'), path: '/' });
  return c.json({ ok: true });
});

// Everything below requires a session, except the page a provider sends the browser back to after
// connecting an app. Only that exact GET is let through: as a prefix it also covered other routes
// that happen to start the same way (DELETE /api/apps/callback is "disconnect the app `callback`").
// Every route under /api/auth/ is defined above and is meant to work signed out.
api.use('/*', async (c, next) => {
  const open = c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health';
  return open ? next() : requireUser(c, next);
});

// ---------- events (SSE) ----------

// The live stream. Every event carries a number ("<run>.<n>" as the SSE id); an app that reconnects sends
// the last one it saw (the Last-Event-ID header a browser adds by itself, or ?after=) and is sent what it
// missed. `hello` says whether that worked (`resumed`); when it did not, the app fetches afresh as before.
// `hello` also names the build, so an open page can tell the server was updated under it.
api.get('/events', (c) => {
  const user = c.get('user');
  const scope = c.get('scope');
  const asked = (c.req.header('last-event-id') ?? c.req.query('after') ?? '').trim();
  const [run, n] = asked.split('.');
  const after = asked && run === hubBoot && /^\d+$/.test(n ?? '') ? Number(n) : null;
  return streamSSE(c, async (stream) => {
    const queue: { id: number; data: string }[] = [];
    let wake: (() => void) | null = null;
    // Notices reach the web and Windows apps here, with the main profile's mutes and quiet hours applied.
    const shaped = (ev: ServerEvent): string | null => {
      if (ev.type === 'notify') {
        const n2 = deliverable(ev.n, user.id, 'main', undefined, undefined, !!scope);
        if (!n2) return null;
        ev = { type: 'notify', n: n2 };
      }
      if (!eventInScope(scope, ev)) return null;
      // A scoped sign-in never sees the owner's own "hidden from my list" (Sam keeps their bot).
      if (scope && ev.type === 'bot' && ev.bot.ownerHidden) ev = { type: 'bot', bot: { ...ev.bot, ownerHidden: false } };
      return JSON.stringify(ev);
    };
    // What was missed and the subscription are taken in the same tick, so nothing falls between them.
    const missed = after === null ? null : hub.since(user.id, after);
    const unsub = hub.subscribe(user.id, (ev, id) => {
      const data = shaped(ev);
      if (data === null) return;
      queue.push({ id, data }); wake?.();
    });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now(), resumed: missed !== null, ...webBuild() }), id: `${hubBoot}.${missed?.at(-1)?.id ?? after ?? hub.lastId()}` });
    for (const m of missed ?? []) {
      const data = shaped(m.ev);
      if (data !== null) await stream.writeSSE({ data, id: `${hubBoot}.${m.id}` });
    }
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) { const q = queue.shift()!; await stream.writeSSE({ data: q.data, id: `${hubBoot}.${q.id}` }); }
    }
    unsub();
  });
});

// ---------- notifications (notify.ts) ----------

// The phone's notification link: only notices, already filtered for this profile, plus clears. A
// phone that was away sends `after` (the last id it showed) and gets what it missed from the last
// day, newest 50, before the live ones.
api.get('/notify/stream', (c) => {
  const user = c.get('user');
  const profile = profileOf(c.req.query('profile'));
  const after = Math.max(0, Number(c.req.query('after')) || 0);
  const scope = c.get('scope');
  // An app that can set timers and alarms says so (phone.ts); only it is sent phone actions.
  const caps = String(c.req.query('caps') ?? '').split(',');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => {
      if (ev.type === 'notify') {
        const n = deliverable(ev.n, user.id, profile, undefined, undefined, !!scope);
        if (n && inScope(scope, n.botId)) { queue.push(JSON.stringify({ type: 'notify', n })); wake?.(); }
      } else if (ev.type === 'notify-clear') { queue.push(JSON.stringify(ev)); wake?.(); }
    });
    const unlink = caps.includes('phone1') ? addPhoneLink(user.id, profile, (data) => { queue.push(data); wake?.(); }) : () => {};
    stream.onAbort(() => { unsub(); unlink(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now(), last: lastNoticeId(user.id) }) });
    if (after > 0) {
      const prefs = getPrefs(user.id, profile);
      for (const n0 of noticesAfter(user.id, after)) {
        const n = deliverable(n0, user.id, profile, prefs, undefined, !!scope);
        if (n && !inScope(scope, n.botId)) continue;
        // Caught up later: shown without sound, so a phone coming back online does not ring ten times.
        if (n) await stream.writeSSE({ data: JSON.stringify({ type: 'notify', n: { ...n, silent: true, catchUp: true } }) });
      }
    }
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 25_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
    unlink();
  });
});

// The phone's answer to a phone action (phone.ts): done, needs_tap (it showed a notification to tap) or failed.
api.post('/phone/actions/:id/result', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = db.prepare('SELECT bot_id FROM phone_actions WHERE id=? AND user_id=?').get(id, user.id) as { bot_id: string } | undefined;
  if (!row || !inScope(c.get('scope'), row.bot_id)) return c.json({ error: 'not found' }, 404);
  const ok = phoneResult(user.id, id, await c.req.json().catch(() => null));
  return ok ? c.json({ ok: true }) : c.json({ error: 'That action was already answered.' }, 409);
});

// Chat list AI summaries (list-summary.ts): on/off and the model, from Settings › General.
api.get('/list-summary', async (c) => {
  const user = c.get('user');
  return c.json({ prefs: getSummaryPrefs(user.id), options: await summaryOptions(), lastError: lastSummaryError(user.id) });
});
api.put('/list-summary', async (c) => {
  const user = c.get('user');
  const before = getSummaryPrefs(user.id);
  const prefs = setSummaryPrefs(user.id, await c.req.json().catch(() => ({})));
  if (prefs.on !== before.on) for (const b of listBots(user.id)) emitBot(b.id); // rows switch between summary and message now
  if (prefs.on) sweepSoon();
  return c.json({ prefs });
});
api.get('/notify/prefs', (c) => c.json({ prefs: getPrefs(c.get('user').id, profileOf(c.req.query('profile'))) }));
api.put('/notify/prefs', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ prefs: setPrefs(c.get('user').id, profileOf(c.req.query('profile')), body) });
});
// Recent notices (the web's bell, and a check that delivery works).
api.get('/notify/recent', (c) => {
  const user = c.get('user');
  const profile = profileOf(c.req.query('profile'));
  const prefs = getPrefs(user.id, profile);
  const scope = c.get('scope');
  return c.json({ notices: noticesAfter(user.id, 0, 30).map((n) => deliverable(n, user.id, profile, prefs, undefined, !!scope)).filter((n) => !!n && inScope(scope, n.botId)) });
});

// ---------- paired PCs (machines.ts, docs/remote-pc.md) ----------

machineRoutes(api);

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  // A deleted side chat waiting for Undo takes no messages.
  return b && b.user_id === userId && !b.chat_deleted_at ? b : null;
};

api.get('/bots', (c) => {
  // A scoped sign-in (lib/scope.ts) gets only its own bots: no other bots, groups or their previews.
  const scope = c.get('scope');
  // A bot the owner hid stays in the list with `ownerHidden` (apps leave it out of the home list but still show its
  // face in groups and offer "Show" in settings). A scoped sign-in never sees that mark.
  const bots = listBots(c.get('user').id).filter((b) => inScope(scope, b.id)).map((b) => (scope && b.ownerHidden ? { ...b, ownerHidden: false } : b));
  return c.json({ bots, live: allLive(c.get('user').id).filter((l) => inScope(scope, l.botId)) });
});

api.post('/bots', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || !body.name.trim()) return c.json({ error: 'A bot needs a name.' }, 400);
  for (const k of ['label', 'description', 'instructions'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'string') return c.json({ error: `${k} must be text.` }, 400);
  }
  if (String(body.instructions ?? '').length > 20_000 || String(body.description ?? '').length > 2000 || String(body.label ?? '').length > 80) return c.json({ error: 'That is too long.' }, 400);
  try {
    return c.json({ bot: createBot(c.get('user').id, body) });
  } catch (e: any) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

/**
 * A change to a Bot's settings, checked: only known fields, each of the right kind and a sane length.
 * Returns the clean values (booleans as 0/1), or a sentence saying what is wrong.
 */
function cleanBotPatch(p: Record<string, unknown>): Record<string, string | number> | string {
  const out: Record<string, string | number> = {};
  const text = (k: string, max: number, required = false): string | null => {
    if (p[k] === undefined) return null;
    if (typeof p[k] !== 'string') return `${k} must be text.`;
    const v = (p[k] as string).trim();
    if (required && !v) return 'A name cannot be empty.';
    if (v.length > max) return `That is too long (${max} characters at most).`;
    out[k] = v;
    return null;
  };
  const oneOf = (k: string, allowed: string[]): string | null => {
    if (p[k] === undefined) return null;
    if (typeof p[k] !== 'string' || !allowed.includes(p[k] as string)) return `${k} must be one of: ${allowed.join(', ')}.`;
    out[k] = p[k] as string;
    return null;
  };
  const err = text('name', 60, true) ?? text('label', 80) ?? text('description', 2000) ?? text('instructions', 20_000)
    ?? text('avatarShape', 20, true) ?? text('avatarColor', 20, true) ?? text('voice', 60, true) ?? text('voiceLanguage', 20, true)
    ?? oneOf('mode', ['personal', 'teammate']) ?? oneOf('effort', ['low', 'medium', 'high', 'xhigh']) ?? oneOf('visuals', VISUALS_LEVELS) ?? oneOf('busySend', BUSY_SEND_MODES);
  if (err) return err;
  if (p.pinned !== undefined) {
    if (typeof p.pinned !== 'boolean') return 'pinned must be true or false.';
    out.pinned = p.pinned ? 1 : 0;
  }
  if (p.ownerHidden !== undefined) {
    if (typeof p.ownerHidden !== 'boolean') return 'ownerHidden must be true or false.';
    out.ownerHidden = p.ownerHidden ? 1 : 0;
  }
  if (p.webSearch !== undefined) {
    if (typeof p.webSearch !== 'boolean') return 'webSearch must be true or false.';
    out.webSearch = p.webSearch ? 1 : 0;
  }
  if (p.phoneActions !== undefined) {
    if (typeof p.phoneActions !== 'boolean') return 'phoneActions must be true or false.';
    out.phoneActions = p.phoneActions ? 1 : 0;
  }
  if (p.chatColor !== undefined) {
    // A colour from the chat palette, or null / '' to go back to the picked one.
    if (p.chatColor === null || p.chatColor === '') out.chatColor = '';
    else if (!isChatColor(p.chatColor)) return `chatColor must be one of: ${CHAT_COLOR_ORDER.join(', ')}, or null.`;
    else out.chatColor = p.chatColor as string;
  }
  if (p.voiceSpeed !== undefined) {
    const n = Number(p.voiceSpeed);
    if (typeof p.voiceSpeed !== 'number' || !Number.isFinite(n) || n < 0.5 || n > 2) return 'voiceSpeed must be a number between 0.5 and 2.';
    out.voiceSpeed = n;
  }
  return out;
}

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (b.side_of) return c.json({ error: "A side chat has the bot's settings. Change them on the bot itself." }, 400);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'Nothing to change.' }, 400);
  const checked = cleanBotPatch(raw);
  if (typeof checked === 'string') return c.json({ error: checked }, 400);
  const p: Record<string, string | number> = checked;
  if (p.ownerHidden === 1 && b.is_primary) return c.json({ error: 'Your main bot cannot be hidden. Make another bot your main one first.' }, 400);
  const cols: Record<string, string> = { ownerHidden: 'owner_hidden', name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language', chatColor: 'chat_color', visuals: 'visuals', webSearch: 'web_search', phoneActions: 'phone_actions', busySend: 'busy_send' };
  for (const [k, col] of Object.entries(cols)) {
    if (p[k] === undefined) continue;
    // The chat colour leaves updated_at alone: it is in the picture's address, and the picture did not change.
    if (k === 'chatColor') db.prepare('UPDATE bots SET chat_color=? WHERE id=?').run(p[k] === '' ? null : p[k], b.id);
    // So does hiding it from the owner's view (nothing about the bot itself changes).
    else if (k === 'ownerHidden') db.prepare('UPDATE bots SET owner_hidden=? WHERE id=?').run(p[k], b.id);
    // So does the visuals level (it only changes the bot's prompt).
    else if (k === 'visuals') db.prepare('UPDATE bots SET visuals=? WHERE id=?').run(p[k], b.id);
    // So does what a message sent mid-turn does (steer-mode.ts).
    else if (k === 'busySend') db.prepare('UPDATE bots SET busy_send=? WHERE id=?').run(p[k], b.id);
    // Web search changes the prompt and the bot's tools: a bot the app runs restarts its agent to drop or regain them.
    // Phone timers and alarms change the prompt and the tools: the agent restarts to pick them up, like web search.
    else if (k === 'phoneActions') {
      db.prepare('UPDATE bots SET phone_actions=? WHERE id=?').run(p[k], b.id);
      if (b.kind !== 'room') restartEngine(b.id).catch((e) => console.warn('[engine] restart after phone actions change failed', e?.message ?? e));
    }
    else if (k === 'webSearch') {
      db.prepare('UPDATE bots SET web_search=? WHERE id=?').run(p[k], b.id);
      if (b.kind !== 'room') restartEngine(b.id).catch((e) => console.warn('[engine] restart after web search change failed', e?.message ?? e));
    }
    else db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(p[k], now(), b.id);
  }
  if (b.kind !== 'room') {
    if (['name', 'label', 'description'].some((k) => p[k] !== undefined)) syncPersona(b.id);
    // Its desktop carries its name and colour: dress the screen again, if it has one.
    const looks = ['name', 'label', 'avatarShape', 'avatarColor'].some((k) => p[k] !== undefined);
    if (looks && db.prepare('SELECT 1 FROM screens WHERE bot_id=?').get(b.id)) {
      readyScreen(b.user_id, b.id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
    }
  }
  // A colour change can move the colours picked for the account's other bots (chat-colors.ts).
  if (p.chatColor !== undefined || p.avatarColor !== undefined) for (const x of listBots(b.user_id)) emitBot(x.id);
  else emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

// ---------- looks (pictures, look cards, poses): avatars.ts ----------

lookRoutes(api, ownBot);

api.delete('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (b.side_of) return c.json({ error: 'Delete a side chat with DELETE /api/side-chats/<id>.' }, 400);
  interrupt(b.id, { quiet: true });
  // Its side chats go with it (stopped first, so nothing is left running on an engine about to go).
  for (const sc of db.prepare('SELECT id FROM bots WHERE side_of=?').all(b.id) as { id: string }[]) interrupt(sc.id, { quiet: true });
  removeSideChatsOf(b.id);
  for (const r of listRoutines(b.id)) {
    unscheduleRoutine(r.id);
    await deleteEventTrigger(r.id).catch(() => {});
  }
  if (b.kind !== 'room') {
    await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
    await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
  }
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  forgetLooks(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  // Deleting the main Bot hands the role to the oldest remaining eligible one, so check-ins keep running.
  if (b.is_primary) {
    const next = (db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent')='agent' AND COALESCE(hidden,0)=0 ORDER BY created_at").all(b.user_id) as { id: string }[])
      .find((x) => !isSilo(x.id) && !isOutside(x.id));
    if (next) db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(next.id, b.user_id);
  }
  // It leaves every group it was in, so their member lists and counts stay true.
  if (b.kind !== 'room') {
    for (const room of db.prepare("SELECT id, members, description FROM bots WHERE user_id=? AND kind='room'").all(b.user_id) as { id: string; members: string | null; description: string | null }[]) {
      let ids: string[] = [];
      try { ids = room.members ? JSON.parse(room.members) as string[] : []; } catch { /* unreadable list: leave it */ }
      if (!ids.includes(b.id)) continue;
      const next = ids.filter((id) => id !== b.id);
      const about = /^Group chat with \d+ Bots$/.test(String(room.description ?? '').trim()) ? `Group chat with ${next.length} Bots` : room.description;
      db.prepare('UPDATE bots SET members=?, description=?, updated_at=? WHERE id=?').run(JSON.stringify(next), about, now(), room.id);
      appendRow(room.id, 'event', { type: 'event', event: 'bot-message', text: `${b.name} left` });
    }
  }
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  // The primary runs the check-ins, so it must be one of your own Bots: not a group, a walled-off Bot or an outside member.
  if (b.kind === 'room' || isSilo(b.id) || isOutside(b.id)) return c.json({ error: 'Only one of your own Bots can be the main Bot.' }, 400);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  const limit = Number(c.req.query('limit') ?? 200);
  if ((beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) || !Number.isInteger(limit) || limit < 1) return c.json({ error: 'beforeSeq and limit must be whole numbers of at least 1.' }, 400);
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit }) });
});

/**
 * Runs a chat's message hand-offs one after another. A message with attachments waits for its files to be
 * read; a later message in the same chat waits for it, so the bot always hears them in order. With nothing
 * waiting and no files, the hand-off runs straight away, as before.
 */
const handoffs = new Map<string, Promise<void>>();
function inOrder(chatId: string, slow: boolean, job: () => Promise<void> | void) {
  const prev = handoffs.get(chatId);
  if (!prev && !slow) { try { const r = job(); if (r) r.catch((e) => console.error('[messages] hand-off failed', e)); } catch (e) { console.error('[messages] hand-off failed', e); } return; }
  const next = (prev ?? Promise.resolve()).then(job).catch((e) => console.error('[messages] hand-off failed', e));
  handoffs.set(chatId, next);
  void next.then(() => { if (handoffs.get(chatId) === next) handoffs.delete(chatId); });
}

/** Messages an app named with a clientId, for a while: a retry of the same send answers the row that is already there. */
const recentSends = new Map<string, { generation: number; seq: number; at: number }>();

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const sent = await c.req.json<{ text?: unknown; editOf?: unknown; attachments?: unknown; clientId?: unknown }>().catch(() => ({} as { text?: unknown; editOf?: unknown; attachments?: unknown; clientId?: unknown }));
  const text = typeof sent.text === 'string' ? sent.text : '';
  // Pictures and files sent with the message (chat-extras.ts); a message may be only attachments.
  const attached = checkAttachments(b.id, sent.attachments);
  if (!attached.ok) return c.json({ error: attached.error }, 400);
  if (!text.trim() && !attached.files.length) return c.json({ error: 'empty' }, 400);
  // An app that sends a message again after a dropped connection names it with the same clientId: the
  // message that already arrived is answered, so a retry can never post it twice.
  const clientId = typeof sent.clientId === 'string' && sent.clientId.length <= 80 ? `${b.id}:${sent.clientId}` : null;
  const dup = clientId ? recentSends.get(clientId) : undefined;
  if (dup && dup.generation === b.generation) { const row = getRow(b.id, dup.seq); if (row) return c.json({ row, duplicate: true }); }
  if (text.length > 200_000) return c.json({ error: 'That message is too long to send. Attach it as a file instead.' }, 413);
  // A script's message (a Claude thread, a test) is shown as its own, never as the person's, and the bot
  // is told who sent it. It is still the person's account, so the bot may act on it, but it is not an approval.
  const agent = c.get('agent');
  // An edit of one of your own messages (message-edit.ts): sent as a new message, the old one marked Edited.
  const editing = sent.editOf !== undefined && sent.editOf !== null;
  if (editing && agent) return c.json({ error: `Only a person can edit their messages. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const edit = editing ? checkEdit(b.id, sent.editOf, text) : null;
  if (edit && !edit.ok) return c.json({ error: edit.error }, edit.status);
  const from: MessageBody['from'] | undefined = agent ? { kind: 'agent', id: 'session', name: agent } : undefined;
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: text.trim(), ...(from ? { from } : {}), ...(edit?.ok ? { editOf: sent.editOf as number } : {}), ...(attached.files.length ? { attachments: attached.files } : {}) });
  if (clientId) { recentSends.set(clientId, { generation: row.generation, seq: row.seq, at: Date.now() }); if (recentSends.size > 2000) for (const [k, v] of recentSends) if (Date.now() - v.at > 15 * 60_000) recentSends.delete(k); }
  if (edit?.ok) markEdited(b.id, sent.editOf as number, edit.original, row.seq);
  // A side chat without a name is named from the first thing said in it (side-chats.ts).
  if (b.side_of) autoTitle(b.id, text.trim() || attached.files[0]?.name || 'Files');
  const lead = agent ? `${agentNote(agent, c.get('user').name)}\n` : edit?.ok ? `${editNote(edit.original)}\n` : '';
  const said = `${lead}${text.trim()}`;
  // Attached documents are read on this machine first (attachmentNote), which can take a few seconds, so
  // the bot is told after that; the chat's messages still reach it in the order they were sent.
  // Who the bot is told a steering note is from (steer-mode.ts): the person signed in, Alex or Sam.
  const owner = displayName(c.get('user'), currentSession(c)?.person ?? null);
  inOrder(b.id, attached.files.length > 0, async () => {
    // Group chats dispatch to their member Bots instead of running their own loop. Each member that
    // answers gets its own copy of the files, read for it the same way.
    if (b.kind === 'room') {
      const mode = busySendFor(b.id);
      // Interrupt: the group's members stop what they are doing for the group, then hear the new message.
      if (mode === 'interrupt') interrupt(b.id);
      // Steer: a member already answering this group takes the message into that answer. A message with
      // files goes out as usual, so each member gets its own copy of them.
      const steer = mode === 'steer' && !attached.files.length
        ? (memberId: string, roomId: string, roomName: string) => steerRoomMember(memberId, { id: roomId, name: roomName }, row.seq, said, owner,
          () => { void dispatchRoomMessage(roomId, said, enqueue, agent, undefined, { only: [memberId] }); })
        : undefined;
      await dispatchRoomMessage(b.id, said, enqueue, agent, attached.files.length ? { files: attached.files, note: (memberId, files, problems) => attachmentNote(memberId, files, { group: b.name, problems }) } : undefined, { steer });
      return;
    }
    const problems: string[] = [];
    const note = await attachmentNote(b.id, attached.files, { problems });
    // A file the bot is not given in full is said in the chat, so it is never lost quietly.
    if (problems.length) appendRow(b.id, 'notice', { type: 'notice', text: `${b.name} could not read ${problems.join(', ')}.`, tone: 'warn' });
    const images = imagePaths(b.id, attached.files);
    // Any pending question card is answered by a free-text message. While the bot works, the message
    // steers that reply, waits its turn, or stops it, by the bot's setting (steer-mode.ts).
    sendFromOwner(b.id, { type: 'user', text: [said, note].filter((x) => x.trim()).join('\n\n'), agent, ...(images.length ? { images } : {}) }, row.seq, owner);
  });
  return c.json({ row: getRow(b.id, row.seq) ?? row });
});

// React to a Bot's message with an emoji, or take the reaction back (a toggle): { emoji }.
// The Bot that wrote it is told on its next turn, as feedback only: a reaction is never an approval.
// A script signed in to the account (a Claude thread, a test) cannot react for the person.
api.post('/bots/:id/rows/:seq/reactions', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const agent = c.get('agent');
  if (agent) return c.json({ error: `Only a person can react to messages. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const { emoji } = await c.req.json<{ emoji: string }>().catch(() => ({ emoji: '' }));
  const r = personReact(b.id, Number(c.req.param('seq')), emoji, displayName(c.get('user'), currentSession(c)?.person ?? null));
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, reactions: r.reactions, added: r.added });
});

// ---------- side chats (side-chats.ts) ----------
// A side chat is read and written like any chat with its own id (/bots/<id>/rows, /messages, /interrupt,
// /fresh, /read, cards and approvals); these routes list, make, rename, delete and undelete them.

api.get('/bots/:id/side-chats', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || b.side_of) return c.json({ error: 'not found' }, 404);
  return c.json({ chats: sideChatsAllowed(b) ? [] : listSideChats(b.id), allowed: !sideChatsAllowed(b), why: sideChatsAllowed(b) });
});

api.post('/bots/:id/side-chats', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({} as { title?: unknown }));
  const r = createSideChat(b.id, body?.title);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  return c.json({ chat: r });
});

api.patch('/side-chats/:id', async (c) => {
  const sc = ownSideChat(c.get('user').id, c.req.param('id'));
  if (!sc) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({} as { title?: unknown }));
  const err = renameSideChat(sc.id, body?.title);
  if (err) return c.json({ error: err }, 400);
  return c.json({ ok: true, chats: listSideChats(sc.side_of) });
});

// Delete: the side chat stops and leaves the list at once; POST .../restore brings it back for 10 minutes.
api.delete('/side-chats/:id', (c) => {
  const sc = ownSideChat(c.get('user').id, c.req.param('id'));
  if (!sc) return c.json({ error: 'not found' }, 404);
  interrupt(sc.id, { quiet: true });
  deleteSideChat(sc.id);
  return c.json({ ok: true, undoUntil: now() + SIDE_UNDO_MS });
});

api.post('/side-chats/:id/restore', (c) => {
  const sc = ownSideChat(c.get('user').id, c.req.param('id'), true);
  if (!sc) return c.json({ error: 'not found' }, 404);
  const err = restoreSideChat(sc.id);
  if (err) return c.json({ error: err }, 409);
  return c.json({ ok: true, chats: listSideChats(sc.side_of) });
});

// ---------- outside members (outside.ts, slack-link.ts) ----------

api.get('/bots/:id/exchanges', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !isOutside(b.id)) return c.json({ error: 'not found' }, 404);
  const limit = Math.floor(Number(c.req.query('limit') ?? 100));
  return c.json({ exchanges: listExchanges(b.id, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100), error: linkError() });
});

api.post('/bots/:id/link', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !isOutside(b.id)) return c.json({ error: 'not found' }, 404);
  const { paused } = await c.req.json<{ paused: boolean }>().catch(() => ({ paused: false }));
  setPaused(b.id, !!paused);
  return c.json({ ok: true });
});

// Stop the bot's running turn. In a group chat this stops every member answering the group's messages,
// or only one with { member: botId }; the reply lists who was stopped (agent/room-runs.ts).
api.post('/bots/:id/interrupt', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ member?: unknown }>().catch(() => ({} as { member?: unknown }));
  const member = typeof body?.member === 'string' && body.member ? body.member : undefined;
  if (member && b.kind !== 'room') return c.json({ error: 'Only a group chat has members to stop.' }, 400);
  const stopped = interrupt(b.id, { member });
  return c.json({ ok: true, stopped });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id, { quiet: true });
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// Undo "New conversation" (store.ts restoreConversation): 409 with the reason when it can't be undone.
api.post('/bots/:id/fresh/undo', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const r = restoreConversation(b.id);
  if (!r.ok) return c.json({ error: r.reason }, 409);
  emitBot(b.id);
  return c.json({ ok: true, generation: r.generation });
});

// Answer an approval card. The answer is read back: the reply is the approval as it now stands.
// Every client must send the card's digest, so it can only approve the action it
// showed, "Always allow" included. "Always allow" makes a rule for that bot and the card's tools only
// (allow-rules.ts). A wrong digest or an approval that is no longer pending is answered with 409 and
// the approval's state.
// Only signed-in people reach this route; bots use /mcp and can never answer a card.
api.post('/approvals/:id', async (c) => {
  // A script signed in to the account (a Claude thread, a test) can never answer a card for the person.
  const agent = c.get('agent');
  if (agent) return c.json({ error: `Only a person can answer approval cards. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const { decision, digest } = await c.req.json<{ decision: 'allow' | 'always' | 'deny'; digest?: string }>().catch(() => ({ decision: '' as 'deny', digest: undefined }));
  if (!['allow', 'always', 'deny'].includes(decision)) return c.json({ error: 'decision must be allow, always or deny' }, 400);
  if (digest !== undefined && typeof digest !== 'string') return c.json({ error: 'digest must be a string' }, 400);
  if (!digest) return c.json({ error: 'digest required' }, 400);
  const user = c.get('user');
  const via = c.get('client') === 'bearer' ? (c.req.header('x-cleft-via') === 'notification' ? 'phone notification' : 'phone app') : /Electron|CleftBot/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web';
  try {
    const approval = resolveApproval(user.id, c.req.param('id'), decision, digest, { by: displayName(user, currentSession(c)?.person ?? null), via });
    return c.json({ ok: true, approval });
  } catch (e) {
    if (e instanceof ApprovalError && e.code !== 'not_found') return c.json({ error: e.message, code: e.code, approval: e.approval }, 409);
    return c.json({ error: 'not found' }, 404);
  }
});

/**
 * Answer a posting plan card (posting.ts): the days the person left switched on, and Approve or Always
 * allow. Only from the apps (never a notification), only by a person, and only for days on the card.
 */
api.post('/approvals/:id/plan', async (c) => {
  const agent = c.get('agent');
  if (agent) return c.json({ error: `Only a person can answer this card. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const sent = await c.req.json<{ days?: unknown; digest?: unknown; decision?: unknown }>().catch(() => ({} as { days?: unknown; digest?: unknown; decision?: unknown }));
  if (typeof sent.digest !== 'string' || !sent.digest) return c.json({ error: 'digest required' }, 400);
  const days = Array.isArray(sent.days) ? sent.days.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14) : [];
  if (!days.length) return c.json({ error: 'Switch on at least one day, or press Don\'t post.' }, 400);
  const decision = sent.decision === 'always' ? 'always' : 'allow';
  if (c.req.header('x-cleft-via') === 'notification') return c.json({ error: 'Open the chat to answer this card.' }, 409);
  const user = c.get('user');
  const via = c.get('client') === 'bearer' ? 'phone app' : /Electron|CleftBot/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web';
  const id = c.req.param('id');
  const tool = (db.prepare('SELECT tool FROM approvals WHERE id=?').get(id) as { tool?: string } | undefined)?.tool;
  if (tool !== 'posting_plan') return c.json({ error: 'not found' }, 404);
  handPlanDays(id, days);
  try {
    const approval = resolveApproval(user.id, id, decision, sent.digest, { by: displayName(user, currentSession(c)?.person ?? null), via, withPlan: true });
    return c.json({ ok: true, approval });
  } catch (e) {
    if (e instanceof ApprovalError && e.code !== 'not_found') return c.json({ error: e.message, code: e.code, approval: e.approval }, 409);
    return c.json({ error: 'not found' }, 404);
  }
});

/**
 * Answer a secure input card (browser-cards.ts) with the value the person typed. The value is handed to the
 * waiting tool in memory and typed into the bot's browser; it is never stored, logged or put on the card.
 * Same rules as /approvals/:id (a person, the card's digest), and only from the apps, never a notification.
 */
api.post('/approvals/:id/secret', async (c) => {
  const agent = c.get('agent');
  if (agent) return c.json({ error: `Only a person can answer this card. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const sent = await c.req.json<{ value?: unknown; digest?: unknown }>().catch(() => ({} as { value?: unknown; digest?: unknown }));
  if (typeof sent.digest !== 'string' || !sent.digest) return c.json({ error: 'digest required' }, 400);
  if (c.req.header('x-cleft-via') === 'notification') return c.json({ error: 'Open the chat to answer this card.' }, 409);
  const user = c.get('user');
  const via = c.get('client') === 'bearer' ? 'phone app' : /Electron|CleftBot/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web';
  const id = c.req.param('id');
  const apRow = db.prepare('SELECT tool, bot_id, row_seq FROM approvals WHERE id=?').get(id) as { tool?: string; bot_id: string; row_seq: number } | undefined;
  if (apRow?.tool !== 'secure_input') return c.json({ error: 'not found' }, 404);
  // A server key (drive-pull.ts) is a whole JSON file; page fields take up to 512 characters.
  const cardRow = getRow(apRow.bot_id, apRow.row_seq);
  const max = (cardRow?.body as any)?.secret?.kind === 'service_key' ? 8192 : 512;
  if (typeof sent.value !== 'string' || !sent.value.length || sent.value.length > max) return c.json({ error: `Type a value (up to ${max} characters).` }, 400);
  handSecret(id, sent.value);
  sent.value = '';
  try {
    const approval = resolveApproval(user.id, id, 'allow', sent.digest, { by: displayName(user, currentSession(c)?.person ?? null), via, withSecret: true });
    return c.json({ ok: true, approval });
  } catch (e) {
    dropSecret(id);
    if (e instanceof ApprovalError && e.code !== 'not_found') return c.json({ error: e.message, code: e.code, approval: e.approval }, 409);
    return c.json({ error: 'not found' }, 404);
  }
});

/**
 * The card a request names, refused when it is from an earlier conversation: "New conversation" starts the
 * numbering again, so a tab left open on the old chat names a card by a number that now means another
 * card. Clients send the conversation (generation) the card belongs to. A card that was already handled
 * is refused by each route, all in one synchronous step after the request body has been read.
 */
function cardFor(c: any, botId: string, generation: number): Row | 'stale' | null {
  const g = c.req.query('generation');
  if (g !== undefined && Number(g) !== generation) return 'stale';
  return getRow(botId, Number(c.req.param('seq')));
}
const staleCard = (c: any) => c.json({ error: 'This card is from an earlier conversation. Reload the chat.', code: 'stale_card' }, 409);

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const sent = await c.req.json<{ answer?: unknown }>().catch(() => ({} as { answer?: unknown }));
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  if (row.body.status !== 'pending') return c.json({ error: 'This question was already answered.' }, 409);
  const answer = typeof sent.answer === 'string' ? sent.answer.trim().slice(0, 4000) : '';
  if (!answer) return c.json({ error: 'Pick or type an answer.' }, 400);
  const agent = c.get('agent');
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer, ...(agent ? { from: { kind: 'agent' as const, id: 'session', name: agent } } : {}) });
  enqueue(b.id, { type: 'user', agent, text: `${agent ? `${agentNote(agent, c.get('user').name)}\n` : ''}[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

/**
 * A person's change to an answer view (views.ts): tick, pick, type, or Send. A Send posts an ordinary chat
 * message as the person (a script's is labelled as its own), so the bot acts on it like anything typed and
 * every action still meets approval cards. Bots use /mcp and never reach this route.
 */
api.post('/bots/:id/cards/:seq/view', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const op = await c.req.json<any>().catch(() => null);
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card' || row.body.card !== 'view') return c.json({ error: 'not a view' }, 400);
  let out: ReturnType<typeof applyViewOp>;
  const user = c.get('user');
  try { out = applyViewOp(row.body, op, displayName(user, currentSession(c)?.person ?? null)); } catch (e) {
    if (e instanceof ViewError) return c.json({ error: e.message }, e.status as 400 | 409);
    throw e;
  }
  const updated = updateRow(b.id, row.seq, out.card);
  if (out.message) {
    const agent = c.get('agent');
    const from: MessageBody['from'] | undefined = agent ? { kind: 'agent', id: 'session', name: agent } : undefined;
    // Choice buttons in a group answer the bot that asked, so the reply @mentions it (as Reply does).
    const asker = b.kind === 'room' && row.body.quick && row.body.from ? `@${row.body.from.name} ` : '';
    appendRow(b.id, 'message', { type: 'message', role: 'user', text: asker + out.message, ...(from ? { from } : {}) });
    const told = asker + (out.context ?? out.message);
    const said = agent ? `${agentNote(agent, c.get('user').name)}\n${told}` : told;
    if (b.kind === 'room') dispatchRoomMessage(b.id, said, enqueue, agent);
    else enqueue(b.id, { type: 'user', text: said, agent });
  }
  return c.json({ ok: true, row: updated });
});

/**
 * Pin or unpin a board (board-pin.ts) from its card or the dock above the message box. Saved on the card, so
 * every device shows the same; a person's unpin sticks until someone pins it again. Never an approval.
 */
api.post('/bots/:id/cards/:seq/pin', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<any>().catch(() => null);
  if (typeof body?.on !== 'boolean') return c.json({ error: 'on must be true or false' }, 400);
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card' || row.body.card !== 'view' || row.body.quick) return c.json({ error: 'not a board' }, 400);
  const updated = updateRow(b.id, row.seq, withPin(row.body, { person: body.on, now: Date.now() }));
  return c.json({ ok: true, row: updated });
});

/**
 * Open as Page: a person turns an answer view into a Page in the bot's workspace, with what they already
 * did kept, to keep editing it with the bot. Once made, the card points at it and this only answers its path.
 */
api.post('/bots/:id/cards/:seq/page', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (b.kind === 'room') return c.json({ error: 'Open the Page from the Bot that made it.' }, 400);
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card' || row.body.card !== 'view') return c.json({ error: 'not a view' }, 400);
  if (row.body.pagePath) return c.json({ ok: true, path: row.body.pagePath });
  const user = c.get('user');
  const agent: string | null = c.get('agent') ?? null;
  const name = agent || displayName(user, currentSession(c)?.person ?? null) || 'You';
  // A side chat is the same bot: the Page goes in the bot's own workspace, and remembers the chat it came from.
  const made = createPage(chatOwner(b.id), { title: row.body.title || 'From the chat', blocks: viewToPageBlocks(row.body) }, { kind: 'person', id: agent ? `${user.id}:script:${agent}` : user.id, name });
  notePageOrigin(b.id, made.page.id, { kind: 'view', seq: row.seq });
  updateRow(b.id, row.seq, { ...row.body, pagePath: made.path });
  return c.json({ ok: true, path: made.path });
});

/**
 * Save a group skill a member proposed (card 'skill-proposal'), as shown or as the person edited it.
 * Signed-in people only: a bot never reaches this route, so a proposal is never saved by a bot.
 */
api.post('/bots/:id/cards/:seq/save-skill', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const agent = c.get('agent');
  if (agent) return c.json({ error: `Only a person can save a proposed skill. This sign-in belongs to ${agent}.`, code: 'agent_session' }, 403);
  const p = await c.req.json<{ name?: string; description?: string; body?: string }>().catch(() => ({} as { name?: string; description?: string; body?: string }));
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card' || row.body.card !== 'skill-proposal') return c.json({ error: 'not a skill proposal' }, 400);
  if (row.body.status !== 'pending') return c.json({ error: 'This proposal was already handled.' }, 409);
  const name = String(p.name ?? row.body.name).trim().slice(0, 80);
  const body = String(p.body ?? row.body.body).trim().slice(0, 20_000);
  const description = String(p.description ?? row.body.description).trim().slice(0, 300);
  if (!name || !body) return c.json({ error: 'The skill needs a name and steps.' }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, name, body, description, Date.now(), Date.now());
  updateRow(b.id, row.seq, { ...row.body, name, description, body, skillId: id, status: 'saved' });
  appendRow(b.id, 'event', { type: 'event', event: 'bot-message', text: `Saved group skill “${name}”` });
  enqueue(row.body.fromBotId, { type: 'system', text: `A person saved your proposed group skill "${name}" in ${b.name}. Everyone in that group now follows it there.` });
  return c.json({ ok: true, skillId: id });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = cardFor(c, b.id, b.generation);
  if (row === 'stale') return staleCard(c);
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  // Only cards that have a "skip" of their own. An approval is answered through /approvals (Deny), so
  // the waiting tool hears about it; a plugin plan through /plugins/drafts; the rest have nothing to dismiss.
  if (!['question', 'connect', 'skill-proposal', 'look'].includes(row.body.card)) return c.json({ error: 'This card cannot be dismissed.' }, 400);
  // A card already answered, saved, skipped or chosen keeps its outcome.
  if (['answered', 'saved', 'skipped', 'connected', 'applied', 'dismissed'].includes((row.body as any).status)) return c.json({ error: 'This card was already handled.' }, 409);
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const sent = await c.req.json<{ enabled?: unknown; quiet?: unknown }>().catch(() => ({} as { enabled?: unknown; quiet?: unknown }));
  if (sent.enabled === undefined && sent.quiet === undefined) return c.json({ error: 'Send enabled or quiet.' }, 400);
  if (sent.enabled !== undefined && typeof sent.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false.' }, 400);
  if (sent.quiet !== undefined && typeof sent.quiet !== 'boolean') return c.json({ error: 'quiet must be true or false.' }, 400);
  if (typeof sent.quiet === 'boolean') db.prepare('UPDATE routines SET quiet=? WHERE id=?').run(sent.quiet ? 1 : 0, r.id);
  if (typeof sent.enabled === 'boolean') db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(sent.enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  if (typeof sent.enabled === 'boolean') sent.enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  await deleteEventTrigger(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  const scope = c.get('scope');
  return c.json({ tasks: rows.filter((r) => inScope(scope, r.bot_id)).map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ memories: listMemories(b.id) });
});

api.delete('/memories/:id', (c) => {
  const botId = memoryBot(c.req.param('id'));
  if (!botId || !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  deleteMemory(c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- computer ----------

api.get('/computer', async (c) => c.json({ computer: await refreshComputer(c.get('user').id) }));

api.post('/computer/ensure', (c) => {
  const userId = c.get('user').id;
  ensureComputer(userId).catch((e) => console.warn('[computer] ensure failed', e.message));
  return c.json({ computer: computerState(userId) });
});

api.post('/computer/suspend', async (c) => {
  await suspendComputer(c.get('user').id);
  return c.json({ computer: computerState(c.get('user').id) });
});

api.get('/bots/:id/screenshot', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(b.id) as any;
  if (!env.orgoComputerId || computerState(user.id).status !== 'running' || !scr) return c.body(null, 204);
  try {
    const s = await orgo.screenshot(env.orgoComputerId, scr.screen_id);
    const b64 = s.image.replace(/^data:[^,]+,/, '');
    return c.body(Buffer.from(b64, 'base64'), 200, { 'Content-Type': s.mime_type ?? 'image/jpeg', 'Cache-Control': 'no-store' });
  } catch {
    return c.body(null, 204);
  }
});

// ---------- apps (local MCP servers from apps.json) ----------

/** The local apps and whether each is running, in the shape the web app's app list expects. */
api.get('/apps', async (c) => {
  const search = (c.req.query('search') ?? '').toLowerCase();
  const { apps, configFile, error } = await appsStatus();
  const all: Toolkit[] = apps.map((a) => ({
    slug: a.id,
    name: a.name,
    logo: a.logo,
    description: a.status === 'ready' ? `${a.description ? `${a.description} · ` : ''}${a.tools} tools`
      : a.status === 'disabled' ? 'Turned off in apps.json'
      : `Not running${a.error ? `: ${a.error}` : ''}`,
    categories: [],
    managedAuth: false,
    noAuth: true,
    connected: a.status === 'ready',
    status: a.status,
  }));
  const items = search ? all.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search)) : all;
  const connectedApps = all.filter((t) => t.connected);
  return c.json({ apps: items, connected: connectedApps.map((t) => t.slug), connectedApps, categories: [], total: items.length, configFile, error });
});

// Apps are added and removed in apps.json on the server, not from the browser.
const notHere = (c: Context) => c.json({ error: 'Apps are set up in apps.json on the server. See docs/local-apps.md.' }, 400);
api.post('/apps/:slug/connect', notHere);
api.delete('/apps/:slug', notHere);

// "Always allow" rules (allow-rules.ts): list them, see what they let through, remove one. Made only
// from an approval card; there is no route to create or widen one directly.
api.get('/allow-rules', (c) => {
  const botId = c.req.query('botId') || undefined;
  if (botId && !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  return c.json({ rules: listRules(c.get('user').id, botId), log: ruleLog(c.get('user').id, botId, 30), freeRun: freeRunList(c.get('user').id, botId) });
});

/** The maintainer bots this person owns and whether each runs terminal commands without a card. */
function freeRunList(userId: string, botId?: string) {
  const bots = db.prepare(`SELECT id, name FROM bots WHERE user_id=? AND kind != 'room' ${botId ? 'AND id=?' : ''} ORDER BY name COLLATE NOCASE`).all(...(botId ? [userId, botId] : [userId])) as { id: string; name: string }[];
  return bots.filter((b) => isMaintainer(b.id)).map((b) => ({ botId: b.id, botName: b.name, on: freeTerminal(b.id), canChange: isOwner(userId) }));
}

/**
 * The owner's master switch for the maintainer bot's free-run (maintainer-guard.ts): on, every terminal
 * command runs without a card; off, the per-command guard is back. Only a signed-in person who owns the
 * server; a script session or a bot token never reaches it.
 */
api.put('/bots/:id/free-terminal', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can change this.' }, 403);
  if (c.get('agent')) return c.json({ error: 'Only a person can change this.' }, 403);
  if (!isMaintainer(b.id)) return c.json({ error: `${b.name} is not the maintainer bot.` }, 409);
  const { on } = await c.req.json<{ on?: boolean }>().catch(() => ({} as { on?: boolean }));
  setFreeTerminal(b.id, on === true);
  const who = displayName(user);
  maintainerAudit(String(who), 'free-run', on === true ? 'on' : 'off', `${b.name}'s terminal commands ${on === true ? 'run without a card' : 'ask again per command'}`);
  console.log(`[maintainer] ${user.id} turned ${on === true ? 'on' : 'off'} free-run for ${b.name}`);
  return c.json({ ok: true, on: on === true });
});
/**
 * The publish hold for a bot's browser (posting.ts): on, every Post / Share / Schedule press on social sites
 * waits for a posting plan the person approved. Anyone signed in to the owner's account may turn it on;
 * only a person who owns the server may turn it off.
 */
api.put('/bots/:id/publish-guard', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { on } = await c.req.json<{ on?: boolean }>().catch(() => ({} as { on?: boolean }));
  if (on !== true && (c.get('agent') || !isOwner(user.id))) return c.json({ error: 'Only the owner, in person, can turn the publish hold off.' }, 403);
  setPublishGuard(b.id, on === true);
  console.log(`[posting] ${c.get('agent') ?? user.id} turned the publish hold ${on === true ? 'on' : 'off'} for ${b.name}`);
  return c.json({ ok: true, on: on === true });
});
api.delete('/allow-rules/:id', (c) => (deleteRule(c.get('user').id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);
