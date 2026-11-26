# Voice and calls (no xAI)

The original Bot HQ used xAI's realtime voice model. This fork does voice with **a speech server on
your own machine** and **the bot's own agent** as the brain:

```
you talk ──> browser hears you stop ──> /api/voice/turn ──> speech-to-text (local) ──> message to the bot
                                                                                          │
you hear <── browser plays it <── /api/voice/speak <── text-to-speech (local) <── the bot's reply, sentence by sentence
```

So a call is the same bot as in the chat: same memory, connected apps, computer and approval cards.
What you say on a call shows up in the chat as your message (marked as said on a call), and its
replies show up as normal replies. Nothing goes to a voice service in the cloud. The only thing that
leaves the machine is what any message to the bot sends to its model (with Hermes signed in to
ChatGPT, that is OpenAI).

## Calling a bot, like a dot

- Press the voice button in the composer (when the box is empty), or **Start voice chat** in the bot's details panel.
- Just talk. When you pause, it sends what you said; the bot answers out loud.
- Talk over it to interrupt; it stops and listens.
- Long jobs: it says what it is about to do, and every half minute or so of silence it tells you it is
  still working (and in which app). Its result is read out when it lands.
- Something waiting for your OK (an email to send, an event to create) is read out. It waits on the
  screen, or, with `VOICE_APPROVALS=1`, you can answer on the call with a plain "yes" / "approve" or
  "no" / "cancel" (anything longer or less clear goes to the bot as a normal message).
- "Goodbye" or "hang up" ends the call. Each call leaves a record in the chat with its transcript.
- Replies to things you type during a call are read out too.

**On your phone:** open the app in the phone's browser and add it to the home screen. Browsers only
allow the microphone on HTTPS (or localhost), so reach the machine over HTTPS. The simplest private
way is Tailscale: `tailscale serve --bg 8787` on the machine gives it an HTTPS address on your tailnet;
set that address as `APP_URL`/`SERVER_URL` in `.env` (and in `PUBLIC_URL` when running the setup
script). The screen is kept awake while a call is on.

There is no phone number to dial. A real phone line needs a carrier (Twilio, Telnyx, ...) that carries
the call's audio through its cloud, which is what this setup avoids. If you want one later, the call
logic here can be put behind a SIP bridge; see "Later" below.

## The speech server

