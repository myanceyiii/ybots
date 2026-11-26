// Unit test for server/src/helpers.ts: helper (sub-agent) settings read from and written into a
// Hermes config.yaml. Needs a built server: `npm run build -w server`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'engines'), SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', HERMES_HOME_PRIMARY: path.join(dir, 'h') });
const { readHelpers, cleanHelpers, saveHelpers, loadHelpers, helperRuns, helperModels, HelpersError } = await import('../server/dist/helpers.js');
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };

const MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol'];
const home = path.join(dir, 'home');
fs.mkdirSync(path.join(home, 'plugins', 'advanced-delegation'), { recursive: true });
const ORIGINAL = `# Howard's config
model:
  default: gpt-6.2-sol   # main model
  provider: openai-codex
agent:
  disabled_toolsets:
    - delegation
    - video
  reasoning_effort: high
delegation:
  model: ''
  max_iterations: 250
  max_concurrent_children: 10
  max_spawn_depth: 3
  subagent_auto_approve: true
plugins:
  enabled: [advanced-delegation, cleft-bot-gate]
`;
fs.writeFileSync(path.join(home, 'config.yaml'), ORIGINAL, { mode: 0o600 });

test('reads an untouched config: off, inheriting the main model', () => {
  const h = loadHelpers(home, 'openai-codex');
  assert.equal(h.enabled, false);
  assert.equal(h.inheritsMainModel, true);
  assert.equal(h.maxAtOnce, 10);
  assert.equal(h.perJobChoice, true);
});

