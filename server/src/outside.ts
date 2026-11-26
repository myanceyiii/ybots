import fs from 'node:fs';
import { db } from './db.js';

/**
 * Outside members: a bot that lives somewhere else (today: Sheldon, a ChatGPT agent in the household
 * Slack) and is reached through a link instead of an engine. The app never starts an agent for it.
 * Messages to it go out through the link (slack-link.ts); its answers come back as messages that are
 * information only and never approve anything.
 *
 * OUTSIDE_BOTS (or OUTSIDE_BOTS_FILE) is JSON, keyed by bot id or "name:<Bot name>":
 *   {
 *     "name:Sheldon": {
 *       "via": "slack",
 *       "slackUserId": "U0123ABCD",     // the outside bot's Slack member id (mentioned in every post)
 *       "channel": "C0123ABCD",         // where to talk to it
 *       "channelName": "assistants",    // shown in the app
 *       "replyMinutes": 75,             // no answer after this long: the asking bot is told
 *       "aliases": { "Claude": "Leonard" }, // optional: names it may use for our bots
 *       "callUrl": "https://chatgpt.com/…" // optional: where "Call" goes (callUrlOf); default chatgpt.com/voice
 *     }
 *   }
 */

export interface OutsideBot {
  via: 'slack';
  slackUserId: string;
  channel: string;
  channelName: string;
  replyMinutes: number;
  aliases: Record<string, string>;
  /** The name owner posts are signed with ("[Alex]>@Sheldon …"); defaults to the owner's first name. */
  ownerName: string | null;
  /** Where the app's "Call" button goes: a chatgpt.com page, which the ChatGPT Android app opens itself. */
  callUrl: string;
}

/**
 * ChatGPT's voice page. On the web it is the "Meet Voice / Tap to talk" page (checked 2026-11-22). On
 * Android, chatgpt.com's assetlinks.json lets com.openai.chatgpt handle all chatgpt.com links, so the
 * installed app takes it; /voice opening voice mode in the app is reported, not documented by OpenAI.
 */
export const DEFAULT_CALL_URL = 'https://chatgpt.com/voice';

