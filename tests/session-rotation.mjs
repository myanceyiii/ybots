// The maintainer's fresh engine session after a quiet spell (server/src/session-rotation.ts): when it turns
// over, when it must not (a question, card, task or board still waiting on the owner), the handoff it carries,
// and a simulated stop-for-input that is answered the next morning and again a day later.
// Run after `npm run build -w server`:  node tests/session-rotation.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-rotation-'));
Object.assign(process.env, {
  HOME: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ORGO_API_KEY: 'unused',
  DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false',
  HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), APPS_CONFIG: path.join(dir, 'apps.json'),
  APP_URL: 'http://127.0.0.1:1', SERVER_URL: 'http://127.0.0.1:1', MAINTAINER_BOTS: '',
});
const { db } = await import(path.join(root, 'server/dist/db.js'));
const rot = await import(path.join(root, 'server/dist/session-rotation.js'));

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 1, 0, 0);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'Sam', T0);
const mkBot = (id, name, engine) => db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, 'u1', name, engine, T0, T0);
mkBot('bot_h', 'Howard', 'primary');
mkBot('bot_l', 'Leonard', 'managed');
const bot = (id) => db.prepare('SELECT * FROM bots WHERE id=?').get(id);

let seq = 1;
const say = (botId, role, text, at) => {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(botId, bot(botId).generation, seq, seq, 'message', JSON.stringify({ type: 'message', role, text }), at);
  seq++;
};
const reset = (botId) => {
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM engine_segments WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM approvals WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM tasks WHERE bot_id=?').run(botId);
};
const user = { type: 'user' };
const notices = (botId) => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice'").all(botId).map((r) => JSON.parse(r.body).text);

await test('other bots never turn over', () => {
  say('bot_l', 'user', 'hi', T0); say('bot_l', 'assistant', 'Done.', T0 + 1000);
  assert.equal(rot.planRotation(bot('bot_l'), user, T0 + 30 * H).rotate, false);
  assert.equal(rot.conversationKey('bot_l', 1), 'hq-bot_l-g1');
});

await test('a recent chat keeps its session', () => {
  reset('bot_h');
  say('bot_h', 'user', 'Fix the timer panel', T0); say('bot_h', 'assistant', 'Fixed and deployed.', T0 + 60_000);
  const p = rot.planRotation(bot('bot_h'), user, T0 + H);
  assert.equal(p.rotate, false); assert.equal(p.reason, 'recent');
});

await test('after a clean finish and 2 quiet hours, the owner\'s next message starts a fresh session with a handoff', () => {
  reset('bot_h');
  for (let i = 0; i < 25; i++) { say('bot_h', 'user', `job ${i}`, T0 + i * 1000); say('bot_h', 'assistant', `Finished job ${i}.`, T0 + i * 1000 + 500); }
  say('bot_h', 'user', 'Next: check the backups', T0 + 3 * H);
  assert.equal(rot.planRotation(bot('bot_h'), { type: 'routine' }, T0 + 3 * H).rotate, false, 'routines never turn it over');
  const r = rot.rotateIfDue(bot('bot_h'), { type: 'user', text: 'Next: check the backups' }, 'Sam', T0 + 3 * H);
  assert.ok(r, 'rotated');
  assert.equal(rot.conversationKey('bot_h', 1), 'hq-bot_h-g1-s1');
  assert.match(r.handoff, /^\[New session\./);
  assert.match(r.handoff, /The last 20 messages, oldest first/);
  assert.match(r.handoff, /Howard \([^)]+\): Finished job 24\./);
  assert.doesNotMatch(r.handoff, /Next: check the backups/, 'the new message is the turn, not part of the handoff');
  assert.doesNotMatch(r.handoff, /job 3\b/, 'only the last 20');
  assert.match(notices('bot_h').pop(), /^New session started, handoff loaded/);
  // The very next message goes on in the new session.
  say('bot_h', 'assistant', 'Backups are fine.', T0 + 3 * H + 60_000);
  assert.equal(rot.rotateIfDue(bot('bot_h'), { type: 'user', text: 'thanks' }, 'Sam', T0 + 3 * H + 120_000), null);
  assert.equal(rot.conversationKey('bot_h', 1), 'hq-bot_h-g1-s1');
});