test('saving turns helpers on, writes routes up to the cap, and forces the safe keys back', () => {
  const cur = loadHelpers(home, 'openai-codex');
  const s = cleanHelpers({ enabled: true, maxAtOnce: 4, stepLimit: 60, maxTier: 'standard', defaultTier: 'heavy',
    routes: { light: { model: 'gpt-6-luna', effort: 'low' }, standard: { model: 'gpt-6.1-terra' }, heavy: { model: 'gpt-6.2-sol' } } }, MODELS, cur);
  assert.deepEqual(Object.keys(s.routes), ['light', 'standard'], 'deep is above the cap');
  assert.equal(s.defaultTier, 'standard', 'default clamps down to the cap');
  const h = saveHelpers(home, s, 'openai-codex');
  const text = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
  assert.match(text, /# Howard's config/, 'comments kept');
  assert.match(text, /# main model/);
  assert.ok(!/- delegation/.test(text), 'delegation no longer disabled');
  assert.match(text, /- video/, 'other disabled toolsets kept');
  assert.match(text, /max_spawn_depth: 1/);
  assert.match(text, /subagent_auto_approve: false/);
  assert.match(text, /auto_resume: false/);
  assert.match(text, /backend: model_map/);
  assert.ok(!/gpt-6\.2-sol\n[\s\S]*deep/.test(text) && !/name: deep/.test(text), 'no deep route');
  assert.equal(h.enabled, true);
  assert.equal(h.maxTier, 'standard');
  assert.equal(h.defaultTier, 'standard');
  assert.equal(h.routes.light.effort, 'low');
  assert.equal(h.maxAtOnce, 4);
  assert.equal(h.stepLimit, 60);
  assert.equal((fs.statSync(path.join(home, 'config.yaml')).mode & 0o777), 0o600, 'mode kept');
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml.cleft-helpers.bak'), 'utf8'), ORIGINAL, 'backup of the previous file');
});

test('turning helpers off puts delegation back in disabled_toolsets', () => {
  const cur = loadHelpers(home, 'openai-codex');
  const s = cleanHelpers({ ...cur, enabled: false }, MODELS, cur);
  const h = saveHelpers(home, s, 'openai-codex');
  assert.equal(h.enabled, false);
  assert.equal(h.maxTier, 'standard', 'routes kept for next time');
});

test('refuses models outside the bot list, bad numbers and an empty route set', () => {
  const cur = loadHelpers(home, 'openai-codex');
  assert.throws(() => cleanHelpers({ ...cur, enabled: true, routes: { light: { model: 'made-up-model' } } }, MODELS, cur), HelpersError);
  assert.throws(() => cleanHelpers({ ...cur, maxAtOnce: 11 }, MODELS, cur), HelpersError);
  assert.throws(() => cleanHelpers({ ...cur, stepLimit: 5 }, MODELS, cur), HelpersError);
  assert.throws(() => cleanHelpers({ ...cur, maxAtOnce: 2.5 }, MODELS, cur), HelpersError);
  assert.throws(() => cleanHelpers({ ...cur, enabled: true, maxTier: 'light', routes: { heavy: { model: 'gpt-6.2-sol' } } }, MODELS, cur), HelpersError);
  assert.throws(() => cleanHelpers({ ...cur, enabled: true, routes: { light: { model: 'gpt-6-luna', effort: 'turbo' } } }, MODELS, cur), HelpersError);
});

test('with no live model list, only models already configured pass', () => {
  const cur = loadHelpers(home, 'openai-codex');
  assert.doesNotThrow(() => cleanHelpers({ ...cur, enabled: true, routes: { light: { model: 'gpt-6-luna' } } }, [], cur));
  assert.throws(() => cleanHelpers({ ...cur, enabled: true, maxTier: 'heavy', routes: { heavy: { model: 'gpt-6.2-sol' } } }, [], cur), HelpersError);
});

test('without the plugin, routes fall back to the default model and the backend to default', () => {
  const h2 = path.join(dir, 'home2');
  fs.mkdirSync(h2);
  fs.writeFileSync(path.join(h2, 'config.yaml'), 'delegation:\n  backend: model_map\n');
  const cur = loadHelpers(h2, 'anthropic');
  assert.equal(cur.perJobChoice, false);
  const s = cleanHelpers({ enabled: true, maxAtOnce: 3, stepLimit: 40, maxTier: 'standard', defaultTier: 'light', routes: { light: { model: 'claude-haiku-5-5' }, standard: { model: 'claude-sonnet-5-5' } } }, ['claude-haiku-5-5', 'claude-sonnet-5-5'], cur);
  const h = saveHelpers(h2, s, 'anthropic');
  const text = fs.readFileSync(path.join(h2, 'config.yaml'), 'utf8');
  assert.match(text, /backend: default/);
  assert.match(text, /model: claude-haiku-5-5/);
  assert.equal(h.routes.standard.model, 'claude-haiku-5-5', 'read back as the single default route');
});

test('helper runs: missing state.db gives an empty list', () => {
  assert.deepEqual(helperRuns(path.join(dir, 'nowhere')), []);
});

test('helper runs are read from async_delegations, newest first', () => {
  const h3 = path.join(dir, 'home3');
  fs.mkdirSync(h3);
  const sdb = new Database(path.join(h3, 'state.db'));
  sdb.exec('CREATE TABLE async_delegations (delegation_id TEXT PRIMARY KEY, origin_session TEXT NOT NULL, state TEXT NOT NULL, dispatched_at REAL NOT NULL, completed_at REAL, updated_at REAL NOT NULL, task_json TEXT, result_json TEXT)');
  const ins = sdb.prepare('INSERT INTO async_delegations VALUES (?,?,?,?,?,?,?,?)');
  ins.run('d1', 's', 'completed', 100, 160, 160, JSON.stringify({ tasks: [{ goal: 'Check disk on Host1' }] }), JSON.stringify({ results: [{ status: 'completed', summary: 'Disk 41% used', route: { model: 'gpt-6-luna' } }] }));
  ins.run('d2', 's', 'running', 200, null, 200, JSON.stringify({ goal: 'Read the nginx logs' }), null);
  sdb.close();
  const runs = helperRuns(h3);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, 'd2');
  assert.deepEqual(runs[0].goals, ['Read the nginx logs']);
  assert.equal(runs[1].summary, 'Disk 41% used');
  assert.deepEqual(runs[1].models, ['gpt-6-luna']);
  assert.equal(runs[1].endedAt, 160000);
});

fs.rmSync(dir, { recursive: true, force: true });
test('helper models are only the bot\'s own models (Auto tiers + manual + main), as listed', () => {
  const listed = ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-2'];
  const auto = { model: 'claude-sonnet-5', model_mode: 'auto', model_tiers: JSON.stringify({ light: { model: 'claude-sonnet-5' }, standard: { model: 'claude-opus-5-5' } }) };
  assert.deepEqual(helperModels(auto, 'claude-sonnet-5', listed), ['claude-sonnet-5', 'claude-opus-5-5']);
  // Manual: only its model and the config's main model; tiers are ignored.
  assert.deepEqual(helperModels({ ...auto, model_mode: 'manual' }, 'claude-sonnet-5', listed), ['claude-sonnet-5']);
  // Nothing listed: the bot's own models are kept, never anything else.
  assert.deepEqual(helperModels({ model: null, model_mode: 'manual' }, 'gpt-6.2-sol', []), ['gpt-6.2-sol']);
  // A model the bot isn't allowed is refused when saving.
  const own = helperModels(auto, 'claude-sonnet-5', listed);
  const cur = readHelpers({});
  assert.throws(() => cleanHelpers({ enabled: true, maxAtOnce: 2, stepLimit: 60, maxTier: 'heavy', defaultTier: 'light', routes: { heavy: { model: 'claude-fable-5-2' } } }, own, cur), HelpersError);
  const ok = cleanHelpers({ enabled: true, maxAtOnce: 2, stepLimit: 60, maxTier: 'standard', defaultTier: 'light', routes: { light: { model: 'claude-sonnet-5' }, standard: { model: 'claude-opus-5-5' } } }, own, cur);
  assert.equal(ok.defaultTier, 'light');
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
