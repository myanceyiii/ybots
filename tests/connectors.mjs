// Tests for the Connectors catalog (server/src/connectors.ts) against the built server code, a
// throwaway database and the fake MCP server in tests/fixtures. Nothing leaves this machine.
//   npm run build -w server && node tests/connectors.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-connectors-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), APP_URL: 'http://localhost:5173', OWNER_EMAIL: 'owner@example.test',
  CONNECTORS_CATALOG: path.join(dir, 'catalog.json'), GOOGLE_ACCOUNTS_DIR: path.join(dir, 'google'),
});
delete process.env.EXTRA_MCP_SERVERS;
delete process.env.CONNECTOR_SCAN_HOSTS;
const demoServer = path.join(here, 'fixtures/demo-mcp-server.mjs');
fs.writeFileSync(process.env.APPS_CONFIG, JSON.stringify({ apps: [{ id: 'actual', name: 'Actual', command: process.execPath, args: [demoServer], bots: ['Leonard'] }] }));

const catalog = [
  { id: 'actual-budget', name: 'Actual Budget', machine: 'server-one', appIds: ['actual'], match: ['docker:actual-mcp'] },
  { id: 'demo-notes', name: 'Demo notes', machine: 'host1', template: { name: 'Demo notes', command: process.execPath, args: [demoServer], readOnly: true }, match: ['unit:demo-notes*@host1'] },
  { id: 'law-library', name: 'Law library', machine: 'lab', firm: true, template: { command: process.execPath, args: [demoServer] } },
  { id: 'old-browser', name: 'Old browser', retired: '2026-11-10', since: '2026-06-01' },
];
const writeCatalog = (list) => {
  fs.writeFileSync(process.env.CONNECTORS_CATALOG, JSON.stringify({ connectors: list }));
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
  fs.utimesSync(process.env.CONNECTORS_CATALOG, t, t);
};
writeCatalog(catalog);

const { db } = await import('../server/dist/db.js');
const con = await import('../server/dist/connectors.js');
const registry = await import('../server/dist/plugins/registry.js');
(await import('../server/dist/agent/rooms.js')).initRooms();

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); }
};

const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_owner', 'owner@example.test', 'Owner', t0);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u_other', 'other@example.test', 'Other', t0);
const addBot = (id, user, name, i) => db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, user, name, t0 + i, t0 + i);
addBot('b_howard', 'u_owner', 'Howard', 1);
addBot('b_leonard', 'u_owner', 'Leonard', 2);
addBot('r_family', 'u_owner', 'Family', 3);
db.prepare("UPDATE bots SET kind='room' WHERE id='r_family'").run();
const byId = async () => new Map((await con.listConnectors()).map((c) => [c.id, c]));

await test('the catalog file is loaded, with history and reach', async () => {
  const m = await byId();
  assert.equal(m.size, 4);
  assert.equal(m.get('actual-budget').reach, 'cleft');
  assert.deepEqual(m.get('actual-budget').apps.map((a) => [a.id, a.bots]), [['actual', ['Leonard']]]);
  assert.equal(m.get('actual-budget').canAdd, false);
  assert.equal(m.get('demo-notes').canAdd, true);
  assert.equal(m.get('law-library').canAdd, false);
  assert.equal(m.get('old-browser').status, 'retired');
  assert.equal(m.get('old-browser').reach, 'needs-setup');
  assert.ok(m.get('old-browser').goneAt);
});

await test('parseScan reads every line kind and which hosts finished', () => {
  const { items, hostsDone } = con.parseScan([
    'unit|host1|demo-notes.service|enabled|active|Demo notes',
    'userunit|host2|me:cleft-tunnel.service|enabled|inactive|',
    'docker|server-one|actual-mcp|img:1|Up 3 days',
    'front|server-one|claude-actual|https://x.example/mcp|http://127.0.0.1:3600/http',
    'hermes|host2|/home/me/.hermes/config.yaml|kiln|http://h:1/mcp|True',
    'done|host1', 'done|server-one', 'garbage',
  ].join('\n'));
  assert.deepEqual(items.map((i) => [i.kind, i.name, i.active]), [
    ['unit', 'demo-notes.service', true], ['userunit', 'me:cleft-tunnel.service', false], ['docker', 'actual-mcp', true],
    ['front', 'claude-actual', true], ['hermes', 'kiln', true],
  ]);
  assert.deepEqual([...hostsDone].sort(), ['host1', 'server-one']);
});

