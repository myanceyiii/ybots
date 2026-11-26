// The chat list's line under each bot (server/src/list-preview.ts) and the summary clean-up
// (server/src/list-summary.ts). Needs a built server: `npm run build -w server`, then `node tests/list-preview.mjs`.
import assert from 'node:assert/strict';
const P = await import('../server/dist/list-preview.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const msg = (role, text, from) => ({ type: 'message', role, text, ...(from ? { from } : {}) });
const noCut = (s) => assert.ok(!/…$/.test(s), `ends in an ellipsis: ${s}`);

const long = 'Google Tasks can work, but Howard can\'t switch it on himself, so you need to decide who does it. I can walk you through the Connect step in Settings if you like, or Howard can ask you on a card.';

test("a bot's own reply: whole sentences, and a short recap on whole words", () => {
  const p = P.listPreview([msg('assistant', long)], false);
  assert.equal(p.by, 'bot');
  assert.ok(p.text.length <= P.LONG_MAX, p.text);
  assert.equal(p.text, "Google Tasks can work, but Howard can't switch it on himself, so you need to decide who does it.");
  assert.ok(p.short.length <= P.SHORT_MAX, p.short);
  noCut(p.text); noCut(p.short);
  assert.deepEqual(p.forms, [p.text, "Google Tasks can work, but Howard can't switch it on himself", p.short], 'a middle form on whole words');
});

test('you posted last', () => {
  const p = P.listPreview([msg('user', 'Can you check the bills?'), msg('assistant', 'Sure.')], false);
  assert.deepEqual([p.text, p.short, p.by], ['You posted last.', 'You posted last.', 'you']);
});

test('a voice call message counts as you', () => {
  assert.equal(P.listPreview([msg('user', 'yes', { kind: 'voice', id: 'c', name: 'Voice call' })], false).text, 'You posted last.');
});

test('another bot posted last', () => {
  const p = P.listPreview([msg('user', 'Leonard, the Tasks connector is on.', { kind: 'bot', id: 'h', name: 'Howard' }), msg('assistant', 'Ok')], false);
  assert.deepEqual([p.text, p.by], ['Howard posted last.', 'other']);
});

test('a Claude thread signed in to the account', () => {
  assert.equal(P.listPreview([msg('user', 'hi', { kind: 'agent', id: 's', name: 'Claude: Fix list previews' })], false).text, 'Claude posted last.');
});

test('a routine', () => {
  assert.equal(P.listPreview([msg('user', 'run', { kind: 'routine', id: 'r', name: 'Morning brief' })], false).text, 'A routine ran last.');
});

test('a pending approval keeps "Waiting for you" in both forms', () => {
  const p = P.listPreview([{ type: 'card', card: 'approval', approvalId: 'a', title: 'Allow Howard to hermes owner run command with a very long description of what it does?', status: 'pending' }], false);
  assert.match(p.text, /^Waiting for you/);
  assert.equal(p.short, 'Waiting for you.');
});

test('a files card is skipped for the reply above it', () => {
  assert.equal(P.listPreview([{ type: 'card', card: 'files', files: [] }, msg('assistant', 'Done, the sheet is saved.')], false).text, 'Done, the sheet is saved.');
});

test('in a group, the newest message with its writer; short says who posted', () => {
  const p = P.listPreview([msg('assistant', '**Leonard: money**\n\n- one\n- two', { kind: 'bot', id: 'l', name: 'Leonard' })], true);
  assert.equal(p.text, 'Leonard: Leonard: money - one - two');
  assert.equal(p.short, 'Leonard posted last.');
  assert.equal(p.by, 'member');
});

test('in a group, you posted last', () => {
  assert.equal(P.listPreview([msg('user', '@Howard hi')], true).text, 'You posted last.');
});

test('a group event shows when newest', () => {
  assert.equal(P.listPreview([{ type: 'event', event: 'bot-message', text: 'Bo left' }], true).text, 'Bo left');
});

test('one very long sentence falls back to the recap, never a cut', () => {
  const p = P.listPreview([msg('assistant', 'I checked every one of the household accounts that are connected through the Plaid bridge and the Actual budget and found three duplicate subscriptions that renew next week')], false);
  assert.ok(p.text.length <= P.MID_MAX, p.text);
  assert.ok(p.short.length <= P.SHORT_MAX, p.short);
  assert.deepEqual(p.forms, [p.text, p.short]);
  noCut(p.text); noCut(p.short);
});

test('empty chat', () => { assert.equal(P.listPreview([], false), null); });

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
