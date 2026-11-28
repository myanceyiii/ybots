// The Needs you board (server/src/needs-you.ts): one list of everything waiting on the person across every bot.
// Cards waiting (approvals, emails, questions, connect cards, looks), unanswered forms and choice buttons, tasks
// waiting on the person and stalled ones; answered cards, forms answered in words and old cards left off; Sam's
// scoped sign-in sees only Robin's; a bot Alex hid is off Alex's board; the mobile copy of the types matches.
// Throwaway database, fake Hermes. Run after `npm run build -w server`:   node tests/needs-you-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, runner, startServer } from './lib/server.mjs';

const { test, done } = runner();
const s = await startServer({
  name: 'needs-you-e2e',
  env: { DISPLAY_NAMES: 'owner@example.com=Alex,sam@example.com=Sam', SCOPED_PEOPLE: 'sam@example.com=Robin', CF_ACCESS_ACCOUNTS: 'sam@example.com=owner@example.com' },
});
try {
  const alex = (await s.signIn('owner@example.com')).api;
  const sam = (await s.signIn('sam@example.com')).api;
  const leonard = (await alex('POST', '/bots', { name: 'Leonard' })).json.bot;
  const robin = (await alex('POST', '/bots', { name: 'Robin' })).json.bot;
  const howard = (await alex('POST', '/bots', { name: 'Howard' })).json.bot;
  assert.ok(leonard?.id && robin?.id && howard?.id);

  const { default: Database } = await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'));
  const db = new Database(s.dbPath);
  db.pragma('busy_timeout = 3000');
  const now = Date.now();
  const gen = (id) => db.prepare('SELECT generation FROM bots WHERE id=?').get(id).generation;
  let seq = 1000;
  const put = (botId, kind, body, at = now - 60_000) => {
    const n = ++seq;
    db.prepare('INSERT INTO rows (bot_id, generation, seq, updated_seq, kind, body, created_at) VALUES (?,?,?,?,?,?,?)').run(botId, gen(botId), n, n, kind, JSON.stringify(body), at);
    return n;
  };
  const card = (c) => ({ type: 'card', ...c });
  const approval = put(leonard.id, 'card', card({ card: 'approval', approvalId: 'a1', title: 'Pay the electric bill', detail: '$84.12 to Ameren', tool: 'pay', args: {}, status: 'pending' }), now - 5 * 60_000);
  const email = put(leonard.id, 'card', card({ card: 'approval', approvalId: 'a2', title: 'Send an email', detail: '', tool: 'gmail_send', args: {}, status: 'pending', mail: { to: 'school@example.org', subject: 'Field trip form', from: '', cc: '', bcc: '', body: '', html: false, attachments: [], replyAll: false, threadId: '', forwardOf: '' } }), now - 4 * 60_000);
  put(leonard.id, 'card', card({ card: 'approval', approvalId: 'a3', title: 'Already answered', detail: '', tool: 'x', args: {}, status: 'allowed' }));
  put(leonard.id, 'card', card({ card: 'approval', approvalId: 'a4', title: 'Left weeks ago', detail: '', tool: 'x', args: {}, status: 'pending' }), now - 30 * 86_400_000);
  const question = put(howard.id, 'card', card({ card: 'question', question: 'Restart Hermes now or tonight?', options: ['Now', 'Tonight'], status: 'pending' }), now - 3 * 60_000);
  const robinQ = put(robin.id, 'card', card({ card: 'question', question: 'Chicken or fish for dinner?', options: ['Chicken', 'Fish'], status: 'pending' }), now - 2 * 60_000);
  // An older form Howard moved on from, then a newer unanswered form.
  put(howard.id, 'card', card({ card: 'view', title: 'Old', blocks: [{ id: 'f0', type: 'form', title: 'Old form', fields: [{ id: 'x', label: 'X' }] }], text: '' }), now - 90_000);
  const form = put(howard.id, 'card', card({ card: 'view', title: 'Backup settings', blocks: [{ id: 'f1', type: 'form', title: 'Backup settings', fields: [{ id: 'day', label: 'Day' }, { id: 'time', label: 'Time' }] }], text: '' }), now - 60_000);
  // Leonard's choice buttons were answered in words (a message from the person after them): not waiting.
  put(leonard.id, 'card', card({ card: 'view', title: '', quick: true, blocks: [{ id: 'c1', type: 'choice', question: 'Which card?', options: ['Visa', 'Amex'], picked: [] }], text: '' }), now - 50_000);
  put(leonard.id, 'message', { type: 'message', role: 'user', text: 'The Visa' }, now - 40_000);
  // Robin's choice buttons are still waiting.
  const choice = put(robin.id, 'card', card({ card: 'view', title: '', quick: true, blocks: [{ id: 'c2', type: 'choice', question: 'Remind you at 5 or 6?', options: ['5', '6'], picked: [] }], text: '' }), now - 30_000);
  db.prepare("INSERT INTO tasks (id, bot_id, title, state, note, created_at, updated_at) VALUES ('t1', ?, 'Pick a plumber', 'needs_input', 'Two quotes in', ?, ?)").run(leonard.id, now - 3600_000, now - 20_000);
  db.prepare("INSERT INTO tasks (id, bot_id, title, state, note, created_at, updated_at) VALUES ('t2', ?, 'Move the backups', 'working', '', ?, ?)").run(howard.id, now - 3 * 86_400_000, now - 2 * 86_400_000);
  db.prepare("INSERT INTO tasks (id, bot_id, title, state, note, created_at, updated_at) VALUES ('t3', ?, 'Fresh work', 'working', '', ?, ?)").run(howard.id, now, now);
  db.prepare("INSERT INTO tasks (id, bot_id, title, state, note, created_at, updated_at) VALUES ('t4', ?, 'Done thing', 'done', '', ?, ?)").run(howard.id, now, now);

  const board = async (who = alex) => { const r = await who('GET', '/needs-you'); assert.equal(r.status, 200, r.text); return r.json.items; };

  await test('Alex sees every card, form and task waiting on him, newest first, each pointing at its card', async () => {
    const items = await board();
    const ids = items.map((i) => i.id);
    assert.deepEqual(ids, [`task:t1`, `${robin.id}:${choice}`, `${howard.id}:${form}`, `${robin.id}:${robinQ}`, `${howard.id}:${question}`, `${leonard.id}:${email}`, `${leonard.id}:${approval}`, 'task:t2']);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.deepEqual([by[`${leonard.id}:${approval}`].kind, by[`${leonard.id}:${approval}`].title, by[`${leonard.id}:${approval}`].seq, by[`${leonard.id}:${approval}`].chatId], ['approval', 'Pay the electric bill', approval, leonard.id]);
    assert.deepEqual([by[`${leonard.id}:${email}`].kind, by[`${leonard.id}:${email}`].label, by[`${leonard.id}:${email}`].title, by[`${leonard.id}:${email}`].detail], ['email', 'Email to send', 'To school@example.org', 'Field trip form']);
    assert.equal(by[`${howard.id}:${form}`].kind, 'form');
    assert.equal(by[`${howard.id}:${form}`].detail, 'Day, Time');
    assert.equal(by[`${robin.id}:${choice}`].kind, 'choice');
    assert.equal(by['task:t1'].kind, 'task');
    assert.equal(by['task:t1'].seq, undefined);
    assert.equal(by['task:t2'].kind, 'stalled');
  });

  await test("Sam's Robin sign-in sees only Robin's items", async () => {
    const items = await board(sam);
    assert.deepEqual(items.map((i) => i.id), [`${robin.id}:${choice}`, `${robin.id}:${robinQ}`]);
    assert.ok(items.every((i) => i.botId === robin.id));
  });

  await test('an answered card leaves the board', async () => {
    const r = db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(howard.id, question);
    db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify({ ...JSON.parse(r.body), status: 'answered', answer: 'Now' }), howard.id, question);
    assert.ok(!(await board()).some((i) => i.id === `${howard.id}:${question}`));
  });

  await test('a bot Alex hid is off his board but still on Sam\'s', async () => {
    db.prepare('UPDATE bots SET owner_hidden=1 WHERE id=?').run(robin.id);
    assert.ok(!(await board()).some((i) => i.botId === robin.id));
    assert.equal((await board(sam)).length, 2);
    db.prepare('UPDATE bots SET owner_hidden=0 WHERE id=?').run(robin.id);
  });

  await test('a handoff stuck on the person shows once, only when its bot has nothing else on the board', async () => {
    const add = (id, to, task) => db.prepare("INSERT INTO bot_hops (id, user_id, from_bot, to_bot, ask_chat, depth, task, kind, status, attempts, seen, created_at, updated_at) VALUES (?, (SELECT user_id FROM bots WHERE id=?), ?, ?, ?, 1, ?, 'ask', 'waiting', 1, 0, ?, ?)")
      .run(id, to, howard.id, to, howard.id, task, now - 10_000, now - 10_000);
    add('h1', leonard.id, 'Find the warranty for the dryer');
    let items = await board();
    assert.ok(!items.some((i) => i.id === 'hop:h1'), 'Leonard already has cards on the board');
    db.prepare("UPDATE rows SET body=replace(body, '\"pending\"', '\"allowed\"') WHERE bot_id=?").run(leonard.id);
    db.prepare("UPDATE tasks SET state='done' WHERE bot_id=?").run(leonard.id);
    items = await board();
    const hop = items.find((i) => i.id === 'hop:h1');
    assert.ok(hop, JSON.stringify(items.map((i) => i.id)));
    assert.deepEqual([hop.kind, hop.label, hop.title, hop.detail, hop.botId], ['handoff', 'Handoff waiting', 'Find the warranty for the dryer', 'Howard is waiting on this', leonard.id]);
    assert.ok(!(await board(sam)).some((i) => i.kind === 'handoff'), 'not on the Robin sign-in');
  });

  await test('a check-in offer reads as one', async () => {
    const n = put(robin.id, 'card', card({ card: 'view', title: '', quick: true, checkin: { subject: 'the mail' }, blocks: [{ id: 'c', type: 'choice', question: 'Keep an eye on the mail?', options: ['Daily', 'Not now'], picked: [] }], text: '' }), now - 1000);
    const it = (await board()).find((i) => i.id === `${robin.id}:${n}`);
    assert.equal(it.label, 'Check-in offer');
  });

  await test('signed out gets nothing', async () => {
    const r = await fetch(`${s.BASE}/api/needs-you`);
    assert.equal(r.status, 401);
  });

  await test('the phone app reads these types from the server file (docs/api-contract.md)', () => {
    assert.match(fs.readFileSync(path.join(root, 'mobile/src/api.ts'), 'utf8'), /from '@shared\/needs-you-types'/);
  });
  db.close();
} finally {
  await s.stop();
}
done();