await test('simulated stop for input: answered next morning in the same session, a day later in a new one with the checkpoint', () => {
  reset('bot_h');
  say('bot_h', 'user', 'Get the SSD migration as far as you can before the outage', T0);
  const cp = 'The offline copy is staged; the cutover needs the outage.\n\n**Checkpoint**\n- Goal: move server-one to the NVMe\n- Done so far: fresh capacity scan (21.4% free), rescue USB boot-tested\n- State of the machines: HDD still live, SSD seeded, no services changed\n- Question for Sam: can I take server-one down at 6 AM for the final copy?\n- Next step once answered: stop services, final rsync, switch boot entry';
  say('bot_h', 'assistant', cp, T0 + 40 * 60_000);
  const morning = T0 + 40 * 60_000 + 10 * H;
  const p = rot.planRotation(bot('bot_h'), user, morning);
  assert.equal(p.rotate, false); assert.equal(p.reason, 'work still open'); assert.equal(p.open.question, true);
  assert.equal(rot.rotateIfDue(bot('bot_h'), { type: 'user', text: 'Yes, 6 AM is fine' }, 'Sam', morning), null);
  assert.equal(rot.conversationKey('bot_h', 1), 'hq-bot_h-g1', 'same session the next morning');
  // A day and more later, it turns over and the checkpoint comes along.
  const later = T0 + 40 * 60_000 + 26 * H;
  const r = rot.rotateIfDue(bot('bot_h'), { type: 'user', text: 'Yes, 6 AM is fine' }, 'Sam', later);
  assert.ok(r);
  assert.match(r.handoff, /## Your latest checkpoint/);
  assert.match(r.handoff, /Question for Sam: can I take server-one down at 6 AM/);
  assert.match(r.handoff, /quiet for a day with work still open/);
  assert.match(notices('bot_h').pop(), /the latest checkpoint, the last messages, the open question/);
});

await test('a waiting card, an open task or a live board also keeps the session', () => {
  reset('bot_h');
  say('bot_h', 'user', 'deploy it', T0); say('bot_h', 'assistant', 'Waiting on the card.', T0 + 1000);
  db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES ('ap1','bot_h',1,'c1','hermes__terminal','pending',?)").run(T0);
  assert.deepEqual(rot.planRotation(bot('bot_h'), user, T0 + 5 * H).open.cards, ['hermes__terminal']);
  assert.equal(rot.planRotation(bot('bot_h'), user, T0 + 5 * H).rotate, false);
  db.prepare("UPDATE approvals SET status='expired'").run();
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES ('t1','bot_h','SSD migration','needs_input',?,?)").run(T0, T0);
  assert.equal(rot.planRotation(bot('bot_h'), user, T0 + 5 * H).rotate, false);
  db.prepare("UPDATE tasks SET state='done'").run();
  const board = { type: 'card', card: 'view', title: 'SSD migration', text: '', blocks: [{ type: 'progress', label: 'Copying', value: 40 }], pin: { on: true, by: 'bot', at: T0 + 4.5 * H }, updatedAt: T0 + 4.5 * H };
  db.prepare("INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES ('bot_h',1,?,?,'card',?,?)").run(seq, seq, JSON.stringify(board), T0 + 4.5 * H); seq++;
  const p = rot.planRotation(bot('bot_h'), user, T0 + 7 * H);
  assert.deepEqual(p.open.boards, ['SSD migration (paused)']);
  assert.equal(p.rotate, false);
});

await test('a reply quoting an older message brings that message and its neighbours', () => {
  reset('bot_h');
  say('bot_h', 'assistant', 'The Borg repository on the USB disk is 412 GB and the prune job last ran on November 12.', T0);
  for (let i = 0; i < 30; i++) say('bot_h', 'assistant', `Unrelated note ${i}.`, T0 + (i + 1) * 1000);
  const text = '> The Borg repository on the USB disk is 412 GB and the prune job last ran on November 12.\n\nRun the prune now.';
  say('bot_h', 'user', text, T0 + 4 * H);
  const r = rot.rotateIfDue(bot('bot_h'), { type: 'user', text }, 'Sam', T0 + 4 * H);
  assert.ok(r);
  assert.match(r.handoff, /## The earlier message Sam is replying to[\s\S]*412 GB/);
});

await test('questions are recognised; MAINTAINER_FRESH_AFTER_MIN=0 turns it off', () => {
  assert.equal(rot.awaitsOwner('Should I restart it now?'), true);
  assert.equal(rot.awaitsOwner('Should I restart it now?**'), true);
  assert.equal(rot.awaitsOwner('Restarted it. All healthy.'), false);
  reset('bot_h');
  say('bot_h', 'user', 'x', T0); say('bot_h', 'assistant', 'Done.', T0 + 1000);
  process.env.MAINTAINER_FRESH_AFTER_MIN = '0';
  assert.equal(rot.planRotation(bot('bot_h'), user, T0 + 50 * H).rotate, false);
  delete process.env.MAINTAINER_FRESH_AFTER_MIN;
  assert.equal(rot.planRotation(bot('bot_h'), user, T0 + 50 * H).rotate, true);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
