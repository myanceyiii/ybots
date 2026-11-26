"""Cleft Bot approval gate for Hermes (a ``pre_tool_call`` hook).

Before Hermes runs one of its own tools (terminal, write_file, the browser, ...), this asks the Cleft
Bot server on this machine (POST /mcp/<bot>/gate). The server decides from the owner's settings:
read-only tools run, others show an approval card in the app and wait for the owner. Tools served by
the Cleft Bot server itself (mcp__hq__*) are already checked there and pass straight through.

It fails closed: if the server cannot be reached or answers anything unexpected, the tool is not
run. gate.json next to this file (written by the server, mode 600) holds the URL and token.

When the server lets a terminal command through with ``redact: true`` (the maintainer's free-run on a
command that touches secret files, .env, keys, tokens), a ``transform_tool_result`` hook masks the
secrets in that command's output before the model or the chat sees it. The command still runs.

Steering: at each tool step (pre and post tool call) it also asks the server (POST /mcp/<bot>/steer)
whether the owner sent a message for the reply in progress. A note it gets is handed to Hermes' own
mid-turn steering (``agent.steer``), which delivers it as a user message right after the current tool
step. This never blocks or slows a tool: any failure is ignored.
"""
import contextlib
import json
import os
import re
import sys
import threading
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_OWN = ("mcp__hq__", "mcp_hq_")
# Loopback only, and never through a proxy from the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _config():
    with open(os.path.join(_HERE, "gate.json"), encoding="utf-8") as f:
        return json.load(f)


def _human_wait(session_id):
    """Tell Hermes this is a wait on a person, so its tool batch deadline does not run out meanwhile."""
    try:
        from tools.approval_human_wait import human_wait_window
        return human_wait_window(session_id or None)
    except Exception:
        return contextlib.nullcontext()


def _platform():
    """Where this session came from (telegram, api_server, cron, ...), as Hermes records it."""
    try:
        from tools.approval_context import _get_session_platform
        return _get_session_platform() or ""
    except Exception:
        return os.getenv("HERMES_SESSION_PLATFORM", "")


def _findings(tool_name, args):
    """Hermes' own dangerous-command findings for a terminal command, so the app can ask about them.

    These only ever make the app stricter. Hermes' saved command_allowlist is not applied here.
    """
    if tool_name != "terminal":
        return []
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        return []
    found = []
    try:
        from tools import approval_detection as d
        try:
            hard, why = d.detect_hardline_command(command)
            if hard and why:
                found.append(str(why))
        except Exception:
            pass
        try:
            found.extend(str(x) for x in d._iter_dangerous_descriptions(command))
        except Exception:
            flagged = d.detect_dangerous_command(command)
            if flagged and flagged[0]:
                found.append(str(flagged[1] or flagged[2] or "dangerous command"))
    except Exception:
        return []
    return list(dict.fromkeys(x for x in found if x))[:20]


# Commands whose output must be redacted: (session, command) -> when the server said so.
_REDACT = {}
_REDACT_LOCK = threading.Lock()
_ASSIGN = re.compile(r"(?im)^(\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:token|secret|password|passwd|pass|key|credential|auth|cookie|dsn|private)[A-Za-z0-9_.-]*\s*[:=]\s*)(.+)$")


def _redact_key(session_id, command):
    return (session_id or "", command or "")


def _mark_redact(session_id, command):
    with _REDACT_LOCK:
        now = time.time()
        for k, t in list(_REDACT.items()):
            if now - t > 3600:
                _REDACT.pop(k, None)
        _REDACT[_redact_key(session_id, command)] = now


