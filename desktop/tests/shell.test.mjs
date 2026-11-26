// The shell's own rules, tested without Electron: what it remembers, where the window opens, the badge,
// who needs you, which keys it answers, the right-click menu, Quick Chat's bot list and the log scrubber.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanSettings, cleanPatch, cleanShortcut, mergeSettings, notificationsPaused, tomorrowMorning } = require('../src/prefs.js');
const { readJson, writeJson } = require('../src/store.js');
const { fitBounds } = require('../src/winstate.js');
const { badgeText, badgeBitmap, withDot } = require('../src/badge.js');
const { countFromTitle, summarize, botLine, tooltip, EMPTY } = require('../src/attention.js');
const { shellCommand, zoomStep } = require('../src/keys.js');
const { offlineHint, retryDelay, parseLaunch, freeName } = require('../src/policy.js');
const { contextTemplate } = require('../src/contextmenu.js');
const { quickBots } = require('../src/quickchat.js');
const log = require('../src/log.js');

test('settings: anything missing or wrong falls back to its default', () => {
  const d = cleanSettings(null);
  assert.equal(d.address, undefined);
  assert.equal(d.closeToTray, true);
  assert.equal(d.zoom, 1);
  assert.equal(d.notifications.enabled, true);
  assert.equal(d.quickChat.shortcut, 'Alt+Shift+Y');
  const s = cleanSettings({ address: 'cleft.example.ts.net', theme: 'purple', zoom: 99, window: { width: 5, height: 5 }, closeToTray: 'yes', notifications: { sound: false, pausedUntil: -4 }, quickChat: { shortcut: 'nonsense', lastBot: '../etc' }, recentAddresses: ['https://a.example.com', 'javascript:alert(1)', 'https://a.example.com', 7], updates: { skipped: 'latest' } });
  assert.equal(s.address, 'https://cleft.example.ts.net');
  assert.equal(s.theme, undefined);
  assert.equal(s.zoom, 1);
  assert.equal(s.window, null);
  assert.equal(s.closeToTray, true);
  assert.equal(s.notifications.sound, false);
  assert.equal(s.notifications.pausedUntil, 0);
  assert.equal(s.quickChat.shortcut, 'Alt+Shift+Y');
  assert.equal(s.quickChat.lastBot, '');
  assert.deepEqual(s.recentAddresses, ['https://a.example.com']);
  assert.equal(s.updates.skipped, '');
  // A bad address in the file must not stop the app: it just asks again.
  assert.equal(cleanSettings({ address: 'http://not-https.example.com' }).address, undefined);
  // Arrays and strings are not settings.
  assert.equal(cleanSettings([1, 2]).zoom, 1);
  assert.equal(cleanSettings('x').closeToTray, true);
});

test('settings: an empty shortcut means none; shortcuts need a real modifier', () => {
  assert.equal(cleanSettings({ quickChat: { shortcut: '' } }).quickChat.shortcut, '');
  assert.equal(cleanShortcut('Ctrl+Alt+Space'), 'Ctrl+Alt+Space');
  assert.equal(cleanShortcut('Shift+Alt+Y'), 'Alt+Shift+Y'); // one order
  assert.equal(cleanShortcut('Shift+A'), null); // that is just typing a capital A
  assert.equal(cleanShortcut('A'), null);
  assert.equal(cleanShortcut('Ctrl+Ctrl+A'), null);
  assert.equal(cleanShortcut('Ctrl+Hyper+A'), null);
  assert.equal(cleanShortcut('Super+F13'), 'Super+F13');
  assert.equal(cleanShortcut(7), null);
});

