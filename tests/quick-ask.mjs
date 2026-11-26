// The quick-ask card's logic (web/src/voice/quickAsk.ts = mobile/src/voice/quickAsk.ts): when you have
// finished talking, the Bot's answer to what you sent, and which sentences of it to read out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { EndOfSpeech, replyAfter, SpeechQueue } from '../mobile/src/voice/quickAsk.ts';

const root = new URL('..', import.meta.url).pathname;
const frames = (ms, level) => new Array(Math.round(ms / 40)).fill(level);

test('web and phone copies are the same file', () => {
  for (const f of ['quickAsk.ts', 'speakable.ts']) {
    assert.equal(fs.readFileSync(`${root}web/src/voice/${f}`, 'utf8'), fs.readFileSync(`${root}mobile/src/voice/${f}`, 'utf8'), f);
  }
});

test('sends once you have spoken and then stayed quiet', () => {
  const e = new EndOfSpeech();
  assert.equal(e.push(frames(400, 0.002)), null);
  assert.equal(e.push(frames(1500, 0.1), 'what is on my calendar'), null);
  assert.equal(e.push(frames(600, 0.002), 'what is on my calendar'), null, 'a short pause is not the end');
  assert.equal(e.push(frames(700, 0.002), 'what is on my calendar'), 'done');
});

test('a sentence that obviously goes on gets longer', () => {
  const e = new EndOfSpeech();
  e.push(frames(1000, 0.1));
  assert.equal(e.push(frames(1400, 0.002), 'remind me to call the dentist and'), null);
  assert.equal(e.push(frames(900, 0.002), 'remind me to call the dentist and'), 'done');
});

test('nothing said: stops listening after a while; a click is not speech', () => {
  const e = new EndOfSpeech();
  e.push(frames(200, 0.2));
  assert.equal(e.heard, false);
  assert.equal(e.push(frames(7800, 0.002)), 'nothing');
});

test('one request cannot run for ever', () => {
  const e = new EndOfSpeech();
  assert.equal(e.push(frames(60_000, 0.1)), 'long');
});

test('the answer: Bot messages after yours, streaming, and a card waiting on you', () => {
  const rows = [
    { seq: 4, body: { type: 'message', role: 'assistant', text: 'old' } },
    { seq: 5, body: { type: 'message', role: 'user', text: 'hi' } },
    { seq: 6, body: { type: 'tool', name: 'x' } },
    { seq: 7, body: { type: 'message', role: 'assistant', text: 'Checking.', streaming: false } },
    { seq: 8, body: { type: 'card', card: 'approval', status: 'pending', title: 'Allow Leonard to send an email?' } },
  ];
  const r = replyAfter(rows, 5);
  assert.equal(r.text, 'Checking.');
  assert.equal(r.streaming, false);
  assert.equal(r.waiting, 'Allow Leonard to send an email?');
  assert.deepEqual(r.seqs, [7, 8]);
  assert.equal(replyAfter(rows, 8).text, '');
});

test('read out: whole sentences only, each once', () => {
  const q = new SpeechQueue(1);
  const row = (text, streaming) => [{ seq: 2, body: { type: 'message', role: 'assistant', text, streaming } }];
  assert.deepEqual(q.feed(row('It is sunny', true)), []);
  assert.deepEqual(q.feed(row('It is sunny. Highs of', true)), ['It is sunny.']);
  assert.deepEqual(q.feed(row('It is sunny. Highs of 70', false)), ['Highs of 70']);
  assert.deepEqual(q.feed(row('It is sunny. Highs of 70', false)), []);
});
