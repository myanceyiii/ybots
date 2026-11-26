// Voice, with local speech in place of xAI.
//
// Speech-to-text and text-to-speech come from speech servers you run yourself that speak the
// OpenAI audio API, on this machine: Speaches (faster-whisper) at VOICE_URL hears you, and the voice
// comes from VOICE_TTS_URL: Phonon (Gradium's ptts-openai-server) with VOICE_TTS_ENGINE=phonon, or
// Speaches' Kokoro when that is not set. Phonon streams, so a call can start playing a sentence
// about a tenth of a second after asking for it (POST /speak with stream: true).
// The thinking is done by the bot's own agent (Hermes, signed in to ChatGPT or a local model): on a
// call, every time you finish speaking, what you said becomes a message to the bot, and its replies
// are read back to you as they stream in. So a call is the same bot, with the same memory, apps,
// approvals and computer, just by voice; nothing goes to a voice service in the cloud.
//
// Routes (all under /api/voice):
//   GET  /options   voices, languages and speeds for the settings panel
//   POST /session   start a call: a call record in the chat, and the greeting to speak
//   POST /turn      one thing you said on a call (audio): transcribed, then sent to the bot
//   POST /speak     text -> audio (WAV), for the bot's replies; with stream: true the WAV is sent as it is made
//   POST /preview   the same, with the settings panel's sample sentence (kept once made)
//   GET  /sample    a voice saying its sample sentence (MP3), for the play button next to each voice
//   POST /stt       dictation in the composer
//   POST /end       end a call: the record gets its duration and transcript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db, now } from './db.js';
import { env, isLoopbackUrl } from './env.js';
import { newId } from './lib/ids.js';
import { currentSession, displayName, type AuthVars } from './lib/auth.js';
import { appendRow, emitBot, getBotRow } from './store.js';
import { ApprovalError, enqueue, resolveApproval } from './agent/loop.js';
import type { EventBody, MessageBody, VoiceCallRecord, VoiceOption } from './types.js';
import { liveSttUp } from './voiceLive.js';

export const voiceApi = new Hono<AuthVars>();

// ---------- the speech server ----------

const voiceUrl = process.env.VOICE_URL ?? 'http://127.0.0.1:8000/v1';
const ttsUrl = process.env.VOICE_TTS_URL || voiceUrl;
/** 'phonon': Gradium's ptts-openai-server (streams; voices by name; no speed control). Otherwise Speaches/Kokoro. */
const ttsEngine: 'phonon' | 'openai' = process.env.VOICE_TTS_ENGINE === 'phonon' ? 'phonon' : 'openai';

const speech = {
  url: voiceUrl.replace(/\/+$/, ''),
  key: process.env.VOICE_API_KEY ?? '',
  sttModel: process.env.VOICE_STT_MODEL ?? 'Systran/faster-distil-whisper-small.en',
  /** Where speech is made, and how. */
  ttsUrl: ttsUrl.replace(/\/+$/, ''),
  ttsKey: process.env.VOICE_TTS_API_KEY ?? process.env.VOICE_API_KEY ?? '',
  engine: ttsEngine,
  ttsModel: process.env.VOICE_TTS_MODEL ?? (ttsEngine === 'phonon' ? 'phonon' : 'speaches-ai/Kokoro-82M-v1.0-ONNX'),
  defaultVoice: process.env.VOICE_TTS_VOICE ?? (ttsEngine === 'phonon' ? 'Easton' : 'af_heart'),
  /** VOICE=off turns voice off entirely. */
  off: process.env.VOICE === 'off',
  /** Audio would leave this machine; refused unless VOICE_REMOTE=1. */
  remoteRefused: (!isLoopbackUrl(voiceUrl) || !isLoopbackUrl(ttsUrl)) && process.env.VOICE_REMOTE !== '1',
  /** Approve or cancel a waiting action by saying so on a call. Off unless VOICE_APPROVALS=1. */
  approvals: process.env.VOICE_APPROVALS === '1',
};
/** Phonon has no rate control: it always speaks at its natural pace. */
const speedWorks = speech.engine !== 'phonon';

voiceApi.use('*', async (c, next) => {
  if (speech.off) return c.json({ error: 'Voice is turned off (VOICE=off).' }, 503);
  if (speech.remoteRefused) return c.json({ error: `VOICE_URL ${speech.url} or VOICE_TTS_URL ${speech.ttsUrl} is not on this machine; set VOICE_REMOTE=1 only if sending audio there is acceptable.` }, 503);
  await next();
});

const authHeaders = (): Record<string, string> => (speech.key ? { Authorization: `Bearer ${speech.key}` } : {});
const ttsHeaders = (): Record<string, string> => (speech.ttsKey ? { Authorization: `Bearer ${speech.ttsKey}` } : {});

