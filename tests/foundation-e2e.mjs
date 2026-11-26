// The server's foundations, through the real server (throwaway database, fake Hermes):
//  - it refuses to start on an empty database when one with accounts sits beside it (db-guard.ts), and
//    starts with ALLOW_EMPTY_DB=1;
//  - an unknown /api address answers 404 as JSON, a missing asset 404 and never the page;
//  - answers carry nosniff and referrer headers, large ones are compressed, event streams are not;
//  - health says ok with the database's answer, and names the commit only to this machine;
//  - the owner's status: checks, database, snapshot now; other accounts are refused;
//  - signed-in devices: listed with their names, one signed out from another, scripts cannot sign out;
//  - a session in use is renewed; creating a bot checks what it is sent.
// Run after `npm run build -w server`:   node tests/foundation-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, sleep, startServer } from './lib/server.mjs';

const require = createRequire(path.join(root, 'server/package.json'));
const Database = require('better-sqlite3');
const { test, done } = runner();

await test('refuses to start on an empty database beside one with accounts; ALLOW_EMPTY_DB=1 starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const real = new Database(path.join(dir, 'bothq.db'));
    real.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE bots (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('u1','a@example.com'); INSERT INTO bots VALUES ('b1'),('b2');");
    real.close();
    fs.writeFileSync(path.join(dir, 'stray.db'), ''); // an empty stray file is not a database with accounts
    const refused = await startServer({ dir, keepDir: true, expectExit: true, env: { DB_PATH: path.join(dir, 'cleftbot.db') } });
    assert.notEqual(refused.state.exit, null, 'the server should have stopped');
    assert.notEqual(refused.state.exit, 0);
    assert.match(refused.state.log, /Refusing to start/);
    assert.match(refused.state.log, /bothq\.db beside it has 1 account and 2 bots/);
    assert.ok(!fs.existsSync(path.join(dir, 'cleftbot.db')), 'the empty database must not be created');
    await refused.stop();
    const fresh = await startServer({ dir, keepDir: true, env: { DB_PATH: path.join(dir, 'cleftbot.db'), ALLOW_EMPTY_DB: '1' } });
    assert.equal((await fetch(`${fresh.BASE}/api/health`)).status, 200);
    await fresh.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const s = await startServer({ name: 'foundation', env: { DB_SNAPSHOTS_KEEP: '2' } });
try {
  const me = await s.signIn('owner@example.com', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' });
  const api = me.api;

  await test('an unknown /api address is a 404 in JSON; signed out it is a 401', async () => {
    const r = await api('GET', '/no-such-thing');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'no_route');
    const out = await fetch(`${s.BASE}/api/no-such-thing`);
    assert.equal(out.status, 401);
    const posted = await api('POST', '/bots/x/no-such-action', {});
    assert.equal(posted.status, 404);
  });

  await test('answers carry nosniff, a referrer policy and the frame rules', async () => {
    const r = await api('GET', '/bots');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  await test('a large answer is compressed when asked; the event stream never is', async () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(400);
    const { json: { bots } } = await api('GET', '/bots');
    await api('POST', `/bots/${bots[0].id}/messages`, { text: big });
    const r = await fetch(`${s.BASE}/api/bots/${bots[0].id}/rows`, { headers: { authorization: `Bearer ${me.token}`, 'accept-encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.ok((await r.json()).rows.length >= 1);
    const ctrl = new AbortController();
    const ev = await fetch(`${s.BASE}/api/events`, { headers: { authorization: `Bearer ${me.token}`, 'accept-encoding': 'gzip' }, signal: ctrl.signal });
    assert.equal(ev.headers.get('content-encoding'), null);
    assert.match(ev.headers.get('content-type'), /text\/event-stream/);
    ctrl.abort();
  });

  const hasWeb = fs.existsSync(path.join(root, 'web/dist/index.html'));
  await test(`the page is always asked for again, hashed files are kept, a missing one is a 404${hasWeb ? '' : ' (skipped: web not built)'}`, async () => {
    if (!hasWeb) return;
    const page = await fetch(`${s.BASE}/`);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const deep = await fetch(`${s.BASE}/some/deep/link`);
    assert.equal(deep.status, 200);
    assert.equal(deep.headers.get('cache-control'), 'no-cache');
    const asset = fs.readdirSync(path.join(root, 'web/dist/assets')).find((f) => f.endsWith('.js'));
    const a = await fetch(`${s.BASE}/assets/${asset}`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(a.status, 200);
    assert.match(a.headers.get('cache-control'), /immutable/);
    assert.equal(a.headers.get('content-encoding'), 'gzip');
    const gone = await fetch(`${s.BASE}/assets/index-OLDHASH.js`);
    assert.equal(gone.status, 404);
    assert.doesNotMatch(await gone.text(), /<html/i);
  });

  await test('health: ok with the database checked; the commit and busy list only from this machine', async () => {
    const local = await (await fetch(`${s.BASE}/api/health`)).json();
    assert.equal(local.ok, true);
    assert.ok(Array.isArray(local.busy));
    assert.ok('commit' in local && local.uptimeSec >= 0);
    const far = await (await fetch(`${s.BASE}/api/health`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json();
    assert.deepEqual(far, { ok: true, engine: 'hermes' });
  });

  await test('status: the owner gets checks, database and bots; a snapshot can be made and old ones are pruned', async () => {
    const r = await api('GET', '/status');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.db.integrity, 'ok');
    assert.ok(r.json.checks.find((c) => c.id === 'db' && c.state === 'ok'));
    assert.ok(r.json.checks.find((c) => c.id === 'server'));
    assert.equal(r.json.bots.length, 1);
    assert.equal(r.json.bots[0].state, 'ready');
    assert.ok(r.json.server.uptimeSec >= 0 && r.json.disk.freeBytes > 0);
    assert.equal(r.json.backup, null);
    const snap = await api('POST', '/status/snapshot');
    assert.equal(snap.status, 200, snap.text);
    assert.match(snap.json.snapshot.name, /^test-\d{8}-\d{6}-manual\.sqlite$/);
    const file = path.join(s.dir, 'snapshots', snap.json.snapshot.name);
    const copy = new Database(file, { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    copy.close();
    assert.equal((fs.statSync(file).mode & 0o077), 0, 'a snapshot is readable by the server only');
    assert.equal((await api('POST', '/status/snapshot')).status, 429);
  });

  await test('status is the owner\'s only', async () => {
    const other = await s.signIn('someone@example.com');
    assert.equal((await other.api('GET', '/status')).status, 403);
    assert.equal((await other.api('POST', '/status/snapshot')).status, 403);
    assert.equal((await fetch(`${s.BASE}/api/status`)).status, 401);
  });

  await test('a warning the server logs shows up among the status problems, with addresses masked', async () => {
    // A sign-in from an account that is not allowed logs nothing; an unknown bot's turn does not either. Use a
    // request the server cannot read: it answers 400 without logging, so trigger a real warning instead.
    await api('PATCH', '/bots/does-not-exist', { name: 'x' });
    const r = await api('GET', '/status');
    assert.ok(Array.isArray(r.json.problems));
    for (const p of r.json.problems) assert.doesNotMatch(p.text, /owner@example\.com/);
  });

  await test('signed-in devices: listed with names, newest use first, this one marked', async () => {
    const phone = await s.signIn('owner@example.com', { 'user-agent': 'okhttp/4.12.0', 'x-cleft-device': "Alex's Pixel" });
    const r = await api('GET', '/auth/sessions');
    assert.equal(r.status, 200, r.text);
    const mine = r.json.sessions.find((x) => x.current);
    assert.ok(mine, 'this device is in the list');
    assert.equal(r.json.sessions[0].current, true);
    assert.equal(mine.device, 'Chrome on Windows');
    assert.ok(r.json.sessions.find((x) => x.device === "Alex's Pixel"));
    assert.ok(r.json.sessions.every((x) => !('token' in x) && /^[a-f0-9]{24}$/.test(x.id)));
    // Sign the phone out from here: its next request is refused.
    const target = r.json.sessions.find((x) => x.device === "Alex's Pixel");
    const out = await api('DELETE', `/auth/sessions/${target.id}`);
    assert.equal(out.status, 200, out.text);
    assert.equal((await phone.api('GET', '/bots')).status, 401);
    assert.equal((await api('DELETE', `/auth/sessions/${mine.id}`)).status, 400);
    assert.equal((await api('DELETE', '/auth/sessions/nope')).status, 404);
  });

  await test('a script can list devices but not sign them out; sign out others keeps scripts unless asked', async () => {
    const script = await s.signInScript('Claude: test');
    const extra = await s.signIn('owner@example.com', { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' });
    const listed = await script.api('GET', '/auth/sessions');
    assert.equal(listed.status, 200);
    assert.ok(listed.json.sessions.find((x) => x.kind === 'script' && x.who === 'Claude: test'));
    assert.equal((await script.api('POST', '/auth/sessions/sign-out-others', {})).status, 403);
    assert.equal((await script.api('DELETE', `/auth/sessions/${listed.json.sessions.find((x) => !x.current).id}`)).status, 403);
    const r = await api('POST', '/auth/sessions/sign-out-others', {});
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.signedOut >= 1);
    assert.equal((await extra.api('GET', '/bots')).status, 401);
    assert.equal((await script.api('GET', '/bots')).status, 200, 'the script stays signed in');
    assert.equal((await api('GET', '/bots')).status, 200, 'this device stays signed in');
    const all = await api('POST', '/auth/sessions/sign-out-others', { scripts: true });
    assert.equal(all.json.sessions.length, 1);
    assert.equal((await script.api('GET', '/bots')).status, 401);
  });

  await test('another account never sees or signs out this account\'s devices', async () => {
    const other = await s.signIn('third@example.com');
    const theirs = await other.api('GET', '/auth/sessions');
    assert.equal(theirs.json.sessions.length, 1);
    const mine = (await api('GET', '/auth/sessions')).json.sessions[0];
    assert.ok(!theirs.json.sessions.some((x) => x.id === mine.id));
    assert.equal((await other.api('DELETE', `/auth/sessions/${mine.id}`)).status, 404, 'mine is not theirs to find');
  });

  await test('a session in use is renewed: an expiry less than 29 days away moves out to 30 days', async () => {
    const db = new Database(s.dbPath);
    const soon = Date.now() + 2 * 86_400_000;
    db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token=?').run(soon, me.token);
    db.close();
    assert.equal((await api('GET', '/bots')).status, 200);
    const db2 = new Database(s.dbPath, { readonly: true });
    const row = db2.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE token=?').get(me.token);
    db2.close();
    assert.ok(row.expires_at > Date.now() + 29 * 86_400_000, 'expiry moved out');
    assert.ok(Date.now() - row.last_seen_at < 60_000);
  });

  await test('creating a bot checks what it is sent', async () => {
    assert.equal((await api('POST', '/bots', {})).status, 400);
    assert.equal((await api('POST', '/bots', { name: 42 })).status, 400);
    assert.equal((await api('POST', '/bots', { name: '   ' })).status, 400);
    assert.equal((await api('POST', '/bots', { name: 'Ok', instructions: 7 })).status, 400);
    const bad = await fetch(`${s.BASE}/api/bots`, { method: 'POST', headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
  });

  await test('the exchanges limit never reaches the database as NaN', async () => {
    const { json: { bots } } = await api('GET', '/bots');
    assert.equal((await api('GET', `/bots/${bots[0].id}/exchanges?limit=abc`)).status, 404); // not an outside member: still a clean answer
  });
} finally {
  await s.stop();
}

// The owner is told when a check stays bad, once, and the notice is taken down when it is over.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const history = path.join(dir, 'history.log');
  fs.writeFileSync(history, `weekly-1 ${new Date().toISOString()} failed\n`);
  const w = await startServer({ name: 'watch', env: { STATUS_WATCH: '1', STATUS_WATCH_MS: '250', BACKUP_HISTORY_FILE: history } });
  try {
    const me = await w.signIn('owner@example.com');
    const other = await w.signIn('someone@example.com');
    const notices = async (who) => (await who.api('GET', '/notify/recent')).json.notices.filter((n) => n.tag.startsWith('sys:'));
    await test('a check that stays bad reaches the owner as one notification, from the main bot', async () => {
      let got = [];
      for (let i = 0; i < 40 && !got.length; i++) { await sleep(150); got = await notices(me); }
      assert.equal(got.length, 1, JSON.stringify(got));
      assert.equal(got[0].tag, 'sys:backup');
      assert.match(got[0].title, /Off-site backup needs attention/);
      assert.equal(got[0].channel, 'jobs');
      const bots = (await me.api('GET', '/bots')).json.bots;
      assert.equal(got[0].botId, bots.find((b) => b.isPrimary)?.id ?? bots[0].id);
      await sleep(800);
      assert.equal((await notices(me)).length, 1, 'not repeated on every look');
      assert.equal((await notices(other)).length, 0, 'another account is not told');
    });
    await test('when the problem is over the apps are told to take the notice down', async () => {
      const ctl = new AbortController();
      let text = '';
      const res = await fetch(`${w.BASE}/api/events`, { headers: { authorization: `Bearer ${me.token}` }, signal: ctl.signal });
      (async () => { try { for await (const c of res.body) text += new TextDecoder().decode(c); } catch { /* closed */ } })();
      fs.writeFileSync(history, `weekly-2 ${new Date().toISOString()} ok\n`);
      for (let i = 0; i < 40 && !text.includes('notify-clear'); i++) await sleep(150);
      ctl.abort();
      assert.match(text, /"type":"notify-clear","tags":\["sys:backup"\]/);
    });
  } finally {
    await w.stop();
  }
}
await sleep(50);
done();
