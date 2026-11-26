// Emoji reaction helpers (server/src/reactions.ts). Needs a built server:
// `npm run build -w server`, then `node tests/reactions.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const t = await import('../server/dist/reactions.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const me = { kind: 'person', id: 'person', name: 'Alex' };
const leo = { kind: 'bot', id: 'bot_l', name: 'Leonard' };

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/reactions.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/reactions.ts', import.meta.url), 'utf8'));
});
test('every picker emoji is accepted, text is not', () => {
  for (const e of [...t.QUICK_REACTIONS, ...t.MORE_REACTIONS]) assert.ok(t.isReactionEmoji(e), e);
  for (const bad of ['', 'ok', 'approve', '👍👍👍👍👍👍👍👍👍', '1', '<b>', 42, null]) assert.equal(t.isReactionEmoji(bad), false, String(bad));
  assert.ok(t.isReactionEmoji('🦄'), 'other single emoji are fine');
  assert.ok(t.isReactionEmoji('👍🏽'), 'skin tones are fine');
});
test('a toggle adds, then takes back', () => {
  const a = t.toggleReaction(undefined, '👍', me, 1);
  assert.equal(a.added, true);
  assert.equal(a.list.length, 1);
  const b = t.toggleReaction(a.list, '👍', me, 2);
  assert.equal(b.added, false);
  assert.equal(b.list.length, 0);
});
test("a person's toggle leaves a Bot's same emoji alone", () => {
  const withBot = t.toggleReaction(undefined, '👍', leo, 1).list;
  const both = t.toggleReaction(withBot, '👍', me, 2).list;
  assert.equal(both.length, 2);
  const back = t.toggleReaction(both, '👍', me, 3).list;
  assert.deepEqual(back.map((r) => r.by.kind), ['bot']);
});
test('chips group by emoji, mark yours, and name who reacted', () => {
  let l = t.toggleReaction(undefined, '👍', leo, 1).list;
  l = t.toggleReaction(l, '❤️', me, 2).list;
  l = t.toggleReaction(l, '👍', me, 3).list;
  assert.deepEqual(t.reactionChips(l), [
    { emoji: '👍', count: 2, mine: true, names: 'Leonard, You' },
    { emoji: '❤️', count: 1, mine: true, names: 'You' },
  ]);
  assert.deepEqual(t.reactionChips(undefined), []);
});
test('one message holds at most 12 different emoji', () => {
  let l = [];
  for (const e of t.MORE_REACTIONS.slice(0, 12)) l = t.toggleReaction(l, e, me, 1).list;
  const r = t.toggleReaction(l, '👍', me, 2);
  assert.equal(r.added, false);
  assert.equal(r.list, l);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