test('settings: a page may change only the listed settings, to the right kind of value', () => {
  assert.deepEqual(cleanPatch('closeToTray', false), { closeToTray: false });
  assert.deepEqual(cleanPatch('notifications.sound', false), { notifications: { sound: false } });
  assert.deepEqual(cleanPatch('quickChat.shortcut', 'Ctrl+Alt+K'), { quickChat: { shortcut: 'Ctrl+Alt+K' } });
  assert.deepEqual(cleanPatch('quickChat.shortcut', ''), { quickChat: { shortcut: '' } });
  // Talk to a Bot: its own shortcut, cleaned the same way, Alt+Shift+L by default.
  assert.deepEqual(cleanSettings({}).talk, { shortcut: 'Alt+Shift+L', enabled: true });
  assert.equal(cleanSettings({ talk: { shortcut: 'nonsense', enabled: 'yes' } }).talk.shortcut, 'Alt+Shift+L');
  assert.equal(cleanSettings({ talk: { shortcut: '', enabled: false } }).talk.enabled, false);
  assert.deepEqual(cleanPatch('talk.shortcut', 'Ctrl+Alt+L'), { talk: { shortcut: 'Ctrl+Alt+L' } });
  assert.deepEqual(cleanPatch('talk.enabled', false), { talk: { enabled: false } });
  assert.throws(() => cleanPatch('talk.shortcut', 'L'), /Ctrl, Alt/);
  assert.throws(() => cleanPatch('quickChat.shortcut', 'K'), /Ctrl, Alt/);
  assert.throws(() => cleanPatch('address', 'https://evil.example.com'), /cannot be changed/);
  assert.throws(() => cleanPatch('closeToTray', 'no'), /cannot be changed/);
  assert.throws(() => cleanPatch('__proto__', true), /cannot be changed/);
  const merged = mergeSettings(cleanSettings(null), cleanPatch('notifications.sound', false));
  assert.equal(merged.notifications.sound, false);
  assert.equal(merged.notifications.enabled, true, 'the other notification settings are kept');
});

test('notifications: paused until a time, or switched off; "tomorrow morning" is the next 8:00', () => {
  const s = cleanSettings(null);
  assert.equal(notificationsPaused(s, 1000), false);
  assert.equal(notificationsPaused(mergeSettings(s, { notifications: { pausedUntil: 2000 } }), 1000), true);
  assert.equal(notificationsPaused(mergeSettings(s, { notifications: { pausedUntil: 2000 } }), 3000), false);
  assert.equal(notificationsPaused(mergeSettings(s, { notifications: { enabled: false } }), 1000), true);
  const evening = new Date(2026, 10, 24, 21, 30);
  assert.equal(new Date(tomorrowMorning(evening)).getDate(), 25);
  assert.equal(new Date(tomorrowMorning(evening)).getHours(), 8);
  const early = new Date(2026, 10, 24, 6, 0);
  assert.equal(new Date(tomorrowMorning(early)).getDate(), 24);
});

