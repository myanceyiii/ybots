// Tests for Settings › Connections (server/src/connections.ts): the worded list every app shows, the
// per-tool rules, Turn off / Turn on / Remove of apps.json entries with the digest and Undo, and
// Reconnect, including moving an older Google connection's bots to a new Google sign-in.
// Throwaway database, apps.json, catalog and Google folder; the fake MCP server in tests/fixtures.
//   npm run build -w server && node tests/connections.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-connections-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), APP_URL: 'http://localhost:5173', OWNER_EMAIL: 'owner@example.test',
  CONNECTORS_CATALOG: path.join(dir, 'catalog.json'), GOOGLE_ACCOUNTS_DIR: path.join(dir, 'google'),
  CLEFT_MAINTAINER_LOG: path.join(dir, 'maintainer.log'), GOOGLE_WORKSPACE_MCP: path.join(dir, 'no-workspace-mcp'),
});
delete process.env.EXTRA_MCP_SERVERS;
const demo = path.join(here, 'fixtures/demo-mcp-server.mjs');
const appsFile = process.env.APPS_CONFIG;
fs.writeFileSync(appsFile, JSON.stringify({ apps: [
  { id: 'actual', name: 'Actual', description: 'Household budget. Reads and writes the budget.', command: process.execPath, args: [demo], env: { ACTUAL_KEY: 'sekrit-value' }, bots: ['Leonard'], ask: ['send_*'] },
  { id: 'google', name: 'Google (Alex)', command: process.execPath, args: [demo], bots: ['Leonard'] },
] }, null, 2));
fs.writeFileSync(process.env.CONNECTORS_CATALOG, JSON.stringify({ connectors: [] }));

const { db } = await import('../server/dist/db.js');
await import('../server/dist/connectors.js');
const conn = await import('../server/dist/connections.js');
const admin = await import('../server/dist/connector-admin.js');
const apps = await import('../server/dist/local-apps.js');
const registry = await import('../server/dist/plugins/registry.js');
const g = await import('../server/dist/google-accounts.js');

