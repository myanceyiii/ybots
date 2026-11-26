// Shared provider catalog (server/src/provider-catalog.ts, engine.ts writeHome, routes PATCH /engine):
// the Anthropic API key leaves a managed bot's environment for its credential pool so the Claude
// subscription plugin can run beside it; no rotating OAuth token or primary sign-in is copied; fallbacks
// are explicit per bot (an existing chain is adopted, a new bot gets none); the subscription is off for
// every bot until switched on, and points only that bot's plugin at the login; statuses keep listed,
// access and verified apart. Hermetic: throwaway database and homes, HERMES_BIN=/bin/false (the agent
// never starts; only its home is written). Run after `npm run build -w server`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-catalog-'));
const primary = path.join(dir, 'primary');
const plugins = path.join(dir, 'provider-plugins');
fs.mkdirSync(primary, { recursive: true });
fs.writeFileSync(path.join(primary, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-shared-key-000000\nANTHROPIC_TOKEN=sk-ant-oat-rotating\nCLAUDE_CODE_OAUTH_TOKEN=oauth-rotating\nOPENROUTER_API_KEY=sk-or-test\nAPI_SERVER_KEY=pk\n');
fs.writeFileSync(path.join(primary, 'config.yaml'), '# Howard: hand-kept, keep this comment\n' + YAML.stringify({ model: { default: 'gpt-6.2-sol', provider: 'openai-codex' }, fallback_providers: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }], custom_providers: [] }));
fs.writeFileSync(path.join(primary, 'auth.json'), JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { refresh_token: 'PRIMARY-ROTATING' } } } }));
fs.mkdirSync(path.join(plugins, 'claude-subscription-directsdk-experimental'), { recursive: true });
fs.writeFileSync(path.join(plugins, 'claude-subscription-directsdk-experimental', 'plugin.yaml'), 'name: claude-subscription-directsdk-experimental\nkind: model-provider\nversion: 0.3.4\n');
fs.writeFileSync(path.join(plugins, 'claude-subscription-directsdk-experimental', '__init__.py'), '# fake\n');