test('files: written whole, and a file that cannot be read is set aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-store-'));
  try {
    const file = path.join(dir, 'deep', 'settings.json');
    assert.deepEqual(readJson(file), { value: null, bad: false });
    writeJson(file, { a: 1 });
    writeJson(file, { a: 2 });
    assert.deepEqual(readJson(file), { value: { a: 2 }, bad: false });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'], 'no temporary file is left behind');
    fs.writeFileSync(file, '{"a": 2, "b"'); // cut off mid-write
    assert.deepEqual(readJson(file), { value: null, bad: true });
    const left = fs.readdirSync(path.dirname(file));
    assert.equal(left.length, 1);
    assert.match(left[0], /^settings\.bad-\d+\.json$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('window: opens where it was left, unless that screen is gone', () => {
  const one = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const two = [...one, { x: 1920, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(fitBounds(null, one), { width: 1200, height: 820, maximized: false });
  assert.deepEqual(fitBounds({ x: 100, y: 80, width: 900, height: 700, maximized: false }, one), { x: 100, y: 80, width: 900, height: 700, maximized: false });
  // Left on the second monitor, which is still there.
  assert.equal(fitBounds({ x: 2200, y: 100, width: 900, height: 700 }, two).x, 2200);
  // Left on a monitor that has been unplugged: centred on the first screen.
  const moved = fitBounds({ x: 2200, y: 100, width: 900, height: 700, maximized: true }, one);
  assert.equal(moved.x, 510);
  assert.equal(moved.y, 170);
  assert.equal(moved.maximized, true);
  // Bigger than the screen now (a smaller monitor): shrunk to fit, and pulled fully onto it.
  const small = fitBounds({ x: 600, y: 300, width: 1800, height: 1200 }, [{ x: 0, y: 0, width: 1366, height: 728 }]);
  assert.deepEqual(small, { x: 0, y: 0, width: 1366, height: 728, maximized: false });
  // Hanging off the right edge: pushed back in.
  assert.equal(fitBounds({ x: 1500, y: 100, width: 900, height: 700 }, one).x, 1020);
  // A small laptop screen with no saved window.
  assert.deepEqual(fitBounds(null, [{ x: 0, y: 0, width: 1024, height: 700 }]), { width: 1024, height: 700, maximized: false });
});

test('badge: the count as text, and pixels with a filled circle', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-2), '');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(42), '42');
  assert.equal(badgeText(250), '99');
  assert.equal(badgeBitmap(0), null);
  const b = badgeBitmap(7);
  assert.equal(b.data.length, 32 * 32 * 4);
  const px = (x, y) => [...b.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.deepEqual(px(0, 0), [0, 0, 0, 0], 'the corner is clear');
  assert.deepEqual(px(4, 16), [54, 38, 226, 255], 'the circle is red (stored blue, green, red)');
  let white = 0;
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i] === 255 && b.data[i + 1] === 255 && b.data[i + 2] === 255) white++;
  assert.ok(white > 40, 'the number is drawn in white');
  for (const n of [1, 9, 10, 99]) assert.ok(badgeBitmap(n));
  // The tray dot: the corner changes, the opposite corner does not.
  const base = Buffer.alloc(32 * 32 * 4, 0);
  const d = withDot(base, 32, 'waiting');
  assert.deepEqual([...d.data.subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...d.data.subarray((24 * 32 + 24) * 4, (24 * 32 + 24) * 4 + 4)], [54, 38, 226, 255]);
  assert.deepEqual([...withDot(base, 32, 'unread').data.subarray((24 * 32 + 24) * 4, (24 * 32 + 24) * 4 + 4)], [255, 121, 41, 255]);
  assert.equal(base[(24 * 32 + 24) * 4 + 3], 0, 'the icon it was drawn from is not changed');
});