await test('a scan claims catalog entries, adds what is new, and keeps what went away as history', async () => {
  let { items, hostsDone } = con.parseScan('unit|host1|demo-notes.service|enabled|active|\ndocker|server-one|actual-mcp|i|Up\nunit|host1|new-mcp.service|enabled|active|New one\ndone|host1\ndone|server-one');
  let r = con.applyScan(items, hostsDone, 1000);
  assert.deepEqual(r, { found: 3, added: 1, gone: 0 });
  let m = await byId();
  assert.equal(m.get('demo-notes').status, 'active');
  assert.equal(m.get('actual-budget').status, 'active');
  const fresh = [...m.values()].find((c) => c.source === 'scan');
  assert.equal(fresh.name, 'new-mcp');
  assert.equal(fresh.machine, 'host1');
  // Next scan: host1 answers without either unit; server-one does not answer at all.
  ({ items, hostsDone } = con.parseScan('done|host1'));
  r = con.applyScan(items, hostsDone, 2000);
  assert.equal(r.gone, 2);
  m = await byId();
  assert.equal(m.get('demo-notes').status, 'gone');
  assert.equal(m.get(fresh.id).status, 'gone');
  assert.equal(m.get(fresh.id).firstSeen, 1000);
  assert.equal(m.get('actual-budget').status, 'active', 'a host that did not answer marks nothing gone');
  // It comes back.
  ({ items, hostsDone } = con.parseScan('unit|host1|demo-notes.service|enabled|active|\ndone|host1'));
  con.applyScan(items, hostsDone, 3000);
  assert.equal((await byId()).get('demo-notes').status, 'active');
});

await test('adding is owner only, proposed then confirmed with the digest shown', async () => {
  assert.throws(() => con.proposeConnector('u_other', { action: 'add', connectorId: 'demo-notes', bots: ['b_howard'] }), /owner/);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'law-library', bots: ['b_howard'] }), /firm/);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'old-browser', bots: ['b_howard'] }), /setup|retired/);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'actual-budget', bots: ['b_howard'] }), /already/);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'demo-notes', bots: [] }), /at least one/);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'demo-notes', bots: ['r_family'] }), /at least one/);
  assert.deepEqual(con.botRows().map((b) => b.name), ['Howard', 'Leonard']);
  const p = con.proposeConnector('u_owner', { action: 'add', connectorId: 'demo-notes', bots: ['b_howard'] });
  assert.match(p.summary, /Demo notes for Howard/);
  assert.ok(p.details.some((d) => /Read only/.test(d)));
  assert.throws(() => con.confirmConnector('u_owner', p.id, 'nope'), /not the one shown/);
  assert.equal(registry.enabledFor('demo-notes', 'b_howard'), false);
  assert.equal(con.confirmConnector('u_owner', p.id, p.digest).status, 'applied');
  assert.equal(registry.enabledFor('demo-notes', 'b_howard'), true);
  assert.equal(registry.enabledFor('demo-notes', 'b_leonard'), false);
  const m = await byId();
  assert.equal(m.get('demo-notes').added, true);
  assert.equal(m.get('demo-notes').canAdd, false);
  assert.equal(m.get('demo-notes').reach, 'cleft');
  assert.ok(registry.pluginOverview().some((o) => o.id === 'demo-notes' && o.origin === 'catalog'));
});

