// Tests for server/src/engine-skills.ts: reading a Hermes launcher, SKILL.md handling, and the
// server/box/hermes-skills.py bridge against a small fake Hermes install (real Hermes isn't needed).
// Needs a built server: `npm run build -w server`, then `node tests/engine-skills.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-skills-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'engines'), SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', HERMES_HOME_PRIMARY: path.join(dir, 'h') });
const sk = await import('../server/dist/engine-skills.js');
const { db } = await import('../server/dist/db.js');
await import('../server/dist/db-config.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'o@test.invalid', 'Owner', Date.now());
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_test', 'u1', 'Test', Date.now(), Date.now());
let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };

const python = execFileSync('sh', ['-c', 'command -v python3']).toString().trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ---------- a fake Hermes install: just the calls the bridge makes ----------
const root = path.join(dir, 'agent');
w(`${root}/hermes_bootstrap.py`, 'print("bootstrap noise that must not reach stdout")\n');
for (const pkg of ['tools', 'hermes_cli', 'agent']) w(`${root}/${pkg}/__init__.py`, '');
w(`${root}/tools/skills_tool.py`, `
import os
from pathlib import Path
def _skill_catalog(skip_disabled=False, include_hidden=False):
    base = Path(os.environ["HERMES_HOME"]) / "skills"
    out = []
    for md in sorted(base.rglob("SKILL.md")):
        if any(p.startswith(".") for p in md.relative_to(base).parts): continue
        text = md.read_text()
        desc = next((l.split(":", 1)[1].strip() for l in text.splitlines() if l.startswith("description:")), "")
        cat = md.parent.parent.name if md.parent.parent != base else ""
        out.append({"name": md.parent.name, "load_name": md.parent.name, "description": desc, "category": cat, "path": md})
    return out
`);
w(`${root}/tools/skill_usage.py`, `
import json, os
from pathlib import Path
def _read_bundled_names(): return {"stock"}
def _read_hub_installed_names(): return {"from-hub"}
def _external_skill_names(): return set()
def load_usage():
    p = Path(os.environ["HERMES_HOME"]) / "skills" / ".usage.json"
    return json.loads(p.read_text()) if p.exists() else {}
def activity_count(rec): return int(rec.get("use_count", 0)) + int(rec.get("view_count", 0))
`);
w(`${root}/tools/skill_ledger.py`, `
import json, os, contextvars
from pathlib import Path
_actor = contextvars.ContextVar("a", default=None)
def ledger_path(): return Path(os.environ["HERMES_HOME"]) / "skills" / ".curator_ledger.jsonl"
def set_ledger_actor(a): return _actor.set(a)
def reset_ledger_actor(t): _actor.reset(t)
def actor(): return _actor.get() or "agent"
`);
w(`${root}/tools/skill_manager_tool.py`, `
import json, os, shutil
from pathlib import Path
def _base(): return Path(os.environ["HERMES_HOME"]) / "skills"
def _find_skill(name):
    for md in _base().rglob("SKILL.md"):
        if md.parent.name == name: return {"path": md.parent}
    return None
def apply_skill_pending(p):
    a, name = p["action"], p["name"]
    if a == "create":
        if _find_skill(name): return json.dumps({"success": False, "error": f"A skill named '{name}' already exists."})
        d = _base() / p.get("category", "") / name
        d.mkdir(parents=True); (d / "SKILL.md").write_text(p["content"])
    elif a == "edit":
        if not p["content"].startswith("---"): return json.dumps({"success": False, "error": "SKILL.md must start with YAML frontmatter (---)."})
        (_find_skill(name)["path"] / "SKILL.md").write_text(p["content"])
    elif a == "delete":
        shutil.rmtree(_find_skill(name)["path"])
    from datetime import datetime, timezone
    from tools.skill_ledger import ledger_path, actor
    with open(ledger_path(), "a") as f:
        f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "actor": actor(), "action": a, "skill": name}) + "\\n")
    return json.dumps({"success": True})
`);
w(`${root}/hermes_cli/config.py`, `
import json, os
from pathlib import Path
F = lambda: Path(os.environ["HERMES_HOME"]) / "config.json"
def load_config(): return json.loads(F().read_text()) if F().exists() else {}
def save(c): F().write_text(json.dumps(c))
`);
w(`${root}/hermes_cli/skills_config.py`, `
from hermes_cli.config import save
def get_disabled_skills(c): return set(c.get("skills", {}).get("disabled", []))
def save_disabled_skills(c, d): c.setdefault("skills", {})["disabled"] = sorted(d); save(c)
`);
w(`${root}/agent/prompt_builder.py`, 'def clear_skills_system_prompt_cache(clear_snapshot=False): print("cleared")\n');

