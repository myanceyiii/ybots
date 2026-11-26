// Sends a recording (a WAV file the native voice module wrote) to the server as multipart/form-data.
//
// Why not FormData with { uri, name, type }: since Expo SDK 52 the app's global fetch is expo/fetch,
// which refuses React Native's { uri } form parts ("Unsupported FormDataPart implementation") before
// anything is sent. Every Android dictation and call turn failed that way, reported as "Couldn't reach
// the server" (Cloudflare never saw one). So the file is read here and the body is built by hand:
// plain bytes work with expo/fetch and with React Native's own fetch alike.
import { File as FsFile } from 'expo-file-system';
// expo/fetch (the app's global fetch too) takes a Uint8Array body; named here so that stays true.
import { fetch as expoFetch } from 'expo/fetch';

export type UploadFailure = 'file' | 'network';

/** Where an upload broke: reading the recording on the phone, or reaching the server. */
export class UploadError extends Error {
  constructor(message: string, readonly kind: UploadFailure, readonly cause?: unknown) { super(message); }
}

export interface FilePart { field: string; filename: string; type: string; bytes: Uint8Array }

const enc = new TextEncoder();
const quote = (s: string) => s.replace(/["\r\n\\]/g, '_');

/** multipart/form-data body: the text fields (empty ones left out), then the file. */
export function multipartBody(fields: Record<string, string | undefined | null>, file: FilePart, boundary = `----cleft${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`): { body: Uint8Array; contentType: string } {
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.field)}"; filename="${quote(file.filename)}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.bytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { body.set(p, o); o += p.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface Uploaded { ok: boolean; status: number; json(): Promise<unknown> }

/** POSTs the WAV at `path` (plus `fields`) to `${server}${route}`. Throws UploadError when it never got there. */
export async function postRecording(api: { server: string; authHeader: Record<string, string> }, route: string, path: string, filename: string, fields: Record<string, string | undefined | null> = {}): Promise<Uploaded> {
  let bytes: Uint8Array;
  try {
    bytes = await new FsFile(path.startsWith('file://') ? path : `file://${path}`).bytes();
  } catch (e) {
    throw new UploadError("the recording couldn't be read on this phone", 'file', e);
  }
  const { body, contentType } = multipartBody(fields, { field: 'file', filename, type: 'audio/wav', bytes });
  try {
    return await expoFetch(`${api.server}${route}`, { method: 'POST', headers: { ...api.authHeader, 'content-type': contentType }, body: body.buffer as ArrayBuffer });
  } catch (e) {
    throw new UploadError("couldn't reach the server", 'network', e);
  }
}