def _redact(text):
    """Mask secrets with Hermes' own redactor, forced, plus every credential-shaped assignment line."""
    out = text
    try:
        from agent.redact import redact_sensitive_text
        out = redact_sensitive_text(out, force=True, file_read=True, secret_file=True, redact_url_credentials=True)
    except TypeError:
        try:
            from agent.redact import redact_sensitive_text
            out = redact_sensitive_text(out, force=True)
        except Exception:
            pass
    except Exception:
        pass
    out = _ASSIGN.sub(lambda m: m.group(1) + "«redacted»", out)
    out = re.sub(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", "«redacted private key»", out, flags=re.S)
    return out


# Browser steps: notes from the app's browser guard and masking of values typed from secure input cards.
_CARDLIKE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")


def _luhn(digits):
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _mask_cards(text):
    def one(m):
        digits = re.sub(r"\D", "", m.group(0))
        return "«card number hidden»" if 13 <= len(digits) <= 19 and _luhn(digits) else m.group(0)
    return _CARDLIKE.sub(one, text)


def _mask_entered(text, scrub):
    """Mask any run of the text whose salted hash matches a value typed from a secure input card."""
    import hashlib
    try:
        salt = str(scrub.get("salt") or "")
        items = [(int(i["len"]), str(i["hash"])) for i in scrub.get("items") or []]
    except Exception:
        return text
    if not salt or not items or len(text) > 400000:
        return text
    for length, digest in items:
        if length < 4 or length > 512:
            continue
        i, out, changed = 0, [], False
        while i + length <= len(text):
            if hashlib.sha256((salt + text[i:i + length]).encode("utf-8")).hexdigest() == digest:
                out.append(text[:i] + "«entered by you, hidden»")
                text = text[i + length:]
                i, changed = 0, True
                continue
            i += 1
        if changed:
            text = "".join(out) + text
    return text


def _browser_after(tool_name, result):
    """Ask the app for notes and masks after a browser step; any failure leaves the result as it was."""
    try:
        cfg = _config()
        url = str(cfg.get("url") or "")
        if not url.endswith("/gate"):
            return None
        req = urllib.request.Request(
            url[: -len("/gate")] + "/after", data=json.dumps({"tool": tool_name}).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"},
        )
        with _OPENER.open(req, timeout=3) as r:
            answer = json.loads(r.read().decode("utf-8"))
    except Exception:
        answer = {}
    text = result if isinstance(result, str) else None
    if text is None:
        return None
    out = _mask_cards(text)
    if isinstance(answer, dict) and isinstance(answer.get("scrub"), dict):
        out = _mask_entered(out, answer["scrub"])
    note = answer.get("note") if isinstance(answer, dict) else None
    if isinstance(note, str) and note.strip():
        out = out + "\n\n" + note.strip()
    return out if out != text else None


def redact_result(tool_name="", args=None, result=None, session_id="", **_):
    """transform_tool_result: redact the output of a command the server marked; browser steps get the guard's notes."""
    try:
        if (tool_name.startswith("browser_") or tool_name == "computer_use") and isinstance(result, str):
            return _browser_after(tool_name, result)
        if tool_name != "terminal" or not isinstance(result, str):
            return None
        command = (args or {}).get("command") if isinstance(args, dict) else None
        key = _redact_key(session_id, command)
        with _REDACT_LOCK:
            marked = _REDACT.pop(key, None) is not None
        if not marked:
            return None
        return _redact(result)
    except Exception:
        return "The output of this command was hidden because it may contain secrets."


def _steer_url(cfg):
    if cfg.get("steer_url"):
        return cfg["steer_url"]
    url = str(cfg.get("url") or "")
    return url[: -len("/gate")] + "/steer" if url.endswith("/gate") else None


def _is_agent(obj):
    return obj is not None and callable(getattr(obj, "steer", None)) and hasattr(obj, "_drain_pending_steer")


def _live_agent():
    """The agent whose turn this tool step belongs to: the top-level one only (a helper's steps don't take notes)."""
    agent = None
    try:
        from agent.subagent_lifecycle import get_active_subagent_parent
        agent = get_active_subagent_parent()
    except Exception:
        agent = None
    if not _is_agent(agent):
        agent = None
        f, n = sys._getframe(1), 0
        while f is not None and n < 80 and agent is None:
            for name in ("agent", "self", "parent_agent"):
                cand = f.f_locals.get(name)
                if _is_agent(cand):
                    agent = cand
                    break
            f, n = f.f_back, n + 1
    if agent is None:
        return None
    try:
        if int(getattr(agent, "_delegate_depth", 0) or 0) > 0:
            return None
    except Exception:
        pass
    return agent


def _steer(tool_name, args, session_id):
    """Hand the owner's waiting steering notes, if any, to Hermes' own agent.steer()."""
    try:
        cfg = _config()
        platforms = cfg.get("platforms")
        if platforms and _platform() not in platforms:
            return
        url = _steer_url(cfg)
        agent = _live_agent() if url else None
        if agent is None:
            return
        body = json.dumps({
            "tool": tool_name, "args": args if isinstance(args, dict) else {},
            "session_id": session_id or str(getattr(agent, "session_id", "") or ""),
        }).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"},
        )
        with _OPENER.open(req, timeout=3) as r:
            answer = json.loads(r.read().decode("utf-8"))
        text = answer.get("steer") if isinstance(answer, dict) else None
        if isinstance(text, str) and text.strip():
            agent.steer(text)
    except Exception:
        pass


def after_tool(tool_name="", args=None, session_id="", **_):
    """post_tool_call: a note sent during a long tool step is taken as soon as it ends."""
    _steer(tool_name, args, session_id)
    return None


def _block(message):
    return {"action": "block", "message": message}


def gate(tool_name="", args=None, session_id="", **_):
    _steer(tool_name, args, session_id)
    try:
        if any(tool_name.startswith(p) for p in _OWN):
            return None
        cfg = _config()
        # A Hermes shared with other front-ends (Telegram, the dashboard, cron) lists the platforms the
        # app's turns arrive on; everything else keeps Hermes' own approval rules.
        platforms = cfg.get("platforms")
        if platforms and _platform() not in platforms:
            return None
        payload = {"tool": tool_name, "args": args if isinstance(args, dict) else {}}
        danger = _findings(tool_name, payload["args"])
        if danger:
            payload["danger"] = danger
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            cfg["url"], data=body, method="POST",
            headers={"Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"},
        )
        with _human_wait(session_id):
            with _OPENER.open(req, timeout=float(cfg.get("timeout", 1560))) as r:
                answer = json.loads(r.read().decode("utf-8"))
        if isinstance(answer, dict) and answer.get("action") == "allow":
            if answer.get("redact"):
                _mark_redact(session_id, payload["args"].get("command"))
            return None
        msg = answer.get("message") if isinstance(answer, dict) else None
        return _block(str(msg or "Not allowed by the team app."))
    except Exception as e:  # fail closed
        return _block("The team app's approval check could not be reached, so this was not run (%s). Tell the user." % type(e).__name__)


def register(ctx):
    ctx.register_hook("pre_tool_call", gate)
    try:
        ctx.register_hook("post_tool_call", after_tool)
    except Exception:
        pass
    try:
        ctx.register_hook("transform_tool_result", redact_result)
    except Exception:
        pass
