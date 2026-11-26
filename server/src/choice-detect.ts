/**
 * Choice buttons (choices.ts), the pure part: checking a bot's choices, and spotting an obvious yes/no or
 * "this or that" question at the end of a reply for the fallback buttons. No database here, so tests and
 * any app can use it as it is.
 */

export interface ChoiceSpec { question: string; options: string[]; other?: boolean }

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const CHOICE_LIMITS = { options: 4, option: 60, question: 300 } as const;

/** A bot's loose input as a checked choice, or the reason it can't be shown. */
export function checkChoices(a: { question?: unknown; options?: unknown; other?: unknown }): ChoiceSpec | string {
  const question = clean(a.question, CHOICE_LIMITS.question);
  const seen = new Set<string>();
  const options = (Array.isArray(a.options) ? a.options : [])
    .map((o) => clean(o, CHOICE_LIMITS.option))
    .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  if (!question) return 'give the question';
  // One answer plus the "Other" box is fine ('Reply "approve all" or tell me which to change').
  if (options.length < (a.other === true ? 1 : 2)) return a.other === true ? 'give at least one option' : 'give at least two different options (or one with other: true)';
  if (options.length > CHOICE_LIMITS.options) return `give at most ${CHOICE_LIMITS.options} options (use show_view with a choice block for longer lists)`;
  return { question, options, other: a.other === true };
}

// ---------------- the fallback: spotting an obvious question ----------------

// "Should I ...?", "Do you want me to ...?": a yes or no.
const YES_NO = /^(?:so,?\s+|ok(?:ay)?,?\s+|and\s+|also,?\s+)?(?:should|shall|can|may|could)\s+(?:i|we)\b|^(?:so,?\s+|ok(?:ay)?,?\s+|and\s+|also,?\s+)?(?:do|would)\s+you\s+(?:want|like)\b|^(?:want|ok(?:ay)?|good)\s+(?:me\s+)?to\b|^(?:is|are)\s+(?:it|that|this|these|those)\s+(?:ok(?:ay)?|alright|all right|fine|right|correct)\b|^(?:sound|sounds)\s+good\b|^(?:ready|happy)\s+for\s+me\s+to\b|^(?:go\s+ahead|proceed)\b|^(?:does|do)\s+(?:that|this)\s+(?:work|look\s+right|sound\s+(?:good|right))\b/i;
// The lead-in of an either-or, dropped from the first option ("Should I hold at $1,000" -> "Hold at $1,000").
const LEAD = /^(?:so,?\s+|ok(?:ay)?,?\s+|and\s+|also,?\s+)?(?:(?:should|shall|can|could)\s+(?:i|we)|(?:do|would)\s+you\s+(?:want|like|prefer)(?:\s+(?:me|us))?(?:\s+to)?|want\s+me\s+to|would\s+you\s+rather(?:\s+i)?|(?:do\s+)?you\s+want(?:\s+me\s+to)?|which\s+(?:one|do\s+you\s+want|would\s+you\s+like)[^:,]*[:,]?)\s+/i;
// A question that is not a pick: open-ended words, or one aimed at the bot's own doubts.
const OPEN = /^(?:what|why|how|when|where|who|which\s+of\s+(?:these|the\s+following))\b|\b(?:anything\s+else|any\s+(?:other\s+)?questions|let\s+me\s+know)\b/i;

// Words that open a question about facts, not a pick between two things to do.
const AUX = /^(?:is|are|was|were|do|does|did|have|has|had|will|would|can|could|should|shall|may|might|must|am|i|it|this|that|there|you|they|we|he|she)\b/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s: string) => s.replace(/^[\s,;:–—-]+|[\s,;:.–—-]+$/g, '').replace(/^(?:to|either)\s+/i, '').trim();

/** The sentences of a text that end with a question mark, newest last, from its last two paragraphs. */
function questions(text: string): string[] {
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, '').trim();
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tail = paras.slice(-2).join('\n');
  // Only when the reply ends asking: a question in the middle of more text is often rhetorical.
  if (!/\?\s*\)?\s*$/.test(tail)) return [];
  const out: string[] = [];
  for (const line of tail.split(/\n+/)) {
    const l = line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim();
    // Split on sentence ends but keep amounts like $1,000.50 and "e.g." whole.
    for (const m of l.matchAll(/[^.!?]*?(?:\.(?=\d)[^.!?]*?)*\?/g)) {
      const q = m[0].trim();
      if (q.length > 3) out.push(q);
    }
  }
  return out;
}

