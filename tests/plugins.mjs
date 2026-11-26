// Tests for the plugin system (server/src/plugins/*) against the built server code, a throwaway
// database and the fake MCP server in tests/fixtures. Nothing leaves this machine.
//   npm run build -w server && node tests/plugins.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-plugins-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), APP_URL: 'http://localhost:5173',
  OWNER_EMAIL: 'owner@example.test', PLUGINS_UNSANDBOXED: '1', PLUGINS_ALLOW_LOCAL_TARBALLS: '1',
});
delete process.env.EXTRA_MCP_SERVERS;
const demoServer = path.join(here, 'fixtures/demo-mcp-server.mjs');
const demo = { id: 'demo', name: 'Demo CMS', command: process.execPath, args: [demoServer], block: ['delete_*'] };
const writeApps = (list) => {
  fs.writeFileSync(process.env.APPS_CONFIG, JSON.stringify({ apps: list }));
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
  fs.utimesSync(process.env.APPS_CONFIG, t, t);
};
writeApps([demo]);

const { db } = await import('../server/dist/db.js');
const apps = await import('../server/dist/local-apps.js');
const registry = await import('../server/dist/plugins/registry.js');
const { policyFor } = await import('../server/dist/agent/tools.js');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};

// Two accounts and four bots.
const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_owner', 'owner@example.test', 'Owner', t0);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_other', 'other@example.test', 'Other', t0);
const addBot = (id, user, name, i) => db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, user, name, t0 + i, t0 + i);
addBot('b_howard', 'u_owner', 'Howard', 1);
addBot('b_sheldon', 'u_owner', 'Sheldon', 2);
addBot('b_leonard', 'u_owner', 'Leonard', 3);
addBot('b_robin', 'u_other', 'Robin', 4);

// ---------- per-bot plugins ----------

await test('a hand-written apps.json entry without "bots" goes to every bot, as before', async () => {
  for (const b of ['b_howard', 'b_sheldon', 'b_robin']) assert.equal(registry.enabledFor('demo', b), true);
  assert.equal((await registry.toolsForBot('b_robin')).length, 4);
});

await test('"bots" names the bots that get it, by id or by name (any case)', async () => {
  writeApps([{ ...demo, bots: ['sheldon', 'b_leonard'] }]);
  assert.equal(registry.enabledFor('demo', 'b_sheldon'), true);
  assert.equal(registry.enabledFor('demo', 'b_leonard'), true);
  assert.equal(registry.enabledFor('demo', 'b_howard'), false);
  assert.equal((await registry.toolsForBot('b_howard')).length, 0);
});

await test("a bot without the plugin has its tools refused, even with a stored 'Always allow'", async () => {
  db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,?)').run('u_owner', 'demo__tag_case', 'always_allow');
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_howard').decision, 'block');
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_sheldon').decision, 'allow');
  db.prepare('DELETE FROM policies WHERE tool=?').run('demo__tag_case');
});

await test("the owner's switch overrides the default both ways, and is read back", async () => {
  assert.deepEqual(registry.setEnabled('u_owner', 'demo', 'b_howard', true), { pluginId: 'demo', botId: 'b_howard', enabled: true });
  assert.deepEqual(registry.setEnabled('u_owner', 'demo', 'b_sheldon', false), { pluginId: 'demo', botId: 'b_sheldon', enabled: false });
  assert.equal(registry.enabledFor('demo', 'b_sheldon'), false);
  const n = db.prepare("SELECT count(*) n FROM plugin_audit WHERE plugin_id='demo'").get().n;
  assert.equal(n, 2);
  db.prepare('DELETE FROM plugin_bots').run();
});

await test('an exclusive plugin is on for one bot at most', async () => {
  writeApps([{ ...demo, exclusive: true, bots: ['Sheldon'] }]);
  assert.equal(registry.enabledFor('demo', 'b_sheldon'), true);
  assert.throws(() => registry.setEnabled('u_owner', 'demo', 'b_howard', true), /one bot only, and Sheldon has it/);
  registry.setEnabled('u_owner', 'demo', 'b_sheldon', false);
  registry.setEnabled('u_owner', 'demo', 'b_howard', true);
  assert.deepEqual(registry.botsWith('demo').map((b) => b.name), ['Howard']);
  db.prepare('DELETE FROM plugin_bots').run();
  writeApps([{ ...demo, exclusive: true, bots: ['*'] }]);
  assert.equal(registry.botsWith('demo').length, 0, 'an exclusive plugin naming every bot is on for none');
});

await test('plugins installed through the app are off for every bot until the owner turns them on', async () => {
  writeApps([]);
  const dispose = apps.registerAppSource('test', () => [{ ...demo, id: 'inst', origin: 'installed' }]);
  assert.equal(registry.botsWith('inst').length, 0);
  registry.setEnabled('u_owner', 'inst', 'b_leonard', true);
  assert.deepEqual(registry.botsWith('inst').map((b) => b.name), ['Leonard']);
  dispose();
  assert.equal(registry.enabledFor('inst', 'b_leonard'), false, 'a plugin that is gone is off');
  db.prepare('DELETE FROM plugin_bots').run();
  writeApps([demo]);
});

