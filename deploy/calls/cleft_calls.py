"""Phone calls for YBots (docs/calls.md).

A bot calls a business through Telnyx. Telnyx carries the phone line and streams the call's audio to this
service over a WebSocket; everything else runs on this machine:

  Telnyx audio -> Silero VAD -> speech to text (Speaches, local) -> call brain (Cleft server, the bot's own
  model with every tool off) -> Phonon text to speech (local) -> Telnyx audio

Endpoints (uvicorn on 127.0.0.1:8791; only /telnyx/* is published, through Tailscale Serve and the
Cloudflare tunnel at calls.example.com):
  POST /calls                  this machine only, Bearer CLEFT_CALLS_KEY. Dials one number.
  GET  /calls/{id}             this machine only. The call's record (status, transcript, timings).
  WS   /telnyx/media/{token}   Telnyx's audio stream. The token is made for one dial, works once, for 2 minutes,
                               and the stream's call_control_id must be the one that dial returned.
  POST /telnyx/events          Telnyx's call events. Logged only; nothing is done on their say-so.

Safety: only numbers in CALLS_ALLOWED_TO may be dialled ("*": any US number; each call is still allowed on a card in the app first). Telnyx's own
outbound profile also limits destinations, spend per day and calls at once. Recordings and transcripts stay in
/var/lib/cleft-calls. Logs carry times, lengths and ids, never what was said.
"""
import asyncio
import hmac
import json
import os
import secrets
import time
import wave
from pathlib import Path

import httpx
import numpy as np
import websockets
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    VADUserStartedSpeakingFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.telnyx import TelnyxFrameSerializer
from pipecat.services.openai import tts as openai_tts
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

TELNYX_API = "https://api.telnyx.com/v2"
TELNYX_KEY = os.environ.get("TELNYX_API_KEY", "")
CONNECTION_ID = os.environ.get("TELNYX_CONNECTION_ID", "")
FROM_NUMBER = os.environ.get("CALLS_FROM", "")
PUBLIC_WSS = os.environ.get("CALLS_PUBLIC_WSS", "wss://calls.example.com").rstrip("/")
CALLS_KEY = os.environ.get("CLEFT_CALLS_KEY", "")
CLEFT_URL = os.environ.get("CLEFT_URL", "http://127.0.0.1:8787").rstrip("/")
STT_URL = os.environ.get("CALLS_STT_URL", "http://127.0.0.1:8000/v1")
STT_MODEL = os.environ.get("CALLS_STT_MODEL", "Systran/faster-distil-whisper-small.en")
STT_ENGINE = os.environ.get("CALLS_STT", "moonshine")  # moonshine (live, streaming) or speaches (whisper, after each turn)
LIVE_STT_URL = os.environ.get("CALLS_LIVE_STT_URL", "ws://127.0.0.1:8790/live")
TTS_URL = os.environ.get("CALLS_TTS_URL", "http://127.0.0.1:8880/v1")
TTS_VOICE = os.environ.get("CALLS_TTS_VOICE", "Easton")
TTS_RATE = int(os.environ.get("CALLS_TTS_RATE", "24000"))
ALLOWED_TO = {n.strip() for n in os.environ.get("CALLS_ALLOWED_TO", "").split(",") if n.strip()}
MAX_SECONDS = int(os.environ.get("CALLS_MAX_SECONDS", "300"))
STATE = Path(os.environ.get("CALLS_STATE", "/var/lib/cleft-calls"))
TOKEN_TTL = 120
FORWARDING = ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via")

# Phonon's voices are not OpenAI's names; Pipecat's OpenAI speech service only refuses names it does not know.
openai_tts.VALID_VOICES.setdefault(TTS_VOICE, TTS_VOICE)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
calls: dict[str, dict] = {}  # call id -> record
tokens: dict[str, str] = {}  # media token -> call id


def now() -> float:
    return time.time()