test('who needs you: from the title count and from the bot list, waiting first', () => {
  assert.equal(countFromTitle('(3) YBots'), 3);
  assert.equal(countFromTitle('(12) Robin'), 12);
  assert.equal(countFromTitle('YBots'), 0);
  assert.equal(countFromTitle('Sign in (2)'), 0);
  assert.equal(countFromTitle(undefined), 0);
  const att = summarize({
    bots: [
      { id: 'leonard', name: 'Leonard', unread: 2, lastActivityAt: 50 },
      { id: 'howard', name: 'Howard', unread: 0, lastActivityAt: 10 },
      { id: 'robin', name: 'Robin', unread: 0, lastActivityAt: 5 },
      { id: 'group1', name: 'Household\nHuddle', unread: 1, lastActivityAt: 70 },
      { id: '../bad', name: 'Bad', unread: 9 },
      null,
    ],
    live: [{ botId: 'howard', awaiting: { reason: 'approval', since: 1 } }, { botId: 'group1', members: [{ id: 'x', state: 'working' }] }, { botId: 'robin', awaiting: null }],
  });
  assert.equal(att.total, 3);
  assert.equal(att.waiting, 1);
  assert.deepEqual(att.bots.map((b) => b.id), ['howard', 'group1', 'leonard']);
  assert.equal(att.bots[1].name, 'Household Huddle');
  assert.equal(botLine(att.bots[0]), 'Howard is waiting for you');
  assert.equal(botLine(att.bots[2]), 'Leonard: 2 new messages');
  assert.equal(botLine(att.bots[1]), 'Household Huddle: 1 new message');
  assert.equal(tooltip(att), 'YBots: 1 bot is waiting for you');
  assert.equal(tooltip(EMPTY), 'YBots');
  assert.equal(tooltip(EMPTY, 2), 'YBots: 2 chats have something new');
  // A group member waiting on a card counts as the group waiting.
  assert.equal(summarize({ bots: [{ id: 'g', name: 'G', unread: 0 }], live: [{ botId: 'g', members: [{ state: 'waiting' }] }] }).waiting, 1);
  assert.deepEqual(summarize(null), { total: 0, waiting: 0, bots: [] });
  assert.deepEqual(summarize({ bots: 'x', live: 3 }), { total: 0, waiting: 0, bots: [] });
  // A bot hidden from the list (Alex hid Robin) never counts or shows in Quick Chat.
  const hid = { bots: [{ id: 'p', name: 'Robin', unread: 3, ownerHidden: true }, { id: 'l', name: 'Leonard', unread: 1 }], live: [{ botId: 'p', awaiting: { reason: 'x' } }] };
  assert.deepEqual(summarize(hid).bots.map((b) => b.id), ['l']);
  assert.deepEqual(quickBots(hid).map((b) => b.id), ['l']);
});

test('keys: the shell answers its own shortcuts and leaves the web app its own', () => {
  const k = (key, mods = {}) => shellCommand({ type: 'keyDown', key, ...mods });
  assert.equal(k('f', { control: true }), 'find');
  assert.equal(k('F', { control: true }), 'find');
  assert.equal(k('=', { control: true }), 'zoom-in');
  assert.equal(k('+', { control: true, shift: true }), 'zoom-in');
  assert.equal(k('-', { control: true }), 'zoom-out');
  assert.equal(k('0', { control: true }), 'zoom-reset');
  assert.equal(k('r', { control: true }), 'reload');
  assert.equal(k('R', { control: true, shift: true }), 'hard-reload');
  assert.equal(k('F5'), 'reload');
  assert.equal(k('F3'), 'find-next');
  assert.equal(k('F3', { shift: true }), 'find-prev');
  assert.equal(k('F11'), 'fullscreen');
  assert.equal(k('w', { control: true }), 'close');
  assert.equal(k('ArrowLeft', { alt: true }), 'back');
  assert.equal(k('ArrowRight', { alt: true }), 'forward');
  // The web app's own: search, sidebar, settings, full-screen chat, new conversation, next chat.
  for (const [key, mods] of [['k', { control: true }], ['b', { control: true }], [',', { control: true }], ['f', { control: true, shift: true }], ['o', { control: true, shift: true }], ['ArrowDown', { alt: true }], ['/', { control: true }], ['a', {}], ['Enter', {}]]) {
    assert.equal(k(key, mods), null, `${JSON.stringify(mods)} ${key} belongs to the page`);
  }
  assert.equal(shellCommand({ type: 'keyUp', key: 'f', control: true }), null);
  assert.equal(k('p', { control: true }), 'print');
  assert.equal(k('p', { control: true, shift: true }), null);
  assert.equal(shellCommand({ type: 'keyDown', key: 'f', control: true, alt: true }), null, 'AltGr combinations type characters');
  assert.equal(shellCommand(null), null);
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1, -1), 0.9);
  assert.equal(zoomStep(3, 1), 3);
  assert.equal(zoomStep(0.5, -1), 0.5);
  assert.equal(zoomStep(1.1, -1), 1);
});