Object.assign(process.env, {
  HOME: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ORGO_API_KEY: 'unused', BOTHQ_NO_SCHEDULER: '1',
  DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false', HERMES_HOME_PRIMARY: primary,
  APPS_CONFIG: path.join(dir, 'apps.json'), APP_URL: 'http://127.0.0.1:1', SERVER_URL: 'http://127.0.0.1:1', ENGINE_PORT_BASE: '18650',
  PROVIDER_PLUGINS_DIR: plugins, CLAUDE_LOGIN_DIR: '/opt/test/claude-login', CLAUDE_CODE_BIN: '/opt/test/bin/claude',
  PRIMARY_RESTART_COMMAND: `touch ${path.join(dir, 'restarted')}`, MAINTAINER_LOG: path.join(dir, 'maint.log'), PRIMARY_BACKUP_DIR: path.join(dir, 'primary-backups'),
});
const cat = await import(path.join(root, 'server/dist/provider-catalog.js'));
const { db } = await import(path.join(root, 'server/dist/db.js'));
const engine = await import(path.join(root, 'server/dist/engine.js'));

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack ?? e.message}`); } };
const t = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', t);
const mk = (id, name, extra = {}) => {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'u1', name, 'managed', extra.port, extra.provider ?? null, extra.model ?? null, t, t);
};
const home = (id) => path.join(dir, 'engines', id);
const dotenv = (id) => Object.fromEntries(fs.readFileSync(path.join(home(id), '.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const cfg = (id) => YAML.parse(fs.readFileSync(path.join(home(id), 'config.yaml'), 'utf8'));
const auth = (id) => JSON.parse(fs.readFileSync(path.join(home(id), 'auth.json'), 'utf8'));
const writeHome = async (id) => {
  await engine.restartEngine(id).catch(() => {}); // waits for an earlier start, then starts again (HERMES_BIN fails at once)
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home(id), '.hq-provider-fp')); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
};

// ---------- pure helpers ----------

await test('isolateAnthropicEnv takes out every variable the plugin refuses and returns the key', () => {
  const r = cat.isolateAnthropicEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_TOKEN: 'x', OPENROUTER_API_KEY: 'or' });
  assert.equal(r.apiKey, 'k');
  assert.deepEqual(Object.keys(r.vars), ['OPENROUTER_API_KEY']);
  for (const k of cat.CONFLICTING_ENV) assert.ok(!(k in r.vars));
});

await test('upsertPoolKey adds one owned row, drops env-seeded rows, keeps others, updates in place', () => {
  const a = { version: 1, credential_pool: { anthropic: [{ id: 'e1', source: 'env:ANTHROPIC_API_KEY', access_token: 'old' }, { id: 'h1', source: 'hermes_pkce', auth_type: 'oauth', access_token: 'mine' }], openrouter: [{ id: 'o' }] } };
  assert.equal(cat.upsertPoolKey(a, 'NEW'), true);
  const rows = a.credential_pool.anthropic;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, cat.POOL_LABEL);
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].auth_type, 'api_key');
  assert.equal(rows[0].access_token, 'NEW');
  assert.equal(rows[1].id, 'h1');
  assert.deepEqual(a.credential_pool.openrouter, [{ id: 'o' }]);
  assert.equal(cat.upsertPoolKey(a, 'NEW'), false, 'same key: no change');
  rows[0].last_status = 'exhausted';
  assert.equal(cat.upsertPoolKey(a, 'ROTATED'), true);
  assert.equal(a.credential_pool.anthropic[0].access_token, 'ROTATED');
  assert.equal(a.credential_pool.anthropic[0].last_status, undefined, 'old status cleared with the new key');
  assert.equal(cat.upsertPoolKey(a, null), true);
  assert.deepEqual(a.credential_pool.anthropic.map((r) => r.id), ['h1'], 'no key: only our row goes');
});

await test('cleanFallbacks validates, caps at 3 and drops repeats', () => {
  assert.deepEqual(cat.cleanFallbacks([{ provider: 'openrouter', model: 'a/b' }, { provider: 'openrouter', model: 'a/b' }]), [{ provider: 'openrouter', model: 'a/b' }]);
  assert.throws(() => cat.cleanFallbacks([{ provider: 'x', model: '' }]));
  assert.throws(() => cat.cleanFallbacks([1, 2, 3, 4].map((i) => ({ provider: 'p', model: `m${i}` }))));
  assert.throws(() => cat.cleanFallbacks('nope'));
  assert.deepEqual(cat.cleanFallbacks(null), []);
});

await test('readFallbacks merges fallback_providers and the legacy fallback_model', () => {
  assert.deepEqual(cat.readFallbacks({ fallback_providers: [{ provider: 'a', model: 'm' }], fallback_model: { provider: 'b', model: 'n' } }), [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }]);
  assert.deepEqual(cat.readFallbacks({}), []);
});

await test('applyProviderConfig writes the chain, turns off borrowed logins, gates the Claude login', () => {
  const c = { fallback_model: { provider: 'x', model: 'y' }, plugins: { enabled: ['cleft-bot-gate'] } };
  cat.applyProviderConfig(c, { fallbacks: [{ provider: 'openrouter', model: 'm' }], subscriptionOn: false, loginDir: '/login', offDir: '/h/no-claude-login' });
  assert.deepEqual(c.fallback_providers, [{ provider: 'openrouter', model: 'm' }]);
  assert.equal(c.fallback_model, undefined);
  assert.equal(c.auth.adopt_external_logins, false);
  assert.deepEqual(c.plugins.enabled, ['cleft-bot-gate'], 'other plugin settings kept');
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/h/no-claude-login');
  cat.applyProviderConfig(c, { fallbacks: [], subscriptionOn: true, loginDir: '/login', offDir: '/h/no-claude-login' });
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/login');
  cat.applyProviderConfig(c, { fallbacks: [], subscriptionOn: true, loginDir: '', offDir: '/h/no-claude-login' });
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/h/no-claude-login', 'no login set up: still nothing');
});

await test('providerStatuses keeps listed, access and verified apart', () => {
  const s = cat.providerStatuses({
    hermes: [
      { slug: 'anthropic', authenticated: true, models: ['claude-sonnet-5'] },
      { slug: cat.SUBSCRIPTION, authenticated: false, models: [] },
      { slug: 'openai-codex', authenticated: false },
      { slug: 'refuseless', name: 'refuseless', authenticated: true, models: ['glm'] },
      { slug: 'fireworks', authenticated: false },
    ],
    managed: true, botName: 'Leonard', subscriptionOn: false, loginDir: '/login', pluginInstalled: true,
    sharedKeys: { ANTHROPIC_API_KEY: true, OPENROUTER_API_KEY: false },
    checks: [{ provider: 'anthropic', model: 'claude-sonnet-5', at: 5, ok: 1, detail: 'ok', ms: 10 }], turns: [],
  });
  const by = Object.fromEntries(s.map((p) => [p.id, p]));
  assert.equal(by.anthropic.access, 'ready');
  assert.equal(by.anthropic.verified.ok, true);
  assert.equal(by[cat.SUBSCRIPTION].access, 'off', 'opt-in off');
  assert.equal(by[cat.SUBSCRIPTION].verified, null);
  assert.ok(by[cat.SUBSCRIPTION].warning.includes('terms'));
  assert.deepEqual(by[cat.SUBSCRIPTION].models, ['sonnet', 'opus', 'haiku'], 'suggestions when the agent lists none');
  assert.equal(by[cat.SUBSCRIPTION].modelsFromAgent, false);
  assert.equal(by.openrouter.access, 'needs_key');
  assert.equal(by['openai-codex'].access, 'not_signed_in');
  assert.equal(by.refuseless.source, 'agent');
  assert.equal(by.fireworks, undefined, 'unauthenticated providers outside the catalog are not listed');
  const on = cat.providerStatuses({ hermes: [{ slug: cat.SUBSCRIPTION, authenticated: false, warning: 'not logged in' }], managed: true, botName: 'L', subscriptionOn: true, loginDir: '/login', pluginInstalled: true, sharedKeys: {}, checks: [], turns: [] });
  assert.equal(on.find((p) => p.id === cat.SUBSCRIPTION).access, 'not_signed_in', 'switched on but no login: not ready');
  const howard = cat.providerStatuses({ hermes: [], managed: false, botName: 'Howard', subscriptionOn: false, loginDir: '/login', pluginInstalled: false, sharedKeys: {}, checks: [], turns: [] });
  assert.equal(howard.find((p) => p.id === cat.SUBSCRIPTION).eligible, false, 'never offered for an agent the app does not run');
});

await test('answeredBy spots a fallback answer', () => {
  assert.equal(cat.answeredBy('claude-sonnet-5', 'claude-sonnet-5').same, true);
  assert.equal(cat.answeredBy('sonnet', 'claude-sonnet-5-5').same, true);
  assert.equal(cat.answeredBy('claude-sonnet-5', 'anthropic/claude-sonnet-5').same, true);
  assert.equal(cat.answeredBy('claude-opus-5-5', 'gpt-6.2-sol').same, false);
  assert.equal(cat.answeredBy('x', undefined).same, true);
});

// ---------- a managed bot's home ----------

await test('existing bot: key moves to the pool, env has no conflicting variable, chain adopted, plugin copied', async () => {
  mk('bot_old', 'Leonard', { port: 18650, provider: 'anthropic', model: 'claude-sonnet-5' });
  fs.mkdirSync(home('bot_old'), { recursive: true });
  // As Host2 has it today: the key in .env, an env-seeded pool row, an existing (empty) chain, a nous sign-in.
  fs.writeFileSync(path.join(home('bot_old'), '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-shared-key-000000\nOPENROUTER_API_KEY=sk-or-test\nAPI_SERVER_KEY=keepme\nMY_OWN=1\n');
  fs.writeFileSync(path.join(home('bot_old'), 'config.yaml'), YAML.stringify({ model: { default: 'claude-sonnet-5', provider: 'anthropic' }, fallback_providers: [{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }], fallback_model: null, delegation: { provider: 'anthropic' } }));
  fs.writeFileSync(path.join(home('bot_old'), 'auth.json'), JSON.stringify({ version: 1, providers: { nous: { x: 1 } }, credential_pool: { anthropic: [{ id: 'e', source: 'env:ANTHROPIC_API_KEY', access_token: 'sk-ant-test-shared-key-000000' }] } }));
  await writeHome('bot_old');
  const e = dotenv('bot_old');
  for (const k of cat.CONFLICTING_ENV) assert.ok(!(k in e), `${k} must not be in the bot's env`);
  assert.equal(e.API_SERVER_KEY, 'keepme');
  assert.equal(e.MY_OWN, '1', 'hand-added keys kept');
  assert.equal(e.OPENROUTER_API_KEY, 'sk-or-test');
  assert.equal(e.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND, '/opt/test/bin/claude');
  const a = auth('bot_old');
  assert.deepEqual(a.providers, { nous: { x: 1 } }, 'its own sign-ins kept');
  assert.equal(a.credential_pool.anthropic.length, 1);
  assert.equal(a.credential_pool.anthropic[0].label, cat.POOL_LABEL);
  assert.equal(a.credential_pool.anthropic[0].access_token, 'sk-ant-test-shared-key-000000');
  const c = cfg('bot_old');
  assert.deepEqual(c.model, { default: 'claude-sonnet-5', provider: 'anthropic' }, 'default unchanged');
  assert.deepEqual(c.fallback_providers, [{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }], 'existing chain kept');
  assert.equal(c.auth.adopt_external_logins, false);
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, path.join(home('bot_old'), 'no-claude-login'), 'subscription off by default');
  assert.equal(JSON.parse(db.prepare('SELECT fallbacks FROM bots WHERE id=?').get('bot_old').fallbacks).length, 1, 'adopted chain saved and visible');
  assert.ok(fs.existsSync(path.join(home('bot_old'), 'plugins', cat.SUBSCRIPTION, 'plugin.yaml')));
  assert.equal(engine.startedProviderFingerprint('bot_old'), engine.providerFingerprint('bot_old'));
  assert.equal(fs.statSync(path.join(home('bot_old'), 'auth.json')).mode & 0o777, 0o600);
});

