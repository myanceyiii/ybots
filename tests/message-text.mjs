// Copy, Share and Reply text for chat messages (server/src/message-text.ts). Needs a built server:
// `npm run build -w server`, then `node tests/message-text.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const t = await import('../server/dist/message-text.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/messageText.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/message-text.ts', import.meta.url), 'utf8'));
});
test('plain text drops markdown markup', () => {
  const md = '## Plan\n\n**Bold** and *italic* and __strong__ and ~~gone~~.\n\n* one\n* two\n1. first\n\n> quoted\n\n---\n\nSee [the docs](https://example.com/x) and `npm run build`.';
  assert.equal(t.plainText(md), 'Plan\n\nBold and italic and strong and gone.\n\n- one\n- two\n1. first\n\nquoted\n\nSee the docs (https://example.com/x) and npm run build.');
});
test('code blocks keep their content as is', () => {
  assert.equal(t.plainText('Run:\n```bash\necho **hi** _x_\n```\ndone'), 'Run:\necho **hi** _x_\ndone');
});
test('tables become readable rows', () => {
  assert.equal(t.plainText('| Bill | Due |\n|---|---:|\n| Power | Dec 3 |'), 'Bill  ·  Due\nPower  ·  Dec 3');
});
test('snake_case, 2*3*4 and bare links survive', () => {
  assert.equal(t.plainText('use my_file_name and 2*3*4 at https://a.b/c_d'), 'use my_file_name and 2*3*4 at https://a.b/c_d');
});
test('a link whose text is its address is shown once', () => {
  assert.equal(t.plainText('[https://x.io](https://x.io)'), 'https://x.io');
});
test('task lists show boxes', () => {
  assert.equal(t.plainText('- [ ] milk\n- [x] eggs'), '- ☐ milk\n- ☑ eggs');
});
test('excerpt is short and marked when cut', () => {
  assert.equal(t.replyExcerpt('**Hi** there'), 'Hi there');
  const long = t.replyExcerpt('word '.repeat(200));
  assert.ok(long.length <= 281 && long.endsWith('…'), long);
  assert.equal(t.replyExcerpt('a\nb\nc\nd\ne'), 'a\nb\nc\nd…');
});
test('a reply quotes the message, then the answer', () => {
  assert.equal(t.composeReply('Yes, do it', { name: 'Leonard', excerpt: 'Pay the bill?\nIt is due Friday.' }), '> Pay the bill?\n> It is due Friday.\n\nYes, do it');
});
test('in a group a reply @mentions the writer once', () => {
  assert.equal(t.composeReply('ok', { name: 'Robin', excerpt: 'x', mention: true }), '> x\n\n@Robin ok');
  assert.equal(t.composeReply('thanks @robin', { name: 'Robin', excerpt: 'x', mention: true }), '> x\n\nthanks @robin');
});
test('splitReply undoes composeReply and leaves other text alone', () => {
  const sent = t.composeReply('Line one\n\nLine two', { name: 'L', excerpt: 'q1\n\nq3' });
  assert.deepEqual(t.splitReply(sent), { quote: 'q1\n\nq3', body: 'Line one\n\nLine two' });
  assert.deepEqual(t.splitReply('> just a quote'), { quote: null, body: '> just a quote' });
  assert.deepEqual(t.splitReply('hello'), { quote: null, body: 'hello' });
  assert.deepEqual(t.splitReply('>no space\n\nx'), { quote: null, body: '>no space\n\nx' });
});

// The @ picker in group chats.
const { mentionedMembers } = await import('../server/dist/agent/room-mentions.js');
test('typing @ starts a mention query; an email address does not', () => {
  assert.deepEqual(t.mentionQuery('What about you, @', 17), { start: 16, query: '' });
  assert.deepEqual(t.mentionQuery('hi @She', 7), { start: 3, query: 'She' });
  assert.deepEqual(t.mentionQuery('@sheldon', 8), { start: 0, query: 'sheldon' });
  assert.equal(t.mentionQuery('me@home', 7), null);
  assert.equal(t.mentionQuery('@ x', 3), null);
  assert.equal(t.mentionQuery('@a\nb', 4), null);
  assert.equal(t.mentionQuery('no at sign', 5), null);
});
test('matches: names that start with the query, then later words', () => {
  const m = ['Sheldon', 'Howard', 'Leonard', 'Robin', 'Doug Shea'].map((name) => ({ name }));
  assert.deepEqual(t.mentionMatches(m, '').map((x) => x.name), ['Sheldon', 'Howard', 'Leonard', 'Robin', 'Doug Shea']);
  assert.deepEqual(t.mentionMatches(m, 'sh').map((x) => x.name), ['Sheldon', 'Doug Shea']);
  assert.deepEqual(t.mentionMatches(m, 'sheldon ').map((x) => x.name), []);
});
test('a pick puts "@Name " in place of the query', () => {
  assert.deepEqual(t.insertMention('What about you, @she', 16, 20, 'Sheldon'), { text: 'What about you, @Sheldon ', cursor: 25 });
  assert.deepEqual(t.insertMention('@Le and more', 0, 3, 'Leonard'), { text: '@Leonard and more', cursor: 9 });
  assert.deepEqual(t.insertMention('@Lexx more', 0, 3, 'Leonard'), { text: '@Leonard more', cursor: 9 });
});
test('the highlight agrees with who the server sends the message to', () => {
  const members = ['Robin', 'Robin West', 'A+B', 'Sheldon'].map((name) => ({ name }));
  const names = members.map((m) => m.name);
  for (const text of ['What about you, @sheldon?', 'Note for person@robin.example and @Robinette.', '(@rOBin West), please review.', '@A+B: ask @Robin, then @Robin.', '@Sheldon-x @sheldon_', 'plain']) {
    const lit = [...new Set(t.mentionParts(text, names).filter((p) => p.mention).map((p) => p.text.slice(1).toLowerCase()))].sort();
    const server = mentionedMembers(text, members).map((m) => m.name.toLowerCase()).sort();
    assert.deepEqual(lit, server, text);
  }
  assert.deepEqual(t.mentionParts('hi @sheldon!', names), [{ text: 'hi ', mention: false }, { text: '@sheldon', mention: true }, { text: '!', mention: false }]);
  assert.equal(t.mentionParts('x', names).map((p) => p.text).join(''), 'x');
});

test('edit: the box gets your words, the reply quote is kept on send', () => {
  assert.equal(t.editDraft('Pay it today'), 'Pay it today');
  const sent = t.composeReply('Yes, do it', { name: 'Leonard', excerpt: 'Pay the bill?\nIt is due Friday.' });
  assert.equal(t.editDraft(sent), 'Yes, do it');
  assert.equal(t.composeEdit(sent, '  No, wait  '), '> Pay the bill?\n> It is due Friday.\n\nNo, wait');
  assert.equal(t.composeEdit('plain words', ' new words '), 'new words');
  assert.equal(t.editChanged(sent, 'Yes, do it '), false);
  assert.equal(t.editChanged(sent, 'No'), true);
});
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
