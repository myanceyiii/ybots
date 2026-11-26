/**
 * The line under each bot in the chat list (web, Windows and Android).
 *
 * Alex, 2026-11-23: a bot's row shows only what that bot itself said last (or a short AI summary of the
 * conversation, list-summary.ts). When someone else spoke last it says so in a few words ("You posted last.",
 * "Howard posted last.") instead of their text, and nothing is cut off mid-text on any screen.
 *
 * Every preview comes in two whole forms, so no app ever has to cut one:
 * - `text`: whole sentences, at most LONG_MAX characters (fits three lines on a phone and in the web list).
 * - `short`: a recap of at most SHORT_MAX characters on whole words (caption.ts), never ending in "…". Apps show
 *   it when `text` would not fit the lines they have (a folded phone, a list dragged narrow).
 *
 * Pure module apart from its imports' pure helpers, so tests can load it on its own.
 */
import { SHORT_MAX, shortRecap } from './caption.js';
import { plainText, splitReply } from './message-text.js';
import type { RowBody } from './types.js';

export { SHORT_MAX };
/** Longest `text`, in characters: three lines at the narrowest row that still shows the message. */
export const LONG_MAX = 110;

export type PreviewBy = 'bot' | 'member' | 'you' | 'other' | 'card' | 'event' | 'summary';
export interface ListPreview {
  text: string;
  short: string;
  /** Every form, longest first: `text`, a middle recap on whole words when it differs, then `short`. Apps show the first that fits. */
  forms?: string[];
  /** Who the line is about. 'bot' and 'member' lines may be replaced by an AI summary. */
  by: PreviewBy;
}

const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
const noEnd = (s: string) => s.replace(/[\s,;:–—-]+$/u, '');

/** Whole sentences from the start of `text`, at most `max` characters; null when even the first is longer. */
export function wholeSentences(text: string, max = LONG_MAX): string | null {
  const t = oneLine(text);
  if (!t) return null;
  if (t.length <= max) return t;
  const parts = t.split(/(?<=[.!?…])\s+(?=[^a-z])/u);
  let out = '';
  for (const s of parts) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  return out || null;
}

/** A middle form between the sentences and the short recap: whole words, at most this many characters (two lines on a phone). */
export const MID_MAX = 72;

/** The forms of one piece of text: whole sentences when they fit, a middle recap, and the short recap. */
export function bothForms(text: string, max = LONG_MAX): { text: string; mid: string; short: string } | null {
  const t = oneLine(text);
  if (!t) return null;
  const firstSentence = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  const short = t.length <= SHORT_MAX ? t : shortRecap(firstSentence) || noEnd(t.slice(0, SHORT_MAX));
  const mid = t.length <= MID_MAX ? t : shortRecap(firstSentence, Math.min(MID_MAX, max)) || short;
  const long = wholeSentences(t, max) ?? (mid.length > short.length ? mid : short);
  return { text: long, mid: mid.length < long.length && mid.length > short.length ? mid : short, short };
}

/** The forms of a preview, longest first, without repeats. */
export const formsOf = (...f: (string | null | undefined)[]) => [...new Set(f.filter((x): x is string => !!x))];

/** "Howard" out of a sender name such as "Claude: Fix the list" or "Howard · Admin". */
const firstName = (name: string) => (name.split(/[:·|(]/)[0] ?? name).trim().split(/\s+/).slice(0, 2).join(' ') || 'Someone';

function postedLast(who: string): ListPreview {
  const line = who === 'You' ? 'You posted last.' : `${who} posted last.`;
  return { text: line, short: line.length <= SHORT_MAX ? line : 'Someone else posted last.', by: who === 'You' ? 'you' : 'other' };
}

/** The line for a card (approval, question, view...), or null for a card that says nothing on its own. */
function cardLine(b: Extract<RowBody, { type: 'card' }>): ListPreview | null {
  switch (b.card) {
    case 'approval':
      if (b.status === 'pending') {
        const f = bothForms(`Waiting for you: ${b.title}`);
        return { text: f?.text ?? 'Waiting for you.', short: 'Waiting for you.', forms: formsOf(f?.text, f?.mid, 'Waiting for you.'), by: 'card' };
      }
      // An answered or expired card says nothing new: the line comes from the rows before it.
      return null;
    case 'question': return withForms(`Asked you: ${b.question}`, 'card', 'Asked you a question.');
    case 'connect': return withForms(`Connect ${b.toolkitName}`, 'card');
    case 'look': return withForms('New looks to pick from', 'card');
    case 'look-reveal': return withForms('A new look', 'card');
    case 'skill-proposal': return withForms(`Proposed skill: ${b.name}`, 'card', 'Proposed a skill.');
    case 'view': return b.quick ? null : withForms(b.title || plainText(b.text.split('\n')[0]), 'card');
    case 'plugin': return withForms(b.view.title || b.pluginName, 'card');
    case 'plugin-plan': return withForms(`Plugin plan: ${b.title}`, 'card', 'A plugin plan to review.');
    case 'plugin-review': return withForms(`Plugin ready to review: ${b.title}`, 'card', 'A plugin to review.');
    case 'draft': return withForms(b.subject ? `Draft: ${b.subject}` : 'Draft', 'card', 'A draft to review.');
    case 'files': return null;
  }
  return null;
}

function withForms(text: string, by: PreviewBy, short?: string): ListPreview | null {
  const f = bothForms(text);
  if (!f) return null;
  const sh = short && f.short !== f.text && f.text.length > SHORT_MAX ? short : f.short;
  return { text: f.text, short: sh, forms: formsOf(f.text, f.mid, sh), by };
}

/**
 * The preview for one chat from its newest rows (newest first). `group` is a group chat, where the latest
 * message shows with its writer's name; in a bot's own chat only that bot's own words show.
 */
export function listPreview(rows: RowBody[], group: boolean): ListPreview | null {
  let event: ListPreview | null = null;
  for (const b of rows) {
    if (b.type === 'message') {
      if (b.role === 'user') {
        // A message from you (typed, or said on a call), or one another bot, a routine or a program sent.
        if (!b.from || b.from.kind === 'voice') return postedLast('You');
        if (b.from.kind === 'routine') return { text: 'A routine ran last.', short: 'A routine ran last.', by: 'other' };
        if (b.from.kind === 'agent') return postedLast(/^claude\b/i.test(b.from.name) ? 'Claude' : firstName(b.from.name));
        return postedLast(firstName(b.from.name));
      }
      const words = plainText(splitReply(b.text).body);
      if (!oneLine(words)) continue;
      if (group && b.from?.name) {
        const name = firstName(b.from.name);
        const f = bothForms(words, LONG_MAX - name.length - 2)!;
        const sh = `${name} posted last.`.length <= SHORT_MAX ? `${name} posted last.` : f.short;
        return { text: `${name}: ${f.text}`, short: sh, forms: formsOf(`${name}: ${f.text}`, `${name}: ${f.mid}`, sh), by: 'member' };
      }
      const f = bothForms(words)!;
      return { text: f.text, short: f.short, forms: formsOf(f.text, f.mid, f.short), by: 'bot' };
    }
    if (b.type === 'card') {
      const c = cardLine(b);
      if (c) return c;
      continue;
    }
    // A line such as "Bo left" or "Running routine: X": newest in a group shows; in a bot's chat only when nothing else does.
    if (b.type === 'event' && !event) {
      event = withForms(b.text, 'event');
      if (group && event) return event;
    }
  }
  return event;
}