await test('new bot (like Raj): starts on the shared Claude API, no fallback, no primary sign-ins or OAuth tokens copied, key in pool', async () => {
  mk('bot_new', 'Raj', { port: 18651 });
  await writeHome('bot_new');
  const e = dotenv('bot_new');
  for (const k of cat.CONFLICTING_ENV) assert.ok(!(k in e), `${k} must not be in the new bot's env`);
  const raw = fs.readFileSync(path.join(home('bot_new'), 'auth.json'), 'utf8');
  assert.ok(!raw.includes('PRIMARY-ROTATING'), 'the primary agent\'s sign-ins are not copied');
  assert.ok(!raw.includes('oauth-rotating') && !raw.includes('sk-ant-oat-rotating'), 'no OAuth token copied');
  assert.equal(auth('bot_new').credential_pool.anthropic[0].label, cat.POOL_LABEL);
  const c = cfg('bot_new');
  assert.deepEqual(c.fallback_providers, [], 'the primary agent\'s chain is not inherited');
  assert.equal(c.model.provider, 'anthropic', 'not the owner\'s ChatGPT sign-in route, which bots do not share');
  assert.equal(c.model.default, 'claude-sonnet-5');
  assert.ok(!c.model.base_url, 'no leftover ChatGPT endpoint');
  const row = db.prepare('SELECT provider, model FROM bots WHERE id=?').get('bot_new');
  assert.deepEqual([row.provider, row.model], ['anthropic', 'claude-sonnet-5'], 'saved as the bot\'s own choice, so settings show it');
  assert.deepEqual(JSON.parse(db.prepare('SELECT fallbacks FROM bots WHERE id=?').get('bot_new').fallbacks), []);
  assert.equal(db.prepare('SELECT claude_subscription FROM bots WHERE id=?').get('bot_new').claude_subscription, 0);
  assert.ok(fs.existsSync(path.join(home('bot_new'), 'plugins', cat.SUBSCRIPTION, 'plugin.yaml')), 'new bots get the plugin');
});

