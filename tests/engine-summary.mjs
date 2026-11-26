// The collapsed Engine section's line and problem count (server/src/engine-summary.ts), shared with the
// phone (mobile/src/engineSummary.ts). Needs a built server: `npm run build -w server`, then `node tests/engine-summary.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { engineSummary } = await import('../server/dist/engine-summary.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const cat = (id, name, access = 'ready', extra = {}) => ({ id, name, access, verified: null, lastTurn: null, ...extra });
const base = {
  status: 'ready', provider: 'anthropic', model: 'claude-sonnet-5', modelMode: 'manual', modelTiers: null,
  providers: [{ id: 'anthropic', name: 'Anthropic', kind: 'api_key', connected: true }],
  catalog: [cat('anthropic', 'Anthropic'), cat('openai-codex', 'ChatGPT', 'not_signed_in'), cat('openrouter', 'OpenRouter', 'needs_key')],
  fallbacks: [],
};

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/engineSummary.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/engine-summary.ts', import.meta.url), 'utf8'));
});

test('manual: model and effort, no problems when the provider in use works', () => {
  const s = engineSummary(base, 'medium');
  assert.equal(s.line, 'claude-sonnet-5 · Medium effort');
  assert.equal(s.providerName, 'Anthropic');
  assert.deepEqual(s.problems, [], 'providers the bot does not use are not problems');
});

test('auto: counts the tiers set', () => {
  assert.equal(engineSummary({ ...base, modelMode: 'auto', modelTiers: { light: { model: 'a', effort: 'low' }, heavy: { model: 'b', effort: 'high' } } }, 'high').line, 'Auto · 2 tiers');
  assert.equal(engineSummary({ ...base, modelMode: 'auto', modelTiers: {} }).line, 'Auto · claude-sonnet-5');
});

test('out of credit: the newest failed request on the provider in use is a problem', () => {
  const e = { ...base, catalog: [cat('anthropic', 'Anthropic', 'ready', { verified: { at: 1, ok: true }, lastTurn: { at: 2, ok: false } })] };
  assert.deepEqual(engineSummary(e).problems, ['Anthropic: last request failed']);
  const fixed = { ...base, catalog: [cat('anthropic', 'Anthropic', 'ready', { verified: { at: 3, ok: true }, lastTurn: { at: 2, ok: false } })] };
  assert.deepEqual(engineSummary(fixed).problems, [], 'a newer good Check clears it');
});

test('agent down, provider not signed in, and a fallback with no key all count', () => {
  const e = { ...base, status: 'error', provider: 'openai-codex', fallbacks: [{ provider: 'openrouter', model: 'x' }, { provider: 'anthropic', model: 'y' }] };
  assert.deepEqual(engineSummary(e).problems, ['Agent has a problem', 'ChatGPT: not signed in', 'Fallback 1 (OpenRouter): no key']);
});

test('no catalog (owner agent, older server): a disconnected subscription counts', () => {
  const e = { ...base, catalog: undefined, provider: 'codex', providers: [{ id: 'codex', name: 'Codex', kind: 'subscription', connected: false }] };
  assert.deepEqual(engineSummary(e).problems, ['Codex: not signed in']);
  assert.equal(engineSummary({ ...base, catalog: undefined, providers: [], provider: null, model: null }).line, 'Default model');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