const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_owner', 'owner@example.test', 'Alex', t0);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_sam', 'sam@example.test', 'Sam', t0);
const addBot = (id, user, name, engine, i) => db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, user, name, engine, t0 + i, t0 + i);
addBot('b_howard', 'u_owner', 'Howard', 'primary', 1);
addBot('b_leonard', 'u_owner', 'Leonard', 'managed', 2);
addBot('b_robin', 'u_sam', 'Robin', 'managed', 3);
await apps.listAppTools();

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${e.stack}`); }
}
const get = async (id, user = 'u_owner') => (await conn.connectionsFor(user)).connections.find((c) => c.id === id);
const opts = { via: 'Connections in the web', base: 'http://localhost:5173' };

await test('the list is worded the same for every app, with no server jargon in the main view', async () => {
  const a = await get('actual');
  assert.equal(a.state, 'connected');
  assert.equal(a.stateText, 'Connected');
  assert.equal(a.summary, 'Household budget.');
  assert.equal(a.usedBy, 'Used by Leonard');
  assert.match(a.toolsLine, /^4 tools: 1 run on their own, 3 ask first$/);
  const main = JSON.stringify([a.summary, a.problem, a.usedBy, a.toolsLine, a.actions, a.reconnect]);
  assert.ok(!/apps\.json|set up on the server|own process|EXTRA_MCP/i.test(main), `no jargon: ${main}`);
  assert.deepEqual(a.actions.map((x) => x.id), ['turn_off', 'remove'], 'a server-file connection can be turned off and removed here');
  assert.equal(a.reconnect.label, 'Reconnect');
  assert.ok(a.details.some((d) => d.label === 'Set up in' && /apps\.json/.test(d.value)), 'the file is named only under details');
  assert.ok(!JSON.stringify(await conn.connectionsFor('u_owner')).includes('sekrit-value'), 'never a key');
  const send = a.tools.find((t) => t.name === 'send_note');
  assert.deepEqual(send.choices, ['asks', 'off'], 'a tool that must ask cannot be set to run on its own');
});

await test('someone who is not the owner sees only connections their bots can have, and no actions', async () => {
  const k = await conn.connectionsFor('u_sam');
  assert.equal(k.owner, false);
  for (const c of k.connections) {
    assert.deepEqual(c.actions, []);
    assert.equal(c.reconnect, null);
    assert.ok(c.bots.every((b) => b.id === 'b_robin'), 'only her own bots');
  }
  assert.deepEqual(k.ready, []);
  assert.throws(() => conn.propose('u_sam', 'actual', 'turn_off'), /Only the owner/);
  assert.throws(() => conn.setToolRule('u_sam', 'actual', 'delete_case', 'off'), /Only the owner/);
});

await test('per-tool rules: stricter always, looser only where nothing fixed says otherwise, back to default', async () => {
  const t = { appId: 'actual', tool: 'delete_case', readOnly: false };
  assert.equal(apps.appRule(t).decision, 'ask');
  assert.equal(conn.setToolRule('u_owner', 'actual', 'delete_case', 'runs').rule, 'runs');
  assert.equal(apps.appRule(t).decision, 'allow');
  assert.equal(conn.setToolRule('u_owner', 'actual', 'delete_case', 'off').rule, 'off');
  assert.deepEqual(apps.appRule(t), { decision: 'block', fixed: true });
  assert.throws(() => conn.setToolRule('u_owner', 'actual', 'send_note', 'runs'), /Always asks first/);
  assert.equal(conn.setToolRule('u_owner', 'actual', 'send_note', 'off').rule, 'off', 'a must-ask tool can still be switched off');
  assert.equal(apps.appRule({ appId: 'actual', tool: 'list_cases', readOnly: true }).decision, 'allow');
  conn.setToolRule('u_owner', 'actual', 'list_cases', 'asks');
  assert.deepEqual(apps.appRule({ appId: 'actual', tool: 'list_cases', readOnly: true }), { decision: 'ask', fixed: true });
  for (const tool of ['delete_case', 'send_note', 'list_cases']) conn.setToolRule('u_owner', 'actual', tool, null);
  assert.equal(apps.appRule(t).decision, 'ask', 'back to the default');
  assert.equal((await get('actual')).tools.every((x) => !x.chosen), true);
});

await test('Turn off and Turn on edit the server file with the digest shown, and Undo puts it back', async () => {
  const p = conn.propose('u_owner', 'actual', 'turn_off');
  assert.equal(p.summary, 'Turn off Actual');
  assert.ok(p.details.some((d) => /Leonard loses its tools/.test(d)));
  await assert.rejects(() => conn.confirm('u_owner', null, p.id, 'wrong', opts), /not the one shown/);
  await assert.rejects(() => conn.confirm('u_owner', 'Claude: test', p.id, p.digest, opts), /Only a person/);
  await conn.confirm('u_owner', null, p.id, p.digest, opts);
  assert.equal(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((x) => x.id === 'actual').enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((x) => x.id === 'actual').env.ACTUAL_KEY, 'sekrit-value', 'its key is kept');
  const off = await get('actual');
  assert.equal(off.state, 'off');
  assert.deepEqual(off.actions.map((x) => x.id), ['turn_on', 'remove']);
  assert.equal(off.reconnect, null);
  const h = admin.history(5)[0];
  assert.equal(h.summary, 'Turn off Actual', 'in the words the person saw');
  assert.equal(h.bot, 'Alex', 'recorded as the person, not a bot');
  assert.equal(h.byPerson, true);
  assert.equal(h.canRollBack, true);
  await admin.undoAsPerson('u_owner', h.id, 'Undo in the web');
  assert.equal(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((x) => x.id === 'actual').enabled, undefined, 'Undo restores the entry exactly');
  assert.throws(() => conn.propose('u_owner', 'actual', 'turn_on'), /already on/);
  const off2 = conn.propose('u_owner', 'actual', 'turn_off');
  await conn.confirm('u_owner', null, off2.id, off2.digest, opts);
  const on = conn.propose('u_owner', 'actual', 'turn_on');
  await conn.confirm('u_owner', null, on.id, on.digest, opts);
  assert.equal('enabled' in JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((x) => x.id === 'actual'), false, 'Turn on takes the switch out again');
  await apps.listAppTools();
});

await test('Remove takes an entry out of the server file, a stale confirm is refused, and Undo puts it back', async () => {
  const p = conn.propose('u_owner', 'actual', 'remove');
  const stale = conn.propose('u_owner', 'actual', 'turn_off');
  await conn.confirm('u_owner', null, p.id, p.digest, opts);
  assert.equal(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.some((x) => x.id === 'actual'), false);
  assert.equal(await get('actual'), undefined);
  await assert.rejects(() => conn.confirm('u_owner', null, stale.id, stale.digest, opts), /no longer|changed|not an apps.json|No connected app/i, 'a confirm shown before the removal does nothing');
  await admin.undoAsPerson('u_owner', admin.history(5)[0].id, 'Undo in the web');
  await apps.listAppTools();
  assert.equal((await get('actual')).state, 'connected');
  const c = conn.propose('u_owner', 'actual', 'remove');
  assert.equal(conn.cancel('u_owner', c.id).status, 'cancelled');
  await assert.rejects(() => conn.confirm('u_owner', null, c.id, c.digest, opts), /expired or was cancelled/);
});

await test('Reconnect starts a plain connection again', async () => {
  await assert.rejects(() => conn.reconnect('u_owner', 'Claude: test', 'actual', opts), /Only a person/);
  const r = await conn.reconnect('u_owner', null, 'actual', { base: opts.base, origin: opts.base });
  assert.match(r.note, /^Reconnected\. 4 tools ready\.$/);
});

await test('an older Google connection without Tasks says so, and Reconnect moves its bots to the new sign-in', async () => {
  const old = await get('google');
  assert.equal(old.kind, 'google');
  assert.equal(old.state, 'needs_reconnect');
  assert.match(old.problem, /without Tasks/);
  await assert.rejects(() => conn.reconnect('u_owner', null, 'google', { base: opts.base, origin: opts.base }), /confirm moving its Bots/);
  g.saveClient('u_owner', null, JSON.stringify({ web: { client_id: '1-abc.apps.googleusercontent.com', client_secret: 'shh' } }));
  const p = conn.propose('u_owner', 'google', 'reconnect');
  assert.ok(p.details.some((d) => /Leonard moves to the new sign-in/.test(d)));
  const r = await conn.confirm('u_owner', null, p.id, p.digest, opts);
  const su = new URL(r.signInUrl);
  assert.ok(su.searchParams.get('scope').includes('/auth/tasks'), 'asks for Tasks with changes allowed');
  const real = globalThis.fetch;
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'alex@example.test', sub: '42' })).toString('base64url')}.y`;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: g.SCOPES.write.join(' '), id_token: idToken }), { headers: { 'Content-Type': 'application/json' } });
  try { await g.finishGoogle({ code: 'C', state: su.searchParams.get('state') }); } finally { globalThis.fetch = real; }
  const id = 'google-alex-example-test';
  assert.equal(registry.enabledFor(id, 'b_leonard'), true, 'Leonard has the new sign-in');
  assert.equal(registry.enabledFor(id, 'b_howard'), false, 'nobody else gets it');
  assert.equal(registry.enabledFor('google', 'b_leonard'), false, 'the old one is switched off for him');
  const moves = admin.history(5).filter((h) => h.byPerson && h.action === 'set_bot');
  assert.equal(moves.length, 2, 'both moves are in Recent changes');
  assert.ok(moves.every((m) => m.canRollBack));
  const nu = await get(id);
  assert.equal(nu.kind, 'google');
  assert.match(nu.summary, /^Gmail, Calendar, Drive and Tasks for alex@example\.test\. Reads run on their own; changes ask first\.$/);
  assert.equal(nu.reconnect.write, true);
  assert.deepEqual(nu.actions.map((x) => x.id), ['remove', 'delete']);
});