await test('switching the subscription on for one bot changes only that bot, and asks for a restart', async () => {
  db.prepare('UPDATE bots SET claude_subscription=1, fallbacks=? WHERE id=?').run(JSON.stringify([{ provider: cat.SUBSCRIPTION, model: 'sonnet' }]), 'bot_new');
  const r = engine.syncEngineProviders('bot_new');
  assert.equal(r.written, true);
  assert.equal(r.restart, true, 'plugin login setting changed: restart');
  assert.equal(cfg('bot_new').plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/opt/test/claude-login');
  assert.deepEqual(cfg('bot_new').fallback_providers, [{ provider: cat.SUBSCRIPTION, model: 'sonnet' }]);
  assert.equal(cfg('bot_old').plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, path.join(home('bot_old'), 'no-claude-login'), 'other bot untouched');
  assert.deepEqual(cfg('bot_old').model, { default: 'claude-sonnet-5', provider: 'anthropic' }, 'other bot default untouched');
  db.prepare('UPDATE bots SET fallbacks=? WHERE id=?').run('[]', 'bot_old');
  assert.equal(engine.syncEngineProviders('bot_old').restart, false, 'a fallback change needs no restart');
});

await test('a second start keeps the setup (persistence) and a new shared key reaches the pool', async () => {
  fs.writeFileSync(path.join(primary, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-rotated-key-111111\nOPENROUTER_API_KEY=sk-or-test\n');
  assert.notEqual(engine.startedProviderFingerprint('bot_old'), engine.providerFingerprint('bot_old'), 'a new key is noticed');
  fs.rmSync(path.join(home('bot_old'), '.hq-provider-fp'));
  await writeHome('bot_old');
  assert.equal(auth('bot_old').credential_pool.anthropic.length, 1);
  assert.equal(auth('bot_old').credential_pool.anthropic[0].access_token, 'sk-ant-test-rotated-key-111111');
  assert.deepEqual(cfg('bot_old').fallback_providers, [], 'the app\'s chain is kept across starts');
  fs.rmSync(path.join(home('bot_new'), '.hq-provider-fp'));
  await writeHome('bot_new');
  assert.equal(cfg('bot_new').plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/opt/test/claude-login', 'opt-in survives a start');
});

await test('the primary agent\'s home is never written by a managed bot\'s start', () => {
  const c = YAML.parse(fs.readFileSync(path.join(primary, 'config.yaml'), 'utf8'));
  assert.deepEqual(c.fallback_providers, [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }]);
  assert.equal(c.auth, undefined);
  assert.ok(fs.readFileSync(path.join(primary, 'auth.json'), 'utf8').includes('PRIMARY-ROTATING'));
});

// ---------- the owner's own agent (Howard): configurable from the app, written safely ----------

const pp = await import(path.join(root, 'server/dist/primary-providers.js'));
const pcfg = () => YAML.parse(fs.readFileSync(path.join(primary, 'config.yaml'), 'utf8'));
const penv = () => fs.readFileSync(path.join(primary, '.env'), 'utf8');
// The owner's .env as it stood before the managed-bot tests rotated the key.
fs.writeFileSync(path.join(primary, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-shared-key-000000\nANTHROPIC_TOKEN=sk-ant-oat-rotating\nCLAUDE_CODE_OAUTH_TOKEN=oauth-rotating\nOPENROUTER_API_KEY=sk-or-test\nAPI_SERVER_KEY=pk\n');
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bot_howard', 'u1', 'Howard', 'primary', t, t);

await test('primary: a first sync only points the unused plugin at an empty folder; default, key and chain stay; no restart', () => {
  const r = engine.syncPrimaryEngine('bot_howard', { model: false, actor: 'test' });
  const c = pcfg();
  assert.deepEqual(c.model, { default: 'gpt-6.2-sol', provider: 'openai-codex' }, 'his default is kept');
  assert.deepEqual(c.fallback_providers, [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }], 'chain never set in the app: kept');
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, path.join(primary, 'no-claude-login'), 'never the owner\'s own ~/.claude');
  assert.ok(fs.readFileSync(path.join(primary, 'config.yaml'), 'utf8').startsWith('# Howard: hand-kept, keep this comment'), 'comments kept');
  assert.match(penv(), /^ANTHROPIC_API_KEY=sk-ant-test-shared-key-000000$/m, '.env untouched while the subscription is off');
  assert.equal(r.restart, false);
  assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'config.yaml')) && fs.existsSync(path.join(r.backup, '.env')), 'backed up first');
  assert.equal(pp.primaryRestartPending(), null);
  assert.equal(engine.syncPrimaryEngine('bot_howard', { model: false, actor: 'test' }).backup, null, 'nothing changed: nothing written');
});

