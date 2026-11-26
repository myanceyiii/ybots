// Sign-in without a server command: Cloudflare Access identity and "Sign in another device".
// Usage: npm run build -w server && node tests/sign-in.mjs
// Starts server/dist/index.js on a free port with made-up keys and a database in a temp folder, and
// a stand-in for the Access team's certs endpoint signed with a key made here. Nothing leaves this machine.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const ENTRY = path.join(ROOT, 'server/dist/index.js');
if (!fs.existsSync(ENTRY)) throw new Error('server/dist/index.js is missing: run `npm run build -w server` first');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-signin-'));
const SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = 'https://hq.example.test';
const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-of-this-app';
const LISTED = 'listed@example.test';
const OTHER = 'stranger@example.test';

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push({ ok: true }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ ok: false }); console.log(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
};
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ---------- a stand-in Access team: one signing key, published as JWKS ----------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-1';
let certsHits = 0;
const certs = http.createServer((q, res) => {
  certsHits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] }));
});
await new Promise((r) => certs.listen(0, '127.0.0.1', r));
const CERTS = `http://127.0.0.1:${certs.address().port}/cdn-cgi/access/certs`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims = {}, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const body = { iss: TEAM, aud: [AUD], email: LISTED, iat: t, nbf: t, exp: t + 3600, sub: 'x', type: 'app', ...claims };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const head = b64({ alg, kid, typ: 'JWT' });
  const data = `${head}.${b64(body)}`;
  const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
  return `${data}.${sig}`;
}

// ---------- the server ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let child = null, log = '';
async function start(extra = {}) {
  await stop();
  log = '';
  child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/no-outbound.mjs'), ENTRY], {
    cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '', HOME: TMP, NODE_ENV: 'test', PORT: String(PORT), HOST: '127.0.0.1', SESSION_SECRET: SECRET,
      DB_PATH: path.join(TMP, 'hq.db'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(TMP, 'hermes'),
      HERMES_BIN: path.join(TMP, 'no-hermes'), ENGINES_DIR: path.join(TMP, 'engines'), ENGINE_PORT_BASE: String(await freePort()),
      MAX_BOTS: '20', CLEFTBOT_NO_SCHEDULER: '1', COMPUTER: 'local', HQ_NO_SCREENS: '1',
      APP_URL: PUBLIC_URL, SERVER_URL: PUBLIC_URL, ALLOWED_EMAILS: LISTED,
      CF_ACCESS_TEAM_DOMAIN: 'team', CF_ACCESS_AUD: AUD, CF_ACCESS_CERTS_URL: CERTS, CF_ACCESS_APP_URL: 'https://cleft.example.test/',
      ...extra,
    },
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stop() {
  if (!child) return;
  const c = child; child = null;
  if (c.exitCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); }
}

