// New bots get the same light / standard / heavy Auto tiers as the others (engine.ts seedTiers):
// once, from the suggested tiers for their saved provider, and never over a person's choice.
// Needs a built server: `npm run build -w server`, then `node tests/tiers-seed.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-seed-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.ENGINES_DIR = path.join(dir, 'engines');
process.env.HERMES_HOME_PRIMARY = path.join(dir, 'hermes');
process.env.SESSION_SECRET ??= 'x'.repeat(64);
process.env.ORGO_API_KEY ??= 'unused';
process.env.SHARED_SKILLS_DIR = path.join(dir, 'shared-skills');

const { db } = await import('../server/dist/db.js');
const { seedTiers, installSharedSkills } = await import('../server/dist/engine.js');
let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); }
};

const SUB = 'claude-subscription-directsdk-experimental';
const providers = [{ id: SUB, name: 'Claude subscription', kind: 'subscription', connected: true,
  models: ['claude-sonnet-5-5[1m]', 'claude-haiku-5-5[1m]', 'claude-opus-5-5[1m]'] }];
db.prepare("INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES ('u1','o@example.com','Owner',0)").run();
const add = (id, extra = {}) => {
  db.prepare("INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, 'u1', id, '', '', '', 'blob', 'amber', 'personal', 0, 0, 0);
  db.prepare('UPDATE bots SET provider=?, model=?, tiers_seed=?, model_mode=?, model_tiers=? WHERE id=?')
    .run(extra.provider ?? SUB, 'claude-sonnet-5-5[1m]', extra.seed ?? 1, extra.mode ?? 'manual', extra.tiers ?? null, id);
};
const row = (id) => db.prepare('SELECT model, model_mode, model_tiers, tiers_seed FROM bots WHERE id=?').get(id);

test('a waiting bot gets Auto with the suggested tiers and keeps its own model', () => {
  add('b1');
  const out = seedTiers('b1', providers);
  assert.equal(out.modelMode, 'auto');
  assert.equal(out.modelTiers.heavy.model, 'claude-opus-5-5[1m]', 'the [1m] ids survive cleaning');
  const r = row('b1');
  assert.equal(r.model_mode, 'auto');
  assert.equal(r.model, 'claude-sonnet-5-5[1m]');
  assert.equal(r.tiers_seed, 0);
  assert.deepEqual(JSON.parse(r.model_tiers), {
    light: { model: 'claude-haiku-5-5[1m]', effort: 'low' },
    standard: { model: 'claude-sonnet-5-5[1m]', effort: 'medium' },
    heavy: { model: 'claude-opus-5-5[1m]', effort: 'high' },
  });
  assert.equal(seedTiers('b1', providers), null, 'only once');
});

test('a bot whose choice a person made is left alone', () => {
  add('b2', { seed: 0 });
  assert.equal(seedTiers('b2', providers), null);
  assert.equal(row('b2').model_mode, 'manual');
});

test('no model list for its provider: nothing is guessed, it waits', () => {
  add('b3', { provider: 'openai-codex' });
  assert.equal(seedTiers('b3', providers), null);
  assert.equal(row('b3').tiers_seed, 1);
  assert.equal(row('b3').model_mode, 'manual');
});

test('tiers already set are kept', () => {
  add('b4', { tiers: JSON.stringify({ heavy: { model: 'mine', effort: 'high' } }) });
  assert.equal(seedTiers('b4', providers), null);
  assert.equal(JSON.parse(row('b4').model_tiers).heavy.model, 'mine');
  assert.equal(row('b4').tiers_seed, 0);
});

test('shared skills go into a bot home once and are never overwritten or put back', () => {
  const shared = process.env.SHARED_SKILLS_DIR;
  for (const n of ['gbrain-shared-memory', 'household-bot-coordination']) {
    fs.mkdirSync(path.join(shared, 'household', n), { recursive: true });
    fs.writeFileSync(path.join(shared, 'household', n, 'SKILL.md'), `---\nname: ${n}\n---\nshared\n`);
  }
  const home = path.join(dir, 'home-raj');
  fs.mkdirSync(path.join(home, 'skills', 'household', 'household-bot-coordination'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'household', 'household-bot-coordination', 'SKILL.md'), 'own copy');
  assert.deepEqual(installSharedSkills('raj', home), ['household/gbrain-shared-memory']);
  assert.equal(fs.readFileSync(path.join(home, 'skills', 'household', 'household-bot-coordination', 'SKILL.md'), 'utf8'), 'own copy');
  fs.rmSync(path.join(home, 'skills', 'household', 'gbrain-shared-memory'), { recursive: true });
  assert.deepEqual(installSharedSkills('raj', home), [], 'a removed skill stays removed');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