test('offline: says what most likely went wrong, and how soon it tries again', () => {
  assert.match(offlineHint({ code: -105, description: 'ERR_NAME_NOT_RESOLVED', address: 'https://cleft.example.ts.net' }).hint, /Tailscale/);
  assert.doesNotMatch(offlineHint({ code: -105, description: 'ERR_NAME_NOT_RESOLVED', address: 'https://bots.example.com' }).hint, /Tailscale/);
  assert.match(offlineHint({ code: -106, description: 'ERR_INTERNET_DISCONNECTED' }).title, /offline/);
  assert.match(offlineHint({ code: -102, description: 'ERR_CONNECTION_REFUSED' }).title, /not answering/);
  assert.match(offlineHint({ status: 502 }).title, /restarting/);
  assert.match(offlineHint({ status: 530 }).title, /restarting/);
  assert.equal(offlineHint({ description: 'ERR_CERT_DATE_INVALID' }).retry, false);
  assert.equal(offlineHint({ description: 'crashed' }).retry, false);
  assert.equal(offlineHint({}).title, "Can't reach YBots");
  assert.deepEqual([0, 1, 2, 3, 9].map(retryDelay), [5, 10, 20, 30, 30]);
});

test('starting the app: flags and yanceybot:// links only open places', () => {
  assert.deepEqual(parseLaunch(['YanceyBot.exe']), { hidden: false, action: null, botId: null });
  assert.equal(parseLaunch(['YanceyBot.exe', '--hidden']).hidden, true);
  assert.equal(parseLaunch(['YanceyBot.exe', '--quick-chat']).action, 'quick');
  assert.equal(parseLaunch(['YanceyBot.exe', '--settings']).action, 'settings');
  assert.deepEqual(parseLaunch(['YanceyBot.exe', 'yanceybot://chat/leonard_1']), { hidden: false, action: 'chat', botId: 'leonard_1' });
  assert.equal(parseLaunch(['YanceyBot.exe', 'YanceyBot://Quick/']).action, 'quick');
  for (const bad of ['yanceybot://chat/../../etc', 'yanceybot://approve/123', 'yanceybot://chat/a?x=1', 'yanceybot:chat/a', 'https://evil.example.com', '--inspect=9229', 'yanceybot://chat/']) {
    assert.equal(parseLaunch(['YanceyBot.exe', bad]).action, null, bad);
  }
  assert.equal(parseLaunch(['--quick-chat']).action, null, 'the program name itself is never read as a flag');
  assert.deepEqual(parseLaunch(undefined), { hidden: false, action: null, botId: null });
});

test('downloads: a free name in the folder', () => {
  const taken = new Set(['report.pdf', 'report (1).pdf', 'notes']);
  const has = (n) => taken.has(n);
  assert.equal(freeName('new.txt', has), 'new.txt');
  assert.equal(freeName('report.pdf', has), 'report (2).pdf');
  assert.equal(freeName('notes', has), 'notes (1)');
  assert.equal(freeName('a/b\\c:d.txt', has), 'a_b_c_d.txt');
  assert.equal(freeName('', has), 'file');
  assert.equal(freeName('..hidden', has), 'hidden');
});

