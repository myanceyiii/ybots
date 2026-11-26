// Tests for the admin bot's connected-app tools (server/src/connector-admin.ts) against the built
// server code, a throwaway database, a throwaway apps.json and the fake MCP server in tests/fixtures.
// The approval card is stood in for by a function that answers it, so each case says who allowed what.
//   npm run build -w server && node tests/connector-admin.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-connector-admin-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), APP_URL: 'http://localhost:5173', OWNER_EMAIL: 'owner@example.test',
  CONNECTORS_CATALOG: path.join(dir, 'catalog.json'), GOOGLE_ACCOUNTS_DIR: path.join(dir, 'google'),
  CLEFT_MAINTAINER_LOG: path.join(dir, 'maintainer.log'),
});
delete process.env.EXTRA_MCP_SERVERS;
delete process.env.CONNECTOR_ADMIN_BOTS;
const demo = path.join(here, 'fixtures/demo-mcp-server.mjs');
const appsFile = process.env.APPS_CONFIG;
fs.writeFileSync(appsFile, JSON.stringify({ apps: [
  { id: 'actual', name: 'Actual', command: process.execPath, args: [demo], env: { ACTUAL_KEY: 'sekrit-value' }, bots: ['Leonard'] },
  { id: 'cms', name: 'Case management', command: process.execPath, args: [demo], bots: ['Howard'] },
] }, null, 2));
fs.writeFileSync(process.env.CONNECTORS_CATALOG, JSON.stringify({ connectors: [] }));

const { db } = await import('../server/dist/db.js');
await import('../server/dist/connectors.js');
const admin = await import('../server/dist/connector-admin.js');
const registry = await import('../server/dist/plugins/registry.js');
const tools = await import('../server/dist/agent/tools.js');
const apps = await import('../server/dist/local-apps.js');

const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_owner', 'owner@example.test', 'Owner', t0);
const addBot = (id, name, engine, i) => db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, 'u_owner', name, engine, t0 + i, t0 + i);
addBot('b_howard', 'Howard', 'primary', 1);
addBot('b_leonard', 'Leonard', 'managed', 2);