// The two launcher shapes Hermes installs: a one-line shim, and the real launcher.
const launcher = path.join(dir, 'bin', 'real-hermes');
w(launcher, `#!/bin/sh\nexec ${python} -I -c 'import os, re, sys\nos.environ.pop('"'"'PYTHONHOME'"'"', None)\nsys.path.insert(0, '"'"'${root}'"'"')\nfrom hermes_cli.main import main' "$@"\n`);
const shim = path.join(dir, 'bin', 'hermes');
w(shim, `#!/bin/sh\nexec ${launcher} "$@"\n`);

const home = path.join(dir, 'home');
w(`${home}/skills/productivity/weekly-report/SKILL.md`, '---\nname: weekly-report\ndescription: Use for the Friday report.\nmetadata:\n  hermes:\n    tags: [reports]\n---\n\n# Weekly report\n\n1. Gather.\n');
w(`${home}/skills/productivity/weekly-report/references/example.md`, 'x');
w(`${home}/skills/stock/SKILL.md`, '---\nname: stock\ndescription: Shipped with Hermes.\n---\nBody\n');
w(`${home}/skills/.usage.json`, JSON.stringify({ 'weekly-report': { use_count: 3, view_count: 2, last_used_at: '2026-11-20T10:00:00+00:00' } }));

await test('launcher: the shim is followed to the real launcher', () => {
  assert.deepEqual(sk.parseLauncher(shim), { python, root });
});

await test('launcher: unknown files give null', () => {
  w(`${dir}/bin/other`, '#!/bin/sh\necho hi\n');
  assert.equal(sk.parseLauncher(`${dir}/bin/other`), null);
  assert.equal(sk.parseLauncher(`${dir}/missing`), null);
});

await test('slugs are folder names Hermes accepts', () => {
  assert.equal(sk.skillSlug('Weekly report!'), 'weekly-report');
  assert.equal(sk.skillSlug('  Café -- notes  '), 'cafe-notes');
  assert.ok(sk.SKILL_NAME.test(sk.skillSlug('Prep for a sales call')));
});

