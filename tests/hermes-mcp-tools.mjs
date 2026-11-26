// Howard's Hermes MCP connector (server/src/hermes-mcp-tools.ts): its reads run without a card, its risky
// tools always ask with no "Always allow", everything else asks as before. Throwaway database, a fake
// Hermes MCP server over stdio; nothing leaves this machine.
//   npm run build -w server && node tests/hermes-mcp-tools.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-hermes-mcp-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), OWNER_EMAIL: 'owner@example.test',
});
delete process.env.EXTRA_MCP_SERVERS;
delete process.env.MAINTAINER_BOTS;
const entry = { id: 'hermes-mcp', name: 'Hermes MCP', command: process.execPath, args: [path.join(here, 'fixtures/hermes-mcp-fake.mjs')], onlyBots: ['Howard'] };
fs.writeFileSync(process.env.APPS_CONFIG, JSON.stringify({ apps: [entry] }));

const { db } = await import('../server/dist/db.js');
const apps = await import('../server/dist/local-apps.js');
const { policyFor } = await import('../server/dist/agent/tools.js');
const gate = await import('../server/dist/plugins/hermes-gate.js');
const hm = await import('../server/dist/hermes-mcp-tools.js');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};
const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'owner@example.test', 'Owner', t0);
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('b_howard', 'u1', 'Howard', 'primary', t0, t0);
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('b_leonard', 'u1', 'Leonard', 'managed', t0 + 1, t0 + 1);
await apps.listAppTools();
const pol = (tool, args = {}, bot = 'b_howard') => policyFor('u1', `hermes-mcp__${tool}`, args, bot);

await test('every tool the live server lists is sorted, and none is both read and risky', async () => {
  for (const t of hm.HERMES_MCP_READ) assert.ok(!hm.HERMES_MCP_RISKY.has(t), t);
  for (const t of ['hermes_plan_list', 'hermes_mission_list', 'hermes_session_search', 'hermes_events_tail', 'hermes_config_get']) assert.equal(hm.hermesMcpKind(t), 'read', t);
  for (const t of ['hermes_owner_run_command', 'hermes_config_set', 'hermes_config_patch', 'hermes_gateway_restart', 'hermes_oauth_revoke', 'hermes_mission_approve', 'hermes_fleet_dispatch']) assert.equal(hm.hermesMcpKind(t), 'risky', t);
  for (const t of ['hermes_cron_create', 'hermes_cron_run', 'hermes_mission_transition', 'hermes_skill_patch', 'hermes_brand_new_tool']) assert.equal(hm.hermesMcpKind(t), 'other', t);
});

await test('Howard\'s Hermes lookups run without a card (the cards Alex saw)', async () => {
  for (const t of ['hermes_plan_list', 'hermes_mission_list']) {
    const p = pol(t, { limit: 100 });
    assert.equal(p.decision, 'allow', t);
    assert.equal(p.viaRule, undefined, 'a read is not logged as a change');
  }
  assert.equal((await apps.appsStatus()).apps.find((a) => a.id === 'hermes-mcp').reads, 3, 'the Tools tab counts the reads');
});

await test('risky tools always ask and cannot be "Always allow"ed, even with an old stored allow', async () => {
  for (const t of ['hermes_owner_run_command', 'hermes_gateway_restart']) {
    const p = pol(t);
    assert.equal(p.decision, 'ask', t);
    assert.deepEqual(p.asks, [], t);
  }
  db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES ('u1','hermes-mcp__hermes_gateway_restart','always_allow')").run();
  assert.equal(pol('hermes_gateway_restart').decision, 'ask');
});

await test('other writes and unknown tools ask as before, and may be remembered', async () => {
  for (const t of ['hermes_mission_create', 'hermes_brand_new_tool']) {
    const p = pol(t);
    assert.equal(p.decision, 'ask', t);
    assert.deepEqual(p.asks, [`hermes-mcp__${t}`]);
  }
});

await test('reading a secret file through the connector still asks every time', async () => {
  assert.equal(pol('hermes_read_file', { path: '/home/owner/cleft-work/README.md' }).decision, 'allow');
  for (const p of ['/opt/hq/bot-hq-local/.env', '/home/x/.ssh/id_ed25519', '/home/x/.hermes/auth.json']) {
    const r = pol('hermes_read_file', { path: p });
    assert.equal(r.decision, 'ask', p);
    assert.deepEqual(r.asks, [], p);
  }
});

await test('another bot cannot use the connector at all', async () => {
  assert.equal(pol('hermes_plan_list', {}, 'b_leonard').decision, 'block');
});

await test('the same sorting applies if a Hermes home loads the connector itself (gate names)', async () => {
  assert.equal(gate.hermesPolicy('u1', 'b_howard', 'mcp_hermes-mcp_hermes_plan_list', {}).decision, 'allow');
  const risky = gate.hermesPolicy('u1', 'b_howard', 'mcp_hermes_mcp_hermes_owner_run_command', { command: 'ls' });
  assert.equal(risky.decision, 'ask');
  assert.deepEqual(risky.asks, []);
  assert.match(risky.title, /^Hermes MCP: hermes owner run command$/);
  assert.equal(gate.hermesPolicy('u1', 'b_howard', 'mcp_hermes-mcp_hermes_read_file', { path: '/x/.env' }).decision, 'ask');
  const other = gate.hermesPolicy('u1', 'b_howard', 'mcp_hermes-mcp_hermes_cron_create', {});
  assert.equal(other.decision, 'ask');
  assert.equal(other.asks.length, 1);
});

await apps.stopApps();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