def save(call: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    out = {k: v for k, v in call.items() if not k.startswith("_")}
    tmp = STATE / f"{call['id']}.json.tmp"
    tmp.write_text(json.dumps(out, indent=1))
    tmp.replace(STATE / f"{call['id']}.json")


def local_only(request: Request) -> None:
    """This machine, not passed on by a proxy, with the call service key."""
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1") or any(h in request.headers for h in FORWARDING):
        raise HTTPException(403, "forbidden")
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not CALLS_KEY or not hmac.compare_digest(given, CALLS_KEY):
        raise HTTPException(403, "forbidden")


def normalize(number: str) -> str:
    digits = "".join(ch for ch in number if ch.isdigit())
    if len(digits) == 10:
        digits = "1" + digits
    if len(digits) != 11 or not digits.startswith("1") or digits[1] in "01" or digits[4] in "01":
        raise HTTPException(400, "Only US numbers can be called.")
    if digits[4:7] == "555" or digits[1:4] in ("900", "976") or digits[1:4].endswith("11"):
        raise HTTPException(400, "That number can't be called.")
    return "+" + digits


async def telnyx(method: str, path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.request(method, f"{TELNYX_API}{path}", json=body,
                                 headers={"Authorization": f"Bearer {TELNYX_KEY}"})
    if r.status_code >= 300:
        raise HTTPException(502, f"Telnyx answered {r.status_code}: {r.text[:300]}")
    return r.json()


async def warm_brain(call: dict):
    """While the phone rings, have the server load the call model and read the instructions (first turn is then quick)."""
    try:
        async with httpx.AsyncClient(timeout=70) as client:
            r = await client.post(f"{CLEFT_URL}/api/calls/warm", headers={"Authorization": f"Bearer {CALLS_KEY}"},
                                  json={"bot": call["bot"], "brief": call["brief"]})
        call["warm"] = r.json() if r.status_code == 200 else {"ok": False, "status": r.status_code}
    except Exception as e:
        call["warm"] = {"ok": False, "error": type(e).__name__}


@app.post("/calls")
async def place_call(request: Request):
    local_only(request)
    body = await request.json()
    to = normalize(str(body.get("to", "")))
    if "*" not in ALLOWED_TO and to not in ALLOWED_TO:
        raise HTTPException(403, "That number is not on the allowed list.")
    if any(c["status"] in ("dialing", "ringing", "talking") for c in calls.values()):
        raise HTTPException(409, "A call is already on.")
    bot, brief = str(body.get("bot", "")).strip(), str(body.get("brief", "")).strip()
    opening = str(body.get("opening", "")).strip()
    if not (bot and brief and opening):
        raise HTTPException(400, "bot, brief and opening are needed")
    max_s = max(30, min(int(body.get("max_seconds", MAX_SECONDS)), MAX_SECONDS))
    call_id = secrets.token_hex(8)
    token = secrets.token_urlsafe(24)
    call = {"id": call_id, "to": to, "bot": bot, "brief": brief, "opening": opening, "status": "dialing",
            "created": now(), "max_seconds": max_s, "transcript": [], "turns": [], "notes": [], "events": [],
            "_token_expires": now() + TOKEN_TTL}
    calls[call_id] = call
    tokens[token] = call_id
    try:
        res = await telnyx("POST", "/calls", {
            "connection_id": CONNECTION_ID, "to": to, "from": FROM_NUMBER,
            "timeout_secs": 40, "time_limit_secs": max_s,
            "stream_url": f"{PUBLIC_WSS}/telnyx/media/{token}",
            "stream_track": "inbound_track",
            "stream_bidirectional_mode": "rtp",
            "stream_bidirectional_codec": "PCMU",
        })
    except HTTPException as e:
        # The dial never started: the call is over, so it can't block the next one.
        tokens.pop(token, None)
        call["status"] = "failed"
        call["error"] = str(e.detail)[:300]
        call["ended"] = now()
        save(call)
        raise
    call["call_control_id"] = res.get("data", {}).get("call_control_id")
    save(call)
    asyncio.create_task(warm_brain(call))
    logger.info(f"call {call_id}: dialing")
    return {"id": call_id, "status": call["status"]}


@app.get("/calls/{call_id}")
async def get_call(call_id: str, request: Request):
    local_only(request)
    call = calls.get(call_id)
    if not call:
        path = STATE / f"{call_id}.json"
        if not path.exists() or not call_id.isalnum():
            raise HTTPException(404, "no such call")
        return JSONResponse(json.loads(path.read_text()))
    return {k: v for k, v in call.items() if not k.startswith("_")}


@app.post("/telnyx/events")
async def telnyx_events(request: Request):
    # Logged only. Nothing here changes a call, so an unsigned or forged event can do no harm.
    try:
        data = (await request.json()).get("data", {})
        kind = str(data.get("event_type", ""))[:60]
        ccid = data.get("payload", {}).get("call_control_id")
        for call in calls.values():
            if ccid and call.get("call_control_id") == ccid:
                call["events"].append({"at": now(), "type": kind})
                if kind == "call.hangup" and call["status"] != "ended":
                    call["status"] = "ended"
                    call["ended"] = now()
                save(call)
        logger.info(f"telnyx event {kind}")
    except Exception:
        pass
    return {"ok": True}


class CallBrain(FrameProcessor):
    """What they said goes to the call brain; what it says comes back as speech, keys or a hang-up."""

    def __init__(self, call: dict, **kwargs):
        super().__init__(**kwargs)
        self.call = call
        self.busy = False
        self.pending: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.call["transcript"].append({"who": "them", "text": frame.text.strip(), "at": now()})
            self.pending.append(frame.text.strip())
            if not self.busy:
                asyncio.create_task(self.answer())
            return
        await self.push_frame(frame, direction)

    async def answer(self):
        self.busy = True
        try:
            while self.pending:
                self.pending.clear()
                started = now()
                async with httpx.AsyncClient(timeout=25) as client:
                    r = await client.post(f"{CLEFT_URL}/api/calls/think",
                                          headers={"Authorization": f"Bearer {CALLS_KEY}"},
                                          json={"bot": self.call["bot"], "brief": self.call["brief"],
                                                "transcript": [{"who": t["who"], "text": t["text"]} for t in self.call["transcript"]]})
                if r.status_code != 200:
                    # Never read an error out: a short apology, then hang up.
                    logger.warning(f"call {self.call['id']}: brain answered {r.status_code}")
                    reply = {"say": "Sorry, something went wrong on my end. I'll call back later. Goodbye.", "action": "hang_up"}
                else:
                    reply = r.json()
                self.call["turns"].append({"think_ms": round((now() - started) * 1000), "model_ms": reply.get("ms"), "at": now()})
                if reply.get("note"):
                    self.call["notes"].append(reply["note"])
                say = (reply.get("say") or "").strip()
                if say:
                    self.call["transcript"].append({"who": "bot", "text": say, "at": now()})
                    await self.push_frame(TTSSpeakFrame(say))
                if reply.get("action") == "press_keys" and reply.get("keys") and self.call.get("call_control_id"):
                    await telnyx("POST", f"/calls/{self.call['call_control_id']}/actions/send_dtmf", {"digits": reply["keys"]})
                if reply.get("action") == "hang_up":
                    self.call["status"] = "ending"
                    await self.push_frame(EndFrame())
                    return
        except Exception as e:
            logger.warning(f"call {self.call['id']}: brain failed: {type(e).__name__}")
        finally:
            self.busy = False
            save(self.call)


class MoonshineSTT(FrameProcessor):
    """Streams their speech to the live dictation service (Moonshine streaming) while they talk, so the words are
    ready the moment they stop instead of being transcribed afterwards. Audio is 8 kHz from the phone, sent as
    16 kHz; the half second before the VAD noticed speech is sent too, so first words are not cut."""

    PREROLL = 0.5

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.ws = None
        self.preroll: list[bytes] = []
        self.preroll_bytes = 0
        self.reader: asyncio.Task | None = None
        self.final: asyncio.Future | None = None

    @staticmethod
    def up16(pcm: bytes, rate: int) -> bytes:
        x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
        if rate == 16000 or not len(x):
            return pcm
        n = int(len(x) * 16000 / rate)
        y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
        return y.astype(np.int16).tobytes()

    async def open(self):
        try:
            self.ws = await websockets.connect(LIVE_STT_URL, max_size=2**20, open_timeout=2)
            loop = asyncio.get_running_loop()
            self.final = loop.create_future()
            self.reader = asyncio.create_task(self.read(self.ws, self.final))
            for chunk in self.preroll:
                await self.ws.send(chunk)
        except Exception as e:
            logger.warning(f"live speech service unavailable: {type(e).__name__}")
            self.ws = None

    async def read(self, ws, final: asyncio.Future):
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    m = json.loads(msg)
                    if m.get("type") == "final" and not final.done():
                        final.set_result(m.get("text", ""))
        except Exception:
            pass
        finally:
            if not final.done():
                final.set_result("")

    async def close(self) -> str:
        ws, final = self.ws, self.final
        self.ws = None
        if not ws or not final:
            return ""
        try:
            await ws.send(json.dumps({"type": "stop"}))
            return (await asyncio.wait_for(final, 3)).strip()
        except Exception:
            return ""
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            pcm = self.up16(frame.audio, frame.sample_rate)
            if self.ws:
                try:
                    await self.ws.send(pcm)
                except Exception:
                    self.ws = None
            else:
                self.preroll.append(pcm)
                self.preroll_bytes += len(pcm)
                while self.preroll and self.preroll_bytes > int(16000 * 2 * self.PREROLL):
                    self.preroll_bytes -= len(self.preroll.pop(0))
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            await self.open()
            self.preroll, self.preroll_bytes = [], 0
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            text = await self.close()
            await self.push_frame(frame, direction)
            if text:
                await self.push_frame(TranscriptionFrame(text=text, user_id="them", timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            return
        await self.push_frame(frame, direction)


class Timer(FrameProcessor):
    """Time from the end of their speech to the bot's first sound, per turn."""

    def __init__(self, call: dict, **kwargs):
        super().__init__(**kwargs)
        self.call = call
        self.stopped_at: float | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            self.stopped_at = now()
        elif isinstance(frame, TTSAudioRawFrame) and self.stopped_at:
            self.call.setdefault("first_audio_ms", []).append(round((now() - self.stopped_at) * 1000))
            self.stopped_at = None
        await self.push_frame(frame, direction)


@app.websocket("/telnyx/media/{token}")
async def media(websocket: WebSocket, token: str):
    call_id = tokens.pop(token, None)
    call = calls.get(call_id) if call_id else None
    if not call or now() > call.get("_token_expires", 0):
        await websocket.close(code=4403)
        return
    await websocket.accept()
    _, data = await parse_telephony_websocket(websocket)
    if not data.get("call_id") or data.get("call_id") != call.get("call_control_id"):
        logger.warning(f"call {call_id}: stream for a different call refused")
        await websocket.close(code=4403)
        return
    call["status"] = "talking"
    call["answered"] = now()
    serializer = TelnyxFrameSerializer(stream_id=data["stream_id"], call_control_id=data["call_id"],
                                       outbound_encoding=data.get("outbound_encoding") or "PCMU",
                                       inbound_encoding="PCMU", api_key=TELNYX_KEY)
    transport = FastAPIWebsocketTransport(websocket=websocket, params=FastAPIWebsocketParams(
        audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer))
    stt = MoonshineSTT() if STT_ENGINE == "moonshine" else OpenAISTTService(
        api_key="local", base_url=STT_URL, settings=OpenAISTTService.Settings(model=STT_MODEL))
    tts = OpenAITTSService(api_key="local", base_url=TTS_URL, sample_rate=TTS_RATE,
                           settings=OpenAITTSService.Settings(model="phonon", voice=TTS_VOICE))
    recorder = AudioBufferProcessor(sample_rate=8000, num_channels=1, auto_start_recording=True)
    timer = Timer(call)
    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=float(os.environ.get("CALLS_VAD_STOP", "0.5"))))),
        stt,
        CallBrain(call),
        tts,
        timer,
        transport.output(),
        recorder,
    ])
    task = PipelineTask(pipeline, params=PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000))

    @recorder.event_handler("on_audio_data")
    async def on_audio(_proc, audio: bytes, sample_rate: int, channels: int):
        STATE.mkdir(parents=True, exist_ok=True)
        with wave.open(str(STATE / f"{call_id}.wav"), "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(audio)
        call["recording"] = f"{call_id}.wav"

    @transport.event_handler("on_client_connected")
    async def on_connected(_t, _c):
        call["transcript"].append({"who": "bot", "text": call["opening"], "at": now()})
        await task.queue_frames([TTSSpeakFrame(call["opening"])])

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_t, _c):
        await task.cancel()

    try:
        await PipelineRunner(handle_sigint=False).run(task)
    finally:
        call["status"] = "ended"
        call.setdefault("ended", now())
        save(call)
        logger.info(f"call {call_id}: ended after {round(call['ended'] - call.get('answered', call['ended']))} s")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("CALLS_HOST", "127.0.0.1"), port=int(os.environ.get("CALLS_PORT", "8791")),
                log_level="warning", proxy_headers=False)
