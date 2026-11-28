// Pinned boards (server/src/board-pin.ts): when a view pins and unpins itself, and the Android copy.
// Needs a built server: `npm run build -w server`, then `node tests/board-pin.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const p = await import('../server/dist/board-pin.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const T = 1_000_000;
const bar = (value, extra = {}) => ({ id: 'p', type: 'progress', label: 'Work', value, max: 10, ...extra });
const list = (...done) => ({ id: 'k', type: 'checklist', items: done.map((d, i) => ({ id: `i${i}`, text: `Item ${i}`, done: d })) });

test('the Android copy is the same file, word for word (scripts/shared-copies.mjs)', () => {
  const mobile = fs.readFileSync(new URL('../mobile/src/boardPin.ts', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server/src/board-pin.ts', import.meta.url), 'utf8');
  assert.equal(mobile, server);
});
test('a live or step-counting bar pins itself when shown; a gauge does not', () => {
  assert.equal(p.nextPin({ blocks: [bar(2, { live: true })] }, { now: T })?.on, true);
  assert.equal(p.nextPin({ blocks: [bar(2, { note: 'Step 2 of 10' })] }, { now: T })?.by, 'auto');
  assert.equal(p.nextPin({ blocks: [bar(6, { label: '$600 of $1,000 spent' })] }, { now: T }), undefined);
  assert.equal(p.nextPin({ blocks: [list(false, false)] }, { now: T }), undefined, 'a to-do list shown once stays in the chat');
});
test('a bar or unticked checklist the bot moves with update_view pins itself', () => {
  assert.equal(p.nextPin({ blocks: [bar(3)] }, { moved: true, now: T })?.on, true);
  assert.equal(p.nextPin({ blocks: [list(true, false)] }, { moved: true, now: T })?.on, true);
  assert.equal(p.nextPin({ blocks: [{ id: 't', type: 'table', columns: [], rows: [] }] }, { moved: true, now: T }), undefined);
});
test('the bot and the person can pin or unpin, and a person’s unpin sticks', () => {
  assert.deepEqual(p.nextPin({ blocks: [{ id: 't', type: 'text', md: 'x' }] }, { bot: true, now: T }), { on: true, by: 'bot', at: T });
  const off = p.nextPin({ blocks: [bar(3, { live: true })], pin: { on: true, by: 'auto', at: T } }, { person: false, now: T + 1 });
  assert.deepEqual(off, { on: false, by: 'person', at: T + 1 });
  assert.equal(p.nextPin({ blocks: [bar(4, { live: true })], pin: off }, { moved: true, now: T + 2 }).on, false, 'moving it again does not bring it back');
  assert.equal(p.nextPin({ blocks: [bar(4)], pin: off }, { bot: true, now: T + 3 }).on, true, 'the bot can pin it again');
});
test('a job pins itself even when the bot passed pin: false; pin: false still lets go of a pinned board', () => {
  assert.deepEqual(p.nextPin({ blocks: [bar(2, { live: true })] }, { bot: false, now: T }), { on: true, by: 'auto', at: T }, 'shown as a job');
  assert.equal(p.nextPin({ blocks: [bar(2, { note: 'Step 2 of 10' })] }, { bot: false, now: T }).on, true);
  assert.equal(p.nextPin({ blocks: [bar(6, { label: '$600 of $1,000 spent' })] }, { bot: false, now: T }).on, false, 'a gauge stays out');
  assert.equal(p.nextPin({ blocks: [bar(6)] }, { moved: true, bot: false, now: T }).on, false, 'a gauge the bot moves with pin: false stays out');
  assert.deepEqual(p.nextPin({ blocks: [bar(3, { live: true })], pin: { on: true, by: 'auto', at: T } }, { moved: true, bot: false, now: T + 1 }), { on: true, by: 'auto', at: T }, 'a running job stays pinned');
  assert.equal(p.nextPin({ blocks: [bar(3)], pin: { on: true, by: 'auto', at: T } }, { moved: true, bot: false, now: T + 1 }).on, false, 'pin: false still lets go of a board that is not a job');
  const old = { on: false, by: 'bot', at: T };
  assert.equal(p.nextPin({ blocks: [bar(5, { live: true })], pin: old }, { moved: true, now: T + 3 }).on, true, 'a job shown with pin: false before this change pins when it moves');
  assert.equal(p.nextPin({ blocks: [bar(5, { live: true })], pin: old }, { now: T + 3 }).on, false, 'a tick or a stop does not');
  assert.equal(p.nextPin({ blocks: [bar(5)], pin: old }, { moved: true, now: T + 3 }).on, false, 'a gauge kept out stays out');
});
test('doneAt is set once every bar is full and every item ticked, and kept', () => {
  const pin = { on: true, by: 'auto', at: T };
  assert.equal(p.nextPin({ blocks: [bar(10), list(true, false)], pin }, { now: T + 5 }).doneAt, undefined);
  const done = p.nextPin({ blocks: [bar(10), list(true, true)], pin }, { now: T + 5 });
  assert.equal(done.doneAt, T + 5);
  assert.equal(p.nextPin({ blocks: [bar(10), list(true, true)], pin: done }, { now: T + 9 }).doneAt, T + 5);
  assert.equal(p.nextPin({ blocks: [bar(10), list(true, false)], pin: done }, { now: T + 9 }).doneAt, undefined, 'unticking reopens it');
});
test('choice buttons never pin', () => {
  assert.equal(p.nextPin({ quick: true, blocks: [bar(1, { live: true })] }, { bot: true, now: T }), undefined);
});
test('a stopped board shows as stopped for an hour, then lets go; done still wins', () => {
  const pin = { on: true, by: 'auto', at: T };
  const blocks = [bar(3, { note: 'Stopped: x', stopped: { at: T, reason: 'x' } })];
  assert.equal(p.boardState({ pin, updatedAt: T, blocks }, T, T + 60_000), 'stopped');
  assert.equal(p.boardState({ pin, updatedAt: T, blocks }, T, T + p.BOARD_TIMES.stoppedMs), null);
  assert.equal(p.boardState({ pin: { ...pin, doneAt: T }, blocks }, T, T + 60_000), 'done');
  assert.equal(p.boardState({ pin, blocks: [bar(3)] }, T, T + 60_000), 'live', 'moving the bar again clears the stop');
});
test('shortText keeps whole phrases and never cuts a word', () => {
  assert.equal(p.shortText('Install the timer', 40), 'Install the timer');
  assert.equal(p.shortText('Dependencies installed; timer-data tests running against the staging copy', 40), 'Dependencies installed');
  assert.equal(p.shortText('Systemd timer for nightly backups (with retries and a health ping)', 40), 'Systemd timer for nightly backups');
  const w = p.shortText('Copying every household receipt from the shared drive into the new budget folder', 40);
  assert.equal(w, 'Copying every household receipt');
  assert.equal(p.shortText('Copying every household receipt from the shared drive into the new budget folder', 60), 'Copying every household receipt from the shared drive');
  const last = p.shortText('Supercalifragilistic expialidocious antidisestablishmentarianism words', 30);
  assert.ok(last.length <= 30 && last.endsWith('…') && !/ (the|and)…$/.test(last), last);
});
test('boardLine: stopped boards say how far they got, in whole words', () => {
  const stopped = { title: 'Systemd timer for nightly backups', blocks: [bar(2, { note: 'Stopped: the reply ended before it finished (last step: Dependencies installed; timer-data tes', stopped: { at: T, reason: 'the reply ended before it finished' } })] };
  const l = p.boardLine(stopped);
  assert.equal(l.stopped, true);
  assert.equal(l.step, 'Stopped after: Dependencies installed');
  assert.equal(l.title, 'Systemd timer for nightly backups');
  assert.equal(l.pct, 20);
  const kept = p.boardLine({ title: 'T', blocks: [bar(2, { note: 'Stopped: x (last step: y)', stopped: { at: T, reason: 'x', step: 'Wrote the unit file' } })] });
  assert.equal(kept.step, 'Stopped after: Wrote the unit file');
  assert.equal(p.boardLine({ blocks: [bar(5, { note: 'Step 2 of 4' })] }).step, 'Step 2 of 4');
  assert.equal(p.boardLine({ blocks: [bar(5, { note: 'Step 2 of 4: writing the timer-data unit file and checking it against the staging copy of the GBrain export' })] }).step, 'Step 2 of 4 · Writing the timer-data unit file and checking it');
  assert.equal(p.boardLine({ title: 'Systemd timer migration for the Host1 GBrain and Honcho nightly backups (with restore check)', blocks: [] }).title, 'Systemd timer migration for the Host1 GBrain and Honcho nightly backups');
  assert.equal(p.boardLine({ blocks: [list(true, false)] }).step, '1 of 2 done');
});
test('boardState: live, paused after an hour, gone after a day, done for 10 minutes', () => {
  const pin = { on: true, by: 'auto', at: T };
  assert.equal(p.boardState({ pin, updatedAt: T }, T, T + 60_000), 'live');
  assert.equal(p.boardState({ pin, updatedAt: T }, T, T + p.BOARD_TIMES.pausedMs), 'paused');
  assert.equal(p.boardState({ pin, updatedAt: T }, T, T + p.BOARD_TIMES.expireMs), null);
  assert.equal(p.boardState({ pin: { ...pin, doneAt: T } }, T, T + 60_000), 'done');
  assert.equal(p.boardState({ pin: { ...pin, doneAt: T } }, T, T + p.BOARD_TIMES.doneMs), null);
  assert.equal(p.boardState({ pin: { ...pin, on: false } }, T, T), null);
  assert.equal(p.boardState({}, T, T), null);
});
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
