"""Read and change one Hermes home's skills for the Cleft app (server/src/engine-skills.ts).

Run by the server with Hermes' own Python, as the owner of the Hermes home, with HERMES_HOME set:

    python3 -I -c <this file> <hermes-agent root>    request JSON on stdin, reply JSON on stdout

It goes through Hermes' own skill code, the same calls Hermes' dashboard makes, so names, frontmatter,
size limits, the security scan, per-skill locks, the audit ledger and usage records all behave as they
do when the agent changes a skill itself. A change made here is the person's own, from the signed-in
app, so it skips Hermes' write-approval staging, like the dashboard. A bot changing a skill still goes
through skill_manage and the approval card.
"""
import io
import json
import sys
from contextlib import redirect_stdout

ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
sys._hermes_pin_default_home = True  # keep the HERMES_HOME we were given

out = io.StringIO()  # Hermes may print while importing; only our reply goes to stdout


def reply(obj):
    sys.__stdout__.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.__stdout__.flush()


def fail(msg, status=400):
    reply({"error": str(msg)[:600], "status": status})
    sys.exit(0)


MAX_FILES = 40


def skill_dir(name):
    from tools.skill_manager_tool import _find_skill
    found = _find_skill(name)
    if not found:
        fail(f"No skill called '{name}'.", 404)
    return found["path"]


def provenance_sets():
    from tools.skill_usage import _read_bundled_names, _read_hub_installed_names
    try:
        from tools.skill_usage import _external_skill_names
        external = set(_external_skill_names())
    except Exception:
        external = set()
    bundled, hub = set(_read_bundled_names()), set(_read_hub_installed_names())
    return bundled, hub, external - bundled - hub


def source_of(name, sets):
    bundled, hub, external = sets
    return "hub" if name in hub else "builtin" if name in bundled else "external" if name in external else "own"


def disabled_names():
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills
    return set(get_disabled_skills(load_config()))


BOT_ACTORS = {"agent", "curator"}  # the bot itself, in chat or in Hermes' background review
BOT_ACTIONS = {"create", "patch", "edit", "write_file", "remove_file"}


def bot_changes():
    """Skill name -> (ISO time, action) of the bot's latest change, from Hermes' skill ledger."""
    out = {}
    try:
        from tools.skill_ledger import ledger_path
        with open(ledger_path(), "rb") as f:
            for raw in f:
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if e.get("actor") in BOT_ACTORS and e.get("action") in BOT_ACTIONS and e.get("skill") and e.get("ts"):
                    prev = out.get(e["skill"])
                    if not prev or e["ts"] > prev[0]:
                        out[e["skill"]] = (e["ts"], e["action"])
    except Exception:
        pass
    return out


def do_list(_req):
    from tools.skills_tool import _skill_catalog
    from tools.skill_usage import activity_count, load_usage
    sets = provenance_sets()
    disabled = disabled_names()
    usage = load_usage()
    changes = bot_changes()
    rows = []
    for s in _skill_catalog(skip_disabled=True):
        name = s.get("load_name") or s.get("name")
        if not name:
            continue
        rec = usage.get(name) or usage.get(s["path"].parent.name) or {}
        try:
            mtime = s["path"].stat().st_mtime
        except OSError:
            mtime = 0
        rows.append({
            "name": name,
            "description": s.get("description") or "",
            "category": s.get("category") or "",
            "source": source_of(name, sets),
            "enabled": name not in disabled,
            "uses": activity_count(rec) if rec else 0,
            "lastUsedAt": rec.get("last_used_at"),
            "updatedAt": int(mtime * 1000),
            "pinned": bool(rec.get("pinned")),
            "botChangedAt": (changes.get(name) or changes.get(s["path"].parent.name) or (None, None))[0],
            "botAction": (changes.get(name) or changes.get(s["path"].parent.name) or (None, None))[1],
        })
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return {"skills": rows}


def do_view(req):
    name = req.get("name") or ""
    d = skill_dir(name)
    md = d / "SKILL.md"
    try:
        content = md.read_text(encoding="utf-8-sig")
    except OSError as e:
        fail(f"Couldn't read {name}: {e}", 500)
    files = []
    for p in sorted(d.rglob("*")):
        if p.is_file() and p.name != "SKILL.md" and not any(part.startswith(".") for part in p.relative_to(d).parts):
            files.append(p.relative_to(d).as_posix())
            if len(files) >= MAX_FILES:
                break
    sets = provenance_sets()
    return {"name": name, "content": content, "files": files, "source": source_of(name, sets),
            "enabled": name not in disabled_names(), "category": d.parent.name if d.parent.name != "skills" else ""}


def manage(payload):
    from tools.skill_manager_tool import apply_skill_pending
    token = None
    try:  # the ledger records this change as the person's, not the bot's
        from tools.skill_ledger import set_ledger_actor
        token = set_ledger_actor("user")
    except Exception:
        pass
    try:
        res = json.loads(apply_skill_pending(payload))
    finally:
        if token is not None:
            from tools.skill_ledger import reset_ledger_actor
            reset_ledger_actor(token)
    if not res.get("success"):
        fail(res.get("error") or res.get("message") or "Hermes refused the change.")
    return res


def do_create(req):
    payload = {"action": "create", "name": req.get("name") or "", "content": req.get("content") or ""}
    if req.get("category"):
        payload["category"] = req["category"]
    manage(payload)
    return do_view({"name": payload["name"]})


def do_save(req):
    name = req.get("name") or ""
    skill_dir(name)
    manage({"action": "edit", "name": name, "content": req.get("content") or ""})
    return do_view({"name": name})


def do_delete(req):
    name = req.get("name") or ""
    skill_dir(name)
    manage({"action": "delete", "name": name})
    return {"ok": True}


def do_toggle(req):
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
    name = req.get("name") or ""
    skill_dir(name)
    config = load_config()
    disabled = set(get_disabled_skills(config))
    if req.get("enabled"):
        disabled.discard(name)
    else:
        disabled.add(name)
    save_disabled_skills(config, disabled)
    return {"ok": True, "name": name, "enabled": bool(req.get("enabled"))}


ACTIONS = {"list": do_list, "view": do_view, "create": do_create, "save": do_save, "delete": do_delete, "toggle": do_toggle}

try:
    request = json.loads(sys.stdin.read() or "{}")
    action = ACTIONS.get(request.get("action"))
    if not action:
        fail("unknown action")
    with redirect_stdout(out):
        import hermes_bootstrap  # noqa: F401  (sets up Hermes' dependency paths)
        result = action(request)
    if action in (do_create, do_save, do_delete, do_toggle):
        try:
            with redirect_stdout(out):
                from agent.prompt_builder import clear_skills_system_prompt_cache
                clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception:
            pass
    reply(result)
except SystemExit:
    raise
except Exception as e:  # report, never a traceback on stdout
    fail(f"{type(e).__name__}: {e}", 500)