Anything that speaks the OpenAI audio API works. The setup script runs
[Speaches](https://speaches.ai) in Docker on `127.0.0.1:8000`: faster-whisper for speech-to-text and
Kokoro for text-to-speech, on the CPU. Settings in `.env`:

| Setting | Default | |
|---|---|---|
| `VOICE_URL` | `http://127.0.0.1:8000/v1` | Must be on this machine unless `VOICE_REMOTE=1`. |
| `VOICE_API_KEY` | | If your speech server wants one. |
| `VOICE_STT_MODEL` | `Systran/faster-distil-whisper-small.en` | English-only and quick. For other languages: `Systran/faster-whisper-small`. |
| `VOICE_TTS_ENGINE` | | `phonon` for Phonon (below); otherwise speech comes from Speaches/Kokoro. |
| `VOICE_TTS_URL` | `VOICE_URL` | Where speech is made, when that is a different server from the one that listens. |
| `VOICE_TTS_MODEL` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | (`phonon` with Phonon; its server ignores it.) |
| `VOICE_TTS_CONCURRENCY` | 2 with Phonon, else 4 | How many speech requests at once; the rest wait, calls before voice samples. |
| `VOICE_TTS_VOICE` | `af_heart` (`Easton` with Phonon) | Default voice; each bot can pick its own in its details panel. |
| `VOICE_TTS_VOICES` | what the speech server lists | Comma-separated, to offer only these. |
| `VOICE_SAMPLES_WARM` | on | `0` skips making every voice's sample in the background after start. |
| `VOICE_SAMPLE_DIR` | `data/voice-samples` | Where sample clips are kept. |
| `VOICE_APPROVALS` | off | `1` lets a spoken yes/no answer a waiting approval. |
| `VOICE` | on | `off` turns voice off. |

### Phonon (the call voice on Host2)

[Phonon](https://huggingface.co/gradium/phonon-40m-en) is a small text-to-speech model from Gradium
that runs on the CPU at about 6 to 7 times real time and **streams**: the first sound of a sentence is
ready in about 0.1 s, where Kokoro (as Speaches serves it) gives nothing until the whole sentence is made.
Speech-to-text stays on Speaches. Run Gradium's OpenAI-compatible server on this machine only:

```
docker run -d --name cleft-phonon --restart unless-stopped -p 127.0.0.1:8880:8880 \
  -e PTTS_MODEL=hf://gradium/phonon-40m-en -e PTTS_IGNORE_SPEED=true -e PTTS_MAX_CONCURRENT_REQUESTS=2 \
  -v phonon-cache:/home/phonon/.cache/huggingface ghcr.io/gradium-ai/ptts-openai-server:latest
```

and set `VOICE_TTS_ENGINE=phonon` and `VOICE_TTS_URL=http://127.0.0.1:8880/v1` in `.env`.

- **License.** The 40M models are CC BY-NC 4.0 (non-commercial). YBots is a personal,
  non-commercial project, so that is fine here; anyone using this commercially should use
  `phonon-31m-en` (Apache-2.0) instead. The voice catalog (`gradium/phonon-voices`) is Apache-2.0.
- **Download.** `phonon-40m-en` is gated: accept its terms on Hugging Face, then pass a read token
  (`HF_TOKEN`) for the first start only. Once it is in the `phonon-cache` volume, point `PTTS_MODEL` at
  the snapshot folder in the cache (`/home/phonon/.cache/huggingface/hub/models--gradium--phonon-40m-en/snapshots/<commit>`)
  so the server starts without the token or the network, and delete the token.
- **Voices.** 25 English voices (American and British) plus a few character voices. The server lists
  only names; the app labels and groups them. A bot that had a Kokoro voice is moved to a Phonon voice of
  the same gender and accent the first time the app starts with Phonon (Hadley, Easton, Maeve, Edwin;
  `VOICE_TTS_MAP_AF=...` and so on choose others).
- **Speed.** Phonon has one pace, so the Speed setting is hidden (the server offers only 1x).
- **Streaming.** `POST /api/voice/speak` with `stream: true` sends a WAV whose header says "length
  unknown", then the audio as it is made; the web app (and so Windows) and the Android app play each
  piece as it lands. Without `stream`, it is an ordinary WAV, as before.
- **Going back to Kokoro.** Remove the two settings and restart; bots then use the default Kokoro voice
  until one is picked again.

### Hearing a voice before you pick it

The voice list comes from the speech server itself (Speaches lists a speech model's voices at
`GET /v1/models/{model}`; with Kokoro that is 54 voices in nine languages), grouped by language in the
settings. Each voice has a play button: it plays that voice saying a short sentence in its own language
(`GET /api/voice/sample?voice=...`, MP3). A sample is made once and kept on disk next to the database,
so after the first time it costs nothing; about 30 seconds after the server starts it makes every
voice's sample at normal speed, one at a time, so the first tap is already instant. A voice the
speech server lists but cannot speak (on Host2, Kokoro's eight Chinese and five Japanese voices: that
Speaches can't phonemize either language) is left out of the list once its sample fails, until the app restarts. Clearing
`data/voice-samples` is safe; they are made again.

Model names change between Speaches versions; if the setup script says it could not download one,
look up the current names in the Speaches docs and set them in `.env`.

On a GPU, run Speaches' CUDA image instead and use a larger Whisper model for better accuracy.

## How it decides you have stopped talking

The browser listens for speech (by loudness, against a running estimate of the room's noise) and
sends what you said after 0.8 s of quiet. While the bot speaks it needs a louder voice to interrupt,
so its own voice coming out of the speakers does not cut it off. Headphones or a phone held to your
ear work best; on a laptop speaker in a noisy room, mute when you are not talking.

## Later

- **A phone number.** Being built: bots calling businesses through Telnyx, see [calls.md](calls.md).
- **A faster voice front.** A small local model could answer quick chit-chat itself and hand real work
  to the bot, like xAI's voice did, to cut the pause before simple answers.
