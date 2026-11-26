// Unit test for applyModelToConfig (server/src/engine.ts): the bot's chosen provider and model become
// its Hermes config's default route. Needs a built server: `npm run build -w server`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-model-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'engines'), SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', HERMES_HOME_PRIMARY: path.join(dir, 'h') });
const { applyModelToConfig } = await import('../server/dist/engine.js');
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };

test('switching provider replaces the default route and drops the old endpoint settings', () => {
  const cfg = { model: { default: 'gpt-6.2-sol', provider: 'openai-codex', base_url: 'https://chatgpt.example/codex', context_length: 400000 }, other: 1 };
  assert.equal(applyModelToConfig(cfg, 'anthropic', 'claude-sonnet-5'), true);
  assert.deepEqual(cfg.model, { default: 'claude-sonnet-5', provider: 'anthropic' });
  assert.equal(cfg.other, 1);
});

test('same provider, new model only changes the model', () => {
  const cfg = { model: { default: 'claude-sonnet-5', provider: 'anthropic', context_length: 200000 } };
  assert.equal(applyModelToConfig(cfg, 'anthropic', 'claude-opus-5-5'), true);
  assert.deepEqual(cfg.model, { default: 'claude-opus-5-5', provider: 'anthropic', context_length: 200000 });
});

test('nothing to do is reported as no change', () => {
  const cfg = { model: { default: 'claude-sonnet-5', provider: 'anthropic' } };
  assert.equal(applyModelToConfig(cfg, 'anthropic', 'claude-sonnet-5'), false);
  assert.equal(applyModelToConfig(cfg, null, null), false);
});

test('a plain string model is turned into a block', () => {
  const cfg = { model: 'gpt-5.5' };
  assert.equal(applyModelToConfig(cfg, 'openai-codex', null), true);
  assert.deepEqual(cfg.model, { provider: 'openai-codex' });
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
