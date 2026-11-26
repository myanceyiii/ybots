// "Waiting on you" and "No answer yet" never show together (server/src/reply-wait.ts, and its Android copy).
// Needs a built server: `npm run build -w server`, then `node tests/reply-wait.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const w = await import('../server/dist/reply-wait.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const T = 10_000_000;
const msg = (seq, at) => ({ seq, createdAt: at, body: { type: 'message', role: 'user', text: 'hi' } });
const card = (seq, at, status = 'pending', extra = {}) => ({ seq, createdAt: at, body: { type: 'card', card: 'approval', status, ...extra } });
const tool = (seq, at) => ({ seq, createdAt: at, body: { type: 'tool-call', status: 'done' } });
const run = (o) => w.replyWait({ live: null, startedAt: null, ...o }).state;

test('the Android copy is the same file under its one-line header', () => {
  const mobile = fs.readFileSync(new URL('../mobile/src/replyWait.ts', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server/src/reply-wait.ts', import.meta.url), 'utf8');
  assert.match(mobile.split('\n')[0], /^\/\/ Verbatim copy of server\/src\/reply-wait\.ts/);
  assert.equal(mobile.split('\n').slice(1).join('\n'), server);
});

test('a secure input card waiting (turn ended): no "No answer yet", however long', () => {
  const a = msg(1, T); const rows = [a, tool(2, T + 1000), card(3, T + 2000, 'pending', { secret: { field: 'service_key' } })];
  for (const later of [60_000, 10 * 60_000, 3 * 60 * 60_000]) assert.equal(run({ rows, asked: a, now: T + later }), 'waiting', `${later}ms`);
});

test('an approval waiting in a live turn (isRunning false, awaiting set): waiting, never stalled or slow', () => {
  const a = msg(1, T);
  const live = { isRunning: false, awaiting: { since: T + 5000 }, activity: { kind: 'waiting_for_you' } };
  assert.equal(run({ live, rows: [a], asked: a, now: T + 20 * 60_000 }), 'waiting');
  // Even if the server still says running while it waits, it is not "Taking a while".
  const r = w.replyWait({ live: { ...live, isRunning: true }, rows: [a], asked: a, startedAt: T, now: T + 20 * 60_000 });
  assert.equal(r.state, 'waiting');
});

test('question and connect cards count too; plugin cards (no status) do not', () => {
  const a = msg(1, T);
  assert.equal(run({ rows: [a, { seq: 2, createdAt: T + 1, body: { type: 'card', card: 'question', status: 'pending' } }], asked: a, now: T + 120_000 }), 'waiting');
  assert.equal(run({ rows: [a, { seq: 2, createdAt: T + 1, body: { type: 'card', card: 'connect', status: 'pending' } }], asked: a, now: T + 120_000 }), 'waiting');
  assert.equal(run({ rows: [a, { seq: 2, createdAt: T + 1, body: { type: 'card', card: 'plugin' } }], asked: a, now: T + 120_000 }), 'stalled');
});

test('the bot truly produced nothing and nothing is pending: "No answer yet" still shows', () => {
  const a = msg(1, T);
  assert.equal(run({ rows: [a], asked: a, now: T + 10_000 }), 'sending');
  assert.equal(run({ rows: [a], asked: a, now: T + 46_000 }), 'stalled');
  assert.equal(run({ rows: [a, card(2, T + 1000, 'denied')], asked: a, now: T + 120_000 }), 'stalled', 'an answered card is not waiting');
  assert.equal(run({ rows: [a], asked: a, now: T + 31 * 60_000 }), 'none', 'gives up after 30 minutes');
});

test('answered card, bot resumes: working; the clock starts after the answer, not at the message', () => {
  const a = msg(1, T); const answered = [a, card(2, T + 1000, 'allowed')];
  const answeredAt = T + 15 * 60_000;
  assert.equal(run({ live: { isRunning: true }, rows: answered, asked: a, now: answeredAt + 1000 }), 'working');
  assert.equal(run({ rows: answered, asked: a, touchedAt: answeredAt, now: answeredAt + 5000 }), 'sending', 'just answered: not late yet');
  assert.equal(run({ rows: answered, asked: a, touchedAt: answeredAt, now: answeredAt + 50_000 }), 'stalled', 'answered and nothing came back');
});

test('working long without a card: "Taking a while" still shows', () => {
  const a = msg(1, T);
  const r = w.replyWait({ live: { isRunning: true }, rows: [a, tool(2, T + 1000)], asked: a, startedAt: T, now: T + 3 * 60_000 });
  assert.equal(r.state, 'working'); assert.equal(r.slow, true);
});

test('a card abandoned over a day ago does not hide a missed reply to a new message', () => {
  const old = card(1, T - 25 * 60 * 60_000); const a = msg(2, T);
  assert.equal(run({ rows: [old, a], asked: a, now: T + 60_000 }), 'stalled');
  const recent = card(1, T - 60 * 60_000);
  assert.equal(run({ rows: [recent, a], asked: a, now: T + 60_000 }), 'waiting', 'a card from an hour ago still waits on you');
});

test('nothing owed and nothing running: nothing shown', () => {
  assert.equal(run({ rows: [card(1, T)], asked: null, now: T + 60_000 }), 'none');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