/** One question as choices, or null when it isn't an obvious pick. */
export function choicesFor(q: string): ChoiceSpec | null {
  const question = q.replace(/^[^A-Za-z0-9$"'(]+/, '').trim();
  const bare = question.replace(/\?+$/, '').trim();
  if (!bare || question.length > 260 || OPEN.test(bare)) return null;
  // "this or that": exactly one " or " splitting two short sides (", or" too).
  const parts = bare.split(/,?\s+or\s+/i);
  if (parts.length === 2 && !/\bor\s+(?:not|something|anything|so)\b/i.test(bare)) {
    // With a lead-in ("Should I ... or ...?") or as a bare pick ("Tuesday or Wednesday?", "Hold at $1,000 or
    // budget $1,200?"); a bare one that opens like a question about facts ("Is it ... or ...?") is not a pick.
    const leadMatch = parts[0].match(LEAD);
    const barePick = !leadMatch && !AUX.test(bare) && words(bare) <= 14;
    if (leadMatch || barePick) {
      // "A, B, or C" gives three (up to four) options.
      const list = [...parts[0].replace(LEAD, '').split(/,\s+/), parts[1]].map(tidy);
      const lower = new Set(list.map((o) => o.toLowerCase()));
      if (list.length <= CHOICE_LIMITS.options && list.every((o) => o && words(o) <= 8) && lower.size === list.length) {
        return { question, options: list.map((o) => cap(o).slice(0, CHOICE_LIMITS.option)) };
      }
    }
    return null;
  }
  if (parts.length > 2) return null;
  if (YES_NO.test(bare)) return { question, options: ['Yes', 'No'] };
  return null;
}

// ---------------- the fallback: 'Reply "approve all" or tell me which to change' ----------------

// A quoted phrase: "x", “x”, 'x' or ‘x’ (single quotes hold no apostrophe, so "don't" never splits).
const QUOTED = String.raw`(?:"([^"\n]{1,60})"|“([^”\n]{1,60})”|'([^'\n]{1,60})'|‘([^’\n]{1,60})’)`;
// The instruction itself, at the start of the reply's last sentence.
const REPLY_WITH = new RegExp(String.raw`^(?:(?:just|simply|please)\s+)?(?:reply|respond|answer|say|type|text|send(?:\s+me)?|tell\s+me)(?:\s+(?:with|me))?\s+` + QUOTED, 'i');
// More quoted answers after it: ', "B"' or ' or "B"'.
const MORE = new RegExp(String.raw`^\s*(?:,\s*(?:or\s+)?|\s+or\s+)` + QUOTED, 'i');

/** The last sentence of a reply, when it is an instruction to answer with set words, as choices. */
export function replyPhraseChoices(text: string): ChoiceSpec | null {
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, '').trim();
  const last = body.split(/\n+/).map((l) => l.replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim()).filter(Boolean).pop() ?? '';
  // Its last sentence (amounts like $1,000.50 stay whole).
  const sentence = (last.match(/(?:[^.!?]|\.(?=\d))+[.!?]*\s*$/)?.[0] ?? last).trim();
  if (sentence.length > 260 || /\?\s*$/.test(sentence)) return null;
  const m = sentence.match(REPLY_WITH);
  if (!m) return null;
  const options = [m.slice(1, 5).find(Boolean)!];
  let rest = sentence.slice(m[0].length);
  for (let n = 0; n < CHOICE_LIMITS.options - 1; n++) {
    const more = rest.match(MORE);
    if (!more) break;
    options.push(more.slice(1, 5).find(Boolean)!);
    rest = rest.slice(more[0].length);
  }
  const opts = [...new Map(options.map((o) => [o.trim().toLowerCase(), cap(o.trim()).slice(0, CHOICE_LIMITS.option)])).values()].filter(Boolean);
  if (!opts.length || opts.some((o) => words(o) > 8)) return null;
  // Anything after the quoted answers ("or tell me which numbers to change") gets an Other box, and so does a
  // single answer, so there is always a second way to reply.
  const other = opts.length === 1 || /\w/.test(rest);
  return { question: sentence, options: opts, ...(other ? { other: true } : {}) };
}

/** Up to two obvious picks at the end of a bot's reply, for the fallback buttons. */
export function detectChoices(text: string): ChoiceSpec[] {
  const out: ChoiceSpec[] = [];
  for (const q of questions(text)) {
    const c = choicesFor(q);
    if (c) out.push(c);
  }
  if (!out.length) {
    const r = replyPhraseChoices(text);
    if (r) out.push(r);
  }
  return out.slice(-2);
}
