// Tests for server/src/local-apps.ts against a fake MCP server (tests/fixtures/demo-mcp-server.mjs).
// Needs a built server: `npm run build -w server`, then `node tests/local-apps.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-apps-'));
const cfg = path.join(dir, 'apps.json');
const write = (apps) => {
  fs.writeFileSync(cfg, JSON.stringify({ apps }));
  // load() compares modification times; make sure each write counts as a change.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
  fs.utimesSync(cfg, t, t);
};
const demo = { id: 'demo', name: 'Demo CMS', command: process.execPath, args: [path.join(here, 'fixtures/demo-mcp-server.mjs')], block: ['delete_*'] };
process.env.APPS_CONFIG = cfg;
process.env.DEMO_PREFIX = 'from-env';

const apps = await import('../server/dist/local-apps.js');
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

write([demo]);

await test('tools are listed with the app prefix', async () => {
  const tools = await apps.listAppTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['demo__delete_case', 'demo__list_cases', 'demo__send_note', 'demo__tag_case']);
  assert.ok(tools.find((t) => t.name === 'demo__list_cases').description.startsWith('[Demo CMS]'));
});

await test('names are found whatever their case', () => {
  assert.equal(apps.findAppTool('DEMO__LIST_CASES')?.tool, 'list_cases');
  assert.equal(apps.findAppTool('demo__nope'), undefined);
});

await test('read-only tool runs, others ask, blocked one is blocked', () => {
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__list_cases')), { decision: 'allow', fixed: false });
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__send_note')), { decision: 'ask', fixed: false });
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__delete_case')), { decision: 'block', fixed: true });
});

await test('a tool call returns the server text', async () => {
  const r = await apps.callAppTool(apps.findAppTool('demo__send_note'), { to: 'jane', message: { subject: 'Hi', body: 'x' } });
  assert.equal(r.isError, false);
  assert.equal(r.output, 'sent "Hi" to jane');
});

await test('a bad call comes back as an error, not a crash', async () => {
  const r = await apps.callAppTool(apps.findAppTool('demo__send_note'), { to: 5 });
  assert.equal(r.isError, true);
});

await test('apps.json "ask" overrides the read-only hint and cannot be remembered', async () => {
  write([{ ...demo, ask: ['list_*'] }]);
  await apps.listAppTools();
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__list_cases')), { decision: 'ask', fixed: true });
});

await test('trustReadOnlyHints=false makes read-only tools ask', async () => {
  write([{ ...demo, trustReadOnlyHints: false }]);
  await apps.listAppTools();
  assert.equal(apps.appRule(apps.findAppTool('demo__list_cases')).decision, 'ask');
});

await test('"allow" patterns run without asking', async () => {
  write([{ ...demo, allow: ['send_*'] }]);
  await apps.listAppTools();
  assert.equal(apps.appRule(apps.findAppTool('demo__send_note')).decision, 'allow');
});

await test('readOnly blocks every tool that would ask, keeps reads, and counts them', async () => {
  write([{ ...demo, readOnly: true }]);
  await apps.listAppTools();
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__list_cases')), { decision: 'allow', fixed: false });
  assert.deepEqual(apps.appRule(apps.findAppTool('demo__send_note')), { decision: 'block', fixed: true });
  write([{ ...demo, readOnly: true, allow: ['send_*'] }]);
  await apps.listAppTools();
  assert.equal(apps.appRule(apps.findAppTool('demo__send_note')).decision, 'allow');
  write([{ ...demo, readOnly: true }]);
  const s = (await apps.appsStatus()).apps.find((a) => a.id === 'demo');
  assert.equal(s.readOnly, true);
  assert.equal(s.reads, 1);
  assert.equal(s.blocked, 3);
});

await test('readOnly must be a boolean', async () => {
  write([{ ...demo, readOnly: 'yes' }]);
  const s = await apps.appsStatus();
  assert.equal(s.apps.length, 0);
});

await test('a URL off this machine is refused unless remote is set', async () => {
  write([{ id: 'far', url: 'https://example.com/mcp' }]);
  const s = await apps.appsStatus();
  assert.equal(s.apps.length, 0);
});

await test('a server that fails to start shows as an error', async () => {
  write([{ id: 'broken', command: '/nonexistent/bin' }]);
  const s = await apps.appsStatus();
  assert.equal(s.apps[0].status, 'error');
  assert.ok(s.apps[0].error);
});

await test('a disabled app is listed but not started', async () => {
  write([{ ...demo, enabled: false }]);
  const s = await apps.appsStatus();
  assert.equal(s.apps[0].status, 'disabled');
  assert.equal((await apps.listAppTools()).length, 0);
});

await test('removing an app removes its tools', async () => {
  write([demo]);
  assert.equal((await apps.listAppTools()).length, 4);
  write([]);
  assert.equal((await apps.listAppTools()).length, 0);
  assert.equal(apps.findAppTool('demo__list_cases'), undefined);
});

await test('patterns: * matches anything, case is ignored, other characters are literal', () => {
  assert.equal(apps.matches(['list_*'], 'LIST_cases'), true);
  assert.equal(apps.matches(['list.cases'], 'listXcases'), false);
  assert.equal(apps.matches(['*'], 'anything'), true);
  assert.equal(apps.matches(undefined, 'x'), false);
});


await test('EXTRA_MCP_SERVERS entries become approval-checked apps named extra-<name>', async () => {
  const list = apps.appsFromExtraMcpServers(JSON.stringify({
    'My Tools': { command: process.execPath, args: [path.join(here, 'fixtures/demo-mcp-server.mjs')], timeout: 30 },
    far: { url: 'https://example.com/mcp' },
  }));
  assert.deepEqual(list.map((a) => a.id), ['extra-my-tools', 'extra-far']);
  assert.equal(list[0].origin, 'env');
  assert.equal(list[0].timeoutMs, 30000);
  assert.deepEqual(apps.appsFromExtraMcpServers('not json'), []);
  assert.deepEqual(apps.appsFromExtraMcpServers('[1,2]'), []);
});

await test('another source adds apps; removing the source removes them; apps.json cannot claim an origin', async () => {
  write([{ ...demo, origin: 'installed' }]);
  const dispose = apps.registerAppSource('test', () => [{ ...demo, id: 'demo2', origin: 'installed' }]);
  const s = await apps.appsStatus();
  const byId = Object.fromEntries(s.apps.map((a) => [a.id, a]));
  assert.equal(byId.demo.origin, 'apps.json');
  assert.equal(byId.demo2.origin, 'installed');
  assert.ok(apps.findAppTool('demo2__list_cases'));
  dispose();
  assert.equal(apps.findAppTool('demo2__list_cases'), undefined);
  write([demo]);
});

await test('an unknown plugin kind or a malformed bots list is skipped', async () => {
  write([{ ...demo, kind: 'in-process' }, { ...demo, id: 'demo3', bots: 'Sheldon' }]);
  const s = await apps.appsStatus();
  assert.equal(s.apps.length, 0);
  write([demo]);
});

await apps.stopApps();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
