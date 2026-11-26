// Batch 3 of the server overhaul, through the real server (throwaway database, fake Hermes):
//  - every API answer carries a reference; search engines are told to keep out; a huge JSON request is refused;
//  - the start line names the build and the database it opened;
//  - the status page: other database files beside the live one are flagged, sign-ins are counted, the
//    problem list can be cleared by a person and not by a script;
//  - helper programs' sign-ins: signed out on their own, left alone by "everywhere else", and removed at
//    start when unused for two weeks;
//  - Download my data: every conversation as text for a person, refused to a script, and a person who sees
//    only some bots gets only those;
//  - a stopping server tells the connected apps first (`restarting`).
// Run after `npm run build -w server`:   node tests/polish-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, sleep, startServer, until } from './lib/server.mjs';

const require = createRequire(path.join(root, 'server/package.json'));
const Database = require('better-sqlite3');
const { test, done } = runner();

const ENV = { DISPLAY_NAMES: 'owner@example.com=Alex,sam@example.com=Sam', SCOPED_PEOPLE: 'sam@example.com=Robin', CF_ACCESS_ACCOUNTS: 'sam@example.com=owner@example.com' };
let s = await startServer({ name: 'polish', keepDir: true, env: ENV });
const dir = s.dir;
const secret = s.SECRET;
try {
  const me = await s.signIn();
  const api = me.api;

  await test('API answers carry a reference; robots are told to keep out', async () => {
    const a = await api('GET', '/bots');
    const b = await api('GET', '/no-such-thing');
    assert.match(a.headers.get('x-request-id'), /^[0-9a-f]{8}$/);
    assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
    assert.match(a.headers.get('x-robots-tag'), /noindex/);
    assert.match(a.headers.get('permissions-policy'), /geolocation=\(\)/);
    const robots = await fetch(`${s.BASE}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow: \//);
  });

  await test('a JSON request far larger than the apps send is refused with 413', async () => {
    const r = await fetch(`${s.BASE}/api/bots`, { method: 'POST', headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/json', origin: s.BASE }, body: JSON.stringify({ name: 'x', instructions: 'a'.repeat(17 * 1024 * 1024) }) });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).code, 'too_large');
  });

  await test('the start line names the build and the database', async () => {
    assert.match(s.state.log, /\[cleftbot\] build \S+.*database .*test\.db \(DB_PATH\): \d+ account\(s\), \d+ bot\(s\), \d+ rows/);
  });

  await test('status: other database files are flagged, sign-ins counted', async () => {
    let st = (await api('GET', '/status')).json;
    assert.ok(!st.checks.find((c) => c.id === 'stray-db'), 'nothing stray yet');
    fs.writeFileSync(path.join(dir, 'cleftbot.db'), '');
    fs.writeFileSync(path.join(dir, 'old.db'), '');
    st = (await api('GET', '/status')).json;
    const stray = st.checks.find((c) => c.id === 'stray-db');
    assert.equal(stray.state, 'warn');
    assert.match(stray.detail, /2 other database files/);
    assert.match(stray.detail, /cleftbot\.db, old\.db/);
    assert.match(stray.detail, /uses test\.db/);
    fs.rmSync(path.join(dir, 'cleftbot.db')); fs.rmSync(path.join(dir, 'old.db'));
    assert.equal(st.sessions.people, 1);
    assert.equal(typeof st.stallMs, 'number');
  });

  const script = await s.signInScript('Claude: polish test');
  const script2 = await s.signInScript('Claude: old thread');

  await test('the problem list is cleared by a person, not by a script', async () => {
    assert.equal((await script.api('POST', '/status/problems/clear')).status, 403);
    const r = await api('POST', '/status/problems/clear');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.cleared, 'number');
    assert.equal((await api('GET', '/status')).json.problems.length, 0);
  });

  await test('helper sign-ins: counted, left by "everywhere else", signed out on their own', async () => {
    const phone = await s.signIn('owner@example.com', { 'x-cleft-device': 'Pixel' });
    let st = (await api('GET', '/status')).json;
    assert.equal(st.sessions.scripts, 2);
    assert.equal(st.sessions.people, 2);
    const kept = await api('POST', '/auth/sessions/sign-out-others', {});
    assert.equal(kept.json.signedOut, 1);
    assert.equal((await phone.api('GET', '/bots')).status, 401);
    assert.equal((await script.api('GET', '/bots')).status, 200);
    assert.equal((await script.api('POST', '/auth/sessions/sign-out-others', { only: 'scripts' })).status, 403);
    const only = await api('POST', '/auth/sessions/sign-out-others', { only: 'scripts' });
    assert.equal(only.json.signedOut, 2);
    assert.equal((await script.api('GET', '/bots')).status, 401);
    assert.equal((await api('GET', '/bots')).status, 200, 'the person stays signed in');
    void script2;
  });

  // Bots and a conversation to download.
  const mk = async (name) => (await api('POST', '/bots', { name, instructions: `You are ${name}.` })).json.bot;
  const leonard = await mk('Leonard');
  const robin = await mk('Robin');
  const idle = async (id) => { await sleep(150); return until('the turn to finish', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === id)?.isRunning); };
  await test('Download my data holds every conversation as text', async () => {
    assert.ok(leonard?.id && robin?.id, 'bots made');
    assert.equal((await api('POST', `/bots/${leonard.id}/messages`, { text: 'What is the budget for groceries?' })).status, 200);
    await idle(leonard.id);
    assert.equal((await api('POST', `/bots/${robin.id}/messages`, { text: 'Remind me about the dentist.' })).status, 200);
    await idle(robin.id);
    const r = await api('GET', '/export/account');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="ybots-\d{4}-\d\d-\d\d\.json"/);
    assert.equal(r.json.format, 'yanceybot-account-export');
    const l = r.json.bots.find((b) => b.name === 'Leonard');
    assert.equal(l.instructions, 'You are Leonard.');
    assert.equal(l.conversations.length, 1);
    assert.match(l.conversations[0].markdown, /\*\*Alex\*\*/);
    assert.match(l.conversations[0].markdown, /What is the budget for groceries\?/);
    assert.ok(r.json.counts.messages >= 2);
    assert.ok(!JSON.stringify(r.json).includes(me.token), 'no sign-in in the file');
    // Straight away again: refused, so the heaviest read cannot be run in a loop.
    assert.equal((await api('GET', '/export/account')).status, 429);
  });

  await test('a script cannot download the account; a person who sees one bot gets only that one', async () => {
    const helper = await s.signInScript('Claude: export test');
    assert.equal((await helper.api('GET', '/export/account')).status, 403);
    await sleep(5100);
    const sam = await s.signIn('sam@example.com');
    const r = await sam.api('GET', '/export/account');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.bots.map((b) => b.name), ['Robin']);
    assert.ok(!JSON.stringify(r.json).includes('groceries'));
    assert.match(r.json.bots[0].conversations[0].markdown, /\*\*Sam\*\*|\*\*Alex\*\*/);
  });

  await test('a stopping server tells the connected apps first', async () => {
    const ac = new AbortController();
    const res = await fetch(`${s.BASE}/api/events`, { headers: { authorization: `Bearer ${me.token}` }, signal: ac.signal });
    const reader = res.body.getReader();
    let seen = '';
    const read = (async () => { try { for (;;) { const { value, done: end } = await reader.read(); if (end) break; seen += Buffer.from(value).toString('utf8'); } } catch { /* the server went away */ } })();
    await until('hello', () => /"type":"hello"/.test(seen));
    s.child.kill('SIGTERM');
    await Promise.race([read, sleep(8000)]);
    ac.abort();
    assert.match(seen, /"type":"restarting"/);
  });

  await test('at start, helper sign-ins unused for two weeks are removed; people\'s stay', async () => {
    for (let i = 0; i < 100 && s.state.exit === null; i++) await sleep(50);
    const db = new Database(path.join(dir, 'test.db'));
    const old = Date.now() - 20 * 86_400_000;
    const scripts = db.prepare('SELECT token FROM auth_sessions WHERE agent IS NOT NULL').all();
    assert.ok(scripts.length >= 1);
    db.prepare('UPDATE auth_sessions SET last_seen_at=?, created_at=? WHERE agent IS NOT NULL').run(old, old);
    db.prepare('UPDATE auth_sessions SET last_seen_at=?, created_at=? WHERE agent IS NULL').run(old, old);
    const people = db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE agent IS NULL').get().n;
    db.close();
    s = await startServer({ name: 'polish', dir, keepDir: true, secret, env: ENV });
    assert.match(s.state.log, new RegExp(`removed ${scripts.length} helper sign-in\\(s\\) unused for two weeks`));
    const after = new Database(path.join(dir, 'test.db'), { readonly: true });
    assert.equal(after.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE agent IS NOT NULL').get().n, 0);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE agent IS NULL').get().n, people);
    after.close();
  });
} finally {
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
