import assert from 'node:assert/strict';
import { mentionedMembers } from '../server/dist/agent/room-mentions.js';

const members = ['Robin', 'Robin West', 'A+B'].map((name) => ({ name }));
const matches = (text) => mentionedMembers(text, members).map((m) => m.name);
assert.deepEqual(matches('Note for person@robin.example and @Robinette.'), []);
assert.deepEqual(matches('(@rOBin West), please review.'), ['Robin West']);
assert.deepEqual(matches('@A+B: ask @Robin, then @Robin.'), ['Robin', 'A+B']);
console.log('Group member mention matching passed.');
