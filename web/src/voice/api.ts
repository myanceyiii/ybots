import type { VoiceOption } from '@shared/types';

export interface VoiceSession {
  callId: string;
  /** Rows after this one are what happened during the call. */
  startSeq: number;
  voice: string;
  speed: number;
  language: string;
  greeting: string;
  approvalsByVoice: boolean;
}

export interface VoiceOptions { voices: VoiceOption[]; languages: { code: string; name: string }[]; speeds: number[]; defaultVoice?: string; approvalsByVoice?: boolean; engine?: string; streams?: boolean; live?: boolean }

export interface TurnResult { text: string; seq?: number; action?: 'approved' | 'declined' | 'hangup' | 'review-card'; reason?: string }

async function errorOf(res: Response, fallback: string): Promise<Error> {
  let msg = fallback;
  try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
  return new Error(msg);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw await errorOf(res, res.statusText || `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function audio(path: string, body: unknown, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw await errorOf(res, 'Speech unavailable');
  return res.arrayBuffer();
}

let optionsPromise: Promise<VoiceOptions> | null = null;

export const voiceApi = {
  options: () => (optionsPromise ??= fetch('/api/voice/options', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<VoiceOptions>;
  }).catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => post<VoiceSession>('/session', { botId }),
  /** One thing said on a call: transcribed by the speech server, then sent to the bot. */
  async turn(botId: string, callId: string, wav: Blob, card?: { approvalId: string; digest: string } | null): Promise<TurnResult> {
    const fd = new FormData();
    fd.append('botId', botId);
    fd.append('callId', callId);
    // The approval card the call had read out before you spoke: a spoken yes or no answers only that one.
    if (card) { fd.append('approvalId', card.approvalId); fd.append('digest', card.digest); }
    fd.append('file', wav, 'turn.wav');
    const res = await fetch('/api/voice/turn', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) throw await errorOf(res, 'Could not hear that');
    return res.json() as Promise<TurnResult>;
  },
  /** Text -> WAV in the bot's voice. */
  speak: (botId: string, text: string, signal?: AbortSignal) => audio('/speak', { botId, text }, signal),
  /** Text -> a WAV that arrives as it is made (stream: true); read it with wavPieces(). */
  async speakStream(botId: string, text: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch('/api/voice/speak', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, text, stream: true }), signal });
    if (!res.ok) throw await errorOf(res, 'Speech unavailable');
    return res;
  },
  preview: (p: { botId: string; voice?: string; speed?: number }) => audio('/preview', p),
  /** A voice saying its sample sentence (MP3; the server keeps it once made, the browser for a day). */
  sampleUrl: (voice: string, speed = 1) => `/api/voice/sample?voice=${encodeURIComponent(voice)}&speed=${speed}`,
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string) => post<{ ok: true }>('/end', { botId, callId, transcript, error }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[]) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  async transcribe(blob: Blob, language?: string): Promise<string> {
    const fd = new FormData();
    if (language) fd.append('language', language);
    const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    let res: Response;
    try { res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body: fd }); }
    catch { throw new Error("Couldn't reach the server, so nothing was written down."); }
    if (!res.ok) throw await errorOf(res, 'Transcription failed');
    return ((await res.json()) as { text: string }).text;
  },
};
