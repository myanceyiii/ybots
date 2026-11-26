// Choice buttons, the pure part (server/src/choice-detect.ts): checking a bot's choices and spotting an
// obvious yes/no or "this or that" question at the end of a reply. Run after `npm run build -w server`.
import assert from 'node:assert/strict';
import { checkChoices, detectChoices } from '../server/dist/choice-detect.js';

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const opts = (t) => detectChoices(t).map((c) => c.options);

test('checkChoices: 2 to 4 short, different options and a question', () => {
  assert.deepEqual(checkChoices({ question: ' Hold or raise? ', options: ['Hold', ' Raise ', 'hold'] }), { question: 'Hold or raise?', options: ['Hold', 'Raise'], other: false });
  assert.match(checkChoices({ question: 'Q?', options: ['Only'] }), /at least two/);
  assert.match(checkChoices({ question: 'Q?', options: ['a', 'b', 'c', 'd', 'e'] }), /at most 4/);
  assert.match(checkChoices({ options: ['a', 'b'] }), /question/);
  assert.equal(checkChoices({ question: 'Q?', options: ['a', 'b'], other: true }).other, true);
  assert.equal(checkChoices({ question: 'Q?', options: ['x'.repeat(200), 'b'] }).options[0].length, 60);
});

test("Leonard's two questions become Yes/No and the two amounts", () => {
  const t = 'I found the PayPal charge twice in Actual.\n\nShould I delete the $813.87 PayPal entry and add it again once it posts? Should I hold at $1,000 or budget $1,200?';
  assert.deepEqual(opts(t), [['Yes', 'No'], ['Hold at $1,000', 'Budget $1,200']]);
  assert.equal(detectChoices(t)[0].question, 'Should I delete the $813.87 PayPal entry and add it again once it posts?');
});

test('bare this-or-that picks', () => {
  assert.deepEqual(opts('Groceries are at $940 this month. Hold at $1,000 or budget $1,200?'), [['Hold at $1,000', 'Budget $1,200']]);
  assert.deepEqual(opts('Tuesday or Wednesday?'), [['Tuesday', 'Wednesday']]);
  assert.deepEqual(opts('Do you want me to book the 9am or the 11am?'), [['Book the 9am', 'The 11am']]);
});

test('yes/no openers', () => {
  for (const q of ['Want me to send it?', 'Do you want me to cancel the trial?', 'Would you like a reminder tomorrow?', 'Is that okay?', 'Sound good?', 'Shall we go ahead?', 'Okay to pay the Chase bill now?', 'Does that work?', 'Should I move it to savings or not?'])
    assert.deepEqual(opts(`Done. ${q}`), [['Yes', 'No']], q);
});

test('no buttons for open, factual or mid-reply questions', () => {
  for (const t of [
    'What would you like for dinner?',
    'Why did the sync fail? The bank needs you to sign in again.',
    'Is it raining or sunny?',
    'Let me know if you have any questions?',
    'Here is the list.',
    'Should I pay it? I paid it already. All set.',
    'Should I hold at the current amount we agreed on in March for the household budget or budget for the much higher number?',
  ]) assert.deepEqual(opts(t), [], t);
});

test('a list of three', () => {
  assert.deepEqual(opts('Should I keep the old one, move it, or delete it?'), [['Keep the old one', 'Move it', 'Delete it']]);
});

test('code and links do not confuse it', () => {
  assert.deepEqual(opts('```\nok?\n```\nSee [the bill](https://x.example/a?b=1). Should I pay it?'), [['Yes', 'No']]);
});

test('checkChoices: one option is enough with an Other box', () => {
  assert.deepEqual(checkChoices({ question: 'Approve all?', options: ['Approve all'], other: true }), { question: 'Approve all?', options: ['Approve all'], other: true });
  assert.match(checkChoices({ question: 'Approve all?', options: ['Approve all'] }), /at least two/);
});

test('Leonard\'s briefing: Reply "approve all" or tell me which numbers to change', () => {
  const t = '**To categorize** ("approve all" applies the first guess):\n1. Nov 19, Starbucks, $8.05: Sam\'s Spending / Weekend Eating Out\n\nReply "approve all" or tell me which numbers to change.';
  const c = detectChoices(t);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].options, ['Approve all']);
  assert.equal(c[0].other, true);
  assert.equal(c[0].question, 'Reply "approve all" or tell me which numbers to change.');
});

test('set replies: two or three quoted answers, curly and single quotes', () => {
  assert.deepEqual(detectChoices('All done.\n\nReply “send it” or “hold it”.').map((c) => [c.options, !!c.other]), [[['Send it', 'Hold it'], false]]);
  assert.deepEqual(detectChoices("Say 'yes', 'no' or 'later'.")[0].options, ['Yes', 'No', 'Later']);
  assert.deepEqual(detectChoices('Just reply with "go" when ready.')[0], { question: 'Just reply with "go" when ready.', options: ['Go'], other: true });
});

test('no set-reply buttons mid-reply or for quotes that are not answers', () => {
  for (const t of [
    'Reply "approve all" or tell me which to change. Then I\'ll file them tonight.',
    'He said "approve all" yesterday.',
    'The memo is titled "Q4 plan". It is in your Drive.',
    'Reply "this is a much longer phrase than any button should ever hold for real" please.',
  ]) assert.deepEqual(detectChoices(t), [], t);
});

test('a question at the end wins over a set reply', () => {
  assert.deepEqual(detectChoices('Reply "approve all" for the list.\n\nShould I pay the card now?').map((c) => c.options), [['Yes', 'No']]);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
