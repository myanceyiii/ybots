// Settings > Usage: turns and tokens per day, per bot and per model, for the signed-in account only.
// Hermetic: a throwaway server; turns are written straight into its database.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, startServer } from './lib/server.mjs';

const require = createRequire(path.join(root, 'server/package.json'));
const Database = require('better-sqlite3');
const { test, done } = runner();
const s = await startServer({ name: 'usage' });
const DAY = 86_400_000;

try {
  const me = await s.signIn('owner@example.com');
  const other = await s.signIn('someone@example.com');
  const mine = (await me.api('GET', '/bots')).json.bots[0];
  const theirs = (await other.api('GET', '/bots')).json.bots[0];
  const side = (await me.api('POST', `/bots/${mine.id}/side-chats`, { title: 'Aside' })).json;
  const sideId = side.chat?.id ?? side.id ?? null;

  const db = new Database(s.dbPath);
  const add = (botId, at, model, ok, i, o, provider = 'openrouter') => db.prepare('INSERT INTO model_turns (bot_id, at, mode, tier, provider, model, reason, ok, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)').run(botId, at, 'manual', null, provider, model, null, ok ? 1 : 0, i, o);
  const t = Date.now();
  add(mine.id, t - 1000, 'big-model', true, 1000, 100);
  add(mine.id, t - 2000, 'big-model', true, 2000, 200);
  add(mine.id, t - 3000, 'small-model', false, null, null);
  add(mine.id, t - 3 * DAY, 'small-model', true, 500, 50);
  add(mine.id, t - 40 * DAY, 'old-model', true, 9, 9);
  if (sideId) add(sideId, t - 4000, 'big-model', true, 10, 1);
  add(theirs.id, t - 1000, 'their-model', true, 7777, 777);
  db.close();
  const extra = sideId ? 1 : 0;

  await test('totals, days, bots and models for the period, with failures counted', async () => {
    const r = (await me.api('GET', '/usage?days=14&tz=0')).json;
    assert.equal(r.days, 14);
    assert.equal(r.byDay.length, 14);
    assert.equal(r.totals.turns, 4 + extra);
    assert.equal(r.totals.failed, 1);
    assert.equal(r.totals.inputTokens, 3500 + (extra ? 10 : 0));
    assert.equal(r.byDay.at(-1).day, new Date().toISOString().slice(0, 10));
    assert.equal(r.byDay.reduce((a, d) => a + d.turns, 0), r.totals.turns, 'every turn falls on one of the days');
    assert.equal(r.byBot.length, 1, 'a side chat counts for its bot');
    assert.equal(r.byBot[0].botId, mine.id);
    assert.equal(r.byBot[0].topModel, 'big-model');
    assert.deepEqual(r.byModel.map((m) => m.model).sort(), ['big-model', 'small-model']);
  });

  await test('a longer period reaches further back; the period is kept within 1 to 90 days', async () => {
    assert.equal((await me.api('GET', '/usage?days=90&tz=0')).json.totals.turns, 5 + extra);
    assert.equal((await me.api('GET', '/usage?days=9999')).json.days, 90);
    assert.equal((await me.api('GET', '/usage?days=banana&tz=banana')).json.days, 14);
    assert.equal((await me.api('GET', '/usage?days=1&tz=0')).json.byDay.length, 1);
  });

  await test('the reader\'s time zone decides which day a turn belongs to', async () => {
    // Far enough east or west, "today" has a different date; the turns still add up.
    for (const tz of [-720, 840]) {
      const r = (await me.api('GET', `/usage?days=14&tz=${tz}`)).json;
      assert.equal(r.byDay.reduce((a, d) => a + d.turns, 0), r.totals.turns);
      assert.equal(r.byDay.at(-1).day, new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10));
    }
  });

  await test('another account sees only its own; signed out sees nothing', async () => {
    const r = (await other.api('GET', '/usage?days=14')).json;
    assert.equal(r.totals.turns, 1);
    assert.equal(r.byModel[0].model, 'their-model');
    assert.ok(!JSON.stringify(r).includes('big-model'));
    assert.equal((await fetch(`${s.BASE}/api/usage`)).status, 401);
  });
} finally {
  await s.stop();
}
done();
