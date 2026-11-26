// Scoped sign-ins (SCOPED_PEOPLE): a person who shares the account but sees only their own bot.
// Usage: npm run build -w server && node tests/scope.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-scope-'));
const SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = 'https://hq.example.test';
const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-of-this-app';
const TEAM_ACCOUNT = 'team@example.test';
const ALEX = 'alex@example.test';
const SAM = 'sam@example.test';
const LISTED = ALEX;
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
      APP_URL: PUBLIC_URL, SERVER_URL: PUBLIC_URL, ALLOWED_EMAILS: TEAM_ACCOUNT,
      CF_ACCESS_ACCOUNTS: `${ALEX}=${TEAM_ACCOUNT},${SAM}=${TEAM_ACCOUNT}`, SCOPED_PEOPLE: `${SAM}=Robin`,
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


const j = async (p, opts) => { const r = await req(p, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
// Reads an SSE stream for a moment and returns the events it carried.
async function sse(p, cookie, ms, during) {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}${p}`, { headers: { cookie }, signal: ctl.signal });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5)));
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 300));
  await during();
  await new Promise((r) => setTimeout(r, ms));
  ctl.abort(); await pump;
  return events;
}

try {
  await start();
  const alex = sessionOf((await meWith(access(jwt({ email: ALEX })))).res);
  const sam = sessionOf((await meWith(access(jwt({ email: SAM })))).res);
  if (!alex || !sam) throw new Error('Access sign-in failed');
  const ids = {};
  for (const name of ['Leonard', 'Robin', 'Sheldon']) {
    const r = await j('/api/bots', { cookie: alex, body: { name } });
    if (r.status !== 200) throw new Error(`make ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    ids[name] = r.body.bot.id;
  }
  const group = await j('/api/rooms', { cookie: alex, body: { name: 'Huddle', botIds: [ids.Leonard, ids.Robin] } });
  if (group.status !== 200) throw new Error(`make group: ${group.status} ${JSON.stringify(group.body)}`);

  await step('Alex sees every bot and the group', async () => {
    const names = (await j('/api/bots', { cookie: alex })).body.bots.map((b) => b.name).sort();
    for (const n of ['Huddle', 'Leonard', 'Robin', 'Sheldon']) if (!names.includes(n)) throw new Error(`missing ${n}: ${names}`);
    eq((await j('/api/auth/me', { cookie: alex })).body.user.scope, undefined, 'no scope');
  });

  await step('Sam sees only Robin, and is told so', async () => {
    const { body } = await j('/api/bots', { cookie: sam });
    eq(JSON.stringify(body.bots.map((b) => b.name)), '["Robin"]', 'bots');
    eq(JSON.stringify(body.live.map((l) => l.botId)), JSON.stringify([ids.Robin]), 'live');
    const me = (await j('/api/auth/me', { cookie: sam })).body.user;
    eq(JSON.stringify(me.scope?.bots), JSON.stringify([ids.Robin]), 'me.scope');
  });

  await step("Sam can open Robin's chat and settings", async () => {
    eq((await req(`/api/bots/${ids.Robin}/rows`, { cookie: sam })).status, 200, 'rows');
    eq((await req(`/api/bots/${ids.Robin}/settings`, { cookie: sam })).status, 200, 'settings');
    eq((await req(`/api/bots/${ids.Robin}/side-chats`, { cookie: sam })).status, 200, 'side chats');
  });

  await step('Sam cannot open, change or list anything else', async () => {
    for (const id of [ids.Leonard, ids.Sheldon, group.body.room?.id ?? group.body.bot?.id ?? group.body.id]) {
      if (!id) continue;
      for (const p of ['', '/rows', '/settings', '/files', '/memories', '/routines', '/exchanges']) eq((await req(`/api/bots/${id}${p}`, { cookie: sam })).status, 403, `GET ${id}${p}`);
      eq((await req(`/api/bots/${id}/messages`, { cookie: sam, body: { text: 'hi' } })).status, 403, `POST ${id}/messages`);
      eq((await req(`/api/bots/${id}`, { cookie: sam, method: 'PATCH', body: { name: 'x' } })).status, 403, `PATCH ${id}`);
    }
    for (const p of ['/api/machines', '/api/connectors', '/api/plugins', '/api/computer', '/api/allow-rules', '/api/policies', '/api/apps', '/api/checkins', '/api/connectors/admin-changes'])
      eq((await req(p, { cookie: sam })).status, 403, p);
    eq((await req('/api/bots', { cookie: sam, body: { name: 'Extra' } })).status, 403, 'make a bot');
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: sam, method: 'DELETE' })).status, 403, 'delete Robin');
    eq((await req(`/api/bots/${ids.Robin}/primary`, { cookie: sam, body: {} })).status, 403, 'make Robin primary');
    eq((await req('/api/voice/session', { cookie: sam, body: { botId: ids.Leonard } })).status, 403, 'call Leonard');
  });

  await step('A device Sam signs in gets the same scope', async () => {
    const link = await j('/api/auth/device-link', { cookie: sam, body: {} });
    eq(link.status, 200, 'device link');
    const url = link.body.url ?? link.body.link;
    const { token } = await (await req(new URL(url).pathname, { headers: { accept: 'application/json' } })).json();
    const r = await (await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).json();
    eq(JSON.stringify(r.bots.map((b) => b.name)), '["Robin"]', 'phone bots');
    eq((await fetch(`${BASE}/api/bots/${ids.Leonard}/rows`, { headers: { authorization: `Bearer ${token}` } })).status, 403, 'phone opens Leonard');
  });

  await step("Sam's live stream carries only Robin's events", async () => {
    const events = await sse('/api/events', sam, 500, async () => {
      await req(`/api/bots/${ids.Leonard}`, { cookie: alex, method: 'PATCH', body: { label: 'money' } });
      await req(`/api/bots/${ids.Robin}`, { cookie: alex, method: 'PATCH', body: { label: 'helper' } });
    });
    const bots = events.filter((e) => e.type === 'bot').map((e) => e.bot.name);
    if (bots.includes('Leonard')) throw new Error(`saw Leonard: ${JSON.stringify(bots)}`);
    if (!bots.includes('Robin')) throw new Error(`did not see Robin: ${JSON.stringify(events.map((e) => e.type))}`);
    const mine = await sse('/api/events', alex, 500, async () => { await req(`/api/bots/${ids.Leonard}`, { cookie: alex, method: 'PATCH', body: { label: 'cash' } }); });
    if (!mine.some((e) => e.type === 'bot' && e.bot.name === 'Leonard')) throw new Error('Alex did not see Leonard');
  });

  await step('Tasks and recent notices are filtered', async () => {
    eq((await req('/api/tasks', { cookie: sam })).status, 200, 'tasks');
    eq((await req('/api/notify/recent', { cookie: sam })).status, 200, 'recent');
  });

  await step("Robin's look styles and her own Always-allow rules open for Sam, nobody else's", async () => {
    eq((await req('/api/looks/options', { cookie: sam })).status, 200, 'look styles');
    eq((await req(`/api/allow-rules?botId=${ids.Robin}`, { cookie: sam })).status, 200, "Robin's rules");
    eq((await req(`/api/allow-rules?botId=${ids.Leonard}`, { cookie: sam })).status, 403, "Leonard's rules");
    eq((await req('/api/allow-rules', { cookie: sam })).status, 403, 'every rule');
    eq((await req('/api/allow-rules/nope', { cookie: sam, method: 'DELETE' })).status, 403, 'remove a rule that is not Robin\'s');
  });

  await step("Sam can change Robin's instructions but not rename her (her sign-in finds Robin by name)", async () => {
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: sam, method: 'PATCH', body: { instructions: 'Keep it short.' } })).status, 200, 'instructions');
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: sam, method: 'PATCH', body: { name: 'Robin', instructions: 'Short.' } })).status, 200, 'same name');
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: sam, method: 'PATCH', body: { name: 'Pen' } })).status, 403, 'rename');
    eq((await j('/api/bots', { cookie: sam })).body.bots[0]?.name, 'Robin', 'still Robin');
  });

  await step("Alex can hide Robin from his own view; Sam keeps her and cannot change it", async () => {
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: alex, method: 'PATCH', body: { ownerHidden: true } })).status, 200, 'hide');
    const mine = (await j('/api/bots', { cookie: alex })).body.bots;
    eq(mine.find((b) => b.id === ids.Robin)?.ownerHidden, true, 'Alex sees the mark (apps leave her out of the list)');
    eq(mine.find((b) => b.id === ids.Leonard)?.ownerHidden, false, 'Leonard is not hidden');
    const hers = (await j('/api/bots', { cookie: sam })).body.bots;
    eq(JSON.stringify(hers.map((b) => [b.name, b.ownerHidden])), '[["Robin",false]]', 'Sam still has Robin, unmarked');
    const events = await sse('/api/events', sam, 400, async () => { await req(`/api/bots/${ids.Robin}`, { cookie: alex, method: 'PATCH', body: { label: 'helper 2' } }); });
    const ev = events.find((e) => e.type === 'bot' && e.bot.id === ids.Robin);
    if (!ev || ev.bot.ownerHidden !== false) throw new Error(`Sam's live Robin: ${JSON.stringify(ev?.bot?.ownerHidden)}`);
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: sam, method: 'PATCH', body: { ownerHidden: false } })).status, 403, 'Sam cannot unhide');
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: alex, method: 'PATCH', body: { ownerHidden: 'yes' } })).status, 400, 'not a boolean');
    eq((await req(`/api/bots/${ids.Robin}`, { cookie: alex, method: 'PATCH', body: { ownerHidden: false } })).status, 200, 'show again');
    eq((await j('/api/bots', { cookie: alex })).body.bots.find((b) => b.id === ids.Robin)?.ownerHidden, false, 'shown');
  });

} catch (e) {
  results.push({ ok: false });
  console.log(`FAIL setup: ${e?.message ?? e}\n${log.slice(-2000)}`);
} finally {
  await stop();
  certs.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