class SpeechError extends Error {}
/** The speech server is up but could not speak with this voice. */
class VoiceBroken extends SpeechError {}

async function transcribe(file: Blob, filename: string, language?: string): Promise<string> {
  const out = new FormData();
  out.append('model', speech.sttModel);
  out.append('response_format', 'json');
  if (language && language !== 'auto' && /^[a-z]{2}$/.test(language)) out.append('language', language);
  out.append('file', file, filename);
  const r = await fetch(`${speech.url}/audio/transcriptions`, { method: 'POST', headers: authHeaders(), body: out, signal: AbortSignal.timeout(60_000) })
    .catch((e) => { throw new SpeechError(`The speech server at ${speech.url} did not answer (${e?.message ?? e}).`); });
  if (!r.ok) throw new SpeechError(`Transcription failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = (await r.json().catch(() => ({}))) as { text?: string };
  return String(j.text ?? '').trim();
}

// ---------- making speech ----------

/**
 * Speech requests take turns: Phonon makes a set number at once (PTTS_MAX_CONCURRENT_REQUESTS, and
 * HTTP 429 past that), and a call's next sentence should not wait behind the voice samples being made
 * in the background. So requests queue here, calls first. VOICE_TTS_CONCURRENCY sets how many at once.
 */
const ttsSlots = Math.max(1, Number(process.env.VOICE_TTS_CONCURRENCY ?? (speech.engine === 'phonon' ? 2 : 4)) || 1);
let ttsBusy = 0;
const ttsWaiting: { low: boolean; go: () => void }[] = [];
function ttsTurn(low: boolean): Promise<() => void> {
  let freed = false;
  const release = () => {
    if (freed) return;
    freed = true;
    ttsBusy--;
    const i = ttsWaiting.findIndex((w) => !w.low);
    const next = ttsWaiting.splice(i >= 0 ? i : 0, 1)[0];
    if (next) { ttsBusy++; next.go(); }
  };
  if (ttsBusy < ttsSlots && (low ? !ttsWaiting.length : !ttsWaiting.some((w) => !w.low))) { ttsBusy++; return Promise.resolve(release); }
  return new Promise((resolve) => ttsWaiting.push({ low, go: () => resolve(release) }));
}

/** POST /audio/speech, retrying briefly when the speech server says it is busy (429). */
async function speechRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${speech.ttsUrl}/audio/speech`, {
      method: 'POST',
      headers: { ...ttsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    }).catch((e) => { throw new SpeechError(`The speech server at ${speech.ttsUrl} did not answer (${e?.message ?? e}).`); });
    if (r.status === 429 && attempt < 20) { await r.body?.cancel().catch(() => {}); await new Promise((ok) => setTimeout(ok, 150)); continue; }
    if (!r.ok) throw new SpeechError(`Speech failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r;
  }
}

/** Phonon's raw audio: 16-bit mono at 24 kHz. */
const PCM_RATE = 24_000;

/** A 44-byte WAV header for 16-bit mono PCM. dataBytes 0xffffffff: length not known yet (the audio is still being made). */
export function wavHeader(dataBytes: number, rate = PCM_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(dataBytes >= 0xffffffff - 36 ? 0xffffffff : 36 + dataBytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(Math.min(dataBytes, 0xffffffff), 40);
  return h;
}

function speechBody(text: string, voice: string, speed: number, format: string) {
  // Phonon has one pace; the container runs with PTTS_IGNORE_SPEED, and 1 is sent anyway.
  return { model: speech.ttsModel, input: text, voice, speed: speedWorks ? speed : 1, response_format: format };
}

async function synthesize(text: string, voice: string, speed: number, format: 'wav' | 'mp3' = 'wav', low = false): Promise<Buffer> {
  const release = await ttsTurn(low);
  try {
    // Phonon's own WAV is written for streaming (no length in its header), so ask for raw audio and add a proper header.
    const pcm = speech.engine === 'phonon' && format === 'wav';
    const r = await speechRequest(speechBody(text, voice, speed, pcm ? 'pcm' : format));
    // A voice the server can't speak (e.g. Kokoro's Chinese voices without a Chinese phonemizer) can
    // answer 200 and then cut the body off, or send nothing.
    const buf = await r.arrayBuffer().catch((e) => { throw new VoiceBroken(`The speech server stopped partway (${e?.message ?? e}).`); });
    if (!buf.byteLength) throw new VoiceBroken('The speech server sent no audio.');
    if (!pcm) return Buffer.from(buf);
    const data = Buffer.from(buf, 0, buf.byteLength & ~1);
    return Buffer.concat([wavHeader(data.length), data]);
  } finally {
    release();
  }
}

/**
 * Speech as it is made: a WAV whose header says "length unknown", then the audio in pieces as the
 * speech server sends them. Only Phonon streams; with Kokoro this is the finished WAV in one piece.
 */
async function synthesizeStream(text: string, voice: string, speed: number, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (speech.engine !== 'phonon') {
    const wav = await synthesize(text, voice, speed);
    return new ReadableStream({ start(c) { c.enqueue(new Uint8Array(wav)); c.close(); } });
  }
  const release = await ttsTurn(false);
  let r: Response;
  try { r = await speechRequest(speechBody(text, voice, speed, 'pcm'), signal); } catch (e) { release(); throw e; }
  const reader = r.body!.getReader();
  let odd: number | null = null; // a byte left over, so every piece holds whole samples
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(wavHeader(0xffffffff))); },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { release(); c.close(); return; }
        let bytes = value;
        if (odd !== null) { const b = new Uint8Array(bytes.length + 1); b[0] = odd; b.set(bytes, 1); bytes = b; odd = null; }
        if (bytes.length & 1) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
        if (bytes.length) c.enqueue(bytes);
      } catch (e) { release(); c.error(e); }
    },
    cancel() { release(); void reader.cancel().catch(() => {}); },
  });
}

const speechFailed = (c: any, e: unknown) => {
  const msg = e instanceof SpeechError ? e.message : 'Voice failed';
  console.warn('[voice]', (e as Error)?.message ?? e);
  return c.json({ error: msg }, 502);
};

// ---------- voices / languages ----------

/** Kokoro's voices (the default speech model), used until the speech server has said which it has. */
const KOKORO: [string, string, string][] = [
  ['af_heart', 'female', 'en-us'], ['af_bella', 'female', 'en-us'], ['af_nicole', 'female', 'en-us'], ['af_sarah', 'female', 'en-us'],
  ['af_sky', 'female', 'en-us'], ['am_adam', 'male', 'en-us'], ['am_michael', 'male', 'en-us'], ['am_fenrir', 'male', 'en-us'],
  ['am_puck', 'male', 'en-us'], ['bf_emma', 'female', 'en-gb'], ['bf_isabella', 'female', 'en-gb'],
  ['bm_george', 'male', 'en-gb'], ['bm_lewis', 'male', 'en-gb'],
];

/** Kokoro voice ids start with a letter for the language: a = American English, b = British, and so on. */
const KOKORO_LANG: Record<string, { lang: string; group: string; tag: string }> = {
  a: { lang: 'en-us', group: 'American English', tag: '' },
  b: { lang: 'en-gb', group: 'British English', tag: 'British' },
  e: { lang: 'es', group: 'Spanish', tag: 'Spanish' },
  f: { lang: 'fr-fr', group: 'French', tag: 'French' },
  h: { lang: 'hi', group: 'Hindi', tag: 'Hindi' },
  i: { lang: 'it', group: 'Italian', tag: 'Italian' },
  j: { lang: 'ja', group: 'Japanese', tag: 'Japanese' },
  p: { lang: 'pt-br', group: 'Brazilian Portuguese', tag: 'Portuguese' },
  z: { lang: 'zh', group: 'Mandarin Chinese', tag: 'Chinese' },
};

/** "bf_emma" -> Emma (British), in the British English group. Other ids are shown as they are. */
export function describeVoice(id: string, gender?: string, language?: string): VoiceOption {
  const m = /^([a-z])([fm])_([a-z0-9]+)$/.exec(id);
  const k = m ? KOKORO_LANG[m[1]] : undefined;
  if (!m || !k) return { id, name: id, ...(gender ? { gender } : {}), ...(language ? { language } : {}) };
  const first = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  return { id, name: k.tag ? `${first} (${k.tag})` : first, gender: gender ?? (m[2] === 'f' ? 'female' : 'male'), language: language ?? k.lang, group: k.group };
}

/**
 * Phonon's English voices (from Gradium's voice catalog, gradium/phonon-voices, Apache-2.0): gender
 * and accent, so they can be grouped and labelled. The server only lists names; one not here is shown
 * as it is.
 */
const PHONON: Record<string, [gender: string, lang: string]> = {
  Zoey: ['female', 'en-us'], Juniper: ['female', 'en-us'], Everly: ['female', 'en-us'], Harper: ['female', 'en-us'],
  Hadley: ['female', 'en-us'], Delia: ['female', 'en-us'], Easton: ['male', 'en-us'], Micah: ['male', 'en-us'],
  Trevor: ['male', 'en-us'], Russell: ['male', 'en-us'], Preston: ['male', 'en-us'], Miles: ['male', 'en-us'],
  Maeve: ['female', 'en-gb'], Freya: ['female', 'en-gb'], Pippa: ['female', 'en-gb'], 'Elodie-Rose': ['female', 'en-gb'],
  Imogen: ['female', 'en-gb'], Lottie: ['female', 'en-gb'], Bryony: ['female', 'en-gb'], Alfie: ['male', 'en-gb'],
  Hugh: ['male', 'en-gb'], Edwin: ['male', 'en-gb'], Spencer: ['male', 'en-gb'], Toby: ['male', 'en-gb'], Teddy: ['male', 'en-gb'],
};

/** A Phonon voice: Hadley (American English), Maeve (British), or a character voice (a wizard, a dragon...). */
export function describePhononVoice(id: string): VoiceOption {
  const k = PHONON[id];
  if (!k) return { id, name: id, language: 'en', group: 'Character voices' };
  const british = k[1] === 'en-gb';
  return { id, name: british ? `${id} (British)` : id, gender: k[0], language: k[1], group: british ? 'British English' : 'American English' };
}

/**
 * A bot's saved voice from before Phonon (a Kokoro id such as af_heart or bm_george) becomes a Phonon
 * voice of the same gender and accent, until a voice is picked again in its settings.
 */
export function phononFor(oldId: string): string | null {
  const m = /^([ab])([fm])_/.exec(oldId);
  if (!m) return null;
  const pick = { af: 'Hadley', am: 'Easton', bf: 'Maeve', bm: 'Edwin' }[`${m[1]}${m[2]}`]!;
  return process.env[`VOICE_TTS_MAP_${m[1]}${m[2]}`.toUpperCase()] ?? pick;
}

/** What the speech server says it has, refreshed every 10 minutes. */
let served: { at: number; voices: VoiceOption[] } | null = null;
let refreshing: Promise<void> | null = null;

async function refreshVoices(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (speech.engine === 'phonon') {
        // Phonon lists voice names at GET /v1/audio/voices -> { voices: [...] } ("default" is an alias, not a voice).
        const r = await fetch(`${speech.ttsUrl}/audio/voices`, { headers: ttsHeaders(), signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { voices?: unknown[] };
        const ids = (j.voices ?? []).map((v) => String(typeof v === 'string' ? v : (v as any)?.name ?? (v as any)?.id ?? '')).filter((v) => v && v !== 'default');
        if (!ids.length) throw new Error('no voices listed');
        // People's voices first (American, then British), then the character voices.
        const rank = (v: VoiceOption) => (v.group === 'American English' ? 0 : v.group === 'British English' ? 1 : 2);
        served = { at: Date.now(), voices: ids.map(describePhononVoice).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)) };
        return;
      }
      // Speaches lists a speech model's voices on the model (GET /v1/models/{id} -> voices[]).
      const r = await fetch(`${speech.ttsUrl}/models/${speech.ttsModel}`, { headers: ttsHeaders(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { voices?: { id?: string; name?: string; gender?: string; language?: string }[] };
      const list = (j.voices ?? []).map((v) => String(v.id ?? v.name ?? '')).filter(Boolean);
      if (!list.length) throw new Error('no voices listed');
      const byId = new Map((j.voices ?? []).map((v) => [String(v.id ?? v.name), v]));
      served = { at: Date.now(), voices: list.map((id) => describeVoice(id, byId.get(id)?.gender, byId.get(id)?.language)) };
    } catch (e) {
      // Keep the last good list (or the built-in one) and try again later.
      if (!served) console.warn('[voice] could not list the speech server\'s voices:', (e as Error)?.message ?? e);
      served = { at: Date.now(), voices: served?.voices ?? [] };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Voices the speech server lists but could not speak with (found by the sample warm-up); not offered. */
const broken = new Set<string>();
/**
 * The list is kept beside the samples for a week, so a restart neither offers those voices again for its
 * first half minute nor tries each of them again (one failed request and one log line apiece, every restart).
 */
const BROKEN_KEEP_MS = 7 * 24 * 60 * 60_000;
const brokenFile = () => path.join(process.env.VOICE_SAMPLE_DIR ?? path.join(path.dirname(env.dbPath), 'voice-samples'), 'cannot-speak.json');
try {
  const kept = JSON.parse(fs.readFileSync(brokenFile(), 'utf8')) as { at?: number; ids?: unknown };
  if (typeof kept.at === 'number' && Date.now() - kept.at < BROKEN_KEEP_MS && Array.isArray(kept.ids)) for (const id of kept.ids) if (typeof id === 'string') broken.add(id);
} catch { /* no list yet */ }

function voiceList(): VoiceOption[] {
  return allVoices().filter((v) => !broken.has(v.id));
}

function allVoices(): VoiceOption[] {
  const custom = (process.env.VOICE_TTS_VOICES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (custom.length) return custom.map((id) => (speech.engine === 'phonon' ? describePhononVoice(id) : describeVoice(id)));
  if (!served || Date.now() - served.at > 10 * 60_000) void refreshVoices();
  if (served?.voices.length) return served.voices;
  if (speech.engine === 'phonon') return Object.keys(PHONON).map(describePhononVoice);
  return KOKORO.map(([id, gender, language]) => describeVoice(id, gender, language));
}

// ---------- voice samples (the play buttons in the settings) ----------

/** The sample sentence, in the voice's own language so it sounds right. */
export function sampleText(v: VoiceOption): string {
  const first = v.name.replace(/\s*\(.*\)$/, '');
  const lang = (v.language ?? 'en').toLowerCase();
  if (lang.startsWith('es')) return `Hola, soy ${first}. Así es como sonaré cuando hablemos.`;
  if (lang.startsWith('fr')) return `Bonjour, je suis ${first}. Voici ma voix quand nous parlerons.`;
  if (lang.startsWith('it')) return `Ciao, sono ${first}. Ecco come suonerò quando parleremo.`;
  if (lang.startsWith('pt')) return `Olá, eu sou ${first}. É assim que vou soar quando conversarmos.`;
  if (lang.startsWith('hi')) return `नमस्ते, मैं ${first} हूँ। जब हम बात करेंगे, तो मेरी आवाज़ ऐसी होगी।`;
  if (lang.startsWith('ja')) return 'こんにちは。私たちが話すとき、私の声はこんな感じです。';
  if (lang.startsWith('zh')) return '你好！我们聊天的时候，我的声音就是这样的。';
  return `Hi, I'm ${first}. This is how I'll sound when we talk.`;
}

/** Clips already made are kept on disk, so a preview costs nothing after the first time. */
const sampleDir = process.env.VOICE_SAMPLE_DIR ?? path.join(path.dirname(env.dbPath), 'voice-samples');
const making = new Map<string, Promise<Buffer>>();

/** Speech for (text, voice, speed), from the disk cache or made once (callers asking at the same time share it). */
async function cachedSpeech(text: string, voice: string, speed: number, format: 'mp3' | 'wav', low = false): Promise<Buffer> {
  if (!speedWorks) speed = 1;
  const key = crypto.createHash('sha256').update(JSON.stringify([speech.ttsUrl, speech.engine, speech.ttsModel, voice, speed, format, text])).digest('hex').slice(0, 32);
  const file = path.join(sampleDir, `${key}.${format}`);
  try {
    const kept = await fs.promises.readFile(file);
    if (kept.length) return kept; // an empty file (kept by an earlier version) is made again
  } catch { /* not made yet */ }
  const pending = making.get(key);
  if (pending) return pending;
  const job = synthesize(text, voice, speed, format, low).then(async (buf) => {
    try {
      await fs.promises.mkdir(sampleDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    } catch (e) { console.warn('[voice] could not keep a voice sample:', (e as Error)?.message ?? e); }
    return buf;
  }).finally(() => making.delete(key));
  making.set(key, job);
  return job;
}

/** Sample speeds are the settings' speeds, so the cache stays small. */
const sampleSpeed = (s: unknown) => {
  const n = clampSpeed(s);
  return SPEEDS.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), 1);
};

/**
 * Make every voice's sample at normal speed in the background, one at a time, so the first tap on a
 * play button is already instant. VOICE_SAMPLES_WARM=0 turns this off.
 */
/**
 * With Phonon, bots that still have a Kokoro voice saved (af_heart, bm_george...) are moved to the
 * Phonon voice phononFor() picks, so the settings show the voice they actually speak with.
 */
export function moveToPhononVoices(): number {
  if (speech.engine !== 'phonon') return 0;
  let moved = 0;
  const rows = db.prepare("SELECT id, voice FROM bots WHERE voice GLOB '[ab][fm]_*'").all() as { id: string; voice: string }[];
  for (const r of rows) {
    const to = phononFor(r.voice);
    if (to) { db.prepare('UPDATE bots SET voice=? WHERE id=?').run(to, r.id); moved++; }
  }
  if (moved) console.log(`[voice] moved ${moved} bot${moved === 1 ? '' : 's'} from Kokoro voices to Phonon voices`);
  return moved;
}

export function warmVoiceSamples(delayMs = Number(process.env.VOICE_SAMPLES_WARM_DELAY_MS ?? 30_000)): void {
  try { moveToPhononVoices(); } catch (e) { console.warn('[voice] could not move bots to Phonon voices:', (e as Error)?.message ?? e); }
  if (speech.off || speech.remoteRefused || process.env.VOICE_SAMPLES_WARM === '0') return;
  setTimeout(async () => {
    await refreshVoices();
    let made = 0;
    let found = false;
    for (const v of voiceList()) {
      try { await cachedSpeech(sampleText(v), v.id, 1, 'mp3', true); made++; }
      catch (e) {
        // One voice that can't speak is left out of the list; a server that isn't answering stops the warm-up.
        if (e instanceof VoiceBroken) { broken.add(v.id); found = true; console.warn(`[voice] ${v.id} can't speak on this speech server, so it is not offered:`, e.message); continue; }
        console.warn('[voice] sample warm-up stopped:', (e as Error)?.message ?? e); return;
      }
    }
    if (found) {
      try { await fs.promises.mkdir(path.dirname(brokenFile()), { recursive: true }); await fs.promises.writeFile(brokenFile(), JSON.stringify({ at: Date.now(), ids: [...broken] })); }
      catch (e) { console.warn('[voice] could not keep the list of voices that cannot speak:', (e as Error)?.message ?? e); }
    }
    console.log(`[voice] ${made} voice samples ready${broken.size ? `; left out ${broken.size} that can't speak here (${[...broken].join(', ')})` : ''}`);
  }, delayMs).unref();
}

