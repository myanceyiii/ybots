/**
 * Messages on their way. Send puts the message here and shows it in the chat at once; it goes to the
 * server in order, and if the connection is down it waits and goes out by itself when the server
 * answers again. Each one carries a `clientId`, so a second try can never post it twice. Saved on the
 * phone per account, so closing the app loses nothing. The same idea as web/src/lib/outbox.ts.
 */
import { useEffect, useState } from 'react';
import { tap } from './haptics';
import type { ChatFile, Client, Row } from './api';
import { accountKey, readJson, writeJsonSoon } from './disk';
import { isNetworkFailure, problemText } from './problem';

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

let items: Pending[] = [];
let account = '';
let api: Client | null = null;
let onSent: ((chatId: string, row: Row) => void) | null = null;
const listeners = new Set<() => void>();
const file = () => `outbox-${accountKey(account)}.json`;
const changed = () => {
  for (const fn of listeners) fn();
  if (account) writeJsonSoon(file(), () => items.map((p) => ({ ...p, state: p.state === 'failed' ? 'failed' : 'waiting' })), 100);
};
const patch = (clientId: string, p: Partial<Pending>) => { items = items.map((x) => (x.clientId === clientId ? { ...x, ...p } : x)); changed(); };
const drop = (clientId: string) => { items = items.filter((x) => x.clientId !== clientId); changed(); };

const busy = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

async function pump(chatId: string) {
  if (busy.has(chatId) || !api) return;
  const a = api, who = account;
  busy.add(chatId);
  try {
    for (;;) {
      const next = items.find((p) => p.chatId === chatId);
      // A refused message holds the ones after it, so nothing is posted out of order.
      if (!next || next.state === 'failed' || account !== who) return;
      patch(next.clientId, { state: 'sending', error: undefined });
      try {
        const r = await a.send(chatId, next.text, { attachments: next.attachments.map((f) => f.path), clientId: next.clientId });
        if (account !== who) return;
        if (r?.row) onSent?.(chatId, r.row);
        drop(next.clientId);
      } catch (e) {
        if (account !== who) return;
        const status = (e as { status?: number }).status ?? -1;
        if (isNetworkFailure(e) || [502, 503, 504, 520, 521, 522, 523, 524].includes(status)) {
          patch(next.clientId, { state: 'waiting' });
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flushOutbox, 4000);
          return;
        }
        patch(next.clientId, { state: 'failed', error: problemText(e, 'The message was not sent.') });
        tap('error');
        return;
      }
    }
  } finally { busy.delete(chatId); }
}

/** Try everything that is waiting (the connection came back, the app came to the front). */
export function flushOutbox() {
  for (const id of new Set(items.map((p) => p.chatId))) void pump(id);
}

/** Signed in (or out, with null): load what this account left unsent on this phone, and send it. */
export function setOutboxAccount(next: string, client: Client | null, sent: ((chatId: string, row: Row) => void) | null) {
  api = client; onSent = sent;
  if (next === account) { flushOutbox(); return; }
  account = next; items = [];
  for (const fn of listeners) fn();
  if (!next) return;
  void readJson<Pending[]>(file(), []).then((saved) => {
    if (account !== next) return;
    const fresh = (Array.isArray(saved) ? saved : []).filter((p) => p && typeof p.clientId === 'string' && typeof p.chatId === 'string' && typeof p.text === 'string' && Date.now() - p.createdAt < 3 * 86_400_000)
      .map((p) => ({ ...p, attachments: Array.isArray(p.attachments) ? p.attachments : [], afterSeq: Number(p.afterSeq) || 0 }));
    items = [...fresh.filter((p) => !items.some((x) => x.clientId === p.clientId)), ...items];
    for (const fn of listeners) fn();
    flushOutbox();
  });
}

export function enqueue(chatId: string, text: string, attachments: ChatFile[], afterSeq: number) {
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  items = [...items, { clientId, chatId, text, attachments, state: 'sending', createdAt: Date.now(), afterSeq }];
  changed();
  void pump(chatId);
}
export function retryPending(clientId: string) {
  const p = items.find((x) => x.clientId === clientId);
  if (!p) return;
  patch(clientId, { state: 'waiting', error: undefined });
  void pump(p.chatId);
}
/** Take a message that was never sent out of the chat; it is handed back for the message box. */
export function discardPending(clientId: string): Pending | undefined {
  const p = items.find((x) => x.clientId === clientId);
  // One already on its way can't be taken back: giving it to the composer as well would send it twice.
  if (!p || p.state === 'sending') return undefined;
  drop(clientId);
  return p;
}

const NONE: Pending[] = [];
/** The messages on their way in one chat (all chats without an id). */
export function usePending(chatId?: string): Pending[] {
  const [, bump] = useState(0);
  useEffect(() => { const fn = () => bump((n) => n + 1); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  if (!chatId) return items;
  const mine = items.filter((p) => p.chatId === chatId);
  return mine.length ? mine : NONE;
}

export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
