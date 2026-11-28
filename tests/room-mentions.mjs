import assert from 'node:assert/strict';
import { mentionedMembers } from '../server/dist/agent/room-mentions.js';
import { directMentions } from '../server/dist/direct-mentions.js';

const members = ['Robin', 'Robin West', 'A+B'].map((name) => ({ name }));
const matches = (text) => mentionedMembers(text, members).map((m) => m.name);
assert.deepEqual(matches('Note for person@robin.example and @Robinette.'), []);
assert.deepEqual(matches('(@rOBin West), please review.'), ['Robin West']);
assert.deepEqual(matches('@A+B: ask @Robin, then @Robin.'), ['Robin', 'A+B']);
// A bot's own chat: other bots only, never itself (main or side chat) or a group.
const team = [{ id: 'l', name: 'Leonard' }, { id: 'h', name: 'Howard' }, { id: 'g', name: 'Huddle', kind: 'room' }];
const direct = (text, chat) => directMentions(text, chat, team).map((m) => m.name);
assert.deepEqual(direct('@Howard and @Leonard, see @Huddle', { id: 'l', name: 'Leonard' }), ['Howard']);
assert.deepEqual(direct('@howard?', { id: 'side1', name: 'Leonard', side_of: 'l' }), ['Howard']);
assert.deepEqual(direct('mail howard@example.com', { id: 'l', name: 'Leonard' }), []);
console.log('Group member mention matching passed.');