await test('SKILL.md: split, and rebuild keeping other frontmatter', () => {
  const src = fs.readFileSync(`${home}/skills/productivity/weekly-report/SKILL.md`, 'utf8');
  const { front, body } = sk.splitSkill(src);
  assert.match(front, /tags: \[reports\]/);
  assert.match(body, /^# Weekly report/);
  // Same description: frontmatter is kept byte for byte.
  const same = sk.buildSkill('weekly-report', 'Use for the Friday report.', '# New\n', src);
  assert.ok(same.startsWith(`---\n${front}\n---\n\n# New`));
  // New description: other keys survive.
  const changed = sk.buildSkill('weekly-report', 'Use on Fridays.', 'Steps', src);
  assert.match(changed, /description: Use on Fridays\./);
  assert.match(changed, /tags:/);
  assert.match(changed, /\n---\n\nSteps\n$/);
  // No frontmatter before: one is made.
  assert.equal(sk.buildSkill('a', 'b', 'c'), '---\nname: a\ndescription: b\n---\n\nc\n');
});

const t = { botId: 'bot_test', home, runtime: sk.parseLauncher(shim) };

await test('bridge: list shows every skill with its source and use count', async () => {
  const list = await sk.listHermesSkills(t, true);
  assert.deepEqual(list.map((s) => [s.name, s.category, s.source, s.uses]), [['stock', '', 'builtin', 0], ['weekly-report', 'productivity', 'own', 5]]);
  assert.equal(list[1].lastUsedAt, Date.parse('2026-11-20T10:00:00Z'));
  assert.equal(sk.cachedSkillCount('bot_test'), 2);
});

await test('bridge: view gives the file, its description and extra files', async () => {
  const v = await sk.viewHermesSkill(t, 'weekly-report');
  assert.equal(v.description, 'Use for the Friday report.');
  assert.match(v.body, /1\. Gather\./);
  assert.deepEqual(v.files, ['references/example.md']);
  assert.equal(v.category, 'productivity');
});

await test('bridge: create, edit, turn off and delete', async () => {
  const c = await sk.createHermesSkill(t, { name: 'Prep for a call', category: 'Sales', description: 'Before any sales call.', body: '1. Read notes.' });
  assert.equal(c.name, 'prep-for-a-call');
  assert.ok(fs.existsSync(`${home}/skills/sales/prep-for-a-call/SKILL.md`));
  const e = await sk.saveHermesSkill(t, 'prep-for-a-call', { body: '1. Read notes.\n2. Call.' });
  assert.match(fs.readFileSync(`${home}/skills/sales/prep-for-a-call/SKILL.md`, 'utf8'), /2\. Call\./);
  assert.equal(e.description, 'Before any sales call.');
  await sk.setHermesSkillEnabled(t, 'prep-for-a-call', false);
  assert.equal((await sk.listHermesSkills(t)).find((s) => s.name === 'prep-for-a-call').enabled, false);
  await sk.deleteHermesSkill(t, 'prep-for-a-call');
  assert.ok(!fs.existsSync(`${home}/skills/sales/prep-for-a-call`));
});

await test("bridge: Hermes' refusals come back as messages", async () => {
  await assert.rejects(sk.createHermesSkill(t, { name: 'weekly-report', description: 'd', body: 'b' }), /already exists/);
  await assert.rejects(sk.saveHermesSkill(t, 'weekly-report', { content: 'no frontmatter' }), /frontmatter/);
  await assert.rejects(sk.viewHermesSkill(t, 'nope'), (e) => e.status === 404);
  await assert.rejects(sk.viewHermesSkill(t, '../etc'), (e) => e.status === 404);
  await assert.rejects(sk.createHermesSkill(t, { name: 'x', description: '', body: 'b' }), /when the bot should use/);
});

await test('New marker: only bot changes after the first look, until opened', async () => {
  const ledger = `${home}/skills/.curator_ledger.jsonl`;
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  db.prepare('DELETE FROM skill_reviews WHERE bot_id=?').run('bot_test');
  // A bot change from before the first look is history, not New.
  fs.appendFileSync(ledger, JSON.stringify({ ts: at(-60_000), actor: 'agent', action: 'patch', skill: 'stock' }) + '\n');
  let list = await sk.listHermesSkills(t, true);
  assert.equal(list.find((s) => s.name === 'stock').isNew, false);
  assert.equal(list.find((s) => s.name === 'stock').botAction, 'changed');
  // The bot's background review improves a skill later: New.
  fs.appendFileSync(ledger, JSON.stringify({ ts: at(5_000), actor: 'curator', action: 'patch', skill: 'weekly-report' }) + '\n');
  list = await sk.listHermesSkills(t, true);
  assert.equal(list.find((s) => s.name === 'weekly-report').isNew, true);
  // The person's own create is recorded as theirs, so it is not New.
  await sk.createHermesSkill(t, { name: 'mine', description: 'd', body: 'b' });
  assert.match(fs.readFileSync(ledger, 'utf8'), /"actor": "user", "action": "create", "skill": "mine"/);
  list = await sk.listHermesSkills(t, true);
  assert.equal(list.find((s) => s.name === 'mine').isNew, false);
  // Opening a skill clears its marker; "seen all" clears the rest.
  db.prepare('UPDATE skill_reviews SET seen_at=? WHERE bot_id=? AND name=?').run(Date.now() + 10_000, 'bot_test', '*');
  list = await sk.listHermesSkills(t, true);
  assert.equal(list.find((s) => s.name === 'weekly-report').isNew, false);
  await sk.deleteHermesSkill(t, 'mine');
});

await test("routes: fixed paths like auto-save come before /:name, so they aren't read as skill names", () => {
  const src = fs.readFileSync(new URL('../server/src/routes-config.ts', import.meta.url), 'utf8');
  const at = (m, p) => src.indexOf(`configApi.${m}('/bots/:id/hermes-skills/${p}'`);
  assert.ok(at('put', 'auto-save') >= 0 && at('put', 'auto-save') < at('put', ':name'));
  for (const m of ['get', 'put', 'post', 'delete']) {
    const named = at(m, ':name');
    if (named < 0) continue;
    for (const fixed of ['auto-save', 'seen']) { const f = at(m, fixed); if (f >= 0) assert.ok(f < named, `${m} ${fixed}`); }
  }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