const req = (p, { cookie, headers, body, method } = {}) => fetch(`${BASE}${p}`, {
  method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const sessionOf = (res) => cookiesOf(res).find((c) => c.startsWith('cleftbot_session=') && c !== 'cleftbot_session=');
const meWith = async (headers, cookie) => { const r = await req('/api/auth/me', { headers, cookie }); return { res: r, body: await r.json() }; };
const access = (t) => ({ 'cf-access-jwt-assertion': t });
const hmac = (what) => crypto.createHmac('sha256', SECRET).update(what).digest('hex');

try {
  await start();

  await step('Access: an allowed person is signed in by opening the app', async () => {
    const { res, body } = await meWith(access(jwt()));
    eq(body.user?.email, LISTED, 'user');
    const s = sessionOf(res);
    if (!s) throw new Error('no session cookie');
    eq((await req('/api/bots', { cookie: s })).status, 200, 'the session works');
  });

  await step('Access: tokens that must not sign anyone in', async () => {
    const t = Math.floor(Date.now() / 1000);
    const bad = {
      'no header': undefined,
      'garbage': 'not.a.jwt',
      'another key': jwt({}, { key: other.privateKey }),
      'unknown kid': jwt({}, { kid: 'nope' }),
      'alg none': jwt({}, { alg: 'none' }),
      'another app (aud)': jwt({ aud: ['someone-else'] }),
      'another team (iss)': jwt({ iss: 'https://evil.cloudflareaccess.com' }),
      'expired': jwt({ exp: t - 3600, nbf: t - 7200, iat: t - 7200 }),
      'not yet valid': jwt({ nbf: t + 3600 }),
      'service token (no email)': jwt({ email: undefined, common_name: 'svc.access' }),
      'tampered claims': (() => { const [h, , s] = jwt().split('.'); return `${h}.${b64({ iss: TEAM, aud: [AUD], email: LISTED, exp: t + 3600 })}.${s}`; })(),
    };
    for (const [what, tok] of Object.entries(bad)) {
      const { res, body } = await meWith(tok === undefined ? {} : access(tok));
      eq(body.user, null, `${what}: user`);
      eq(sessionOf(res), undefined, `${what}: cookie`);
    }
  });

  await step('Access: a person not on ALLOWED_EMAILS is told so and not signed in', async () => {
    const { res, body } = await meWith(access(jwt({ email: OTHER })));
    eq(body.user, null, 'user');
    eq(body.signIn?.accessRefused, OTHER, 'refused');
    eq(sessionOf(res), undefined, 'cookie');
  });

  await step('Access: after Log out the browser waits for Continue instead of signing straight back in', async () => {
    const s = sessionOf((await meWith(access(jwt()))).res);
    const out = await req('/api/auth/logout', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } });
    eq(out.status, 200, 'logout');
    const flag = cookiesOf(out).find((c) => c.startsWith('cleftbot_signed_out='));
    if (!flag) throw new Error('no signed-out cookie');
    const { res, body } = await meWith(access(jwt()), flag);
    eq(body.user, null, 'not signed back in');
    eq(body.signIn?.accessReady, true, 'offers Continue');
    eq(sessionOf(res), undefined, 'cookie');
    const cont = await req('/api/auth/access', { method: 'POST', cookie: flag, headers: { ...access(jwt()), origin: PUBLIC_URL } });
    eq(cont.status, 200, 'continue');
    if (!sessionOf(cont)) throw new Error('continue set no session');
    eq((await req('/api/auth/access', { method: 'POST', headers: { ...access(jwt({ email: OTHER })), origin: PUBLIC_URL } })).status, 403, 'continue as someone not allowed');
    eq((await req('/api/auth/access', { method: 'POST', headers: { origin: PUBLIC_URL } })).status, 403, 'continue without Access');
  });

  await step('Access: a cross-site Continue is refused', async () => {
    eq((await req('/api/auth/access', { method: 'POST', headers: { ...access(jwt()), origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' } })).status, 403, 'status');
  });

  await step('Sign in another device: needs a session, and the link works once for the same account', async () => {
    eq((await req('/api/auth/device-link', { method: 'POST', headers: { origin: PUBLIC_URL } })).status, 401, 'no session');
    const s = sessionOf((await meWith(access(jwt()))).res);
    const made = await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } });
    eq(made.status, 200, 'made');
    const { url, appLink } = await made.json();
    if (!url.startsWith(`${PUBLIC_URL}/api/auth/link/`)) throw new Error(`url ${url}`);
    if (!appLink.startsWith('cleftbot://sign-in?link=')) throw new Error(`appLink ${appLink}`);
    const p = new URL(url).pathname;
    const used = await req(p, { headers: { accept: 'application/json' } });
    eq(used.status, 200, 'phone app uses it');
    const { token, user } = await used.json();
    eq(user.email, LISTED, 'same account');
    eq((await req('/api/bots', { headers: { authorization: `Bearer ${token}` } })).status, 200, 'token works');
    eq((await req(p)).status, 410, 'second use');
    eq((await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site');
  });

  await step('Sign in another device: the phone app (bearer) can make one for a browser', async () => {
    const s = sessionOf((await meWith(access(jwt()))).res);
    const { url } = await (await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } })).json();
    const { token } = await (await req(new URL(url).pathname, { headers: { accept: 'application/json' } })).json();
    const made = await req('/api/auth/device-link', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    eq(made.status, 200, 'made');
    const browser = await req(new URL((await made.json()).url).pathname);
    eq(browser.status, 302, 'browser redirected in');
    if (!sessionOf(browser)) throw new Error('no cookie');
  });

  await step('Sign in another device: a link made by an owner session starts an owner session', async () => {
    // The owner key signs in someone not on the list (allowed for owner sessions only).
    const owner = await req('/api/auth/owner', { headers: { authorization: `Bearer ${hmac('owner-login')}` }, body: { email: 'boss@example.test', link: true } });
    eq(owner.status, 200, 'owner link');
    const ownerCookie = sessionOf(await req(new URL((await owner.json()).url).pathname));
    const { url } = await (await req('/api/auth/device-link', { method: 'POST', cookie: ownerCookie, headers: { origin: PUBLIC_URL } })).json();
    const second = sessionOf(await req(new URL(url).pathname));
    eq((await req('/api/bots', { cookie: second })).status, 200, 'owner-made device link still gets in though off the list');
  });

  // ---------- pairing a PC by QR code ----------
  const pair = async (device = 'DESKTOP-TEST') => (await req('/api/auth/pair', { body: { device }, headers: { origin: PUBLIC_URL } })).json();
  const poll = (id, secret) => req(`/api/auth/pair/${id}`, { headers: secret === undefined ? {} : { 'x-pair-secret': secret } });

  await step('Pair a PC: allowed by a signed-in person, the PC gets a one-time link for that account', async () => {
    const p = await pair();
    if (!/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(p.code)) throw new Error(`code ${p.code}`);
    eq(p.url, `${PUBLIC_URL}/pair/${p.id}`, 'url');
    eq((await (await poll(p.id, p.secret)).json()).state, 'waiting', 'waiting');
    const s = sessionOf((await meWith(access(jwt()))).res);
    const info = await (await req(`/api/auth/pair/${p.id}/info`, { cookie: s })).json();
    eq(info.code, p.code, 'phone sees the same code');
    eq(info.device, 'DESKTOP-TEST', 'device');
    eq((await req(`/api/auth/pair/${p.id}/answer`, { cookie: s, body: { allow: true }, headers: { origin: PUBLIC_URL } })).status, 200, 'allow');
    const done = await (await poll(p.id, p.secret)).json();
    eq(done.state, 'allowed', 'allowed');
    const used = await req(new URL(done.link).pathname, { headers: { accept: 'application/json' } });
    eq((await used.json()).user.email, LISTED, 'same account');
    eq((await poll(p.id, p.secret)).status, 404, 'pairing used up');
  });

  await step('Pair a PC: the poll without the right secret gets nothing', async () => {
    const p = await pair();
    const s = sessionOf((await meWith(access(jwt()))).res);
    await req(`/api/auth/pair/${p.id}/answer`, { cookie: s, body: { allow: true }, headers: { origin: PUBLIC_URL } });
    eq((await poll(p.id)).status, 404, 'no secret');
    eq((await poll(p.id, 'x'.repeat(43))).status, 404, 'wrong secret');
    eq((await (await poll(p.id, p.secret)).json()).state, 'allowed', 'the PC still can');
  });

  await step('Pair a PC: Deny ends it, and only a signed-in person can answer', async () => {
    const p = await pair();
    eq((await req(`/api/auth/pair/${p.id}/info`)).status, 401, 'info without a session');
    eq((await req(`/api/auth/pair/${p.id}/answer`, { body: { allow: true }, headers: { origin: PUBLIC_URL } })).status, 401, 'answer without a session');
    const s = sessionOf((await meWith(access(jwt()))).res);
    eq((await req(`/api/auth/pair/${p.id}/answer`, { cookie: s, body: { allow: true }, headers: { origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site answer');
    eq((await req(`/api/auth/pair/${p.id}/answer`, { cookie: s, body: { allow: false }, headers: { origin: PUBLIC_URL } })).status, 200, 'deny');
    eq((await req(`/api/auth/pair/${p.id}/answer`, { cookie: s, body: { allow: true }, headers: { origin: PUBLIC_URL } })).status, 410, 'no second answer');
    eq((await (await poll(p.id, p.secret)).json()).state, 'denied', 'PC told');
    eq((await poll(p.id, p.secret)).status, 404, 'gone');
  });

  await step('Sign in another device: at most 10 links per account in 10 minutes', async () => {
    const s = sessionOf((await meWith(access(jwt()))).res);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } })).status;
    eq(last, 429, 'twelfth');
  });

  await step('the Access team keys were fetched once, not per request', async () => {
    if (certsHits < 1 || certsHits > 3) throw new Error(`certs fetched ${certsHits} times`);
  });

  await start({ CF_ACCESS_ACCOUNTS: `Alias@Example.test=${LISTED}`, DB_PATH: path.join(TMP, 'alias.db'), ALLOW_EMPTY_DB: '1' });
  await step('Access: CF_ACCESS_ACCOUNTS signs an address in to the account it is mapped to', async () => {
    const { res, body } = await meWith(access(jwt({ email: 'alias@example.test' })));
    eq(body.user?.email, LISTED, 'account');
    eq((await req('/api/bots', { cookie: sessionOf(res) })).status, 200, 'session works');
    eq((await meWith(access(jwt({ email: OTHER })))).body.signIn?.accessRefused, OTHER, 'unmapped, unlisted still refused');
  });

  await start({ CF_ACCESS_ACCOUNTS: `alias@example.test=${LISTED},second@example.test=${LISTED}`, DISPLAY_NAMES: `Alias@example.test=Alex,${LISTED}=Alex & Sam`, DB_PATH: path.join(TMP, 'names.db'), ALLOW_EMPTY_DB: '1' });
  await step('Names: a device shows the name of the person who signed in, else the account\'s', async () => {
    const first = await meWith(access(jwt({ email: 'alias@example.test' })));
    eq(first.body.user?.email, LISTED, 'shared account');
    eq(first.body.user?.displayName, 'Alex', 'Access sign-in');
    const s = sessionOf(first.res);
    eq((await meWith({}, s)).body.user?.displayName, 'Alex', 'the session remembers who');
    // A phone signed in from that browser shows the same person.
    const { url } = await (await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } })).json();
    const { token, user } = await (await req(new URL(url).pathname, { headers: { accept: 'application/json' } })).json();
    eq(user.displayName, 'Alex', 'phone sign-in answer');
    eq((await meWith({ authorization: `Bearer ${token}` })).body.user?.displayName, 'Alex', 'phone /auth/me');
    // Someone with no name of their own on the list: the account's name.
    eq((await meWith(access(jwt({ email: 'second@example.test' })))).body.user?.displayName, 'Alex & Sam', 'unnamed person');
  });
  await step('Owner sign-in link for a mapped address opens the shared account, not a new empty one', async () => {
    const owner = await req('/api/auth/owner', { headers: { authorization: `Bearer ${hmac('owner-login')}` }, body: { email: 'Second@Example.test', link: true } });
    eq(owner.status, 200, 'owner link');
    const { token, user } = await (await req(new URL((await owner.json()).url).pathname, { headers: { accept: 'application/json' } })).json();
    eq(user.email, LISTED, 'shared account');
    eq(user.displayName, 'Alex & Sam', 'named for the person');
    eq((await meWith({ authorization: `Bearer ${token}` })).body.user?.email, LISTED, 'phone /auth/me');
  });

  // A person's phone Access token (CF_ACCESS_PHONE_TOKENS): their device links go to the public address with it.
  const phoneFile = path.join(TMP, 'phone.env');
  fs.writeFileSync(phoneFile, 'CFA_ID=abc123.access\nCFA_SECRET=s3cr3t-value\nBASE_URL=https://cleft.example.test\nAPP_SCHEME=cleftbot\n', { mode: 0o600 });
  await start({ CF_ACCESS_PHONE_TOKENS: `${LISTED}=${phoneFile},nofile@example.test=${path.join(TMP, 'missing.env')}`, DB_PATH: path.join(TMP, 'phone.db'), ALLOW_EMPTY_DB: '1' });
  await step('Sign in another device: a person with a phone token gets the public address and the token', async () => {
    const s = sessionOf((await meWith(access(jwt()))).res);
    const { url, appLink } = await (await req('/api/auth/device-link', { method: 'POST', cookie: s, headers: { origin: PUBLIC_URL } })).json();
    if (!/^https:\/\/cleft\.example\.test\/api\/auth\/link\/[A-Za-z0-9_-]+#cfa=abc123\.access:s3cr3t-value$/.test(url)) throw new Error(`url ${url}`);
    if (!appLink.startsWith('cleftbot://sign-in?link=')) throw new Error(`appLink ${appLink}`);
    const used = await req(new URL(url).pathname, { headers: { accept: 'application/json' } });
    eq(used.status, 200, 'link works');
  });
  await step('Sign in another device: a script session never gets the phone token', async () => {
    const owner = await req('/api/auth/owner', { headers: { authorization: `Bearer ${hmac('owner-login')}` }, body: { email: LISTED, link: true, agent: 'Claude: test' } });
    eq(owner.status, 200, 'owner link');
    const c = sessionOf(await req(new URL((await owner.json()).url).pathname));
    const r = await req('/api/auth/device-link', { method: 'POST', cookie: c, headers: { origin: PUBLIC_URL } });
    eq(r.status, 200, 'made');
    const { url } = await r.json();
    if (url.includes('#cfa=') || !url.startsWith(PUBLIC_URL)) throw new Error(`url ${url}`);
  });

  await start({ CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '' });
  await step('Access off: a valid token signs nobody in', async () => {
    const { res, body } = await meWith(access(jwt()));
    eq(body.user, null, 'user');
    eq(sessionOf(res), undefined, 'cookie');
    eq((await req('/api/auth/access', { method: 'POST', headers: { ...access(jwt()), origin: PUBLIC_URL } })).status, 403, 'continue');
  });
} finally {
  await stop();
  certs.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed.`);
if (failed && log) console.log(`--- last server log ---\n${log}`);
process.exit(failed ? 1 : 0);