await test('Reconnect on a Google account opens Google on that account, keeping its mode', async () => {
  const r = await conn.reconnect('u_owner', null, 'google-alex-example-test', { base: opts.base, origin: opts.base });
  const su = new URL(r.signInUrl);
  assert.equal(su.searchParams.get('login_hint'), 'alex@example.test');
  assert.ok(su.searchParams.get('scope').includes('gmail.compose'), 'keeps changes allowed');
  const ro = new URL((await conn.reconnect('u_owner', null, 'google-alex-example-test', { write: false, base: opts.base, origin: opts.base })).signInUrl);
  assert.ok(!ro.searchParams.get('scope').includes('gmail.compose'), 'or read only when asked');
});

await test('a Google account missing a scope needs reconnecting; Disconnect deletes it with the digest', async () => {
  const id = 'google-alex-example-test';
  const credsFile = path.join(dir, 'google', id, 'creds', 'alex@example.test.json');
  const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  fs.writeFileSync(credsFile, JSON.stringify({ ...creds, scopes: creds.scopes.filter((s) => !s.endsWith('/tasks')) }));
  const c = await get(id);
  assert.equal(c.state, 'needs_reconnect');
  assert.equal(c.problem, 'Tasks isn\'t allowed yet. Press Reconnect and tick every box on Google\'s page.');
  const p = conn.propose('u_owner', id, 'delete');
  assert.equal(p.summary, 'Disconnect Google (alex@example.test)');
  await conn.confirm('u_owner', null, p.id, p.digest, opts);
  assert.equal(await get(id), undefined);
  assert.equal(fs.existsSync(path.join(dir, 'google', id)), false, 'its keys are gone');
});

await apps.stopApps?.();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
