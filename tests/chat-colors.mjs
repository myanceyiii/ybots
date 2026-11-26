// Bot colours in chats (server/src/chat-colors.ts). Needs a built server:
// `npm run build -w server`, then `node tests/chat-colors.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const t = await import('../server/dist/chat-colors.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (c) => { const l = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/chatColors.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/chat-colors.ts', import.meta.url), 'utf8'));
});
test('names read at 4.5:1 on their tint, and body text too, in both themes', () => {
  for (const [name, c] of Object.entries(t.CHAT_COLORS)) {
    assert.ok(ratio(c.light.ink, c.light.tint) >= 4.5, `${name} light name ${ratio(c.light.ink, c.light.tint).toFixed(2)}`);
    assert.ok(ratio(c.dark.ink, c.dark.tint) >= 4.5, `${name} dark name ${ratio(c.dark.ink, c.dark.tint).toFixed(2)}`);
    assert.ok(ratio('#000000', c.light.tint) >= 7, `${name} light body`);
    assert.ok(ratio('#F5F5F5', c.dark.tint) >= 7, `${name} dark body`);
  }
});
test('bars stand out from the page at 3:1', () => {
  for (const [name, c] of Object.entries(t.CHAT_COLORS)) {
    assert.ok(ratio(c.light.bar, '#FFFFFF') >= 3, `${name} light bar`);
    assert.ok(ratio(c.dark.bar, '#121212') >= 3, `${name} dark bar`);
  }
});
test('every colour is in the settings order once', () => {
  assert.deepEqual([...t.CHAT_COLOR_ORDER].sort(), Object.keys(t.CHAT_COLORS).sort());
});
test('picture colours are kept; black and gray bots get spare colours apart from the rest', () => {
  const got = t.assignChatColors([
    { id: 'howard', avatarColor: 'red', createdAt: 1 }, { id: 'leonard', avatarColor: 'green', createdAt: 2 },
    { id: 'robin', avatarColor: 'gray', createdAt: 3 }, { id: 'sheldon', avatarColor: 'yellow', createdAt: 4 }, { id: 'doug', avatarColor: 'black', createdAt: 5 },
  ]);
  assert.deepEqual(got, { howard: 'red', leonard: 'green', sheldon: 'yellow', robin: 'blue', doug: 'violet' });
});
test('a colour set in settings wins and moves a picked colour out of its way', () => {
  const got = t.assignChatColors([{ id: 'a', avatarColor: 'gray', createdAt: 1 }, { id: 'b', avatarColor: 'black', chatColor: 'blue', createdAt: 2 }]);
  assert.deepEqual(got, { b: 'blue', a: 'violet' });
});
test('unknown colours fall back', () => {
  assert.equal(t.isChatColor('black'), false);
  assert.equal(t.isChatColor('toString'), false);
  assert.deepEqual(t.chatInk('nope', 'dark'), t.CHAT_COLORS.blue.dark);
  assert.deepEqual(t.assignChatColors([{ id: 'x', chatColor: 'bogus', avatarColor: 'gray' }]), { x: 'blue' });
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