/** Languages Whisper takes as a hint; "auto" lets it detect. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' }, { code: 'it', name: 'Italian' }, { code: 'pt', name: 'Portuguese' }, { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' }, { code: 'ko', name: 'Korean' }, { code: 'vi', name: 'Vietnamese' }, { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' }, { code: 'ru', name: 'Russian' },
];
export const SPEEDS = [0.7, 0.85, 1, 1.15, 1.3, 1.5];

const clampSpeed = (s: unknown) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(1.5, Math.max(0.7, n)) : 1;
};

/** The bot's voice settings; a voice the speech server does not have (e.g. an old xAI one) falls back to the default. */
function settingsOf(bot: any) {
  const voices = voiceList();
  const saved = String(bot?.voice ?? '');
  const mapped = speech.engine === 'phonon' && saved ? phononFor(saved) : null;
  const voice = voices.some((v) => v.id === saved) ? saved : mapped && voices.some((v) => v.id === mapped) ? mapped : speech.defaultVoice;
  const language = LANGUAGES.some((l) => l.code === bot?.voice_language) ? String(bot.voice_language) : 'auto';
  return { voice, speed: clampSpeed(bot?.voice_speed ?? 1), language };
}

function ownBot(userId: string, botId: string | undefined) {
  if (!botId) return null;
  const b = getBotRow(botId);
  return b && b.user_id === userId ? b : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstName = (userId: string) => String((db.prepare('SELECT name FROM users WHERE id=?').get(userId) as any)?.name ?? '').split(/\s+/)[0];

// speeds: [1] when the voice has one pace (Phonon), and the apps leave the Speed setting out.
voiceApi.get('/options', async (c) => c.json({ live: await liveSttUp(), voices: voiceList(), languages: LANGUAGES, speeds: speedWorks ? SPEEDS : [1], defaultVoice: speech.defaultVoice, approvalsByVoice: speech.approvals, engine: speech.engine, streams: speech.engine === 'phonon' }));

// ---------- calls ----------

interface ActiveCall { id: string; botId: string; userId: string; startedAt: number; requests: string[] }
const calls = new Map<string, ActiveCall>();

function callEvent(text: string, call: VoiceCallRecord): EventBody {
  return { type: 'event', event: 'voice-call', text, ref: call.id, call };
}

const fmtDuration = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

voiceApi.post('/session', async (c) => {
  const user = c.get('user');
  const { botId } = await c.req.json<{ botId: string }>().catch(() => ({ botId: '' }));
  const bot = ownBot(user.id, botId);
  if (!bot) return c.json({ error: 'not found' }, 404);
  // A group has no voice of its own: its members answer in the chat, and nobody would speak on a call.
  if (bot.kind === 'room') return c.json({ error: 'Voice chat is with one Bot at a time. Open a Bot to call it.' }, 400);
  const s = settingsOf(bot);
  const callId = newId('call');
  const startRow = appendRow(bot.id, 'event', callEvent(`Voice call with ${bot.name} started`, { id: callId, phase: 'started' }));
  calls.set(callId, { id: callId, botId: bot.id, userId: user.id, startedAt: now(), requests: [] });
  emitBot(bot.id);
  const name = firstName(user.id);
  return c.json({
    callId,
    startSeq: startRow.seq,
    voice: s.voice,
    speed: s.speed,
    language: s.language,
    greeting: `Hi${name ? ` ${name}` : ''}, it's ${bot.name}. What can I do?`,
    approvalsByVoice: speech.approvals,
  });
});

/**
 * A short spoken answer to a waiting approval (only with VOICE_APPROVALS=1): "yes", "approve it",
 * "go ahead, send it" approve; "no", "cancel that", "don't" decline. Anything longer or less clear is
 * an ordinary message to the bot.
 */
export function spokenDecision(text: string): 'allow' | 'deny' | null {
  const words = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return null;
  const yes = new Set(['yes', 'yeah', 'yep', 'sure', 'approve', 'approved', 'go', 'ahead', 'do', 'it', 'send', 'confirm', 'confirmed', 'please', 'okay', 'ok']);
  const no = new Set(['no', 'nope', "don't", 'dont', 'do', 'not', 'cancel', 'stop', 'deny', 'reject', 'decline', 'it', 'that', 'please']);
  const starts = (set: string[]) => set.includes(words[0]);
  if (starts(['yes', 'yeah', 'yep', 'sure', 'approve', 'approved', 'go', 'do', 'send', 'confirm', 'confirmed', 'okay', 'ok']) && words.every((w) => yes.has(w))) return 'allow';
  if (starts(['no', 'nope', "don't", 'dont', 'do', 'cancel', 'stop', 'deny', 'reject', 'decline']) && words.every((w) => no.has(w)) && !(words[0] === 'do' && words[1] !== 'not')) return 'deny';
  return null;
}

voiceApi.post('/turn', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData().catch(() => null);
  const bot = ownBot(user.id, String(form?.get('botId') ?? ''));
  if (!bot) return c.json({ error: 'not found' }, 404);
  const callId = String(form?.get('callId') ?? '');
  const call = calls.get(callId);
  if (!call || call.botId !== bot.id) return c.json({ error: 'call not found' }, 404);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'too long' }, 413);

  let text: string;
  try { text = await transcribe(file, 'turn.wav', settingsOf(bot).language); } catch (e) { return speechFailed(c, e); }
  // Whisper hears words in silence and noise; a lone filler is not a request.
  if (!text || /^[\s.,!?…-]*$/.test(text) || /^(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|uh+|um+|hmm+)[\s.!]*$/i.test(text)) return c.json({ text: '' });

  // "Goodbye" ends the call; the bot is not asked anything.
  if (/^(ok(ay)?,? )?(bye|goodbye|bye bye|hang up|end (the )?call|that'?s all( for now)?|talk (to you )?later)[\s.!,]*(thanks?( you)?)?[\s.!]*$/i.test(text)) return c.json({ text, action: 'hangup' });

  // A spoken yes or no answers the action that is waiting for approval, when that is turned on.
  // A script signed in to the account can never answer a card, by voice or otherwise.
  const decision = speech.approvals && !c.get('agent') ? spokenDecision(text) : null;
  if (decision) {
    // The answer counts only for the card the call read out before you started speaking (the page
    // sends its id and digest), and only while that is the one card waiting. Anything else is sent
    // back to the screen rather than guessed at: a newer card, a delayed transcription or a second
    // waiting action must never be approved by a "yes" meant for something else.
    const waiting = db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").all(bot.id) as { id: string }[];
    const approvalId = String(form?.get('approvalId') ?? '');
    const digest = String(form?.get('digest') ?? '');
    if (approvalId || waiting.length) {
      const review = (reason: string) => c.json({ text, action: 'review-card', reason });
      if (!approvalId || !digest) return review('I did not read out an action for that. Answer it on screen.');
      if (!waiting.some((w) => w.id === approvalId)) return review('That action was already answered or has changed. Check the card on screen.');
      if (waiting.length > 1) return review(`${waiting.length} actions are waiting. Answer them on screen.`);
      try {
        resolveApproval(user.id, approvalId, decision, digest, { by: displayName(user, currentSession(c)?.person ?? null), via: 'voice call' });
      } catch (error) {
        if (error instanceof ApprovalError) return review(error.code === 'digest_mismatch' ? 'That action has changed since I read it out. Check the card on screen.' : 'Open the approval card in chat to review this action.');
        throw error;
      }
      appendRow(bot.id, 'message', { type: 'message', role: 'user', text: `${text} (${decision === 'allow' ? 'approved' : 'declined'} by voice)`, from: { kind: 'voice', id: callId, name: 'Voice call' } });
      return c.json({ text, action: decision === 'allow' ? 'approved' : 'declined' });
    }
  }

  const from: MessageBody['from'] = { kind: 'voice', id: callId, name: 'Voice call' };
  const row = appendRow(bot.id, 'message', { type: 'message', role: 'user', text, from });
  const name = firstName(user.id) || 'The user';
  enqueue(bot.id, {
    type: 'user',
    text: `[Voice call: ${name} said this on a live voice call with you, and everything you write back is read aloud to them. Reply in short, natural spoken sentences: lead with the answer, no markdown, lists, links, IDs or file paths unless asked, and say numbers and dates the way a person would. If the work will take more than a few seconds, first say in one short sentence what you are about to do, then do it, then give the outcome.]\n${text}`,
  });
  call.requests.push(clip(text, 200));
  return c.json({ text, seq: row.seq });
});