/** Only https links on ChatGPT's own hosts, so a bad config can never send the owner somewhere else. */
export function callUrlOf(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return DEFAULT_CALL_URL;
  try {
    const u = new URL(v.trim());
    if (u.protocol === 'https:' && (u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com') && !u.username && !u.password && !u.port) return u.toString();
  } catch { /* fall through */ }
  console.warn('[outside] callUrl must be an https chatgpt.com link; using the voice page');
  return DEFAULT_CALL_URL;
}

/** Message types the household channel already uses (its pinned rules). */
export const OUT_TYPES = ['Q', 'A', 'FYI', 'CAL', 'BUDGET', 'LIST'] as const;
export type OutType = (typeof OUT_TYPES)[number];
export const MAX_OUT = 1000;

let cache: { raw: string; bots: Record<string, OutsideBot> } | null = null;

function rawConfig(): string {
  if (process.env.OUTSIDE_BOTS) return process.env.OUTSIDE_BOTS;
  const f = process.env.OUTSIDE_BOTS_FILE;
  if (!f) return '';
  try { return fs.readFileSync(f, 'utf8'); } catch (e: any) {
    console.warn(`[outside] cannot read OUTSIDE_BOTS_FILE ${f}: ${e?.message ?? e}`);
    return '';
  }
}

const SLACK_ID = /^[A-Z][A-Z0-9]{5,20}$/;

export function outsideBots(): Record<string, OutsideBot> {
  const raw = rawConfig();
  if (cache && cache.raw === raw) return cache.bots;
  const bots: Record<string, OutsideBot> = {};
  if (raw.trim()) {
    try {
      for (const [key, c] of Object.entries<any>(JSON.parse(raw) ?? {})) {
        if (c?.via !== 'slack' || !SLACK_ID.test(String(c.slackUserId ?? '')) || !SLACK_ID.test(String(c.channel ?? ''))) {
          console.warn(`[outside] ${key}: needs via "slack", slackUserId and channel; ignored`);
          continue;
        }
        const aliases: Record<string, string> = {};
        for (const [a, b] of Object.entries<any>(c.aliases ?? {})) if (typeof b === 'string') aliases[a.toLowerCase()] = b;
        bots[key] = {
          via: 'slack',
          slackUserId: c.slackUserId,
          channel: c.channel,
          channelName: String(c.channelName ?? c.channel).replace(/^#/, ''),
          replyMinutes: Number.isFinite(c.replyMinutes) && c.replyMinutes > 0 ? Number(c.replyMinutes) : 75,
          aliases,
          ownerName: typeof c.ownerName === 'string' && /^[\w .'-]{1,40}$/.test(c.ownerName.trim()) ? c.ownerName.trim() : null,
          callUrl: callUrlOf(c.callUrl),
        };
      }
    } catch {
      console.warn('[outside] OUTSIDE_BOTS is not valid JSON; no outside members');
    }
  }
  cache = { raw, bots };
  return bots;
}

export function outsideFor(botId: string | null | undefined): OutsideBot | null {
  if (!botId) return null;
  const bots = outsideBots();
  if (bots[botId]) return bots[botId];
  const named = Object.keys(bots).filter((k) => k.toLowerCase().startsWith('name:'));
  if (!named.length) return null;
  const name = String((db.prepare('SELECT name FROM bots WHERE id=?').get(botId) as any)?.name ?? '').trim().toLowerCase();
  const k = name && named.find((n) => n.slice(5).trim().toLowerCase() === name);
  return k ? bots[k] : null;
}

export const isOutside = (botId: string | null | undefined): boolean => !!outsideFor(botId);

// ---------- what our bots may send out ----------

/**
 * Things that never go to an outside member, whatever the bot was told. The server checks shapes,
 * not meaning: the bot's own rules and the channel's rules still apply to everything else.
 */
const NEVER: [string, RegExp][] = [
  ['a card or account number', /\b(?:\d[ -]?){13,19}\b/],
  ['a Social Security number', /\b\d{3}-\d{2}-\d{4}\b/],
  ['a Slack token', /xox[abposr]-[A-Za-z0-9-]{10,}/],
  ['an API key', /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,})/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a password', /\b(password|passcode|pin)\s*[:=]\s*\S{4,}/i],
  ['an account balance', /\b(balance|available credit)\b[^.\n]{0,30}\$\s?\d/i],
];

/** The same shapes, blanked out of text that is passed along as context (a group's recent messages). */
export function redactNever(text: string): string {
  let out = String(text ?? '');
  for (const [what, re] of NEVER) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (m) => `[${what} removed]${/\s$/.test(m) ? ' ' : ''}`);
  return out;
}

export type OutCheck = { ok: true; type: OutType; body: string } | { ok: false; why: string };

/**
 * A bot's message to an outside member: a type from the channel's list, then the text. The type may
 * be given separately or as the first word ("Q are you free Tue at noon?").
 */
export function checkOutgoing(text: string, type?: string): OutCheck {
  let body = String(text ?? '').trim();
  let t = String(type ?? '').trim().toUpperCase();
  const first = /^([A-Za-z]+)\b[:\s-]*/.exec(body);
  if (first && (OUT_TYPES as readonly string[]).includes(first[1].toUpperCase())) {
    if (!t) t = first[1].toUpperCase();
    if (first[1].toUpperCase() === t) body = body.slice(first[0].length).trim();
  }
  if (!(OUT_TYPES as readonly string[]).includes(t)) return { ok: false, why: `Start with a type: ${OUT_TYPES.join(', ')} (for example "Q is the owner free Tue at noon?").` };
  if (!body) return { ok: false, why: 'The message is empty.' };
  if (body.length > MAX_OUT) return { ok: false, why: `At most ${MAX_OUT} characters.` };
  for (const [what, re] of NEVER) if (re.test(body)) return { ok: false, why: `It looks like it contains ${what}, which never goes outside the app.` };
  return { ok: true, type: t as OutType, body: body.replace(/<!(channel|here|everyone)>|@(channel|here|everyone)\b/g, '').replace(/\s+$/, '') };
}

/** The channel's own format: `[Sender]>@To TYPE text`, plus a real mention so the agent wakes. */
export function formatOutgoing(fromName: string, toName: string, type: string | null, body: string, slackUserId: string): string {
  const head = `[${fromName}]>@${toName}${type ? ` ${type}` : ''}`;
  return `${head} ${body} <@${slackUserId}>`;
}

/**
 * An outside member's own top-level post, written in the channel format: `[Sheldon]>@Leonard Q …`.
 * The "@Leonard" is plain text, not a Slack mention, so names are matched here.
 */
export function parseIncoming(text: string): { to: string | null; type: string | null; body: string } {
  const t = String(text ?? '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim();
  const m = /^\[[^\]]{1,40}\]\s*>\s*@([A-Za-z][\w.-]{0,40})\s*(.*)$/s.exec(t);
  if (!m) return { to: null, type: typeOf(t), body: t };
  return { to: m[1], type: typeOf(m[2]), body: m[2].trim() };
}

function typeOf(s: string): string | null {
  const w = /^([A-Za-z]+)\b/.exec(s.trim())?.[1]?.toUpperCase();
  return w && ['Q', 'A', 'FYI', 'CAL', 'BUDGET', 'LIST', 'BUY', 'ITINERARY', 'RECEIPT'].includes(w) ? w : null;
}

/** "Assistants, stop" from a person in the channel pauses the link (the channel's rule 9). */
export const STOP = /^\s*assistants\s*,?\s+stop\b/i;
export const START = /^\s*assistants\s*,?\s+(start|resume)\b/i;