await test('removing takes it from every bot and keeps the catalog entry', async () => {
  const p = con.proposeConnector('u_owner', { action: 'remove', connectorId: 'demo-notes' });
  con.confirmConnector('u_owner', p.id, p.digest);
  assert.equal(registry.enabledFor('demo-notes', 'b_howard'), false);
  const m = await byId();
  assert.equal(m.get('demo-notes').added, false);
  assert.equal(m.get('demo-notes').canAdd, true);
  const c = con.proposeConnector('u_owner', { action: 'add', connectorId: 'demo-notes', bots: ['b_howard'] });
  assert.equal(con.cancelConnector('u_owner', c.id).status, 'cancelled');
  assert.throws(() => con.confirmConnector('u_owner', c.id, c.digest), /expired or was cancelled/);
});

await test('an add card whose connector changed before Confirm is refused', async () => {
  const p = con.proposeConnector('u_owner', { action: 'add', connectorId: 'demo-notes', bots: ['b_howard'] });
  const { template } = db.prepare('SELECT template FROM connectors WHERE id=?').get('demo-notes');
  db.prepare('UPDATE connectors SET template=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(template), readOnly: false }), 'demo-notes');
  assert.throws(() => con.confirmConnector('u_owner', p.id, p.digest), /changed after you were shown it/);
  assert.equal(registry.enabledFor('demo-notes', 'b_howard'), false);
  db.prepare('UPDATE connectors SET template=? WHERE id=?').run(template, 'demo-notes');
});

await test('editing the catalog updates entries without losing scan history', async () => {
  writeCatalog(catalog.map((e) => (e.id === 'demo-notes' ? { ...e, notes: 'moved' } : e)));
  const m = await byId();
  assert.equal(m.get('demo-notes').notes, 'moved');
  assert.equal(m.get('demo-notes').status, 'active');
  assert.equal(m.get('demo-notes').lastSeen, 3000);
});

await test('the catalog "ignore" list keeps helpers out of the list', async () => {
  fs.writeFileSync(process.env.CONNECTORS_CATALOG, JSON.stringify({ connectors: catalog, ignore: ['docker:lab-*', 'unit:backup*@host1'] }));
  const t = new Date(Date.now() + 5e6); fs.utimesSync(process.env.CONNECTORS_CATALOG, t, t);
  await con.listConnectors();
  const { items, hostsDone } = con.parseScan('docker|host1|lab-srv2|i|Exited\nunit|host1|backup-x.service|static|inactive|\nunit|host1|demo-notes.service|enabled|active|\ndone|host1');
  assert.equal(con.applyScan(items, hostsDone, 4000).added, 0);
  assert.ok(![...(await byId()).keys()].some((id) => /lab-srv2|backup-x/.test(id)));
});

await test('onlyBots: a host server can only ever go to its one bot', async () => {
  const cat2 = [...catalog, { id: 'host-tools', name: 'Host tools', machine: 'host1', template: { command: process.execPath, args: [demoServer], onlyBots: ['Howard'] } }];
  fs.writeFileSync(process.env.CONNECTORS_CATALOG, JSON.stringify({ connectors: cat2 }));
  const t = new Date(Date.now() + 9e6); fs.utimesSync(process.env.CONNECTORS_CATALOG, t, t);
  assert.deepEqual((await byId()).get('host-tools').onlyBots, ['Howard']);
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'host-tools', bots: ['b_howard', 'b_leonard'] }), /only for Howard/);
  const p = con.proposeConnector('u_owner', { action: 'add', connectorId: 'host-tools', bots: ['b_howard'] });
  con.confirmConnector('u_owner', p.id, p.digest);
  assert.equal(registry.enabledFor('host-tools', 'b_howard'), true);
  assert.throws(() => registry.setEnabled('u_owner', 'host-tools', 'b_leonard', true), /only for Howard/);
  db.prepare("INSERT OR REPLACE INTO plugin_bots(plugin_id,bot_id,enabled,updated_at,updated_by) VALUES ('host-tools','b_leonard',1,0,'x')").run();
  assert.equal(registry.enabledFor('host-tools', 'b_leonard'), false, 'a stored switch cannot get around onlyBots');
  assert.deepEqual(registry.pluginOverview().find((o) => o.id === 'host-tools').bots.map((b) => b.name), ['Howard']);
});