await test('primary: fallbacks set in the app are written exactly, without a restart', () => {
  db.prepare('UPDATE bots SET fallbacks=? WHERE id=?').run(JSON.stringify([{ provider: 'anthropic', model: 'claude-sonnet-5' }]), 'bot_howard');
  const r = engine.syncPrimaryEngine('bot_howard', { model: false, actor: 'test' });
  assert.deepEqual(pcfg().fallback_providers, [{ provider: 'anthropic', model: 'claude-sonnet-5' }]);
  assert.equal(r.restart, false);
});

await test('primary: switching the subscription on moves only the API key to the pool, keeps sign-ins, and waits for an idle restart', () => {
  const before = penv();
  db.prepare('UPDATE bots SET claude_subscription=1 WHERE id=?').run('bot_howard');
  const r = engine.syncPrimaryEngine('bot_howard', { model: false, actor: 'test' });
  const e = penv();
  assert.doesNotMatch(e, /^ANTHROPIC_API_KEY=/m);
  assert.match(e, /^ANTHROPIC_TOKEN=sk-ant-oat-rotating$/m, 'other lines untouched');
  assert.match(e, /^OPENROUTER_API_KEY=sk-or-test$/m);
  assert.match(e, /^CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND=\/opt\/test\/bin\/claude$/m);
  const a = JSON.parse(fs.readFileSync(path.join(primary, 'auth.json'), 'utf8'));
  assert.equal(a.credential_pool.anthropic[0].label, cat.POOL_LABEL);
  assert.equal(a.credential_pool.anthropic[0].access_token, 'sk-ant-test-shared-key-000000');
  assert.equal(a.providers['openai-codex'].tokens.refresh_token, 'PRIMARY-ROTATING', 'his sign-ins are kept');
  const c = pcfg();
  assert.equal(c.plugins.entries[cat.SUBSCRIPTION].settings.claude_config_dir, '/opt/test/claude-login');
  assert.equal(c.auth.adopt_external_logins, false);
  assert.deepEqual(c.model, { default: 'gpt-6.2-sol', provider: 'openai-codex' }, 'default still his');
  assert.equal(r.restart, true);
  assert.ok(pp.primaryRestartPending());
  assert.equal(fs.readFileSync(path.join(r.backup, '.env'), 'utf8'), before, 'the backup has the old .env');
  assert.equal(pp.sharedAnthropicKey(), 'sk-ant-test-shared-key-000000', 'bots still get the shared key, now from his pool');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'maint.log'), 'utf8'), /sk-ant|sk-or/, 'the audit line has no secrets');
});

await test('primary: the default is written only when it was changed in the app', () => {
  db.prepare('UPDATE bots SET provider=?, model=? WHERE id=?').run('anthropic', 'claude-sonnet-5', 'bot_howard');
  engine.syncPrimaryEngine('bot_howard', { model: false, actor: 'test' });
  assert.equal(pcfg().model.provider, 'openai-codex');
  engine.syncPrimaryEngine('bot_howard', { model: true, actor: 'test' });
  assert.deepEqual(pcfg().model, { default: 'claude-sonnet-5', provider: 'anthropic' });
});

await test('primary: the restart runs only when idle, then clears', async () => {
  assert.equal(await pp.restartPrimaryIfPending('a turn is running'), 'waiting');
  assert.ok(!fs.existsSync(path.join(dir, 'restarted')));
  fs.writeFileSync(path.join(primary, 'state.db'), '');
  assert.equal(await pp.restartPrimaryIfPending(null), 'waiting', 'its own sessions were just active');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(primary, 'state.db'), old, old);
  assert.equal(await pp.restartPrimaryIfPending(null), 'restarted');
  assert.ok(fs.existsSync(path.join(dir, 'restarted')));
  assert.equal(pp.primaryRestartPending(), null);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
