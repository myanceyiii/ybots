import fs from 'node:fs';
import { db } from './db.js';

/**
 * Siloed bots: a bot whose Hermes agent, screen, browser and files live inside a container
 * (silo/sheldon/). The app does not start, configure or delete that agent. It only
 *   - sends the bot's turns to the agent's API, published by the container on this machine's loopback,
 *   - relays the container's VNC screen to the viewer,
 *   - and checks every message the bot sends to another bot against a per-recipient allow-list
 *     of message types (the team plan, section 8; kept outside the repo). Anything else is refused before delivery.
 *
 * SILO_BOTS (or SILO_BOTS_FILE) is JSON, keyed by bot id:
 *   {
 *     "bot_abc": {
 *       "url": "http://127.0.0.1:8653",            // the agent's API, published by the gate container
 *       "keyFile": "/etc/cleft-bot/silo/sheldon/api_key",
 *       "vnc": "127.0.0.1:5953",                    // optional: live view
 *       "vncPasswordFile": "/etc/cleft-bot/silo/sheldon/vnc_password",
 *       "allow": { "Leonard": ["CAL", "ITINERARY", "RECEIPT", "Q", "A"] }
 *     }
 *   }
 * A key can also be "name:<Bot name>" (case-insensitive), so a bot is siloed from the moment it is
 * created and never gets a Hermes home on the host first. Switch to the id once the bot exists.
 * `allow` names recipients by bot name (case-insensitive). A recipient that is not listed gets nothing.
 * Group chats are closed to a siloed bot: it cannot join one, create one or post in one.
 */

export type SiloType = 'CAL' | 'ITINERARY' | 'RECEIPT' | 'Q' | 'A';
export const SILO_TYPES: SiloType[] = ['CAL', 'ITINERARY', 'RECEIPT', 'Q', 'A'];

export interface SiloBot {
  url: string;
  keyFile?: string;
  key?: string;
  vnc?: string;
  vncPasswordFile?: string;
  allow: Record<string, SiloType[]>;
}

let cache: { raw: string; bots: Record<string, SiloBot> } | null = null;

function rawConfig(): string {
  if (process.env.SILO_BOTS) return process.env.SILO_BOTS;
  const f = process.env.SILO_BOTS_FILE;
  if (!f) return '';
  try { return fs.readFileSync(f, 'utf8'); } catch (e: any) {
    console.warn(`[silo] cannot read SILO_BOTS_FILE ${f}: ${e?.message ?? e}`);
    return '';
  }
}

export function siloBots(): Record<string, SiloBot> {
  const raw = rawConfig();
  if (cache && cache.raw === raw) return cache.bots;
  const bots: Record<string, SiloBot> = {};
  if (raw.trim()) {
    try {
      const v = JSON.parse(raw);
      for (const [id, c] of Object.entries<any>(v ?? {})) {
        if (!c || typeof c.url !== 'string') { console.warn(`[silo] ${id}: no url; ignored`); continue; }
        const allow: Record<string, SiloType[]> = {};
        for (const [name, types] of Object.entries<any>(c.allow ?? {})) {
          allow[name.toLowerCase()] = (Array.isArray(types) ? types : []).filter((t: any) => SILO_TYPES.includes(t));
        }
        bots[id] = { url: c.url.replace(/\/+$/, ''), keyFile: c.keyFile, key: c.key, vnc: c.vnc, vncPasswordFile: c.vncPasswordFile, allow };
      }
    } catch {
      console.warn('[silo] SILO_BOTS is not valid JSON; no bot is siloed');
    }
  }
  cache = { raw, bots };
  return bots;
}

export function siloFor(botId: string | null | undefined): SiloBot | null {
  if (!botId) return null;
  const bots = siloBots();
  if (bots[botId]) return bots[botId];
  const named = Object.keys(bots).filter((k) => k.toLowerCase().startsWith('name:'));
  if (!named.length) return null;
  const name = String((db.prepare('SELECT name FROM bots WHERE id=?').get(botId) as any)?.name ?? '').trim().toLowerCase();
  const k = name && named.find((n) => n.slice(5).trim().toLowerCase() === name);
  return k ? bots[k] : null;
}

export const isSilo = (botId: string | null | undefined): boolean => !!siloFor(botId);

function readFile(file?: string): string {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function siloKey(botId: string): string {
  const s = siloFor(botId);
  return s ? s.key || readFile(s.keyFile) : '';
}

export function siloVnc(botId: string): { host: string; port: number; password: string } | null {
  const s = siloFor(botId);
  if (!s?.vnc) return null;
  const m = /^(.+):(\d+)$/.exec(s.vnc);
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), password: readFile(s.vncPasswordFile) };
}

// ---------- what a siloed bot may send to another bot ----------

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** Short labels only: letters, digits, spaces and a little punctuation. No line breaks, no markup. */
const LABEL = /^[\p{L}\p{N} .,'&()\/-]{1,60}$/u;
const MAX_QA = 500;

type Check = { ok: true; text: string } | { ok: false; why: string };

function fields(data: any, allowed: string[], required: string[]): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'data must be an object';
  const extra = Object.keys(data).filter((k) => !allowed.includes(k));
  if (extra.length) return `fields not allowed: ${extra.join(', ')}`;
  const missing = required.filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
  if (missing.length) return `missing: ${missing.join(', ')}`;
  return null;
}

const iso = (v: any) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const label = (v: any) => v === undefined || (typeof v === 'string' && LABEL.test(v));