await test('unknown plugins and unknown bots are refused', async () => {
  assert.throws(() => registry.setEnabled('u_owner', 'nope', 'b_howard', true), /No plugin/);
  assert.throws(() => registry.setEnabled('u_owner', 'demo', 'b_nope', true), /No such bot/);
  assert.equal(registry.enabledFor('demo', 'b_nope'), false);
});

// ---------- approval stages: plugins can only make rules stricter ----------

const policy = await import('../server/dist/plugins/policy.js');
await apps.ensureApps();

await test('a stage that says "allow" is ignored: an asking tool still asks', async () => {
  const off = policy.registerPolicyStage('loosen', () => 'allow');
  const p = policyFor('u_owner', 'demo__send_note', {}, 'b_howard');
  off();
  assert.equal(p.decision, 'ask');
});

await test("a stage's ask beats 'Always allow', and cannot be remembered away", async () => {
  db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,?)').run('u_owner', 'demo__tag_case', 'always_allow');
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_howard').decision, 'allow');
  const off = policy.registerPolicyStage('careful', ({ tool }) => (tool === 'tag_case' ? 'ask' : undefined));
  const p = policyFor('u_owner', 'demo__tag_case', {}, 'b_howard');
  off();
  db.prepare('DELETE FROM policies WHERE tool=?').run('demo__tag_case');
  assert.equal(p.decision, 'ask');
  assert.deepEqual(p.asks, [], 'no "Always allow" offered');
});

await test('a stage can block a read-only tool; a stage that throws blocks (fails closed)', async () => {
  assert.equal(policyFor('u_owner', 'demo__list_cases', {}, 'b_howard').decision, 'allow');
  let off = policy.registerPolicyStage('strict', () => 'block');
  assert.equal(policyFor('u_owner', 'demo__list_cases', {}, 'b_howard').decision, 'block');
  off();
  off = policy.registerPolicyStage('broken', () => { throw new Error('boom'); });
  assert.equal(policyFor('u_owner', 'demo__list_cases', {}, 'b_howard').decision, 'block');
  off();
  assert.equal(policyFor('u_owner', 'demo__list_cases', {}, 'b_howard').decision, 'allow');
});

await test('a stage sees who is calling and with what', async () => {
  let seen;
  const off = policy.registerPolicyStage('spy', (i) => { seen = i; });
  policyFor('u_owner', 'demo__send_note', { to: 'x' }, 'b_howard');
  off();
  assert.deepEqual(seen, { userId: 'u_owner', botId: 'b_howard', name: 'demo__send_note', appId: 'demo', tool: 'send_note', args: { to: 'x' } });
});

await test("an installed plugin's own allow patterns and read-only hints are not trusted", async () => {
  const dispose = apps.registerAppSource('test', () => [{ ...demo, id: 'inst', allow: ['*'], origin: 'installed' }]);
  await apps.ensureApps();
  registry.setEnabled('u_owner', 'inst', 'b_howard', true);
  assert.equal(policyFor('u_owner', 'inst__list_cases', {}, 'b_howard').decision, 'ask');
  assert.equal(policyFor('u_owner', 'inst__send_note', {}, 'b_howard').decision, 'ask');
  assert.equal(policyFor('u_owner', 'inst__delete_case', {}, 'b_howard').decision, 'block', 'its own block rules still apply');
  dispose();
  db.prepare('DELETE FROM plugin_bots').run();
});

// ---------- owner-only install and switches, on a confirm step ----------

const changes = await import('../server/dist/plugins/changes.js');
const store = await import('../server/dist/plugins/store.js');
const { execFileSync } = await import('node:child_process');

