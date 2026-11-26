// Live dictation: a WebSocket from the app (web, Windows, Android) to the live speech-to-text service on
// this machine (deploy/live-stt, Moonshine streaming), relayed here so sign-in stays the app's own and
// the service is never reachable from outside. The app streams 16 kHz PCM16; the service answers with
// {"type":"text","settled","pending"} as the words change and {"type":"final","text"} after "stop".
//
// LIVE_STT_URL (e.g. ws://127.0.0.1:8790/live) turns it on. Unset, or the service down: the upgrade is
// refused and the apps use the chunked method (POST /api/voice/stt about once a second).
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isLoopbackUrl } from './env.js';
import { isSameOriginRequest, userFromCookieHeader, userFromToken } from './lib/auth.js';

const url = process.env.LIVE_STT_URL?.trim() || '';
const remoteOk = process.env.VOICE_REMOTE === '1';
/** Audio stays on this machine unless VOICE_REMOTE=1, as for the other speech servers. */
export const liveSttConfigured = !!url && process.env.VOICE !== 'off' && (remoteOk || isLoopbackUrl(url.replace(/^ws/, 'http')));

let healthy = false;
let checkedAt = 0;
/** Whether the service answered its health check in the last minute (cheap; cached 20 s). */
export async function liveSttUp(): Promise<boolean> {
  if (!liveSttConfigured) return false;
  if (Date.now() - checkedAt < 20_000) return healthy;
  checkedAt = Date.now();
  try {
    const r = await fetch(url.replace(/^ws/, 'http').replace(/\/live$/, '/health'), { signal: AbortSignal.timeout(1500) });
    healthy = r.ok;
  } catch {
    healthy = false;
  }
  return healthy;
}

const MAX_MS = 150_000;

export function attachLiveStt(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/voice/live') return; // not ours
    const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
    const refuse = (code: string) => { socket.write(`HTTP/1.1 ${code}\r\n\r\n`); socket.destroy(); };
    // Same rules as the screen relay (vnc.ts): a browser must be on our own page; the phone uses its token.
    const bearer = /^Bearer\s+(\S+)$/i.exec(header(req.headers.authorization) ?? '')?.[1];
    if (bearer === undefined && !isSameOriginRequest(header(req.headers.origin), header(req.headers['sec-fetch-site']))) return refuse('403 Forbidden');
    const user = bearer !== undefined ? userFromToken(bearer) : userFromCookieHeader(req.headers.cookie);
    if (!user) return refuse('401 Unauthorized');
    if (!liveSttConfigured) return refuse('503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (client) => relay(client));
  });
}

function relay(client: WebSocket) {
  const up = new WebSocket(url, { maxPayload: 1024 * 1024 });
  const queued: Buffer[] = [];
  let closed = false;
  const end = (code = 1000, why = '') => {
    if (closed) return;
    closed = true;
    clearTimeout(limit);
    try { client.close(code, why); } catch { /* gone */ }
    try { up.close(); } catch { /* gone */ }
  };
  const limit = setTimeout(() => end(1000, 'too long'), MAX_MS);
  up.on('open', () => { for (const b of queued.splice(0)) up.send(b); });
  up.on('message', (data, isBinary) => { if (!isBinary && client.readyState === WebSocket.OPEN) client.send(data.toString()); });
  up.on('close', () => end(1000, 'done'));
  up.on('error', () => {
    healthy = false;
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', message: 'Live dictation is unavailable.' }));
    end(1011, 'unavailable');
  });
  client.on('message', (data, isBinary) => {
    // Audio passes as is; the only text the service takes is {"type":"stop"}.
    const msg = isBinary ? (data as Buffer) : Buffer.from(JSON.stringify({ type: 'stop' }));
    if (up.readyState === WebSocket.OPEN) up.send(msg, { binary: isBinary });
    else if (up.readyState === WebSocket.CONNECTING && queued.length < 500) queued.push(msg);
  });
  client.on('close', () => end());
  client.on('error', () => end());
}
