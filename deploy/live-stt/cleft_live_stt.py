"""Live dictation text for YBots.

A WebSocket on 127.0.0.1 (never exposed): the Cleft server relays an app's microphone to it while
you dictate, and it answers with the words so far. Speech to text is Moonshine streaming (MIT,
github.com/moonshine-ai/moonshine), which keeps its work as you talk instead of starting over.

Protocol (ws://127.0.0.1:8790/live):
  client -> binary: 16 kHz mono 16-bit little-endian PCM, any size pieces
  client -> text:   {"type": "stop"}   finish: settle what is left, send "final", close
  server -> text:   {"type": "ready"}  once the stream is open
                    {"type": "text", "settled": "...", "pending": "..."}  whenever the words change
                    {"type": "final", "text": "..."}
                    {"type": "error", "message": "..."}
Nothing is written to disk: audio lives in memory for one dictation. Logs carry times and lengths only.
"""
import asyncio
import json
import logging
import os
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import websockets
from moonshine_voice import ModelArch, get_model_for_language
from moonshine_voice.transcriber import Transcriber

HOST = os.environ.get("LIVE_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("LIVE_STT_PORT", "8790"))
MODEL = os.environ.get("LIVE_STT_MODEL", "SMALL_STREAMING")
INTERVAL = float(os.environ.get("LIVE_STT_INTERVAL", "0.4"))
MAX_SESSIONS = int(os.environ.get("LIVE_STT_MAX_SESSIONS", "4"))
MAX_SECONDS = 150  # the apps stop at 120 s
RATE = 16000

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cleft-live-stt")

# One engine thread: passes from every dictation run one at a time, so a busy moment costs a little
# lag rather than all of Host2's cores.
engine = ThreadPoolExecutor(max_workers=1, thread_name_prefix="moonshine")
CACHE = os.environ.get("LIVE_STT_CACHE")
path, arch = get_model_for_language("en", ModelArch[MODEL], cache_root=Path(CACHE) if CACHE else None)
transcriber = Transcriber(model_path=path, model_arch=arch, update_interval=INTERVAL)
log.info("loaded %s from %s", MODEL, path)
active = 0


class Words:
    """The newest text of every line Moonshine has started in this dictation, in order."""

    def __init__(self):
        self.lines: dict[int, tuple[str, bool]] = {}

    def __call__(self, event):
        line = getattr(event, "line", None)
        if line is not None:
            self.lines[line.line_id] = (line.text.strip(), line.is_complete)

    def text(self):
        settled, pending = [], []
        for _, (t, done) in sorted(self.lines.items()):
            if t:
                (settled if done and not pending else pending).append(t)
        return " ".join(settled), " ".join(pending)


async def run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(engine, fn, *args)


async def session(ws):
    global active
    if ws.request.path.split("?")[0] != "/live":
        await ws.close(4404, "not found")
        return
    if active >= MAX_SESSIONS:
        await ws.send(json.dumps({"type": "error", "message": "Too many dictations at once."}))
        await ws.close(4429, "busy")
        return
    active += 1
    started = time.monotonic()
    samples = 0
    words = Words()
    stream = await run(lambda: transcriber.create_stream(update_interval=INTERVAL))
    stream.add_listener(words)
    last = None

    async def push(kind="text"):
        nonlocal last
        settled, pending = words.text()
        msg = {"type": "final", "text": " ".join(x for x in (settled, pending) if x)} if kind == "final" else {"type": "text", "settled": settled, "pending": pending}
        key = json.dumps(msg)
        if key != last:
            last = key
            await ws.send(key)

    try:
        await run(stream.start)
        await ws.send(json.dumps({"type": "ready"}))
        async for m in ws:
            if isinstance(m, (bytes, bytearray)):
                if len(m) % 2:
                    m = m[:-1]
                pcm = np.frombuffer(m, dtype="<i2").astype(np.float32) / 32768.0
                samples += len(pcm)
                if samples > MAX_SECONDS * RATE:
                    break
                await run(stream.add_audio, pcm.tolist(), RATE)
                await push()
            else:
                try:
                    if json.loads(m).get("type") == "stop":
                        break
                except ValueError:
                    pass
        else:
            return  # the client went away without "stop": nothing to finish
        await run(stream.stop)
        await push("final")
        await ws.close(1000, "done")
    except websockets.ConnectionClosed:
        pass
    except Exception as e:  # keep serving others
        log.exception("dictation failed")
        try:
            await ws.send(json.dumps({"type": "error", "message": str(e)[:200]}))
        except Exception:
            pass
    finally:
        try:
            await run(stream.close)
        except Exception:
            pass
        active -= 1
        log.info("dictation: %.1f s of audio in %.1f s", samples / RATE, time.monotonic() - started)


async def health(conn, request):
    if request.path == "/health":
        return conn.respond(200, json.dumps({"ok": True, "model": MODEL, "active": active}) + "\n")
    return None


async def main():
    stop = asyncio.get_running_loop().create_future()
    for s in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(s, stop.set_result, None)
    async with websockets.serve(session, HOST, PORT, max_size=1 << 20, process_request=health):
        log.info("listening on ws://%s:%d/live", HOST, PORT)
        await stop


if __name__ == "__main__":
    asyncio.run(main())