await test('wanted connections: shown with what they unlock until bots use them', async () => {
  const cat3 = [...catalog,
    { id: 'flight-status', name: 'Flight status', wanted: { rank: 2, unlocks: 'Flight alerts', bots: ['Leonard', 'Robin'], skills: ['shared/flight-status-watch'], setup: ['Get a key', 'Install'], needs: 'A key' } },
    { id: 'bad-wanted', name: 'Bad wanted', wanted: { rank: 3 } },
    { id: 'store-site', name: 'A store', wanted: { rank: 4, unlocks: 'Carts', via: 'browser' } },
    { id: 'actual-budget', name: 'Actual Budget', machine: 'server-one', appIds: ['actual'], match: ['docker:actual-mcp'], wanted: { unlocks: 'Budget' } },
  ];
  writeCatalog(cat3);
  const m = await byId();
  const f = m.get('flight-status');
  assert.equal(f.status, 'wanted');
  assert.equal(f.wanted.rank, 2);
  assert.deepEqual(f.wanted.skills, ['shared/flight-status-watch']);
  assert.equal(f.canAdd, false);
  assert.equal(m.get('bad-wanted').wanted, null, 'a wanted entry without what it unlocks is ignored');
  assert.equal(f.browserSite, false);
  assert.equal(m.get('store-site').browserSite, true, 'a site used through the shared browser is marked, so the apps list it under the browser');
  assert.equal(m.get('store-site').wanted.via, 'browser');
  assert.equal(m.get('actual-budget').wanted, null, 'once a bot uses it, it is no longer wanted');
  assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: 'flight-status', bots: ['b_leonard'] }), /needs setup/);
  writeCatalog(catalog);
});

await test('connect by address: a key stays in its own file and never in the list', async () => {
  const cu = await import('../server/dist/connectors-custom.js');
  await assert.rejects(() => cu.createCustom('u_other', { name: 'X', url: 'http://127.0.0.1:1/mcp' }, 'http://localhost:5173'), /owner/);
  await assert.rejects(() => cu.createCustom('u_owner', { name: 'X', url: 'https://example.com/mcp' }, 'http://localhost:5173'), /not on this computer/);
  await assert.rejects(() => cu.createCustom('u_owner', { name: 'X', url: 'http://u:p@127.0.0.1:1/mcp' }, 'http://localhost:5173'), /key field/);
  const r = await cu.createCustom('u_owner', { name: 'My Notes', url: 'http://127.0.0.1:1/mcp', auth: 'key', headerValue: 'Bearer sekrit', readOnly: true }, 'http://localhost:5173');
  assert.equal(r.connectorId, 'custom-my-notes');
  const m = await byId();
  const c = m.get('custom-my-notes');
  assert.equal(c.custom, true);
  assert.equal(c.canAdd, true);
  assert.equal(c.needsSignIn, false);
  assert.ok(!JSON.stringify([...m.values()]).includes('sekrit'), 'the key is not in what the apps get');
  const row = db.prepare('SELECT template FROM connectors WHERE id=?').get('custom-my-notes');
  assert.ok(!row.template.includes('sekrit'), 'the key is not in the catalog row');
  const t = JSON.parse(row.template);
  const file = path.resolve(here, '..', t.headersFile);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).Authorization, 'Bearer sekrit');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = await cu.createCustom('u_owner', { name: 'My Notes', url: 'http://127.0.0.1:2/mcp' }, 'http://localhost:5173');
  assert.equal(again.connectorId, 'custom-my-notes-2');
  await cu.deleteCustom('u_owner', 'custom-my-notes');
  await cu.deleteCustom('u_owner', 'custom-my-notes-2');
  assert.equal(fs.existsSync(file), false, 'removing deletes the key file');
  await assert.rejects(() => cu.deleteCustom('u_owner', 'actual-budget'), /connected in the app/);
});