/**
 * Validate one outgoing message and build the exact text the recipient gets. Free text is only
 * carried by Q and A, and only where the allow-list says so; every other type is rebuilt from
 * checked fields, so nothing beyond those fields can travel.
 */
export function checkSiloMessage(type: string, data: any, message: string): Check {
  switch (type) {
    case 'CAL': {
      const bad = fields(data, ['start', 'end', 'status'], ['start', 'end', 'status']);
      if (bad) return { ok: false, why: `CAL: ${bad}` };
      if (!iso(data.start) || !iso(data.end)) return { ok: false, why: 'CAL: start and end must be ISO 8601 dates or times' };
      if (Date.parse(data.end) < Date.parse(data.start)) return { ok: false, why: 'CAL: end is before start' };
      if (data.status !== 'busy' && data.status !== 'away') return { ok: false, why: 'CAL: status must be busy or away' };
      return { ok: true, text: `CAL ${data.status} ${data.start} to ${data.end}` };
    }
    case 'ITINERARY': {
      const keys = ['kind', 'start', 'end', 'from', 'to', 'carrier', 'number'];
      const bad = fields(data, keys, ['kind', 'start']);
      if (bad) return { ok: false, why: `ITINERARY: ${bad}` };
      if (!['flight', 'train', 'hotel', 'car', 'other'].includes(data.kind)) return { ok: false, why: 'ITINERARY: kind must be flight, train, hotel, car or other' };
      if (!iso(data.start) || (data.end !== undefined && !iso(data.end))) return { ok: false, why: 'ITINERARY: start and end must be ISO 8601' };
      for (const k of ['from', 'to', 'carrier', 'number']) if (!label(data[k])) return { ok: false, why: `ITINERARY: ${k} must be a short plain label (60 characters)` };
      const parts = [`ITINERARY ${data.kind}`, `${data.start}${data.end ? ` to ${data.end}` : ''}`];
      if (data.from || data.to) parts.push(`${data.from ?? '?'} -> ${data.to ?? '?'}`);
      if (data.carrier || data.number) parts.push([data.carrier, data.number].filter(Boolean).join(' '));
      return { ok: true, text: parts.join(' | ') };
    }
    case 'RECEIPT': {
      const bad = fields(data, ['date', 'amount', 'currency', 'category', 'vendor'], ['date', 'amount', 'currency', 'category']);
      if (bad) return { ok: false, why: `RECEIPT: ${bad}` };
      if (!iso(data.date)) return { ok: false, why: 'RECEIPT: date must be ISO 8601' };
      const amount = Number(data.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return { ok: false, why: 'RECEIPT: amount must be a number' };
      if (typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) return { ok: false, why: 'RECEIPT: currency must be a 3-letter code' };
      if (!['travel', 'lodging', 'meals', 'mileage', 'supplies', 'other'].includes(data.category)) return { ok: false, why: 'RECEIPT: category must be travel, lodging, meals, mileage, supplies or other' };
      if (!label(data.vendor)) return { ok: false, why: 'RECEIPT: vendor must be a short plain label (60 characters)' };
      return { ok: true, text: `RECEIPT ${data.date} ${amount.toFixed(2)} ${data.currency} ${data.category}${data.vendor ? ` ${data.vendor}` : ''} (reimbursable)` };
    }
    case 'Q':
    case 'A': {
      if (data !== undefined && data !== null && !(typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
        return { ok: false, why: `${type}: put the text in message, not data` };
      }
      const t = String(message ?? '').trim();
      if (!t) return { ok: false, why: `${type}: message is empty` };
      if (t.length > MAX_QA) return { ok: false, why: `${type}: at most ${MAX_QA} characters` };
      return { ok: true, text: `${type} (work calendar): ${t}` };
    }
    default:
      return { ok: false, why: `unknown type "${type}"; use one of ${SILO_TYPES.join(', ')}` };
  }
}

/** Texts that passed checkSiloOutgoing and may be enqueued once (see loop.enqueueBotMessage). */
const cleared = new Map<string, number>();
const clearKey = (from: string, to: string, text: string) => `${from}\u0000${to}\u0000${text}`;

/**
 * Whether siloed bot `fromId` may send `type` to the bot named `toName`, and the text to deliver.
 * On success the text is cleared for exactly one delivery to `toId`.
 */
export function checkSiloOutgoing(fromId: string, toId: string, toName: string, type: string, data: any, message: string): Check {
  const s = siloFor(fromId);
  if (!s) return { ok: false, why: 'not a siloed bot' };
  const allowed = s.allow[toName.toLowerCase()] ?? [];
  if (!allowed.length) return { ok: false, why: `You may not send messages to ${toName}.` };
  if (!type) return { ok: false, why: `Give a type. Allowed to ${toName}: ${allowed.join(', ')}.` };
  if (!allowed.includes(type as SiloType)) return { ok: false, why: `${type} may not be sent to ${toName}. Allowed: ${allowed.join(', ')}.` };
  const r = checkSiloMessage(type, data, message);
  if (r.ok) cleared.set(clearKey(fromId, toId, r.text), (cleared.get(clearKey(fromId, toId, r.text)) ?? 0) + 1);
  return r;
}

/** Last line of defence in the delivery path: a siloed bot's message must have been cleared above. */
export function takeCleared(fromId: string, toId: string, text: string): boolean {
  const k = clearKey(fromId, toId, text);
  const n = cleared.get(k) ?? 0;
  if (n <= 0) return false;
  if (n === 1) cleared.delete(k); else cleared.set(k, n - 1);
  return true;
}
