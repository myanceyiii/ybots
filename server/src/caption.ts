/**
 * The live "thinking" line in the chat (agent/loop.ts sets it, every app shows it).
 *
 * Two forms of the same thought:
 * - `short`: a clean one-line recap for the collapsed bubble. It is the model's own heading when it wrote one,
 *   else the whole sentence when that is short, else a phrase that stops on a whole word. It never ends in "…".
 * - `full`: everything the model said in that thought, for the expanded bubble. Never cut mid-word.
 */

/** Longest recap, in characters. Fits one line in the narrowest bubble (a phone at 360 dp). */
export const SHORT_MAX = 48;
/** Longest full thought kept, in characters. Cut only at a sentence end. */
export const FULL_MAX = 600;

export interface CaptionParts { short: string; full: string | null }

// Lead-ins that say nothing ("I'm", "Let me", "Okay, so I need to"). The verb after them starts the recap.
const LEAD_IN = /^(?:(?:ok(?:ay)?|alright|so|now|next|first|then|hmm|right|well)[,.!]?\s+)*(?:i(?:'|’)m\s+(?:now\s+|still\s+|just\s+)?(?:(?:going|trying|about)\s+to\s+)?|i\s+am\s+(?:now\s+|still\s+)?(?:(?:going|trying|about)\s+to\s+)?|i(?:'|’)ll\s+|i\s+will\s+|i\s+(?:need|want|have|should|must|plan|intend)\s+to\s+|i(?:'|’)d\s+like\s+to\s+|let\s+me\s+|let(?:'|’)s\s+|we\s+(?:need|should)\s+to\s+|i(?:'|’)ve\s+got\s+to\s+|(?:i|we)\s+(?:will\s+)?)/i;

// A phrase never ends on one of these: "Checking whether the" reads as cut off, "Checking the budget tools" does not.
const DANGLING = new Set(('a an the and or but nor so yet to of in on at by for from with into onto about as than that which who whom whose ' +
  'whether if when while because since though although unless until this these those my your our their its his her ' +
  'is are was were be been being do does did can could would should will may might must not no any some each every ' +
  'what how why where via per like just also then very more most less such own other both either neither i we it ' +
  'up out over under after before between through during without within against toward towards upon among around').split(' '));

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const noStop = (s: string) => s.replace(/[\s.,;:!?…–—-]+$/u, '');

/** The full thought, at most FULL_MAX characters, cut only after a whole sentence (or a whole word as a last resort). */
function fullText(text: string): string {
  const t = clean(text);
  if (t.length <= FULL_MAX) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const s of sentences) {
    if ((out ? out.length + 1 : 0) + s.length > FULL_MAX) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out) return out;
  const words = t.slice(0, FULL_MAX + 1).split(' ');
  words.pop();
  return `${noStop(words.join(' '))}…`;
}

/** A short recap of one sentence: drop the lead-in, then keep whole words up to SHORT_MAX, never ending on a filler word. */
export function shortRecap(sentence: string, max = SHORT_MAX): string {
  let s = noStop(clean(sentence));
  const stripped = s.replace(LEAD_IN, '');
  // Keep the lead-in when nothing useful follows it ("I will." stays as it is).
  if (stripped.length >= 3 && stripped !== s) s = cap(stripped);
  if (s.length <= max) return s;
  // Too long: write it headline style first (no "the", "a", "an") so more of the thought fits.
  s = s.replace(/\s+(?:the|a|an)\s+/gi, ' ');
  if (s.length <= max) return s;
  // Prefer ending at a natural break (comma, colon, dash) when that leaves enough to read.
  const words = s.split(' ');
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join(' ').length > max) break;
    kept.push(w);
  }
  if (!kept.length) return noStop(words[0].slice(0, max));
  for (let i = kept.length - 1; i >= 2; i--) {
    if (/[,;:]$/.test(kept[i]) && kept.slice(0, i + 1).join(' ').length >= (max === SHORT_MAX ? 18 : Math.round(max * 0.6))) { kept.length = i + 1; break; }
  }
  while (kept.length > 1 && DANGLING.has(noStop(kept[kept.length - 1]).toLowerCase().replace(/[’']s$/, ''))) kept.pop();
  return noStop(kept.join(' '));
}

/**
 * Both forms of one status line (Hermes' status text, or one thought). `full` is null when it says no more than
 * `short`, so the apps show no expand control.
 */
export function captionParts(text: string, heading?: string): CaptionParts | null {
  const full = fullText(text);
  const head = heading ? noStop(clean(heading)) : '';
  if (!full && !head) return null;
  if (full.length < 4 && !head) return null;
  const first = full.split(/(?<=[.!?])\s+/)[0] ?? full;
  const short = head && head.length <= SHORT_MAX + 16 ? head : shortRecap(first || head);
  return { short, full: full && noStop(full) !== short ? full : null };
}

/**
 * The live line out of the model's running reasoning. Reasoning summaries come as "**Heading**" then a
 * paragraph; raw reasoning is just paragraphs. Uses the latest heading and the paragraph under it.
 */
export function captionFrom(reasoning: string): CaptionParts | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) {
    const last = titles[titles.length - 1];
    const after = reasoning.slice((last.index ?? 0) + last[0].length).trim();
    const para = after.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)[0] ?? '';
    return captionParts(para, last[1].trim());
  }
  const para = reasoning.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  if (!para) return null;
  return captionParts(para);
}