let cards = [];
/** Stands in for the approval card: records it and answers as a person would. */
const answer = (decision, by = 'Alex') => async (pol, args, meta) => {
  cards.push({ pol, args });
  Object.assign(meta, { approvalId: `apr_${cards.length}`, answeredBy: by, answeredVia: 'phone app' });
  return decision;
};

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${e.stack}`); }
}

await test('only the admin bot gets the tools', async () => {
  assert.equal(admin.isConnectorAdmin('b_howard'), true, 'the primary bot is the admin');
  assert.equal(admin.isConnectorAdmin('b_leonard'), false);
  const change = tools.toolMap.get('change_connected_app');
  assert.equal(tools.toolFor(change, 'b_leonard'), false, 'not listed for Leonard');
  assert.equal(tools.toolFor(change, 'b_howard'), true);
  assert.equal(tools.toolFor(tools.toolMap.get('list_apps'), 'b_leonard'), true, 'ordinary tools stay');
  await assert.rejects(() => admin.proposeAndApply('b_leonard', { action: 'restart', app: 'actual' }, answer('allow')), /Only the admin bot/);
  process.env.CONNECTOR_ADMIN_BOTS = 'Leonard';
  assert.equal(admin.isConnectorAdmin('b_leonard'), true, 'CONNECTOR_ADMIN_BOTS names the admins');
  assert.equal(admin.isConnectorAdmin('b_howard'), false);
  delete process.env.CONNECTOR_ADMIN_BOTS;
});

await test('the overview shows servers, tools and bots but never a key', async () => {
  const o = await admin.overview();
  const a = o.apps.find((x) => x.id === 'actual');
  assert.equal(a.server.transport, 'stdio');
  assert.deepEqual(a.server.env, { ACTUAL_KEY: '(hidden)' });
  assert.deepEqual(a.bots.have, ['Leonard']);
  assert.ok(a.tools.length > 0, 'its tools are listed');
  assert.equal(o.apps.find((x) => x.id === 'cms').firm, true, 'case management is a firm app');
  assert.ok(!JSON.stringify(o).includes('sekrit-value'), 'no key anywhere');
  const one = await admin.overview('actual');
  assert.ok(one.apps[0].tools[0].when, 'one app shows whether each tool runs or asks');
  await assert.rejects(() => admin.overview('nope'), /No connected app/);
  assert.ok(admin.logs('actual').some((l) => /ready with/.test(l)), 'its log has the connection');
});

await test('a change waits for its card; a declined card changes nothing', async () => {
  cards = [];
  const r = await admin.proposeAndApply('b_howard', { action: 'set_bot', app: 'actual', bot: 'Howard', on: true, why: 'test' }, answer('deny'));
  assert.equal(r.status, 'declined');
  assert.equal(registry.enabledFor('actual', 'b_howard'), false);
  assert.equal(cards.length, 1, 'one card for one change');
  assert.deepEqual(cards[0].pol.asks, [], 'no Always allow on the card');
  assert.match(cards[0].pol.detail, /Howard: does not have it → has it/);
  const skipped = await admin.proposeAndApply('b_howard', { action: 'set_bot', app: 'actual', bot: 'Howard', on: true }, answer('skipped'));
  assert.equal(skipped.status, 'not answered');
  assert.equal(registry.enabledFor('actual', 'b_howard'), false);
});

await test('set_bot applies once allowed, is logged with who allowed it, and rolls back', async () => {
  const r = await admin.proposeAndApply('b_howard', { action: 'set_bot', app: 'actual', bot: 'Howard', on: true }, answer('allow', 'Alex'));
  assert.equal(r.status, 'applied');
  assert.equal(registry.enabledFor('actual', 'b_howard'), true);
  const h = admin.history();
  assert.equal(h[0].id, r.id);
  assert.equal(h[0].approvedBy, 'Alex');
  assert.equal(h[0].canRollBack, true);
  assert.match(fs.readFileSync(process.env.CLEFT_MAINTAINER_LOG, 'utf8'), new RegExp(`change=${r.id} approved_by=Alex`));
  cards = [];
  const back = await admin.proposeAndApply('b_howard', { action: 'rollback', change: r.id }, answer('allow'));
  assert.equal(back.status, 'applied');
  assert.match(cards[0].pol.detail, /Undo/);
  assert.equal(registry.enabledFor('actual', 'b_howard'), false, 'back to the default');
  assert.equal(db.prepare('SELECT 1 FROM plugin_bots WHERE plugin_id=? AND bot_id=?').get('actual', 'b_howard'), undefined, 'the switch is cleared, not just flipped');
  await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'rollback', change: r.id }, answer('allow')), /already rolled back/);
});

await test('keys can never be set, edited or pulled in', async () => {
  for (const set of [{ env: { X: '1' } }, { headers: { Authorization: 'x' } }, { headersFile: '/etc/shadow' }, { oauth: {} }, { remote: true }]) {
    await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'edit_app', app: 'actual', set }, answer('allow')), /key/, JSON.stringify(set));
  }
  await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'edit_app', app: 'actual', set: { args: ['${SESSION_SECRET}'] } }, answer('allow')), /environment/);
  await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'edit_app', app: 'actual', unset: ['env'] }, answer('allow')), /key/);
  await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'add_app', app: 'leak', entry: { url: 'http://127.0.0.1:9/${HERMES_KEY}' } }, answer('allow')), /environment/);
  await assert.rejects(() => admin.proposeAndApply('b_howard', { action: 'add_app', app: 'far', entry: { url: 'https://example.com/mcp' } }, answer('allow')), /not on this machine/);
});

await test('edit_app shows old and new, keeps keys, and rolls back to the exact entry', async () => {
  cards = [];
  const before = JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((a) => a.id === 'actual');
  const r = await admin.proposeAndApply('b_howard', { action: 'edit_app', app: 'actual', set: { ask: ['*'], timeoutMs: 5000 } }, answer('allow'));
  assert.equal(r.status, 'applied');
  assert.match(cards[0].pol.detail, /ask: \(not set\) → \["\*"\]/);
  const after = JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((a) => a.id === 'actual');
  assert.deepEqual(after.ask, ['*']);
  assert.deepEqual(after.env, { ACTUAL_KEY: 'sekrit-value' }, 'the key stays where it was');
  assert.ok(fs.readdirSync(path.join(dir, 'data', 'apps-json-backups')).length >= 1, 'the old file is kept');
  await admin.proposeAndApply('b_howard', { action: 'rollback', change: r.id }, answer('allow'));
  assert.deepEqual(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((a) => a.id === 'actual'), before);
});

await test('add, remove (its own card) and restart', async () => {
  const add = await admin.proposeAndApply('b_howard', { action: 'add_app', app: 'notes', entry: { name: 'Notes', command: process.execPath, args: [demo], bots: ['Leonard'] } }, answer('allow'));
  assert.equal(add.status, 'applied');
  assert.ok(apps.appConfig('notes'));
  cards = [];
  const rm = await admin.proposeAndApply('b_howard', { action: 'remove_app', app: 'notes' }, answer('allow'));
  assert.equal(rm.status, 'applied');
  assert.match(cards[0].pol.detail, /turns something off or removes it/);
  assert.equal(apps.appConfig('notes'), undefined);
  const back = await admin.proposeAndApply('b_howard', { action: 'rollback', change: rm.id }, answer('allow'));
  assert.equal(back.status, 'applied');
  assert.ok(apps.appConfig('notes'), 'a removed app comes back');
  const rs = await admin.proposeAndApply('b_howard', { action: 'restart', app: 'actual' }, answer('allow'));
  assert.equal(rs.status, 'applied');
  assert.ok(rs.result.tools > 0, 'its tools are listed again');
});

await test('a firm app changes only on a card that says so', async () => {
  cards = [];
  const r = await admin.proposeAndApply('b_howard', { action: 'edit_app', app: 'cms', set: { timeoutMs: 9000 } }, answer('deny'));
  assert.equal(r.status, 'declined');
  assert.match(cards[0].pol.detail, /Work \(firm\) app/);
  assert.equal(JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps.find((a) => a.id === 'cms').timeoutMs, undefined);
});

await test('a person can press Undo in the app without a card', async () => {
  const r = await admin.proposeAndApply('b_howard', { action: 'set_bot', app: 'actual', bot: 'Howard', on: true }, answer('allow'));
  assert.equal(registry.enabledFor('actual', 'b_howard'), true);
  const u = await admin.undoAsPerson('u_owner', r.id, 'Undo in the web');
  assert.match(u.summary, /^Undo:/);
  assert.equal(registry.enabledFor('actual', 'b_howard'), false);
  const h = admin.history();
  assert.equal(h.find((x) => x.id === r.id).rolledBackBy, u.id);
  assert.equal(h.find((x) => x.id === u.id).approvedBy, 'Owner');
  await assert.rejects(() => admin.undoAsPerson('u_owner', r.id, 'web'), /already rolled back/);
});

await apps.stopApps();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