voiceApi.post('/end', async (c) => {
  const user = c.get('user');
  const { botId, callId, transcript, error } = await c.req.json<{ botId: string; callId: string; transcript?: { role: string; text: string }[]; error?: string }>();
  const bot = ownBot(user.id, botId);
  if (!bot) return c.json({ error: 'not found' }, 404);
  const call = calls.get(callId);
  if (!call || call.botId !== bot.id) return c.json({ ok: true, duplicate: true });
  calls.delete(callId);

  const durationMs = now() - call.startedAt;
  const lines = (Array.isArray(transcript) ? transcript : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-200)
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: clip(t.text.trim(), 2000) }));
  const asked = call.requests.length ? ` · ${call.requests.length} request${call.requests.length === 1 ? '' : 's'}` : '';
  const base = `Voice call ended · ${fmtDuration(durationMs)}${asked}${error ? ` · ${clip(error, 120)}` : ''}`;
  const record: VoiceCallRecord = { id: callId, phase: 'ended', durationMs, transcript: lines, tasks: call.requests };
  const row = appendRow(bot.id, 'event', callEvent(base, record));
  emitBot(bot.id);
  return c.json({ ok: true, seq: row.seq });
});

// Calls whose tab vanished without /end: close them after 2h so the map can't grow forever.
setInterval(() => {
  for (const call of calls.values()) {
    if (now() - call.startedAt < 2 * 3600_000) continue;
    calls.delete(call.id);
    appendRow(call.botId, 'event', callEvent('Voice call ended', { id: call.id, phase: 'ended', tasks: call.requests }));
  }
}, 10 * 60_000).unref();

