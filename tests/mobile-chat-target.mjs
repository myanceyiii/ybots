import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationChat } from '../mobile/src/chatTarget.ts';

const roster = [
  { id: 'room', name: 'Family', kind: 'room' },
  { id: 'other', name: 'Other' },
];

test('a notification opens any chat in the account’s roster, and nothing else', () => {
  assert.equal(notificationChat(roster, 'other'), 'other');
  assert.equal(notificationChat(roster, 'room'), 'room');
  assert.equal(notificationChat(roster, 'missing'), null);
  assert.equal(notificationChat(roster, null), null);
  assert.equal(notificationChat([], 'other'), null);
});
