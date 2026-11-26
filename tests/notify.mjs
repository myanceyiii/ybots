// Notifications (server/src/notify.ts): what makes a notice, mutes, quiet hours, hidden bots,
// low-risk approvals only carrying Allow/Deny.
// Run: npm run build -w server && node tests/notify.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
process.env.DB_PATH = path.join(dir, 'hq.db');
process.env.DATABASE_PATH = process.env.DB_PATH;
const { db } = await import('../server/dist/db.js');
const { hub } = await import('../server/dist/lib/hub.js');
const N = await import('../server/dist/notify.js');

const t0 = Date.now();
const cols = db.prepare('PRAGMA table_info(bots)').all().map((c) => c.name);
if (!cols.includes('kind')) db.exec("ALTER TABLE bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'"); // added by routes-rooms in the server
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@b.c', 'Owner', t0);
const addBot = (id, name, kind = 'agent') => db.prepare("INSERT INTO bots(id,user_id,name,avatar_shape,avatar_color,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, 'u1', name, 'circle', 'blue', kind, t0, t0);
addBot('b-leo', 'Leonard'); addBot('b-pen', 'Robin'); addBot('r-fam', 'Family', 'room');

N.startNotify();
const got = [];
hub.subscribe('u1', (ev) => { if (ev.type === 'notify' || ev.type === 'notify-clear') got.push(ev); });
const rows = (botId, seq, body) => hub.emit('u1', { type: 'rows', botId, generation: 1, rows: [{ botId, generation: 1, seq, updatedSeq: seq, kind: body.type === 'card' ? 'card' : 'message', body, createdAt: Date.now() }] });

// A streaming reply notifies once, when it is finished.
rows('b-leo', 1, { type: 'message', role: 'assistant', text: 'Work', streaming: true });
rows('b-leo', 1, { type: 'message', role: 'assistant', text: 'Your **bills** are paid.' });
rows('b-leo', 1, { type: 'message', role: 'assistant', text: 'Your **bills** are paid.' });
rows('b-leo', 2, { type: 'message', role: 'user', text: 'thanks' });
assert.equal(got.length, 1);
assert.deepEqual([got[0].n.channel, got[0].n.title, got[0].n.body, got[0].n.tag], ['messages', 'Leonard', 'Your bills are paid.', 'chat:b-leo']);

// Group messages name the group and the speaker.
rows('r-fam', 1, { type: 'message', role: 'assistant', text: 'Dinner at 6', from: { kind: 'bot', id: 'b-pen', name: 'Robin' } });
assert.equal(got.at(-1).n.title, 'Family'); assert.equal(got.at(-1).n.body, 'Robin: Dinner at 6'); assert.equal(got.at(-1).n.group, true);

// Faces: who it is from, so apps show that bot's picture. No picture: null face (apps draw the initial on its colour).
assert.deepEqual(got[0].n.sender && [got[0].n.sender.id, got[0].n.sender.name, got[0].n.sender.face], ['b-leo', 'Leonard', null]);
assert.match(got[0].n.sender.color, /^#[0-9a-f]{6}$/i);
assert.equal(got.at(-1).n.sender.id, 'b-pen', 'a group message shows the member who posted');
assert.equal(got.at(-1).n.room.id, 'r-fam', 'and the group itself');
// A new picture is a new address (updated_at), so apps fetch the new face instead of a cached old one.
db.prepare("UPDATE bots SET avatar_image='data:image/png;base64,AA', updated_at=? WHERE id='b-leo'").run(t0 + 5);
const f1 = N.faceOf('b-leo').face;
assert.equal(f1, `/api/bots/b-leo/avatar?v=${t0 + 5}&crop=head`);
db.prepare("UPDATE bots SET updated_at=? WHERE id='b-leo'").run(t0 + 9);
assert.notEqual(N.faceOf('b-leo').face, f1);
db.prepare("UPDATE bots SET avatar_image='data:image/png;base64,AA' WHERE id='r-fam'").run();
assert.match(N.faceOf('r-fam').face, /&g=1$/, 'a group picture is shown whole, not face-cropped');

// Approvals: buttons only when the card is low risk (lowRisk true); answering clears it.
const card = (id, extra) => ({ type: 'card', card: 'approval', approvalId: id, title: 'Allow Leonard to add an event?', detail: 'Lunch', tool: 't', args: {}, digest: 'd' + id, status: 'pending', ...extra });
rows('b-leo', 3, card('a1', { lowRisk: true, canAlways: true }));
assert.deepEqual(got.at(-1).n.approval, { id: 'a1', digest: 'da1' });
assert.equal(got.at(-1).n.title, 'Leonard is waiting on you');
assert.equal(got.at(-1).n.sender.id, 'b-leo', 'approval cards carry the bot face too');
rows('b-leo', 3, card('a0', { toolkit: 'actual', toolkitName: 'Actual Budget', tool: 'actual__x' }));
assert.equal(got.at(-1).n.title, 'Leonard is waiting on you · Actual Budget', 'the notice names the app, like the card logo');
rows('b-leo', 3, card('a1', { lowRisk: true, canAlways: true }));
rows('b-leo', 4, card('a2', { lowRisk: false, canAlways: true, risk: "shell" }));
assert.equal(got.at(-1).n.approval, undefined, 'high risk: no buttons');
rows('b-leo', 5, card('a3', {}));
assert.equal(got.at(-1).n.approval, undefined, 'older card without the flag: no buttons');
rows('b-leo', 3, card('a1', { lowRisk: true, canAlways: true, status: 'allowed' }));
assert.deepEqual(got.at(-1), { type: 'notify-clear', tags: ['apr:a1'] });

// Jobs.
hub.emit('u1', { type: 'look-run', botId: 'b-leo', run: 'run1', state: 'done' });
assert.equal(got.at(-1).n.channel, 'jobs'); assert.match(got.at(-1).n.title, /pictures are ready/);
assert.equal(got.at(-1).n.sender.id, 'b-leo');
hub.emit('u1', { type: 'page', botId: 'b-leo', path: 'docs/Budget.md', version: 3, by: 'Leonard', byKind: 'bot' });
const before = got.length;
hub.emit('u1', { type: 'page', botId: 'b-leo', path: 'docs/Budget.md', version: 4, by: 'Leonard', byKind: 'bot' });
assert.equal(got.length, before, 'the same document again soon does not notify again');
assert.equal(got.at(-1).n.title, 'Leonard updated Budget');

// Filters.
const msg = got[0].n;
assert.ok(N.deliverable(msg, 'u1', 'main'));
N.setPrefs('u1', 'main', { mute: { botId: 'b-leo', until: 0 } });
assert.equal(N.deliverable(msg, 'u1', 'main'), null, 'muted');
N.setPrefs('u1', 'main', { unmute: 'b-leo', mute: { botId: 'nope', until: 0 } });
assert.deepEqual(N.getPrefs('u1', 'main').muted, {}, 'unmuted; a bot of another account cannot be muted');
N.setPrefs('u1', 'main', { mute: { botId: 'b-leo', until: Date.now() - 1000 } });
assert.ok(N.deliverable(msg, 'u1', 'main'), 'a mute that ran out');
N.setPrefs('u1', 'main', { channels: { messages: false } });
assert.equal(N.deliverable(msg, 'u1', 'main'), null, 'channel off');
N.setPrefs('u1', 'main', { channels: { messages: true }, preview: false });
assert.equal(N.deliverable(msg, 'u1', 'main').body, 'New message');
N.setPrefs('u1', 'main', { preview: true, dndUntil: Date.now() + 60_000 });
assert.equal(N.deliverable(msg, 'u1', 'main'), null, 'do not disturb');
N.setPrefs('u1', 'main', { dndUntil: 0 });

// A bot hidden from the owner's view (Alex hid Robin): nothing about it reaches the main profile, but a
// scoped sign-in (Sam, same account) still hears it, and groups it posts in still notify.
const pen = { ...msg, botId: 'b-pen' };
assert.ok(N.deliverable(pen, 'u1', 'main'));
db.prepare("UPDATE bots SET owner_hidden=1 WHERE id='b-pen'").run();
assert.equal(N.ownerHidden('b-pen'), true);
assert.equal(N.deliverable(pen, 'u1', 'main'), null, 'hidden: no notifications on the main profile');
assert.ok(N.deliverable(pen, 'u1', 'main', undefined, undefined, true), 'a scoped sign-in still gets them');
assert.ok(N.deliverable({ ...msg, botId: 'r-fam', group: true }, 'u1', 'main'), 'a group with Robin in it still notifies');
assert.ok(N.deliverable(msg, 'u1', 'main'), 'other bots are not affected');
db.prepare("UPDATE bots SET owner_hidden=0 WHERE id='b-pen'").run();
assert.ok(N.deliverable(pen, 'u1', 'main'), 'shown again: notifications are back');

// Quiet hours: 22:00-07:00 in UTC.
const at = (h, m = 0) => Date.UTC(2026, 10, 23, h, m);
const q = { on: true, start: '22:00', end: '07:00', tz: 'UTC', approvalsRing: false };
assert.equal(N.inQuietHours(q, at(23)), true);
assert.equal(N.inQuietHours(q, at(6, 59)), true);
assert.equal(N.inQuietHours(q, at(7)), false);
assert.equal(N.inQuietHours({ ...q, start: '13:00', end: '14:00' }, at(13, 30)), true);
assert.equal(N.inQuietHours({ ...q, on: false }, at(23)), false);
N.setPrefs('u1', 'main', { quiet: q });
N.setPrefs('u1', 'main', { quiet: { tz: 'Not/AZone', start: '25:00' } });
assert.equal(N.getPrefs('u1', 'main').quiet.tz, 'UTC'); assert.equal(N.getPrefs('u1', 'main').quiet.start, '22:00', 'bad values are ignored');
assert.equal(N.deliverable(msg, 'u1', 'main', undefined, at(23)).silent, true, 'quiet hours: silent, not dropped');
const apr = got.find((e) => e.n?.approval).n;
assert.equal(N.deliverable(apr, 'u1', 'main', undefined, at(23)).silent, true);
N.setPrefs('u1', 'main', { quiet: { approvalsRing: true } });
assert.equal(N.deliverable(apr, 'u1', 'main', undefined, at(23)).silent, undefined, 'approvals may still ring');

// Catch-up after a dropped link.
const all = N.noticesAfter('u1', 0);
assert.ok(all.length >= 6);
// A notice taken down since (the answered card a1) is not replayed to an app catching up.
assert.equal(all.some((n) => n.tag === 'apr:a1'), false, 'answered approval is not replayed');
assert.ok(all.some((n) => n.tag === 'apr:a2'), 'a waiting one still is');
assert.deepEqual(N.noticesAfter('u1', all.at(-2).id).map((n) => n.id), [all.at(-1).id]);
console.log('notify ok', all.length, 'notices');
