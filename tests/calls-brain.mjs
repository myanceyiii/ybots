// Phone calls, the pure part (server/src/calls-reply.ts): turning the model's answer into one spoken turn,
// key presses or a hang-up. Run after `npm run build -w server`.
import assert from 'node:assert/strict';
import { parseReply, localMessages, turnProblem } from '../server/dist/calls-reply.js';
import { usNumber, callScript, callResultText, allPartyState } from '../server/dist/calls-place.js';

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };

test('a plain JSON turn', () => {
  assert.deepEqual(parseReply('{"say":"Hi, do you have a table for four?","action":"talk"}'), { say: 'Hi, do you have a table for four?', action: 'talk' });
});
test('JSON inside other text, with a note', () => {
  assert.deepEqual(parseReply('Sure:\n{"say":"Thanks, bye.","action":"hang_up","note":"Closed Mondays"}'), { say: 'Thanks, bye.', action: 'hang_up', note: 'Closed Mondays' });
});
test('key presses keep only digits, * and #', () => {
  assert.deepEqual(parseReply('{"say":"","action":"press_keys","keys":"2; rm -rf #"}'), { say: '', action: 'press_keys', keys: '2#' });
});
test('press_keys without keys becomes talk', () => {
  assert.equal(parseReply('{"say":"Hello?","action":"press_keys"}').action, 'talk');
});
test('an unknown action is only talk, never anything else', () => {
  assert.equal(parseReply('{"say":"ok","action":"pay"}').action, 'talk');
});
test('not JSON (an engine error): marked invalid and never spoken', () => {
  assert.deepEqual(parseReply('Billing or credits exhausted: HTTP 400'), { say: '', action: 'talk', invalid: true });
});
test('long text is cut', () => {
  assert.equal(parseReply(JSON.stringify({ say: 'a'.repeat(2000), action: 'talk' })).say.length, 600);
});

test('the local model sees the call as chat turns, ending on their words', () => {
  const m = localMessages('RULES', [{ who: 'bot', text: 'Hi, this is Howard.' }, { who: 'them', text: 'Hello?' }]);
  assert.deepEqual(m.map((x) => x.role), ['system', 'assistant', 'user']);
  assert.equal(JSON.parse(m[1].content).say, 'Hi, this is Howard.');
  assert.equal(m[2].content, 'Them: Hello?');
  assert.equal(localMessages('RULES', [{ who: 'bot', text: 'Hi' }]).at(-1).role, 'user');
});

const call = [{ who: 'bot', text: 'Hi, this is an AI assistant calling for Alex Morgan. This call is recorded. This is a test call.' }, { who: 'them', text: 'Any living?' }];
test('a turn claiming to be the person it calls for is thrown out', () => {
  assert.ok(turnProblem('Yes, I am Alex Morgan, and yes, I am alive.', call));
  assert.ok(turnProblem("This is Alex.", call));
  assert.ok(turnProblem("I'm a real person, don't worry.", call));
});
test('repeating the introduction is thrown out', () => {
  assert.ok(turnProblem('Hello, this is an AI assistant calling for Alex Morgan. This call is recorded.', call));
});
test('normal turns pass, including booking under his name', () => {
  assert.equal(turnProblem("I'm an AI assistant calling for him. Could I book a table for four at seven under Alex Morgan?", call), null);
  assert.equal(turnProblem('Great, thank you. Goodbye.', call), null);
});

test('place_call: US numbers only, 555/900/N11 refused', () => {
  assert.deepEqual(usNumber('(918) 807-4399'), { number: '+19188074399' });
  assert.ok('error' in usNumber('918-555-1234'));
  assert.ok('error' in usNumber('1-900-222-3333'));
  assert.ok('error' in usNumber('+44 20 7946 0000'));
});
test('place_call: all-party states ask before recording', () => {
  assert.equal(allPartyState('+14155550000'), 'California');
  assert.equal(allPartyState('+19188074399'), null);
  const ca = callScript('Leonard', { to: '', business: 'Zuni', purpose: 'Ask hours', onBehalfOf: 'Alex Morgan', maxMinutes: 5 }, '+14153334444');
  assert.match(ca.opening, /AI assistant calling for Alex Morgan\. This call is recorded\. Is that okay with you\?$/);
  assert.match(ca.brief, /California/);
  const ok = callScript('Leonard', { to: '', business: 'Romano', purpose: 'Book', onBehalfOf: 'Alex Morgan', maxMinutes: 5 }, '+19183334444');
  assert.doesNotMatch(ok.opening, /okay with you/);
});
test('place_call: the result says when nobody answered', () => {
  assert.match(callResultText({ id: 'x', status: 'ended', to: '', transcript: [], notes: [] }, 'Romano'), /Nobody answered/);
  assert.match(callResultText({ id: 'x', status: 'ended', to: '', transcript: [{ who: 'them', text: 'Hi' }], notes: ['open till 9'], answered: 10, ended: 75 }, 'Romano'), /1 min 5 s[\s\S]*open till 9[\s\S]*Them: Hi/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
