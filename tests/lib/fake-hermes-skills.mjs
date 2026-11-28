// A small fake Hermes install with just the calls server/box/hermes-skills.py makes (copied from
// tests/engine-skills.mjs), for suites that save skills without a real Hermes. Returns the launcher path:
// point HERMES_SKILLS_LAUNCHER at it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function fakeHermesInstall(dir) {
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

return shim;
}