await test('connect by address with sign-in: discovery, registration, PKCE, callback', async () => {
  const cu = await import('../server/dist/connectors-custom.js');
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    seen.push([init.method ?? 'GET', url]);
    const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (url === 'http://127.0.0.1:7/mcp') return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1:7/.well-known/oauth-protected-resource"' } });
    if (url.endsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://svc.example/mcp', authorization_servers: ['https://svc.example'] });
    if (url === 'https://svc.example/.well-known/oauth-authorization-server') return json({ authorization_endpoint: 'https://svc.example/authorize', token_endpoint: 'https://svc.example/token', registration_endpoint: 'https://svc.example/register', scopes_supported: ['mcp'] });
    if (url === 'http://127.0.0.1:7/register') { assert.deepEqual(JSON.parse(init.body).redirect_uris, ['http://localhost:5173/api/connectors/oauth/callback']); return json({ client_id: 'cid9' }, 201); }
    if (url === 'http://127.0.0.1:7/token') { const b = new URLSearchParams(init.body); assert.equal(b.get('code'), 'C1'); assert.ok(b.get('code_verifier')); assert.equal(b.get('resource'), 'https://svc.example/mcp'); return json({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }); }
    return new Response('nope', { status: 404 });
  };
  try {
    const r = await cu.createCustom('u_owner', { name: 'Svc', url: 'http://127.0.0.1:7/mcp', auth: 'oauth' }, 'http://localhost:5173');
    const su = new URL(r.signInUrl);
    assert.equal(su.origin + su.pathname, 'https://svc.example/authorize', 'the person signs in on the public page');
    assert.equal(su.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(su.searchParams.get('resource'), 'https://svc.example/mcp');
    let c = (await byId()).get(r.connectorId);
    assert.equal(c.needsSignIn, true);
    assert.equal(c.canAdd, false);
    assert.throws(() => con.proposeConnector('u_owner', { action: 'add', connectorId: r.connectorId, bots: ['b_leonard'] }), /isn't signed in/);
    await assert.rejects(() => cu.finishSignIn({ code: 'C1', state: 'wrong' }), /expired/);
    const name = await cu.finishSignIn({ code: 'C1', state: su.searchParams.get('state') });
    assert.equal(name, 'Svc');
    await assert.rejects(() => cu.finishSignIn({ code: 'C1', state: su.searchParams.get('state') }), /expired/, 'a state works once');
    c = (await byId()).get(r.connectorId);
    assert.equal(c.needsSignIn, false);
    assert.equal(c.canAdd, true);
    const t = JSON.parse(db.prepare('SELECT template FROM connectors WHERE id=?').get(r.connectorId).template);
    assert.equal(t.oauth.tokenUrl, 'http://127.0.0.1:7/token', 'token calls go through the local address');
    assert.equal(JSON.parse(fs.readFileSync(path.resolve(here, '..', t.oauth.tokenFile), 'utf8')).refresh_token, 'R');
    await cu.deleteCustom('u_owner', r.connectorId);
  } finally { globalThis.fetch = real; }
});

await test('connect a Google account: client upload, sign-in, keys kept hidden, read only by default', async () => {
  process.env.GOOGLE_WORKSPACE_MCP = path.join(dir, 'no-workspace-mcp');
  const g = await import('../server/dist/google-accounts.js');
  assert.equal(g.googleBase(["https://box.tail1.ts.net", "https://cleft.example.com"]), "https://cleft.example.com", "public address preferred for the Google return");
  const cu = await import('../server/dist/connectors-custom.js');
  const real = globalThis.fetch;
  const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
  let scope = g.SCOPES.read.join(' ');
  globalThis.fetch = async (u, init = {}) => {
    assert.equal(String(u), 'https://oauth2.googleapis.com/token');
    const b = new URLSearchParams(init.body);
    assert.equal(b.get('client_secret'), 'shh');
    assert.equal(b.get('redirect_uri'), 'http://localhost:5173/api/connectors/google/callback');
    assert.ok(b.get('code_verifier'));
    return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope, id_token: idToken('sam@example.test') }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.throws(() => g.startGoogle('u_owner', null, false, 'http://localhost:5173'), /not set up/);
    assert.throws(() => g.saveClient('u_owner', null, JSON.stringify({ installed: { client_id: 'a.apps.googleusercontent.com', client_secret: 'x' } })), /Desktop client/);
    assert.throws(() => g.saveClient('u_owner', 'Claude: test', '{}'), /Only a person/);
    assert.throws(() => g.saveClient('u_member', null, '{}'), /Only the owner/);
    g.saveClient('u_owner', null, JSON.stringify({ web: { client_id: '1-abc.apps.googleusercontent.com', client_secret: 'shh' } }));
    assert.throws(() => g.startGoogle('u_owner', 'Claude: test', false, 'http://localhost:5173'), /Only a person/);
    const su = new URL(g.startGoogle('u_owner', null, false, 'http://localhost:5173').signInUrl);
    assert.equal(su.origin, 'https://accounts.google.com');
    assert.equal(su.searchParams.get('access_type'), 'offline');
    assert.ok(su.searchParams.get('scope').includes('gmail.readonly') && !su.searchParams.get('scope').includes('gmail.compose'), 'read only asks for read scopes');
    const email = await g.finishGoogle({ code: 'C', state: su.searchParams.get('state') });
    assert.equal(email, 'sam@example.test');
    await assert.rejects(() => g.finishGoogle({ code: 'C', state: su.searchParams.get('state') }), /expired/, 'a state works once');
    const c = (await byId()).get('google-sam-example-test');
    assert.equal(c.custom, true);
    assert.equal(c.canAdd, true);
    assert.equal(c.access, 'read');
    const row = db.prepare('SELECT template, source FROM connectors WHERE id=?').get('google-sam-example-test');
    assert.equal(row.source, 'google');
    const t = JSON.parse(row.template);
    assert.equal(t.readOnly, true);
    assert.equal(t.url, 'http://127.0.0.1:18100/mcp');
    assert.ok(!row.template.includes('shh') && !JSON.stringify(c).includes('"R"'), 'no keys in the row or the list');
    assert.ok(su.searchParams.get('scope').includes('auth/tasks.readonly'), 'read only asks for Tasks read');
    const setup = g.googleSetup('google-sam-example-test');
    assert.deepEqual(setup.missing, [], 'every wanted scope was granted');
    assert.ok(setup.permissions.includes('tasks:readonly'), 'the server runs Tasks read only');
    assert.ok(!JSON.stringify(setup).includes('shh') && !JSON.stringify(setup).includes('"R"'), 'no keys in the admin view');
    assert.match(c.description, /Gmail, Calendar, Drive and Tasks/);
    const creds = path.join(dir, 'google/google-sam-example-test/creds/sam@example.test.json');
    // An account connected before Tasks was added runs without it, and says what is missing.
    const saved = JSON.parse(fs.readFileSync(creds, 'utf8'));
    fs.writeFileSync(creds, JSON.stringify({ ...saved, scopes: saved.scopes.filter((x) => !x.includes('tasks')) }));
    assert.ok(!g.permissionsFor('google-sam-example-test', false).some((x) => x.startsWith('tasks:')), 'no Tasks without its scope');
    assert.deepEqual(g.googleSetup('google-sam-example-test').missing, ['https://www.googleapis.com/auth/tasks.readonly']);
    fs.writeFileSync(creds, JSON.stringify(saved), { mode: 0o600 });
    assert.equal(JSON.parse(fs.readFileSync(creds, 'utf8')).refresh_token, 'R');
    assert.equal(fs.statSync(creds).mode & 0o777, 0o600);
    // A second account gets its own port; an unticked box is refused.
    scope = 'openid email https://www.googleapis.com/auth/gmail.readonly';
    const s2 = new URL(g.startGoogle('u_owner', null, false, 'http://localhost:5173').signInUrl);
    await assert.rejects(() => g.finishGoogle({ code: 'C', state: s2.searchParams.get('state') }), /unticked/);
    await assert.rejects(() => g.finishGoogle({ error: "access_denied", state: "x" }), /test-user list.*console\.cloud\.google\.com\/auth\/audience/);
    // Another address that shortens to the same id gets its own connector, keys and port (it never takes over Sam's).
    scope = g.SCOPES.read.join(' ');
    const realToken = globalThis.fetch;
    globalThis.fetch = async (u, init) => { const r = await realToken(u, init); const j = await r.json(); return new Response(JSON.stringify({ ...j, id_token: idToken('sam-example@test') }), { headers: { 'Content-Type': 'application/json' } }); };
    assert.equal(g.googleId('sam-example@test'), 'google-sam-example-test');
    const s3 = new URL(g.startGoogle('u_owner', null, false, 'http://localhost:5173').signInUrl);
    assert.equal(await g.finishGoogle({ code: 'C', state: s3.searchParams.get('state') }), 'sam-example@test');
    globalThis.fetch = realToken;
    assert.equal(g.account('google-sam-example-test').email, 'sam@example.test', 'the first account is untouched');
    assert.equal(g.account('google-sam-example-test-2').email, 'sam-example@test');
    assert.notEqual(g.account('google-sam-example-test-2').port, g.account('google-sam-example-test').port);
    await cu.deleteCustom('u_owner', 'google-sam-example-test-2');
    await cu.deleteCustom('u_owner', 'google-sam-example-test');
    assert.equal(fs.existsSync(path.dirname(path.dirname(creds))), false, 'removing deletes the keys');
  } finally {
    globalThis.fetch = real;
    fs.rmSync(path.join(dir, 'google'), { recursive: true, force: true });
  }
});

await test('ids of Google accounts and servers added by address always fit an app id', async () => {
  const g = await import('../server/dist/google-accounts.js');
  const cu = await import('../server/dist/connectors-custom.js');
  const APP_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
  assert.equal(g.googleId('sam@example.test'), 'google-sam-example-test', 'a short address keeps its plain id');
  const long = g.googleId('Sam.Rivera@example.com');
  assert.match(long, APP_ID, `${long} is a valid app id`);
  assert.ok(long.startsWith('google-sam-rivera-'), 'the name stays readable');
  assert.equal(long, g.googleId('sam.rivera@example.com'), 'the same address always gets the same id');
  assert.notEqual(long, g.googleId('sam.rivera@example.org'), 'another address with the same name gets its own id');
  assert.match(g.googleId(`${'a.very.long.name'.repeat(4)}@example-of-a-long-domain.test`), APP_ID);
  const name = 'A server with quite a long name indeed';
  const a = await cu.createCustom('u_owner', { name, url: 'http://127.0.0.1:7/mcp' }, 'http://localhost:5173');
  const b = await cu.createCustom('u_owner', { name, url: 'http://127.0.0.1:8/mcp' }, 'http://localhost:5173');
  assert.match(a.connectorId, APP_ID);
  assert.match(b.connectorId, APP_ID);
  assert.notEqual(a.connectorId, b.connectorId);
  await cu.deleteCustom('u_owner', a.connectorId);
  await cu.deleteCustom('u_owner', b.connectorId);
});

await test('a Google server left behind by an earlier run is found by its port and key folder', async () => {
  const g = await import('../server/dist/google-accounts.js');
  const { spawn } = await import('node:child_process');
  const root = path.join(dir, 'google');
  const env = { PATH: process.env.PATH, WORKSPACE_MCP_PORT: '18177', WORKSPACE_MCP_CREDENTIALS_DIR: path.join(root, 'google-someone', 'creds') };
  const ours = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env, stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { ...env, WORKSPACE_MCP_CREDENTIALS_DIR: '/opt/workspace-mcp/someone/creds' }, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(g.staleServers(18177, root), [ours.pid], 'only the server whose keys are under data/google');
    assert.deepEqual(g.staleServers(18178, root), [], 'another port is not touched');
  } finally { ours.kill(); other.kill(); }
});

await test('scanNow without hosts says so and changes nothing', async () => {
  const r = await con.scanNow();
  assert.match(r.error, /CONNECTOR_SCAN_HOSTS/);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
