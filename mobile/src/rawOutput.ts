// Tucks raw tool output (JSON blobs, logs, long dumps) in a bot message away from the prose, so a
// reply reads as an answer with an expandable "details" section instead of a wall of {"error":...}.
// Pure functions with no imports, used by the web app (via @shared) and copied verbatim to
// mobile/src/rawOutput.ts (tests/raw-output.mjs checks the copy stays identical).

export type Segment =
  | { kind: 'md'; text: string }
  /** summary is shown on the collapsed row; text is the full output, pretty-printed when JSON. */
  | { kind: 'raw'; summary: string; text: string };

/** Code fences whose language marks them as machine output rather than something to read. */
const RAW_LANGS = /^(json|jsonc|json5|ndjson|log|logs|output|stdout|stderr|trace|traceback|console|raw|xml|yaml|yml)$/i;
/** Any code block longer than this is collapsed too, whatever its language. */
const LONG_BLOCK = 15;
/** Inline JSON shorter than this stays in the sentence ({"a":1} reads fine). */
const MIN_INLINE_JSON = 40;
/** How far a multi-line JSON block may run before we stop trying to parse it. */
const MAX_JSON_LINES = 400;

function parseJson(s: string): unknown {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : undefined;
  } catch { return undefined; }
}

function clip(s: string, n = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

/** "Error: …" when the JSON is an error payload, otherwise null. */
function errorLine(v: any): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = v.error ?? v.errors;
  let msg: unknown = null;
  if (typeof e === 'string') msg = e;
  else if (e && typeof e === 'object') msg = e.message ?? e.detail ?? e.description ?? (Array.isArray(e) ? e[0]?.message ?? e[0] : null);
  else if (e === true || v.ok === false || v.success === false || v.status === 'error') msg = v.message ?? v.detail ?? v.reason ?? 'something went wrong';
  if (msg == null && typeof v.detail === 'string' && /error|fail|denied|invalid|not found/i.test(v.detail)) msg = v.detail;
  if (msg == null || typeof msg === 'object') return msg == null ? null : 'Error';
  return `Error: ${clip(String(msg))}`;
}

function lineCount(s: string): number { return s.split('\n').length; }

function rawFromJson(v: unknown): Segment {
  const text = JSON.stringify(v, null, 2);
  const n = lineCount(text);
  return { kind: 'raw', summary: errorLine(v) ?? `Raw output · ${n} line${n === 1 ? '' : 's'}`, text };
}

function rawFromText(text: string, lang = ''): Segment {
  const v = parseJson(text);
  if (v !== undefined) return rawFromJson(v);
  const n = lineCount(text);
  const what = /^(log|logs|stdout|stderr|console|trace|traceback)$/i.test(lang) ? 'Log' : 'Raw output';
  return { kind: 'raw', summary: `${what} · ${n} line${n === 1 ? '' : 's'}`, text };
}

/** Finds a JSON object or array embedded in a line of prose ("Failed: {"error":…}"). */
function inlineJson(line: string): { before: string; value: unknown; after: string } | null {
  const m = /(\{\s*"|\[\s*\{)/.exec(line);
  if (!m) return null;
  const start = m.index;
  // Try the longest candidate first: up to each closing brace/bracket from the end.
  for (let end = line.length; end > start; end--) {
    const ch = line[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    const cand = line.slice(start, end);
    if (cand.length < MIN_INLINE_JSON) return null;
    const v = parseJson(cand);
    if (v !== undefined) return { before: line.slice(0, start), value: v, after: line.slice(end) };
  }
  return null;
}

/**
 * Splits a bot message into readable markdown and collapsible raw output. Raw output is: fenced
 * code blocks marked json/log/output (or longer than 15 lines, or holding JSON), bare JSON
 * objects/arrays on their own lines, and long JSON pasted into a sentence. Everything else is left
 * as markdown, byte for byte, so normal replies render exactly as before.
 */
export function splitRawOutput(md: string): Segment[] {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n');
    if (text.trim()) out.push({ kind: 'md', text });
    buf = [];
  };
  const raw = (s: Segment) => { flush(); out.push(s); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      const mark = fence[2];
      const lang = fence[3] ?? '';
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(mark)) j++;
      if (j >= lines.length) { buf.push(...lines.slice(i)); break; } // still streaming: leave it
      const body = lines.slice(i + 1, j).join('\n');
      const looksJson = parseJson(body) !== undefined;
      if (RAW_LANGS.test(lang) || looksJson || j - i - 1 > LONG_BLOCK) raw(rawFromText(body, lang));
      else buf.push(...lines.slice(i, j + 1));
      i = j;
      continue;
    }
    if (/^\s*[[{]/.test(line)) {
      let found = -1;
      let acc = '';
      for (let j = i; j < lines.length && j < i + MAX_JSON_LINES; j++) {
        acc += (j > i ? '\n' : '') + lines[j];
        if (/[}\]]\s*,?\s*$/.test(lines[j]) && parseJson(acc.replace(/,\s*$/, '')) !== undefined) { found = j; break; }
      }
      if (found >= 0) {
        const v = parseJson(acc.replace(/,\s*$/, ''));
        // A one-line tiny object ({"a":1}) or a markdown link "[x](y)" is not worth hiding.
        if (found > i || acc.trim().length >= MIN_INLINE_JSON) { raw(rawFromJson(v)); i = found; continue; }
      }
    }
    const hit = inlineJson(line);
    if (hit) {
      const prose = `${hit.before.replace(/[\s:=-]+$/, '')}${hit.after.replace(/^[\s.,;]+$/, '')}`;
      const seg = rawFromJson(hit.value);
      if (prose.trim()) buf.push(prose);
      raw(seg);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.length ? out : [{ kind: 'md', text: md ?? '' }];
}

/** True when splitRawOutput would change anything, so callers can skip the extra work. */
export function hasRawOutput(md: string): boolean {
  return splitRawOutput(md).some((s) => s.kind === 'raw');
}