/** Pack tests/fixtures/plain-plugin (plus any changes) into a tarball like npm's. */
const pack = (name, tweak = () => {}) => {
  const work = fs.mkdtempSync(path.join(dir, 'pack-'));
  fs.cpSync(path.join(here, 'fixtures/plain-plugin'), path.join(work, 'package'), { recursive: true });
  tweak(path.join(work, 'package'));
  const tgz = path.join(dir, `${name}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package']);
  return tgz;
};
const good = pack('plain');

await test('only the owner can ask for a change', async () => {
  assert.throws(() => changes.proposeChange('u_other', { action: 'enable', pluginId: 'demo', botId: 'b_robin' }), /Only the owner/);
  assert.throws(() => changes.proposeChange('u_other', { action: 'install', spec: `file:${good}` }), /Only the owner/);
});

await test('a switch waits for confirm, which needs the digest shown, and reads back', async () => {
  writeApps([{ ...demo, bots: [] }]);
  const ch = changes.proposeChange('u_owner', { action: 'enable', pluginId: 'demo', botId: 'b_leonard' });
  assert.equal(ch.status, 'pending');
  assert.match(ch.summary, /Turn on Demo CMS for Leonard/);
  assert.equal(registry.enabledFor('demo', 'b_leonard'), false, 'nothing changes before confirm');
  assert.throws(() => changes.confirmChange('u_owner', ch.id, 'x'.repeat(64)), /not the change you were shown/);
  assert.throws(() => changes.confirmChange('u_other', ch.id, ch.digest), /Only the owner/);
  const done = changes.confirmChange('u_owner', ch.id, ch.digest);
  assert.equal(done.status, 'applied');
  assert.equal(done.result.plugin.bots.find((b) => b.id === 'b_leonard').enabled, true);
  const again = changes.confirmChange('u_owner', ch.id, ch.digest);
  assert.deepEqual(again, done, 'confirming twice changes nothing more');
  assert.equal(db.prepare("SELECT count(*) n FROM plugin_audit WHERE plugin_id='demo' AND bot_id='b_leonard'").get().n, 1);
  db.prepare('DELETE FROM plugin_bots').run();
  writeApps([demo]);
});

await test('an expired change cannot be confirmed', async () => {
  const ch = changes.proposeChange('u_owner', { action: 'disable', pluginId: 'demo', botId: 'b_howard' });
  db.prepare('UPDATE plugin_changes SET expires_at=? WHERE id=?').run(Date.now() - 1, ch.id);
  assert.throws(() => changes.confirmChange('u_owner', ch.id, ch.digest), /expired/);
  assert.equal(registry.enabledFor('demo', 'b_howard'), true);
});

await test('packages with install scripts, links, loose dependencies or a loose version are refused', async () => {
  const bad = [
    [pack('scripts', (d) => { const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'))); p.scripts = { postinstall: 'node x' }; fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(p)); }), /install scripts/],
    [pack('link', (d) => fs.symlinkSync('/etc/passwd', path.join(d, 'passwd'))), /link/],
    [pack('deps', (d) => { const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'))); p.dependencies = { zod: '^3' }; fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(p)); }), /shrinkwrap/],
  ];
  for (const [tgz, why] of bad) assert.throws(() => changes.proposeChange('u_owner', { action: 'install', spec: `file:${tgz}` }), why);
  assert.throws(() => changes.proposeChange('u_owner', { action: 'install', spec: 'some-plugin@^1.0.0' }), /exact-version/);
  assert.throws(() => changes.proposeChange('u_owner', { action: 'install', spec: 'file:relative.tgz' }), /absolute path/);
});

await test('an install is shown with its fingerprint, lands switched off, and runs without the server\'s secrets', async () => {
  const ch = changes.proposeChange('u_owner', { action: 'install', spec: `file:${good}` });
  assert.match(ch.summary, /Install Plain 1\.0\.0/);
  assert.match(ch.digest, /^[0-9a-f]{64}$/);
  assert.ok(ch.details.some((d) => /no network/i.test(d)));
  assert.equal(store.installedPlugin('plain-plugin'), undefined, 'nothing installed before confirm');
  const done = changes.confirmChange('u_owner', ch.id, ch.digest);
  assert.equal(done.result.installed.digest, ch.digest);
  assert.ok(done.result.plugin.bots.every((b) => !b.enabled), 'off for every bot');
  registry.setEnabled('u_owner', 'plain-plugin', 'b_howard', true);
  await apps.ensureApps();
  assert.equal(policyFor('u_owner', 'plain-plugin__echo', {}, 'b_howard').decision, 'ask', 'its own allow and read-only hint are ignored');
  assert.equal(policyFor('u_owner', 'plain-plugin__wipe', {}, 'b_howard').decision, 'block', 'its own block rule applies');
  const out = await apps.callAppTool(apps.findAppTool('plain-plugin__echo'), { text: 'hi' });
  assert.equal(out.output, 'echo:hi:clean');
});

await test('a package changed after the card was shown is not installed', async () => {
  const tgz = pack('plain2', (d) => { const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'))); p.version = '1.0.1'; fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(p)); });
  const ch = changes.proposeChange('u_owner', { action: 'install', spec: `file:${tgz}` });
  const stagedDir = db.prepare('SELECT payload FROM plugin_changes WHERE id=?').get(ch.id);
  fs.appendFileSync(path.join(JSON.parse(stagedDir.payload).dir, 'server.mjs'), '\n// sneaky\n');
  assert.throws(() => changes.confirmChange('u_owner', ch.id, ch.digest), /changed after you were shown it/);
  assert.equal(store.installedPlugin('plain-plugin').version, '1.0.0');
});

await test('remove and restore go through the same confirm step', async () => {
  const rm = changes.proposeChange('u_owner', { action: 'remove', pluginId: 'plain-plugin' });
  assert.ok(rm.details.some((d) => /Howard/.test(d)));
  changes.confirmChange('u_owner', rm.id, rm.digest);
  assert.equal(store.installedPlugin('plain-plugin'), undefined);
  assert.equal(registry.enabledFor('plain-plugin', 'b_howard'), false);
  const back = changes.proposeChange('u_owner', { action: 'restore', pluginId: 'plain-plugin' });
  const r = changes.confirmChange('u_owner', back.id, back.digest);
  assert.equal(r.result.installed.version, '1.0.0');
  assert.equal(registry.enabledFor('plain-plugin', 'b_howard'), true, 'the switch was kept');
  db.prepare('DELETE FROM plugin_bots').run();
});

await test('a restore card is refused if that version\'s files changed after it was shown', async () => {
  const rm = changes.proposeChange('u_owner', { action: 'remove', pluginId: 'plain-plugin' });
  changes.confirmChange('u_owner', rm.id, rm.digest);
  const back = changes.proposeChange('u_owner', { action: 'restore', pluginId: 'plain-plugin' });
  const dir = store.pluginHistory('plain-plugin').find((h) => h.digest === back.digest).dir;
  const f = path.join(dir, fs.readdirSync(dir).find((n) => fs.statSync(path.join(dir, n)).isFile()));
  const was = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, was + '\n// changed\n');
  assert.throws(() => changes.confirmChange('u_owner', back.id, back.digest), /changed or are gone/);
  assert.equal(store.installedPlugin('plain-plugin'), undefined);
  fs.writeFileSync(f, was);
  const again = changes.proposeChange('u_owner', { action: 'restore', pluginId: 'plain-plugin' });
  changes.confirmChange('u_owner', again.id, again.digest);
  assert.ok(store.installedPlugin('plain-plugin'));
});

await test('a removal card only removes its displayed version', async () => {
  const old = store.installedPlugin('plain-plugin');
  const rm = changes.proposeChange('u_owner', { action: 'remove', pluginId: old.id });
  const tgz = pack('plain-new', (d) => {
    const f = path.join(d, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(f));
    fs.writeFileSync(f, JSON.stringify({ ...pkg, version: '1.0.2' }));
  });
  const add = changes.proposeChange('u_owner', { action: 'install', spec: `file:${tgz}` });
  changes.confirmChange('u_owner', add.id, add.digest);
  assert.throws(() => changes.confirmChange('u_owner', rm.id, rm.digest), (e) => e.status === 409);
  assert.equal(store.installedPlugin(old.id).digest, add.digest);
  const back = changes.proposeChange('u_owner', { action: 'restore', pluginId: old.id, digest: old.digest });
  changes.confirmChange('u_owner', back.id, back.digest);
});

// ---------- Hermes' own tools go through the gate ----------

const gate = await import('../server/dist/plugins/hermes-gate.js');

await test("Hermes' read-only tools run, others ask (and can be remembered), unknown names are refused", async () => {
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'read_file', {}).decision, 'allow');
  const t = gate.hermesPolicy('u_owner', 'b_howard', 'terminal', { command: 'ls' });
  assert.equal(t.decision, 'ask');
  assert.deepEqual(t.asks, ['hermes__terminal']);
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'brand_new_tool', {}).decision, 'ask', 'a tool we do not know asks');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'bad name; rm', {}).decision, 'block');
  // An older "Always allow" stored for every bot is honoured, risky or not (the owner decides).
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES ('u_owner','hermes__terminal','always_allow')").run();
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'terminal', {}).decision, 'allow', 'old always_allow on the terminal');
  db.prepare("DELETE FROM policies WHERE tool='hermes__terminal'").run();
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES ('u_owner','hermes__tool_search','always_allow')").run();
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'tool_search', {}).decision, 'allow');
  const off = policy.registerPolicyStage('no-search', ({ appId, tool }) => (appId === 'hermes' && tool === 'tool_search' ? 'block' : undefined));
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'tool_search', {}).decision, 'block', 'stages apply to Hermes tools too');
  off();
  db.prepare("DELETE FROM policies WHERE tool='hermes__tool_search'").run();
});

await test("a bot's auto-save switch lets its skill writes through, never deletes, and a block still wins", async () => {
  const create = { action: 'create', name: 'x', content: '---\nname: x\n---\n' };
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', create).decision, 'ask', 'off by default');
  db.prepare("UPDATE bots SET auto_save_skills=1 WHERE id='b_howard'").run();
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', create).decision, 'allow');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', { action: 'patch', name: 'x', old_string: 'a', new_string: 'b' }).decision, 'allow');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', { action: 'delete', name: 'x' }).decision, 'ask', 'deleting still asks');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', { action: 'remove_file', name: 'x', file_path: 'a' }).decision, 'ask');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', { operations: [{ action: 'create' }, { action: 'delete' }] }).decision, 'ask', 'a batch with a delete asks');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', { operations: [{ action: 'create' }, { action: 'patch' }] }).decision, 'allow');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'terminal', {}).decision, 'ask', 'only skill writes are covered');
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES ('u_owner','hermes__skill_manage','blocked')").run();
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'skill_manage', create).decision, 'block', "a stored Don't allow still wins");
  db.prepare("DELETE FROM policies WHERE tool='hermes__skill_manage'").run();
  db.prepare("UPDATE bots SET auto_save_skills=0 WHERE id='b_howard'").run();
});

// ---------- "Always allow" rules: one bot, one low-risk tool ----------

const rules = await import('../server/dist/allow-rules.js');

await test('risky tools (shell, files, deleting, sending, money, PCs, installing) are flagged with a warning', async () => {
  for (const k of ['hermes__terminal', 'hermes__execute_code', 'hermes__write_file', 'hermes__patch', 'hermes__computer_use', 'hermes__browser_click',
    'hermes__browser_type', 'hermes__cronjob_manage', 'hermes__send_message', 'demo__send_note', 'demo__delete_case', 'gmail__send_email',
    'actual-budget__actual_transactions_update', 'actual-budget__actual_budgets_setAmount', 'host-admin__service_control', 'native__fs_write',
    'x__shell_exec', 'webull__place_stock_instruction', 'm365__reply-mail', 'x__install_plugin', 'x__run_command', 'files__write_file', 'files__move_file']) {
    assert.ok(rules.alwaysAllowRisk(k), `${k} should be flagged risky`);
  }
  for (const k of ['hermes__tool_search', 'hermes__memory', 'hermes__browser_navigate', 'hermes__delegate_task', 'demo__tag_case',
    'googlecalendar__create_event', 'gtasks__update_task', 'hermes__image_generate']) {
    assert.equal(rules.alwaysAllowRisk(k), null, `${k} is not risky`);
  }
  assert.deepEqual(rules.alwaysAllowFor(['demo__tag_case']), { canAlways: true, lowRisk: true });
  const risky = rules.alwaysAllowFor(['demo__tag_case', 'demo__send_note']);
  assert.equal(risky.canAlways, true, 'still offered: the owner decides');
  assert.equal(risky.lowRisk, false);
  assert.equal(risky.risk, 'message');
  assert.match(risky.alwaysNote, /send messages/);
  assert.equal(rules.alwaysAllowFor([]).canAlways, false, 'nothing listed, nothing to remember');
});

await test('a rule covers one bot and one tool, risky ones too; a block or a stage still wins', async () => {
  rules.createRules({ userId: 'u_owner', botId: 'b_sheldon', tools: ['demo__tag_case'], labelOf: () => 'Demo: tag case', createdBy: 'Owner', createdVia: 'web', approvalId: 'apr_x' });
  const p = policyFor('u_owner', 'demo__tag_case', {}, 'b_sheldon');
  assert.equal(p.decision, 'allow');
  assert.ok(p.viaRule, 'the decision names the rule, so its use is logged');
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_leonard').decision, 'ask', 'another bot still asks');
  assert.equal(policyFor('u_owner', 'demo__send_note', {}, 'b_sheldon').decision, 'ask', 'another tool still asks');
  // Risky tools can have a rule too, for that bot only.
  rules.createRules({ userId: 'u_owner', botId: 'b_sheldon', tools: ['demo__send_note', 'hermes__terminal'], labelOf: () => 'x', createdBy: 'Owner', createdVia: 'web', approvalId: 'apr_y' });
  assert.equal(policyFor('u_owner', 'demo__send_note', {}, 'b_sheldon').decision, 'allow', 'a rule for a risky tool');
  assert.equal(gate.hermesPolicy('u_owner', 'b_sheldon', 'terminal', {}).decision, 'allow', 'a rule for the terminal');
  assert.equal(gate.hermesPolicy('u_owner', 'b_leonard', 'terminal', {}).decision, 'ask', 'not for another bot');
  assert.equal(rules.listRules('u_owner', 'b_sheldon').find((r) => r.tool === 'hermes__terminal').risk, 'shell');
  db.prepare("DELETE FROM allow_rules WHERE tool IN ('demo__send_note','hermes__terminal')").run();
  // A stored "Don't allow" and a stage's ask both beat the rule.
  const off = policy.registerPolicyStage('careful', ({ tool }) => (tool === 'tag_case' ? 'ask' : undefined));
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_sheldon').decision, 'ask', "a stage's ask");
  off();
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES ('u_owner','demo__tag_case','blocked')").run();
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_sheldon').decision, 'block', "a stored Don't allow");
  db.prepare("DELETE FROM policies WHERE tool='demo__tag_case'").run();
  // Uses are counted and logged; the owner sees them; another account sees nothing and cannot remove it.
  rules.noteRuleUse(p.viaRule, 'b_sheldon', 'demo__tag_case', { id: 'C-1' }, 'Demo: tag case');
  const mine = rules.listRules('u_owner', 'b_sheldon');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].uses, 1);
  assert.equal(mine[0].createdBy, 'Owner');
  assert.equal(rules.ruleLog('u_owner', 'b_sheldon').length, 1);
  assert.equal(rules.listRules('u_other').length, 0);
  assert.equal(rules.ruleLog('u_other').length, 0);
  assert.equal(rules.deleteRule('u_other', mine[0].id), false, 'another account cannot remove it');
  assert.equal(rules.deleteRule('u_owner', mine[0].id), true);
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_sheldon').decision, 'ask', 'asks again once removed');
});

await test("Hermes tools: tool search needs no card; a rule for an unknown tool lets that bot's calls through, and nothing else", async () => {
  // Tool search itself only reads Hermes' own catalog, so it needs no card for any bot (hermes-gate.ts).
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'tool_search', { queries: ['gmail search messages'] }).decision, 'allow');
  assert.equal(gate.hermesPolicy('u_owner', 'b_leonard', 'tool_describe', {}).decision, 'allow');
  // A tool the list does not know asks, and a rule for it covers the one bot it was made for.
  assert.deepEqual(gate.hermesPolicy('u_owner', 'b_howard', 'brand_new_tool', {}).asks, ['hermes__brand_new_tool']);
  rules.createRules({ userId: 'u_owner', botId: 'b_howard', tools: ['hermes__brand_new_tool'], labelOf: () => 'Hermes: use brand new tool', createdBy: 'Owner', createdVia: 'phone app', approvalId: 'apr_z' });
  const p = gate.hermesPolicy('u_owner', 'b_howard', 'brand_new_tool', {});
  assert.equal(p.decision, 'allow');
  assert.ok(p.viaRule);
  assert.equal(gate.hermesPolicy('u_owner', 'b_leonard', 'brand_new_tool', {}).decision, 'ask', 'only the bot it was made for');
  assert.equal(gate.hermesPolicy('u_owner', 'b_howard', 'terminal', {}).decision, 'ask');
  db.prepare("DELETE FROM allow_rules WHERE bot_id='b_howard'").run();
});

await test('the gate plugin lets through only what the server allows, and fails closed', async () => {
  const http = await import('node:http');
  const { spawnSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(dir, 'hermes-'));
  let seen;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(seen.body.tool === 'read_file' ? { action: 'allow' } : { action: 'block', message: 'no' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/mcp/b_howard/gate`;
  assert.equal(gate.installGate(home, url, 'tok'), 'cleft-bot-gate');
  const cfgFile = path.join(home, 'plugins/cleft-bot-gate/gate.json');
  assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
  const py = (tool) => new Promise((resolve) => {
    const code = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(json.dumps(m.gate(tool_name=sys.argv[2],args={'a':1})))`;
    import('node:child_process').then(({ execFile }) => execFile('python3', ['-c', code, path.join(home, 'plugins/cleft-bot-gate/__init__.py'), tool], (e, out) => resolve(JSON.parse(out))));
  });
  assert.equal(await py('read_file'), null);
  assert.equal(seen.auth, 'Bearer tok');
  assert.deepEqual(seen.body, { tool: 'read_file', args: { a: 1 } });
  assert.equal((await py('terminal')).action, 'block');
  assert.equal(await py('mcp__hq__send_file'), null, 'our own /mcp tools are checked there');
  srv.close();
  assert.equal((await py('terminal')).action, 'block', 'server gone: blocked');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, platforms: ['api_server'] }));
  assert.equal(await py('terminal'), null, 'a session from another platform (here: none) keeps Hermes\' own rules');
  fs.rmSync(cfgFile);
  assert.equal((await py('read_file')).action, 'block', 'no config: blocked');
});

// ---------- what plugins may show: cards and settings forms (data only) ----------

const ui = await import('../server/dist/plugins/ui-schema.js');

await test('plugin cards are validated: https links only, no unknown blocks, limits', async () => {
  assert.equal(ui.validatePluginCard({ title: 'x', blocks: [{ kind: 'link', label: 'a', url: 'javascript:alert(1)' }] }).ok, false);
  assert.equal(ui.validatePluginCard({ title: 'x', blocks: [{ kind: 'link', label: 'a', url: 'http://plain.test' }] }).ok, false);
  assert.equal(ui.validatePluginCard({ title: 'x', blocks: [{ kind: 'html', html: '<script>' }] }).ok, false);
  assert.equal(ui.validatePluginCard({ title: 'x', blocks: [{ kind: 'image', url: 'data:image/svg+xml;base64,AA==', alt: 'a' }] }).ok, false, 'no SVG data URLs');
  assert.equal(ui.validatePluginCard({ title: 'x', blocks: Array(31).fill({ kind: 'text', text: 'a' }) }).ok, false);
  const ok = ui.validatePluginCard({ title: 'x', extra: 1, blocks: [{ kind: 'progress', label: 'p', value: 9, max: 5, onclick: 'x' }] });
  assert.deepEqual(ok, { ok: true, value: { title: 'x', blocks: [{ kind: 'progress', label: 'p', value: 5, max: 5 }] } }, 'unknown keys dropped, values clamped');
});

await test('settings: the form is checked, secrets are never handed back, blanks keep a stored secret', async () => {
  const spec = ui.validateSettingsSpec([{ key: 'greeting', label: 'Greeting', type: 'text', required: true }, { key: 'api_key', label: 'Key', type: 'secret' }]).value;
  assert.equal(ui.validateSettingsSpec([{ key: 'Bad Key', label: 'x', type: 'text' }]).ok, false);
  assert.equal(ui.validateSettingValues(spec, {}).ok, false, 'required');
  assert.equal(ui.validateSettingValues(spec, { greeting: 'a\nb' }).ok, false, 'one line');
  const v = ui.validateSettingValues(spec, { greeting: 'hi', api_key: '' }, { api_key: 'old' });
  assert.deepEqual(v.value, { greeting: 'hi', api_key: 'old' });
  assert.deepEqual(ui.publicValues(spec, v.value), { greeting: 'hi', api_key: { set: true } });
});

await test("a plugin's card reaches the conversation as data; settings reach the plugin as its environment", async () => {
  const p = store.installedPlugin('plain-plugin');
  assert.equal(p.manifest.settings.length, 2);
  registry.setEnabled('u_owner', 'plain-plugin', 'b_howard', true);
  await apps.ensureApps();
  const good = await apps.callAppTool(apps.findAppTool('plain-plugin__show'), {});
  assert.equal(good.card.title, 'Case C-1');
  const bad = await apps.callAppTool(apps.findAppTool('plain-plugin__show'), { bad: true });
  assert.equal(bad.card, undefined, 'a card with a javascript: link is not shown');
  store.savePluginSettings('plain-plugin', { greeting: 'hello' }, 'u_owner');
  await apps.ensureApps();
  assert.equal((await apps.callAppTool(apps.findAppTool('plain-plugin__echo'), { text: 'x' })).output, 'echo:x:clean:hello');
  const cfg = apps.appConfig('plain-plugin');
  db.prepare('DELETE FROM plugin_bots').run();
  process.env.PLUGINS_UNSANDBOXED = '0';
  const docker = store.launchConfig(store.installedPlugin('plain-plugin'));
  process.env.PLUGINS_UNSANDBOXED = '1';
  assert.ok(docker.args.includes('--network') && docker.args[docker.args.indexOf('--network') + 1] === 'none');
  assert.ok(docker.args.includes('CLEFTBOT_SETTING_GREETING') && !docker.args.some((a) => a.includes('hello')), 'setting values are not on the command line');
  assert.equal(docker.env.CLEFTBOT_SETTING_GREETING, 'hello');
  assert.ok(cfg);
});

// ---------- plugins made with a bot: plan, Build, checks, review, Install, Undo ----------

const builder = await import('../server/dist/plugins/builder.js');
const rows = await import('../server/dist/store.js');
const cardOf = (botId, card) => db.prepare("SELECT body FROM rows WHERE bot_id=? AND body LIKE ? ORDER BY seq DESC LIMIT 1").get(botId, `%"card":"${card}"%`);
const lastCard = (botId, card) => { const r = cardOf(botId, card); return r && JSON.parse(r.body); };
const plan = { title: 'Weather', purpose: 'Look up the weather', tools: [{ name: 'forecast', description: 'Forecast', writes: false }], network: [] };
const goodFiles = {
  'package.json': JSON.stringify({ name: 'weather-plugin', version: '1.0.0', type: 'module', main: 'index.mjs' }),
  'index.mjs': "import { serve } from './cleftbot-mcp.mjs';\nserve({ name: 'weather', tools: [{ name: 'forecast', description: 'Forecast', readOnly: true, run: async ({ city }) => ({ text: `sunny in ${city}`, card: { title: 'Forecast', blocks: [{ kind: 'text', text: 'sunny' }] } }) }] });\n",
  'test.mjs': "process.exit(0);\n",
};

await test('a bot can only show a plan; files are refused until the owner presses Build', async () => {
  const { draftId } = builder.proposePlugin('u_owner', 'b_howard', plan);
  const card = lastCard('b_howard', 'plugin-plan');
  assert.equal(card.draftId, draftId);
  assert.equal(card.status, 'pending');
  await assert.rejects(builder.submitDraft('u_owner', 'b_howard', { draft_id: draftId, files: goodFiles }), /not pressed Build/);
  await assert.rejects(builder.submitDraft('u_owner', 'b_sheldon', { draft_id: draftId, files: goodFiles }), /No such plugin draft/, 'another bot cannot submit');
  assert.throws(() => builder.startBuild('u_other', draftId), /Only the owner/);
  assert.throws(() => builder.proposePlugin('u_owner', 'b_howard', { ...plan, network: ['not a host!'] }), /host names/);
  globalThis.draftId = draftId;
});

await test('after Build, bad files fail the checks: secrets, unplanned tools, path tricks', async () => {
  const { notice } = builder.startBuild('u_owner', globalThis.draftId);
  assert.match(notice, /submit_plugin_draft/);
  assert.equal(lastCard('b_howard', 'plugin-plan').status, 'building');
  await assert.rejects(builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: { '../x.mjs': '' } }), /not allowed/);
  let out = await builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: { ...goodFiles, 'index.mjs': goodFiles['index.mjs'] + "const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n" } }); // gitleaks:allow (made-up key)
  assert.match(out, /Secrets/);
  assert.equal(lastCard('b_howard', 'plugin-review').status, 'failed');
  out = await builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: { ...goodFiles, 'index.mjs': goodFiles['index.mjs'].replace("name: 'forecast'", "name: 'delete_all'") } });
  assert.match(out, /missing forecast; not in the plan: delete_all/);
  out = await builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: { ...goodFiles, 'test.mjs': 'process.exit(3);\n' } });
  assert.match(out, /test\.mjs failed/);
});

await test('good files pass, the review card carries the fingerprint, and only Install with it installs (switched off)', async () => {
  const out = await builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: goodFiles });
  assert.match(out, /All checks passed/);
  const card = lastCard('b_howard', 'plugin-review');
  assert.equal(card.status, 'pending');
  assert.match(card.digest, /^[0-9a-f]{64}$/);
  assert.ok(card.checks.every((c) => c.ok));
  assert.ok(fs.existsSync(path.join(process.env.PLUGINS_DIR, 'drafts', globalThis.draftId, '.git')), 'recorded in git');
  assert.throws(() => builder.installDraft('u_other', globalThis.draftId, card.digest), /Only the owner/);
  assert.throws(() => builder.installDraft('u_owner', globalThis.draftId, '0'.repeat(64)), /not the version you were shown/);
  const r = builder.installDraft('u_owner', globalThis.draftId, card.digest);
  assert.equal(r.pluginId, 'weather-plugin');
  assert.equal(store.installedPlugin('weather-plugin').digest, card.digest);
  assert.equal(registry.botsWith('weather-plugin').length, 0, 'installed switched off');
  assert.equal(lastCard('b_howard', 'plugin-review').status, 'installed');
  assert.deepEqual(builder.installDraft('u_owner', globalThis.draftId, card.digest), { pluginId: 'weather-plugin' }, 'a second Install changes nothing');
  await assert.rejects(builder.submitDraft('u_owner', 'b_howard', { draft_id: globalThis.draftId, files: goodFiles }), /installed/);
});

await test('Undo removes it; Restore from the Plugins page brings it back', async () => {
  builder.undoDraft('u_owner', globalThis.draftId);
  assert.equal(store.installedPlugin('weather-plugin'), undefined);
  assert.equal(lastCard('b_howard', 'plugin-review').status, 'removed');
  const back = changes.proposeChange('u_owner', { action: 'restore', pluginId: 'weather-plugin' });
  changes.confirmChange('u_owner', back.id, back.digest);
  assert.ok(store.installedPlugin('weather-plugin'));
  void rows;
});

await test('sending mail is spotted, and its card shows the whole email', async () => {
  for (const k of ['google__send_gmail_message', 'google-sam-example-com__send_gmail_message', 'gmail__send_email', 'm365__send-mail', 'm365__reply-mail', 'outlook__forward_mail']) {
    assert.ok(rules.isMailSend(k), `${k} sends mail`);
  }
  for (const k of ['gmail__send_draft', 'google__send_draft', 'outlook__reply']) assert.ok(rules.isMailSend(k), `${k} sends mail`);
  for (const k of ['google__draft_gmail_message', 'google__search_gmail_messages', 'demo__send_note', 'slack__send_message', 'hermes__send_message', 'google__send_calendar_invite']) {
    assert.equal(rules.isMailSend(k), false, `${k} does not send mail`);
  }
  const loop = await import('../server/dist/agent/loop.js');
  const m = loop.mailOnCard({ user_google_email: 'me@example.com', to: 'you@example.com', cc: 'c@example.com', subject: 'Hi', body: '<p>Hello</p>', body_format: 'html', attachments: [{ filename: 'a.pdf' }, '/tmp/b.txt'] });
  assert.equal(m.from, 'me@example.com');
  assert.equal(m.to, 'you@example.com');
  assert.equal(m.cc, 'c@example.com');
  assert.equal(m.html, true);
  assert.deepEqual(m.attachments, ['a.pdf', 'b.txt']);
  assert.equal(loop.mailOnCard({ reply_all: true, thread_id: 't1', body: 'x' }).replyAll, true);
  assert.equal(m.text, 'Hello');
  assert.equal(m.incomplete, undefined);
  // Links keep where they go; a nested message is read as the email; an unknown argument is listed.
  const n = loop.mailOnCard({ message: { to: [{ name: 'Ann', email: 'ann@example.com' }], subject: 'S', body: '<p>Pay <a href="https://evil.example/x">here</a></p>', body_format: 'html' }, track: true });
  assert.equal(n.to, 'Ann <ann@example.com>');
  assert.equal(n.text, 'Pay here (https://evil.example/x)');
  assert.deepEqual(n.other, [{ name: 'track', value: 'true' }]);
  assert.equal(n.incomplete, undefined);
  // A body it can't show, or nobody to send to, can't be sent from the card.
  assert.match(loop.mailOnCard({ to: 'a@example.com', body: { parts: [1] } }).incomplete, /can't be shown in full/);
  assert.match(loop.mailOnCard({ subject: 'x', body: 'y' }).incomplete, /nobody/);
  assert.match(loop.mailOnCard({ raw: 'TUlNRQ==' , to: 'a@example.com' }).incomplete, /raw MIME/);
});

await test('an app "allow" on a write tool runs without a card, offers nothing to remember, and is logged', async () => {
  // Leonard's Actual transaction tools (Alex, 2026-11-24): apps.json allow, one bot only.
  writeApps([{ ...demo, bots: ['Leonard'], allow: ['send_*'], ask: ['tag_*'] }]);
  await apps.listAppTools();
  const send = policyFor('u_owner', 'demo__send_note', {}, 'b_leonard');
  assert.equal(send.decision, 'allow');
  assert.equal(send.viaRule, 'app:demo');
  // A read stays a plain read, with no log line.
  const read = policyFor('u_owner', 'demo__list_cases', {}, 'b_leonard');
  assert.equal(read.decision, 'allow');
  assert.equal(read.viaRule, undefined);
  // A tool still under `ask` keeps its card, and another bot gets nothing.
  assert.equal(policyFor('u_owner', 'demo__tag_case', {}, 'b_leonard').decision, 'ask');
  assert.equal(policyFor('u_owner', 'demo__send_note', {}, 'b_howard').decision, 'block');
  const { noteRuleUse, ruleLog } = await import('../server/dist/allow-rules.js');
  noteRuleUse(send.viaRule, 'b_leonard', send.key, { to: 'x' }, send.title);
  const log = ruleLog('u_owner', 'b_leonard');
  assert.equal(log[0].ruleId, 'app:demo');
  assert.match(log[0].label, /allowed in app settings/);
  writeApps([demo]);
});

// @@MORE@@

await apps.stopApps();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
