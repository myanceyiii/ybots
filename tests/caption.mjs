// The live "thinking" line (server/src/caption.ts): a short recap that is never cut mid-sentence, plus the
// whole thought for the expanded bubble. Needs a built server: `npm run build -w server`, then `node tests/caption.mjs`.
import assert from 'node:assert/strict';
const t = await import('../server/dist/caption.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const long = "I'm weighing whether the read-only Actual Budget tools could give me enough to build the morning briefing, or whether I need the Plaid connector for live balances. The last run failed twice.";

test('a long thought gets a short recap with no ellipsis, and the full text', () => {
  const c = t.captionFrom(long);
  assert.ok(c.short.length <= t.SHORT_MAX, c.short);
  assert.ok(!/[….,;:]$/.test(c.short), c.short);
  assert.equal(c.short, 'Weighing whether read-only Actual Budget tools');
  assert.equal(c.full, long);
});
test('the recap never ends on a filler word', () => {
  for (const s of [long, 'Okay, so I need to figure out which of the three accounts the payment came from, since the memo is blank.',
    'I am going to search the web for the current price of a Pixel 10 Pro in the US, then compare it with the trade-in offer.']) {
    const last = t.captionFrom(s).short.split(' ').pop().toLowerCase();
    assert.ok(!['the', 'a', 'of', 'to', 'whether', 'for', 'could', 'in'].includes(last), `${s} -> ${last}`);
  }
});
test('a heading is the recap; the paragraph under it is the full text', () => {
  const c = t.captionFrom('**Old title**\n\nold text\n\n**Checking budget categories**\n\nI need to look at the December categories.');
  assert.deepEqual(c, { short: 'Checking budget categories', full: 'I need to look at the December categories.' });
});
test('a heading alone has nothing to expand', () => {
  assert.deepEqual(t.captionFrom('**Weighing Actual Budget tool access**'), { short: 'Weighing Actual Budget tool access', full: null });
});
test('a short sentence is shown whole, with nothing to expand', () => {
  assert.deepEqual(t.captionParts('Checking the calendar.'), { short: 'Checking the calendar', full: null });
});
test('the full text is cut only at a sentence end', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const c = t.captionParts(many);
  assert.ok(c.full.length <= t.FULL_MAX);
  assert.ok(c.full.endsWith('here.'), c.full.slice(-20));
});
test('empty or tiny text gives nothing', () => {
  assert.equal(t.captionFrom(''), null);
  assert.equal(t.captionParts('ok'), null);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