// ---------- speech out, dictation in ----------

voiceApi.post('/speak', async (c) => {
  const user = c.get('user');
  const p = await c.req.json<{ botId?: string; text?: string; voice?: string; speed?: number; stream?: boolean }>().catch(() => ({} as any));
  const bot = ownBot(user.id, p.botId);
  if (!bot) return c.json({ error: 'not found' }, 404);
  const s = settingsOf(bot);
  const text = String(p.text ?? '').trim().slice(0, 1500);
  if (!text) return c.json({ error: 'text required' }, 400);
  const voice = p.voice && voiceList().some((v) => v.id === p.voice) ? p.voice : s.voice;
  if (p.stream === true) {
    // The WAV as it is made (header first, length unknown); the apps play each piece as it lands.
    try {
      const ac = new AbortController();
      c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true });
      const body = await synthesizeStream(text, voice, clampSpeed(p.speed ?? s.speed), ac.signal);
      return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    } catch (e) {
      return speechFailed(c, e);
    }
  }
  try {
    const wav = await synthesize(text, voice, clampSpeed(p.speed ?? s.speed));
    return c.body(new Uint8Array(wav), 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
  } catch (e) {
    return speechFailed(c, e);
  }
});

voiceApi.post('/preview', async (c) => {
  const user = c.get('user');
  const p = await c.req.json<{ botId?: string; voice?: string; speed?: number }>().catch(() => ({} as any));
  const bot = ownBot(user.id, p.botId);
  const s = settingsOf(bot);
  const voice = p.voice && voiceList().some((v) => v.id === p.voice) ? p.voice : s.voice;
  try {
    const wav = await cachedSpeech(`Hi, I'm ${bot?.name ?? 'your Bot'}. This is how I'll sound when we talk.`, voice, sampleSpeed(p.speed ?? s.speed), 'wav');
    return c.body(new Uint8Array(wav), 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
  } catch (e) {
    return speechFailed(c, e);
  }
});

/**
 * GET /sample?voice=af_bella&speed=1: a short clip of that voice saying the sample sentence (MP3).
 * The same for every bot, made once and then served from disk, so the play buttons are instant.
 */
voiceApi.get('/sample', async (c) => {
  const v = voiceList().find((x) => x.id === c.req.query('voice'));
  if (!v) return c.json({ error: 'unknown voice' }, 404);
  try {
    const mp3 = await cachedSpeech(sampleText(v), v.id, sampleSpeed(c.req.query('speed') ?? 1), 'mp3');
    return c.body(new Uint8Array(mp3), 200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' });
  } catch (e) {
    if (e instanceof VoiceBroken) broken.add(v.id);
    return speechFailed(c, e);
  }
});

voiceApi.post('/stt', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'recording too long' }, 413);
  if (file.size < 200) return c.json({ text: '' });
  try {
    return c.json({ text: await transcribe(file, file.name || 'dictation.webm', String(form?.get('language') ?? '')) });
  } catch (e) {
    return speechFailed(c, e);
  }
});
