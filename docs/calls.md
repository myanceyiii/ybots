# Phone calls to businesses

A bot can phone a business for you (prices, opening hours, a reservation) and come back with the transcript,
the recording and what it learned. The phone line is Telnyx; listening, speaking and thinking run on this
machine.

```
Cleft server ──POST /calls──> cleft-calls (127.0.0.1:8791) ──dial──> Telnyx ──phone line──> the business
                                     ^                                  │
                                     └── call audio over a WebSocket ───┘ (wss://calls.example.com/telnyx/media/<token>)

cleft-calls: Silero VAD -> Moonshine streaming speech to text -> POST /api/calls/think (local CPU model, else the
             bot's own model with every tool off)
             -> Phonon text to speech -> back to Telnyx
```

## What is built so far (test stage)

- `server/src/calls.ts`: `POST /api/calls/think`, the call brain. This machine only, with the call service key
  (HMAC of `SESSION_SECRET` with `cleft-calls`). One short spoken turn per request, written by the bot's own
  model with tools off. A walled-off (Sheldon) or outside bot gets no call brain. `CALLS=off` turns it off.
- `deploy/calls/cleft_calls.py`: the call service (Pipecat, BSD-2). Dials only numbers in `CALLS_ALLOWED_TO`.
  Each dial makes a one-time media token (2 minutes); the stream must belong to the call that dial started.
  Telnyx events are logged only. Recordings and transcripts: `/var/lib/cleft-calls/<id>.wav|.json`.
- Hosted call model (first choice): `CALLS_API_MODEL` + `CALLS_API_KEY` (+ `CALLS_API_URL`, default
  `https://api.deepseek.com`) in the server's `.env` send each turn to any OpenAI-compatible `/chat/completions`
  with JSON output on (Host2: DeepSeek `deepseek-flash`, thinking off). A turn that claims to be the person or
  repeats itself is retried once, then the local model, then the bot's own model.
- Local call model (backup): when the server's `.env` has `CALLS_LOCAL_MODEL` (Host2: `qwen2.5:1.5b`), each turn goes first
  to a small model on this machine's CPU (`cleft-call-llm.service`, Ollama on 127.0.0.1:11434, no tools at all,
  reply forced into the JSON turn with Ollama's `format`). Measured on Host2: 0.3-0.5 s to the first token and
  1-2 s per turn once loaded, against 5-6 s through Hermes. The call service calls `POST /api/calls/warm` right
  after dialing so the model is loaded (7-8 s) while the phone rings. If the local model fails, the bot's own
  model is used as before. Unset `CALLS_LOCAL_MODEL` to go back.
- `deploy/calls/install.sh`, `cleft-calls.service`, `cleft-call-llm.service`, `test-call.sh`.

- `place_call` (server/src/calls-place.ts, a bot tool): number, business, purpose, on whose behalf, max minutes
  (1-10). Each call shows an approval card with the number, who it is for, the first words and what will be
  asked. Only Allow on that card in the chat runs it: never Always allow, never from a notification. US numbers
  only (555, 900/976 and N11 refused). For businesses in all-party-consent states (CA, FL, WA, MD, MA, NH, PA,
  IL, CT, MT, NV by area code) the opening asks "Is that okay with you?" and the call ends on a no. The tool
  waits for the call to end and gives the bot the transcript and notes; the chat gets a notice with the
  transcript (web, Windows and Android show it as is). `CALLS_FOR_NAME` sets the default name said on calls.
  Walled-off and outside bots cannot call. `CALLS_ALLOWED_TO=*` in calls.env lets any US number through the
  service (the card is the gate); Telnyx's account level must also allow unverified numbers.

Still to come: a Calls screen with a live transcript and the recording on web, Android and Windows.

## Setup on Host2

1. `/etc/cleft-bot/calls/telnyx.env` with `TELNYX_API_KEY=` (root, 600).
2. `sudo TELNYX_CONNECTION_ID=<voice app id> CALLS_FROM=+1... CALLS_ALLOWED_TO=+1... bash deploy/calls/install.sh`
3. Publish only `/telnyx`: `tailscale serve --bg --https=8443 --set-path=/telnyx http://127.0.0.1:8791/telnyx`,
   and a Cloudflare tunnel rule `calls.example.com -> https://<Host2 tailnet address>:8443`
   (no Access app on that name; `/calls` is never published and also refuses anything forwarded).
4. Telnyx: the voice app's webhook is `https://calls.example.com/telnyx/events`. Its outbound profile
   allows US only, $5 a day, one call at a time.
5. Test: `sudo bash deploy/calls/test-call.sh <your number>`, then `--show <id>` for the transcript and timings
   (`first_audio_ms`: from the end of your sentence to the bot's first sound).

## Rules

US numbers only; no N11, 900/976 or 555 numbers. One call at a time. Every call opens by saying it is an AI
assistant and that the call is recorded. The bot never pays, gives card numbers or commits beyond its brief;
it says it will call back instead.
