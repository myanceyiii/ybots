// Plain text for a chat message: what Copy and Share hand out, and how Reply quotes a message.
// Pure functions with no imports, used by the web app (via @shared) and copied verbatim to
// mobile/src/messageText.ts (tests/message-text.mjs checks the copy stays identical).

/** Markdown to readable plain text: no **, #, backticks or link syntax; lists and code kept. */
export function plainText(md: string): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of (md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { out.push(raw); continue; }
    let line = raw;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(''); continue; } // --- rule
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // table divider
    line = line.replace(/^(\s*)#{1,6}\s+/, '$1'); // headings
    line = line.replace(/^(\s*)>\s?/, '$1'); // blockquote
    line = line.replace(/^(\s*)[*+]\s+(\[[ xX]\]\s+)?/, '$1- $2'); // bullets as "- "
    line = line.replace(/^(\s*)-\s+\[([ xX])\]\s+/, (_m, s, x) => `${s}- ${x.trim() ? '☑' : '☐'} `);
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ·  ');
    out.push(inline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(s: string): string {
  // Code spans keep their content untouched; everything else loses its markup.
  return s.split(/(`+[^`]*`+)/).map((part, i) => {
    if (i % 2) return part.replace(/^`+|`+$/g, '');
    return part
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_m, t: string, u: string) => (t === u || /^mailto:/i.test(u) ? t : `${t} (${u})`))
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1');
  }).join('');
}

const QUOTE_LINES = 4;
const QUOTE_CHARS = 280;

/** A short excerpt of a message for a reply: plain text, at most 4 lines and 280 characters. */
export function replyExcerpt(md: string): string {
  const lines = plainText(md).split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l || (i > 0 && a[i - 1]));
  let text = lines.slice(0, QUOTE_LINES).join('\n').trim();
  let cut = lines.length > QUOTE_LINES;
  if (text.length > QUOTE_CHARS) {
    text = text.slice(0, QUOTE_CHARS);
    const space = text.lastIndexOf(' ');
    if (space > QUOTE_CHARS * 0.6) text = text.slice(0, space);
    cut = true;
  }
  return cut ? `${text.trimEnd()}…` : text;
}

export interface ReplyTarget {
  /** Who wrote the message being answered. */
  name: string;
  /** replyExcerpt() of that message. */
  excerpt: string;
  /** In a group chat, @mention the writer so the message goes to it. */
  mention?: boolean;
}

/** The message actually sent for a reply: the excerpt as a "> " quote, then the answer. */
export function composeReply(answer: string, to: ReplyTarget): string {
  const quote = to.excerpt.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  let body = answer.trim();
  if (to.mention && !body.toLowerCase().includes(`@${to.name.toLowerCase()}`)) body = `@${to.name} ${body}`;
  return `${quote}\n\n${body}`;
}

/** Splits a sent reply back into its quote and its answer, so the bubble can show the quote apart. */
export function splitReply(text: string): { quote: string | null; body: string } {
  const lines = (text ?? '').split('\n');
  let n = 0;
  while (n < lines.length && /^>( |$)/.test(lines[n])) n++;
  if (!n || n === lines.length || lines[n].trim() !== '') return { quote: null, body: text };
  return { quote: lines.slice(0, n).map((l) => l.replace(/^> ?/, '')).join('\n'), body: lines.slice(n + 1).join('\n') };
}

// ---- Editing one of your own sent messages ---------------------------------------------------
// Edit puts your words back in the message box; Send posts them as a new message and the old one is
// marked "Edited". A reply keeps its quote, so only your own words are put in the box.

/** The words to put in the message box when you edit a message you sent (a reply's quote left out). */
export function editDraft(text: string): string {
  return splitReply(text ?? '').body;
}

/** The edited message as sent: the original's reply quote (if it had one) above the new words. */
export function composeEdit(original: string, words: string): string {
  const { quote } = splitReply(original ?? '');
  const body = (words ?? '').trim();
  if (quote === null) return body;
  return `${quote.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n${body}`;
}

/** Whether an edit changes anything (spaces at the ends do not count). */
export function editChanged(original: string, words: string): boolean {
  return editDraft(original).trim() !== (words ?? '').trim();
}

// ---- @mentions in a group chat's message box -------------------------------------------------
// The server decides who answers with agent/room-mentions.ts (whole @name, any case, longest name
// first). These helpers follow the same rules so what the apps highlight is what the server reads.

const NAME_CHAR = /[0-9A-Za-z_À-ɏͰ-￿]/;
const BEFORE_AT = /[0-9A-Za-z_@.+/\-À-ɏͰ-￿]/;

/** The @name being typed just before the cursor, if any: where its @ is and the text after it. */
export function mentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = (text ?? '').slice(0, Math.max(0, cursor));
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && BEFORE_AT.test(before[at - 1])) return null; // an email address, not a mention
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n\r]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Members whose name fits a typed @query: names that start with it first, then names with a later word that does. */
export function mentionMatches<T extends { name: string }>(members: T[], query: string): T[] {
  const q = query.toLowerCase();
  const first = members.filter((m) => m.name.toLowerCase().startsWith(q));
  const later = members.filter((m) => !first.includes(m) && m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  return [...first, ...later];
}

/** Puts "@Name " where the @query being typed is. Returns the new text and where the cursor goes. */
export function insertMention(text: string, start: number, cursor: number, name: string): { text: string; cursor: number } {
  const rest = text.slice(cursor).replace(/^[^\s]*/, ''); // the rest of a half-typed word goes too
  const tail = /^\s/.test(rest) ? rest : ` ${rest}`;
  return { text: `${text.slice(0, start)}@${name}${tail}`, cursor: start + name.length + 2 };
}

/** Splits text into plain parts and @mentions of the given member names, for highlighting. */
export function mentionParts(text: string, names: string[]): { text: string; mention: boolean }[] {
  const src = text ?? '';
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const parts: { text: string; mention: boolean }[] = [];
  let plainFrom = 0;
  let i = src.indexOf('@');
  while (sorted.length && i >= 0) {
    let len = 0;
    if (i === 0 || !BEFORE_AT.test(src[i - 1])) {
      const lower = src.slice(i + 1).toLowerCase();
      const name = sorted.find((n) => lower.startsWith(n.toLowerCase()) && !NAME_CHAR.test(lower[n.length] ?? ' ') && lower[n.length] !== '-');
      if (name) len = name.length + 1;
    }
    if (len) {
      if (i > plainFrom) parts.push({ text: src.slice(plainFrom, i), mention: false });
      parts.push({ text: src.slice(i, i + len), mention: true });
      plainFrom = i + len;
    }
    i = src.indexOf('@', i + Math.max(len, 1));
  }
  if (plainFrom < src.length || !parts.length) parts.push({ text: src.slice(plainFrom), mention: false });
  return parts;
}
