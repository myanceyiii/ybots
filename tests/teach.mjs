// Tests for Teach a bot (server/src/teach.ts, teach-page.ts): masking of recorded steps with OpenBot's rules,
// folding repeats, plain-words steps, and reading the model's draft. Hermetic.
// Needs a built server: `npm run build -w server`, then `node tests/teach.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'engines'), SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', HERMES_HOME_PRIMARY: path.join(dir, 'h') });
const t = await import('../server/dist/teach.js');
const page = await import('../server/dist/teach-page.js');
const masking = await import('../server/dist/vendor/openbot/recorder-masking.js');
let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };
const O = 'https://shop.example.com';

await test('the page script carries the same sensitive-field rule as the vendored OpenBot file', () => {
  assert.equal(page.SENSITIVE_FIELD_SOURCE, masking.SENSITIVE_FIELD.source);
  assert.ok(page.TEACH_SOURCE.includes(JSON.stringify(page.TEACH_BINDING)));
  new Function(page.TEACH_SOURCE); // it parses
});

await test('a password field keeps no value, whatever the page sent', () => {
  const s = t.cleanStep('b', { t: 'type', role: 'textbox', name: 'Password', tag: 'input', attrs: { type: 'password' }, text: 'hunter22', origin: O });
  assert.equal(s.sensitive, true);
  assert.equal(s.name, '[sensitive field]');
  assert.equal(s.text, undefined);
  assert.ok(!JSON.stringify(s).includes('hunter22'));
});

await test('a one-time code field is caught by its shape and its autocomplete', () => {
  const a = t.cleanStep('b', { t: 'type', role: 'textbox', name: 'Enter the code we sent', tag: 'input', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code' }, text: '482913', origin: O });
  assert.equal(a.sensitive, true);
  assert.equal(a.text, undefined);
  const card = t.cleanStep('b', { t: 'type', role: 'textbox', name: 'Card number', tag: 'input', attrs: { name: 'cardnumber' }, text: '4242 4242 4242 4242', origin: O });
  assert.equal(card.sensitive, true);
});

await test('ordinary typing is kept, with emails, card numbers and tokens masked', () => {
  const s = t.cleanStep('b', { t: 'type', role: 'textbox', name: 'Search', tag: 'input', attrs: { type: 'search' }, text: 'dog food for alex@example.com', origin: O });
  assert.equal(s.sensitive, undefined);
  assert.equal(s.text, 'dog food for [redacted]');
  const n = t.cleanStep('b', { t: 'type', role: 'textbox', name: 'Notes', tag: 'textarea', attrs: {}, text: 'pay with 4242 4242 4242 4242 ok', origin: O });
  assert.ok(!n.text.includes('4242 4242'));
  const k = t.cleanStep('b', { t: 'click', role: 'button', name: 'Copy key ' + 'sk_' + 'live_abcdefghijklmnopqrstuvwxyz123456', origin: O }); // a fake key, split so secret scanners don't flag it
  assert.ok(k.name.includes('[redacted]'));
});

await test('page addresses lose sign-in codes and tokens', () => {
  const s = t.cleanStep('b', { t: 'page', url: `${O}/callback?code=abc123&state=xyz789`, title: 'Signed in', origin: O });
  assert.ok(!s.url.includes('abc123'));
  assert.ok(!s.url.includes('xyz789'));
  assert.equal(t.cleanStep('b', { t: 'page', url: 'chrome://newtab/', origin: 'chrome://newtab' }), null);
  assert.equal(t.cleanStep('b', { t: 'nope', origin: O }), null);
});

await test('repeats fold: same page, typing again into the same field, a double Enter', () => {
  const steps = [];
  const at = Date.now();
  t.pushStep(steps, { at, kind: 'page', name: 'Page', role: 'page', origin: O, url: `${O}/` });
  assert.equal(t.pushStep(steps, { at, kind: 'page', name: 'Page', role: 'page', origin: O, url: `${O}/` }), false);
  t.pushStep(steps, { at, kind: 'type', name: 'Search', role: 'textbox', origin: O, text: 'dog' });
  t.pushStep(steps, { at, kind: 'type', name: 'Search', role: 'textbox', origin: O, text: 'dog food' });
  t.pushStep(steps, { at, kind: 'press', name: 'Search', role: 'textbox', origin: O });
  t.pushStep(steps, { at: at + 10, kind: 'press', name: 'Search', role: 'textbox', origin: O });
  assert.deepEqual(steps.map((s) => s.kind), ['page', 'type', 'press']);
  assert.equal(steps[1].text, 'dog food');
});

await test('steps read in plain words', () => {
  assert.equal(t.stepLine({ kind: 'click', name: 'Add to cart', role: 'button', origin: O }), 'Click the “Add to cart” button');
  assert.equal(t.stepLine({ kind: 'type', name: 'Search', role: 'textbox', origin: O, text: 'dog food' }), 'Type “dog food” into “Search”');
  assert.match(t.stepLine({ kind: 'type', name: '[sensitive field]', role: 'textbox', origin: O, sensitive: true }), /sensitive field on shop\.example\.com/);
  assert.equal(t.stepLine({ kind: 'check', name: 'Gift wrap', role: 'checkbox', origin: O, checked: true }), 'Tick “Gift wrap”');
});

await test('the model\'s draft is read; a bad one gives null', () => {
  const d = t.parseDraft('NAME: Order Pet Food\nDESCRIPTION: Use when the person wants pet food ordered.\n---\n## Steps\n\n1. Open the shop.\n2. Search for the food.\n');
  assert.equal(d.name, 'order-pet-food');
  assert.match(d.body, /^## Steps/);
  assert.equal(t.parseDraft('Sure! Here is a skill.'), null);
});

await test('without the model, the steps are written up as they are, with the safety notes', () => {
  const steps = [
    { at: 1, kind: 'page', name: 'Page', role: 'page', origin: O, url: `${O}/` },
    { at: 2, kind: 'type', name: '[sensitive field]', role: 'textbox', origin: O, sensitive: true },
  ];
  const d = t.plainDraft(steps, 'Use the usual brand');
  assert.equal(d.name, 'shop-task');
  assert.match(d.body, /1\. Open https:\/\/shop\.example\.com\//);
  assert.match(d.body, /ask_secure_input/);
  assert.match(d.body, /request_purchase_approval/);
  assert.match(d.body, /Use the usual brand/);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