test('right-click: spelling, links, pictures, text boxes and selections', () => {
  const labels = (p) => contextTemplate(p).map((r) => r.type ?? r.label);
  assert.deepEqual(labels({}), [], 'nothing to offer on empty space');
  const spell = contextTemplate({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], isEditable: true, editFlags: { canPaste: true, canCut: true, canCopy: true }, selectionText: 'teh' });
  assert.deepEqual(spell.slice(0, 3).map((r) => r.label), ['the', 'ten', 'Add “teh” to the dictionary']);
  assert.ok(spell.some((r) => r.role === 'paste' && r.enabled));
  assert.ok(labels({ misspelledWord: 'zzxq', dictionarySuggestions: [], isEditable: true }).includes('No spelling suggestions'));
  const box = contextTemplate({ isEditable: true, editFlags: { canPaste: false }, selectionText: '' });
  assert.equal(box.find((r) => r.role === 'paste').enabled, false);
  assert.equal(box.find((r) => r.role === 'cut').enabled, false);
  assert.deepEqual(labels({ linkURL: 'https://example.com/a' }), ['Open link in your browser', 'Copy link']);
  assert.deepEqual(labels({ linkURL: 'javascript:alert(1)' }), [], 'only web and mail links are offered');
  assert.equal(contextTemplate({ linkURL: 'mailto:a@example.com?subject=x' })[1].arg, 'a@example.com');
  assert.deepEqual(labels({ mediaType: 'image', srcURL: 'https://bots.example.com/x.png' }), ['Copy picture', 'Save picture as…']);
  assert.deepEqual(labels({ mediaType: 'image', srcURL: 'file:///c:/x.png' }), ['Copy picture']);
  const sel = contextTemplate({ selectionText: '  the quarterly budget for the whole household  ' });
  assert.equal(sel[0].role, 'copy');
  assert.match(sel[1].label, /^Search the web for “the quarterly budget for th…”$/);
  assert.match(sel[1].arg, /^https:\/\/www\.google\.com\/search\?q=the%20quarterly/);
  assert.equal(contextTemplate({}, { dev: true })[0].label, 'Inspect');
});

test('Quick Chat: the bots to offer, in the chat list order', () => {
  const list = quickBots({ bots: [
    { id: 'robin', name: 'Robin', lastActivityAt: 90, chatColor: 'magenta' },
    { id: 'sheldon', name: 'Sheldon', outside: { status: 'ready' }, lastActivityAt: 99 },
    { id: 'howard', name: 'Howard', isPrimary: true, lastActivityAt: 1 },
    { id: 'leonard', name: 'Leonard', pinned: true, lastActivityAt: 2, chatColor: { hex: '#fff' } },
    { id: 'huddle', name: 'Household Huddle', kind: 'room', lastActivityAt: 50 },
    { id: 'raj', name: 'Raj', outside: { status: 'not-set-up' } },
    { id: 'bad id', name: 'Bad' },
  ] });
  assert.deepEqual(list.map((b) => b.id), ['howard', 'leonard', 'robin', 'huddle', 'sheldon']);
  assert.equal(list[2].color, 'magenta');
  assert.equal(list[1].color, null);
  assert.equal(list[3].group, true);
  assert.equal(list[0].needs, null);
  const marked = quickBots({ bots: [{ id: 'a', name: 'A', unread: 2 }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], live: [{ botId: 'b', awaiting: { reason: 'approval' } }] });
  assert.deepEqual(marked.map((b) => b.needs), ['unread', 'waiting', null]);
  assert.deepEqual(quickBots(null), []);
});

test('log: sign-in links, pairing ids and secrets never reach the file', () => {
  const line = log.scrub('GET https://x.example.com/api/auth/link/AbCdEf0123456789xyz failed; /pair/abcDEF123; cookie: bothq_session=s3cr3t; x-pair-secret="hunter2"\nnext');
  assert.doesNotMatch(line, /AbCdEf0123456789xyz|abcDEF123|s3cr3t|hunter2/);
  assert.match(line, /\/api\/auth\/link\/…/);
  assert.doesNotMatch(line, /\n/);
  assert.ok(log.scrub('x'.repeat(5000)).length <= 2000);
});

test('Quick Chat: screenshot names and the limits on what a message can carry', () => {
  const { stampedName, attachRefusal } = require('../src/quickchat.js');
  assert.equal(stampedName('Screenshot', new Date(2026, 10, 4, 9, 5, 7)), 'Screenshot 2026-11-04 09.05.07.png');
  assert.equal(attachRefusal(0, 10), null);
  assert.equal(attachRefusal(7, 25 * 1024 * 1024), null);
  assert.match(attachRefusal(8, 10), /8 files at most/);
  assert.match(attachRefusal(0, 0), /empty/);
  assert.match(attachRefusal(0, 25 * 1024 * 1024 + 1), /larger than 25 MB/);
});
