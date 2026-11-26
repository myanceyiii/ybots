import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTimers, validateTarget, readHostTimers, changeTimer } from '../server/dist/systemd-timers.js';

test('timer change executes only after an exact approval and verifies state', async () => {
  const events = [];
  const deps = { approve: async (args) => { events.push(['approve',args]); return 'allow'; }, run: async (...args) => { events.push(['run',...args]); }, inspect: async () => 'disabled' };
  const result = await changeTimer(['host1'], {host:'host1',unit:'test.timer',action:'disable'}, deps);
  assert.equal(result.state, 'disabled');
  assert.deepEqual(events, [['approve',{host:'host1',unit:'test.timer',action:'disable'}],['run','host1','test.timer','disable']]);
});

test('denial and invalid targets never run a timer change', async () => {
  let runs = 0;
  const deps = { approve: async () => 'deny', run: async () => { runs++; }, inspect: async () => 'disabled' };
  await assert.rejects(changeTimer(['host1'], {host:'host1',unit:'test.timer',action:'disable'}, deps));
  await assert.rejects(changeTimer(['host1'], {host:'bad',unit:'test.timer',action:'disable'}, deps));
  assert.equal(runs, 0);
});

test('readback mismatch fails rather than claiming success', async () => {
  const deps = { approve: async () => 'allow', run: async () => {}, inspect: async () => 'enabled' };
  await assert.rejects(changeTimer(['host1'], {host:'host1',unit:'test.timer',action:'disable'}, deps));
});

test('reads actual enablement for instantiated timer units', async () => {
  const result = await readHostTimers('host1', async (_host, command, unit) => {
    if (command === 'timers') return JSON.stringify([{ unit:'backup@daily.timer', next:2000000 }]);
    if (command === 'files') return JSON.stringify([{ unit_file:'backup@.timer', state:'disabled' }]);
    assert.equal(unit, 'backup@daily.timer');
    return 'enabled';
  });
  assert.equal(result.timers.find((t) => t.name === 'backup@daily.timer').state, 'enabled');
});

test('host read returns an explicit error rather than stale data when a command fails', async () => {
  const result = await readHostTimers('host1', async () => { throw new Error('unreachable'); });
  assert.equal(result.host, 'host1');
  assert.equal(result.reachable, false);
  assert.deepEqual(result.timers, []);
});

test('host read combines both live timer and installed unit output', async () => {
  const calls = [];
  const result = await readHostTimers('host1', async (_host, command) => {
    calls.push(command);
    return command === 'timers' ? JSON.stringify([{ unit:'active.timer', next:2000000 }]) : JSON.stringify([{ unit_file:'active.timer', state:'enabled' }, { unit_file:'off.timer', state:'disabled' }]);
  });
  assert.deepEqual(calls, ['timers','files']);
  assert.equal(result.reachable, true);
  assert.deepEqual(result.timers.map((t) => t.name), ['active.timer','off.timer']);
});

test('only accepts configured hosts and safe concrete timer unit names', () => {
  assert.equal(validateTarget(['host1', 'local'], 'host1', 'cleft-backup.timer'), true);
  for (const [host, unit] of [['outside', 'cleft-backup.timer'], ['host1', '../x.timer'], ['host1', 'a.timer;reboot'], ['host1', '-evil.timer'], ['host1', 'foo@.timer']]) {
    assert.equal(validateTarget(['host1', 'local'], host, unit), false);
  }
});

test('includes disabled timers and converts systemd microsecond timestamps', () => {
  const result = mergeTimers([{unit:'cleft-backup.timer',next:1795944680570007,last:0,activates:'cleft-backup.service'}], [{unit_file:'cleft-backup.timer',state:'enabled'}, {unit_file:'paused.timer',state:'disabled'}]);
  assert.deepEqual(result, [
    {name:'cleft-backup.timer',state:'enabled',next:1795944680570,last:null,activates:'cleft-backup.service'},
    {name:'paused.timer',state:'disabled',next:null,last:null,activates:null},
  ]);
});
