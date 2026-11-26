import { create } from 'zustand';
import type { ChatFile } from '@shared/types';
import { api, MAX_ATTACHMENT, MAX_ATTACHMENTS } from './api';
import { isNetworkFailure, problemText } from './problem';
import { lsGet, lsSet } from './storage';
import { useStore } from '../store';

/**
 * Messages on their way. Send puts the message here and shows it in the chat at once; it goes to the
 * server in order, and if the connection is down it waits and goes out by itself when the server
 * answers again. Each one carries a `clientId`, so a second try can never post it twice. Kept in this
 * browser (per account), so a reload or a closed laptop loses nothing.
 */
export interface Pending {
  clientId: string;
  chatId: string;
  text: string;
  attachments: ChatFile[];
  /** sending: on its way. waiting: no connection, tried again by itself. failed: the server refused it. */
  state: 'sending' | 'waiting' | 'failed';
  error?: string;
  createdAt: number;
  /** The newest row the chat held when this was sent: its own row, once it arrives, comes after it. */
  afterSeq: number;
}

export const useOutbox = create<{ items: Pending[] }>(() => ({ items: [] }));

const KEY = () => `outbox.${useStore.getState().user?.id ?? 'none'}`;
const persist = () => lsSet(KEY(), JSON.stringify(useOutbox.getState().items.map((p) => ({ ...p, state: p.state === 'failed' ? 'failed' : 'waiting' }))));
const patch = (clientId: string, p: Partial<Pending>) => { useOutbox.setState((s) => ({ items: s.items.map((x) => (x.clientId === clientId ? { ...x, ...p } : x)) })); persist(); };
const drop = (clientId: string) => { useOutbox.setState((s) => ({ items: s.items.filter((x) => x.clientId !== clientId) })); persist(); };

const busy = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

async function pump(chatId: string) {
  if (busy.has(chatId)) return;
  busy.add(chatId);
  try {
    for (;;) {
      const next = useOutbox.getState().items.find((p) => p.chatId === chatId);
      // A refused message holds the ones after it, so nothing is posted out of order.
      if (!next || next.state === 'failed') return;
      patch(next.clientId, { state: 'sending', error: undefined });
      try {
        const r = await api.send(chatId, next.text, { attachments: next.attachments.map((f) => f.path), clientId: next.clientId });
        // The row and the pending bubble swap in one update, so the message never blinks.
        useStore.getState().upsertRows(chatId, r.row.generation, [r.row]);
        drop(next.clientId);
      } catch (e) {
        if (isNetworkFailure(e) || [502, 503, 504, 520, 521, 522, 523, 524].includes((e as { status?: number }).status ?? -1)) {
          patch(next.clientId, { state: 'waiting' });
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flushOutbox, 4000);
          return;
        }
        patch(next.clientId, { state: 'failed', error: problemText(e, 'The message was not sent.') });
        return;
      }
    }
  } finally {
    busy.delete(chatId);
  }
}

/** Try everything that is waiting (the connection came back, the page was opened again). */
export function flushOutbox() {
  for (const id of new Set(useOutbox.getState().items.map((p) => p.chatId))) void pump(id);
}

export function enqueue(chatId: string, text: string, attachments: ChatFile[] = []) {
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const afterSeq = Math.max(0, ...Object.keys(useStore.getState().transcripts[chatId]?.bySeq ?? {}).map(Number));
  useOutbox.setState((s) => ({ items: [...s.items, { clientId, chatId, text, attachments, state: 'sending', createdAt: Date.now(), afterSeq }] }));
  persist();
  void pump(chatId);
}

export function retryPending(clientId: string) {
  const p = useOutbox.getState().items.find((x) => x.clientId === clientId);
  if (!p) return;
  patch(clientId, { state: 'waiting', error: undefined });
  void pump(p.chatId);
}

/** Take a message that was never sent out of the chat; its words are handed back for the message box. */
export function discardPending(clientId: string): Pending | undefined {
  const p = useOutbox.getState().items.find((x) => x.clientId === clientId);
  if (p && p.state !== 'sending') drop(clientId);
  return p;
}

/** Messages left unsent by an earlier visit (same account, this browser) go out now. */
export function restoreOutbox() {
  try {
    const saved = JSON.parse(lsGet(KEY()) ?? '[]') as Pending[];
    const fresh = Array.isArray(saved) ? saved.filter((p) => p && typeof p.clientId === 'string' && typeof p.chatId === 'string' && typeof p.text === 'string' && Date.now() - p.createdAt < 3 * 86_400_000) : [];
    useOutbox.setState({ items: fresh.map((p) => ({ ...p, attachments: Array.isArray(p.attachments) ? p.attachments : [], afterSeq: Number(p.afterSeq) || 0 })) });
  } catch { useOutbox.setState({ items: [] }); }
  flushOutbox();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', flushOutbox);
  window.addEventListener('cleftbot:account-changed', () => useOutbox.setState({ items: [] }));
  // The live connection coming back is the surest sign the server answers again.
  useStore.subscribe((s, prev) => { if (s.sseConnected && !prev.sseConnected) flushOutbox(); });
}

// ---------- pictures and files being attached to the next message ----------

export interface Attaching {
  id: string;
  name: string;
  size: number;
  state: 'uploading' | 'done' | 'failed';
  /** A local preview of a picture while (and after) it uploads. */
  preview?: string;
  file?: ChatFile;
  error?: string;
}

export const useAttach = create<Record<string, Attaching[]>>(() => ({}));
if (typeof window !== 'undefined') window.addEventListener('cleftbot:account-changed', () => useAttach.setState({}, true));

const setTray = (chatId: string, f: (list: Attaching[]) => Attaching[]) => useAttach.setState((s) => {
  const list = f(s[chatId] ?? []);
  const next = { ...s };
  if (list.length) next[chatId] = list; else delete next[chatId];
  return next;
}, true);

/** Upload files for the next message in this chat. Answers a sentence when some could not be added. */
export function attachFiles(chatId: string, files: File[]): string | null {
  const have = useAttach.getState()[chatId]?.length ?? 0;
  const room = Math.max(0, MAX_ATTACHMENTS - have);
  let note: string | null = files.length > room ? `A message can carry ${MAX_ATTACHMENTS} files at most.` : null;
  for (const f of files.slice(0, room)) {
    if (f.size > MAX_ATTACHMENT) { note = `${f.name} is larger than 25 MB, which is the most a message can carry.`; continue; }
    if (!f.size) { note = `${f.name} is empty.`; continue; }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = f.name || (f.type.startsWith('image/') ? `Pasted picture.${f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}` : 'File');
    const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
    setTray(chatId, (l) => [...l, { id, name, size: f.size, state: 'uploading', preview }]);
    api.attach(chatId, f, name).then(
      (file) => setTray(chatId, (l) => l.map((a) => (a.id === id ? { ...a, state: 'done', file } : a))),
      (e) => setTray(chatId, (l) => l.map((a) => (a.id === id ? { ...a, state: 'failed', error: problemText(e, 'Could not be uploaded.') } : a))),
    );
  }
  return note;
}

export function removeAttaching(chatId: string, id: string) {
  setTray(chatId, (l) => l.filter((a) => { if (a.id === id && a.preview) URL.revokeObjectURL(a.preview); return a.id !== id; }));
}

/** The uploaded files, taken off the tray for a message that is being sent. */
export function takeAttached(chatId: string): ChatFile[] {
  const list = useAttach.getState()[chatId] ?? [];
  setTray(chatId, () => []);
  return list.filter((a) => a.state === 'done' && a.file).map((a) => a.file!);
}

export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
