#!/usr/bin/env python3
"""
A small local bridge that lets the app's "Generate" button make bot pictures with the ChatGPT sign-in
Hermes already has, through Hermes' own openai-codex image provider (plugins/image_gen/openai-codex).

It answers one OpenAI-style route on 127.0.0.1 only:
    POST /v1/images/generations  {"prompt": "...", "n": 1-8, "image": "data:image/...;base64,..." (optional)}
    -> {"data": [{"b64_json": "...", "mime": "image/jpeg"}, ...]}
    -> 422 {"error": {"message": "<the image service's own reason>"}} when nothing came back

`image` is a reference picture: the provider then uses its edit route, so the same character comes
back in a new pose or with a change (the app's look cards and pose sets). A Hermes too old to take a
reference answers 422 with a message saying so, rather than quietly drawing someone else.

Point the app at it with AVATAR_IMAGE_URL=http://127.0.0.1:8660/v1/images/generations.

Run it with Hermes' own Python and HERMES_HOME set to the Hermes home that is signed in to ChatGPT,
for example (as the user that owns that Hermes home):
    HERMES_HOME=/opt/hq/rehearsal/hermes-primary <hermes python> scripts/codex-image-bridge.py
No key is stored here: the provider reads Hermes' own sign-in each time.
"""
import base64
import importlib
import io
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_HOME = os.environ.get("HERMES_HOME")
if not HERMES_HOME:
    sys.exit("Set HERMES_HOME to the Hermes home that is signed in to ChatGPT.")
sys.path.insert(0, os.environ.get("HERMES_AGENT_DIR") or os.path.join(HERMES_HOME, "hermes-agent"))
PROVIDER = importlib.import_module("plugins.image_gen.openai-codex").OpenAICodexImageGenProvider()

PORT = int(os.environ.get("BRIDGE_PORT", "8660"))
SIDE = int(os.environ.get("BRIDGE_SIDE", "512"))  # pictures are shrunk to this many pixels a side
MAX_N = 8
WORKERS = int(os.environ.get("BRIDGE_WORKERS", "4"))  # pictures asked for at once
MAX_BODY = 8 * 1024 * 1024  # a reference picture is at most 2 MB, base64 makes it about 2.7


def shrink(raw: bytes) -> tuple[bytes, str]:
    """A small JPEG when Pillow is there (the app keeps pictures under 2 MB); the original otherwise."""
    try:
        from PIL import Image
    except ImportError:
        return raw, "image/png"
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img.thumbnail((SIDE, SIDE))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue(), "image/jpeg"


def one(job: tuple) -> dict:
    prompt, image = job
    try:
        r = PROVIDER.generate(prompt, "square", image_url=image) if image else PROVIDER.generate(prompt, "square")
    except TypeError as exc:
        if image and "image_url" in str(exc):
            return {"error": "This Hermes cannot start from a reference picture yet; update Hermes to use look changes and poses."}
        return {"error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # the provider normally returns errors, but never let one take the bridge down
        return {"error": f"{type(exc).__name__}: {exc}"}
    path = r.get("image") if isinstance(r, dict) else None
    if not path or not os.path.isfile(path):
        msg = (r.get("error") or r.get("message") or "no picture came back") if isinstance(r, dict) else "no picture came back"
        return {"error": str(msg)}
    try:
        with open(path, "rb") as f:
            data, mime = shrink(f.read())
    finally:
        try:
            os.remove(path)  # the provider caches every picture; the app keeps the one that is chosen
        except OSError:
            pass
    return {"b64_json": base64.b64encode(data).decode(), "mime": mime}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/v1/images/generations":
            return self._send(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY:
                return self._send(413, {"error": {"message": "request too large"}})
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {"error": {"message": "send JSON"}})
        prompt = str(body.get("prompt") or "").strip()
        if not prompt or len(prompt) > 4000:
            return self._send(400, {"error": {"message": "prompt must be 1 to 4000 characters"}})
        n = max(1, min(MAX_N, int(body.get("n") or 1)))
        image = body.get("image")
        if image is not None and not (isinstance(image, str) and image.startswith("data:image/")):
            return self._send(400, {"error": {"message": "image must be a data URL"}})
        with ThreadPoolExecutor(max_workers=min(n, WORKERS)) as pool:
            results = list(pool.map(one, [(prompt, image)] * n))
        data = [r for r in results if "b64_json" in r]
        failed = [r["error"] for r in results if "error" in r]
        if failed:  # the reason only, never the prompt
            sys.stderr.write("%d of %d pictures failed: %s\n" % (len(failed), n, failed[0][:300]))
        if not data:
            return self._send(422, {"error": {"message": results[0]["error"]}})
        try:
            self._send(200, {"data": data})
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write("the app hung up before the pictures were sent (it restarted or gave up)\n")

    def log_message(self, fmt: str, *args) -> None:  # one short line per request, never the prompt
        sys.stderr.write("%s %s\n" % (self.command, args[1] if len(args) > 1 else ""))


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
