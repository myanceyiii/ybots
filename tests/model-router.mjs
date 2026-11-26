// Unit tests for server/src/model-router.ts (manual/auto model choice, tiers, stickiness, provider lock).
// Needs a built server: `npm run build -w server`, then `node tests/model-router.mjs`.
import assert from 'node:assert/strict';

const r = await import('../server/dist/model-router.js');
let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

const tiers = r.suggestTiers([{
  id: 'anthropic', connected: true,
  models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'],
}]).anthropic.tiers;
const auto = { mode: 'auto', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', tiers, providerLock: null };
const manual = { ...auto, mode: 'manual', model: 'claude-opus-5-5' };
const u = (text, source = 'user') => ({ text, source, priorTurns: 1 });
const tierOf = (text, source) => r.classify(u(text, source)).tier;

test('small talk and simple asks are light', () => {
  for (const t of ['thanks!', 'ok', 'good morning', 'add milk to my grocery list', 'what time is it in Denver?', 'remind me at 5 to call mom']) assert.equal(tierOf(t), 'light', t);
});

test('ordinary requests are standard', () => {
  for (const t of [
    'Can you find a good Thai place near the office for Friday lunch?',
    'Summarize this article for me and tell me what you think of it.',
    'Reconcile last month against the bank statement.',
  ]) assert.equal(tierOf(t), 'standard', t);
});

test('planning, code, legal, finance and long work are heavy', () => {
  for (const t of [
    'Plan the migration of our home server to the new machine and analyze the risks step by step.',
    'Debug this:\n```\nTypeError: x is undefined\n    at run (app.js:10:5)\n```',
    'Review this contract clause and draft a memo on the negotiation strategy.',
    'Build a budget forecast for next year and draft a report comparing it with last year.',
    'think hard about this one',
  ]) assert.equal(tierOf(t), 'heavy', t);
});

test('system notices and teammate pings lean light', () => {
  assert.equal(tierOf('The user skipped connecting Gmail. Continue without it.', 'system'), 'light');
  assert.equal(tierOf('Got it, thanks', 'bot'), 'light');
});

test('a failed turn escalates the next one', () => {
  const t = 'Can you try that again? It did not work last time and I need it working.';
  assert.equal(r.classify(u(t), false).tier, 'standard');
  assert.equal(r.classify(u(t), true).tier, 'heavy');
});

test('manual mode sends exactly the manual choice', () => {
  const out = r.route(manual, u('thanks'), r.freshState(0));
  assert.deepEqual([out.mode, out.provider, out.model, out.tier, out.state], ['manual', 'anthropic', 'claude-opus-5-5', null, null]);
});

test('auto mode picks the tier model and its effort, never another provider', () => {
  const light = r.route(auto, u('thanks'), r.freshState(0));
  assert.deepEqual([light.provider, light.model, light.effort, light.tier], ['anthropic', tiers.light.model, 'low', 'light']);
  const heavy = r.route(auto, u('Plan and analyze our tax strategy step by step'), r.freshState(0));
  assert.deepEqual([heavy.provider, heavy.model, heavy.effort, heavy.tier], ['anthropic', tiers.heavy.model, 'high', 'heavy']);
});

test('going up is immediate, going down waits two lighter turns', () => {
  let s = r.freshState(3);
  let out = r.route(auto, u('Plan and analyze our tax strategy step by step'), s); s = out.state;
  assert.equal(out.tier, 'heavy');
  out = r.route(auto, u('thanks'), s); s = out.state;
  assert.equal(out.tier, 'heavy', 'first lighter turn stays');
  out = r.route(auto, u('ok'), s); s = out.state;
  assert.equal(out.tier, 'light', 'second lighter turn steps down');
  out = r.route(auto, u('Debug this stack trace and plan the refactor'), s);
  assert.equal(out.tier, 'heavy', 'back up at once');
});

test('long conversations wait one more turn before stepping down', () => {
  let s = { generation: 1, tier: 'heavy', lowerStreak: 0, lastFailed: false };
  const long = (t) => ({ text: t, source: 'user', priorTurns: 25 });
  let out = r.route(auto, long('thanks'), s); s = out.state; assert.equal(out.tier, 'heavy');
  out = r.route(auto, long('ok'), s); s = out.state; assert.equal(out.tier, 'heavy');
  out = r.route(auto, long('cool'), s); assert.equal(out.tier, 'light');
});

test('a new chat forgets the old tier', () => {
  const s = r.parseState(JSON.stringify({ generation: 1, tier: 'heavy', lowerStreak: 1, lastFailed: true }), 2);
  assert.deepEqual(s, r.freshState(2));
});

test('missing tiers fall back upward, then to the manual model', () => {
  const only = { ...auto, tiers: { heavy: { model: 'big', effort: 'high' } } };
  const out = r.route(only, u('thanks'), r.freshState(0));
  assert.equal(out.model, 'big');
  const none = { ...auto, tiers: null };
  assert.equal(r.route(none, u('thanks'), r.freshState(0)).model, 'claude-sonnet-5');
});

test('provider lock refuses any other provider', () => {
  assert.equal(r.lockViolation({ providerLock: 'openai-codex' }, 'openai-codex'), null);
  assert.match(r.lockViolation({ providerLock: 'openai-codex' }, 'anthropic'), /locked to the openai-codex/);
  assert.match(r.lockViolation({ providerLock: 'openai-codex' }, null), /engine default/);
  assert.equal(r.lockViolation({ providerLock: null }, 'anthropic'), null);
});

test('stored tiers are cleaned', () => {
  assert.equal(r.cleanTiers('not json'), null);
  assert.deepEqual(r.cleanTiers({ light: { model: ' a-1 ', effort: 'bogus' }, heavy: { model: 'bad model; rm -rf' } }), { light: { model: 'a-1', effort: 'low' } });
  assert.deepEqual(r.cleanTiers({ standard: { model: 'claude-sonnet-5-5[1m]', effort: 'medium' } }), { standard: { model: 'claude-sonnet-5-5[1m]', effort: 'medium' } });
});

test('the Claude subscription and OpenRouter get suggested tiers from their own lists', () => {
  const sub = r.suggestTiers([{ id: 'claude-subscription-directsdk-experimental', connected: true,
    models: ['claude-sonnet-5-5[1m]', 'claude-sonnet-5[1m]', 'claude-haiku-5-5[1m]', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]', 'claude-opus-5[1m]'] }]);
  assert.deepEqual(sub['claude-subscription-directsdk-experimental'].tiers, {
    light: { model: 'claude-haiku-5-5[1m]', effort: 'low' },
    standard: { model: 'claude-sonnet-5-5[1m]', effort: 'medium' },
    heavy: { model: 'claude-opus-5-5[1m]', effort: 'high' },
  });
  const or = r.suggestTiers([{ id: 'openrouter', connected: true, models: ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'] }]);
  assert.equal(or.openrouter.tiers.heavy.model, 'anthropic/claude-opus-5.5');
  // Not signed in: nothing suggested.
  assert.deepEqual(r.suggestTiers([{ id: 'claude-subscription-directsdk-experimental', connected: false, models: ['claude-sonnet-5-5[1m]'] }]), {});
});

const mc = await import('../server/dist/model-choice.js').catch(() => null);
if (mc) test('only model-shaped failures escalate', () => {
  assert.equal(mc.failureEscalates('No Codex credentials stored. Run `hermes auth add openai-codex`'), false);
  assert.equal(mc.failureEscalates('429 rate limit exceeded'), false);
  assert.equal(mc.failureEscalates('The operation was aborted due to timeout'), false);
  assert.equal(mc.failureEscalates('the answer came back malformed'), true);
  assert.equal(mc.failureEscalates(null), false);
});

test('minTier lifts a turn to at least that tier (maintainer work runs heavy)', () => {
  assert.equal(r.classify({ text: 'ok', source: 'user', priorTurns: 1, minTier: 'heavy' }).tier, 'heavy');
  assert.equal(r.classify({ text: 'Get as far as you can before the outage', source: 'user', priorTurns: 1, minTier: 'heavy' }).tier, 'heavy');
  const out = r.route(auto, { text: 'check the disks', source: 'user', priorTurns: 1, minTier: 'heavy' }, r.parseState(null, 1));
  assert.equal(out.tier, 'heavy');
  assert.equal(out.model, tiers.heavy.model);
  assert.match(out.reason, /heavy for maintainer work/);
  assert.equal(r.classify({ text: 'ok', source: 'user', priorTurns: 1 }).tier, 'light');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
