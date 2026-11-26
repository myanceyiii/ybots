import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../toast';
import * as Clipboard from 'expo-clipboard';
import { Icon } from './Icon';
import { tap } from '../haptics';
import { sized } from '../prefs';
import { Linking, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { color } from '../theme';
import { splitRawOutput } from '../rawOutput';
import { useSimple } from '../simple';

/**
 * Markdown for bot replies, so they read like the web app: headings, bullet, numbered and task
 * lists (nested), tables, code blocks, quotes, rules, and inline bold, italic, strikethrough, code
 * and links. Raw tool output (JSON, logs, long dumps) folds into a tappable "details" row.
 */
type Block =
  | { kind: 'p' | 'quote' | 'hr'; text: string }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'h'; text: string; level: number }
  | { kind: 'li' | 'ol'; text: string; n: string; depth: number }
  | { kind: 'table'; rows: string[][]; align: ('left' | 'right' | 'center')[] };

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const code: string[] = [];
      // The word after the fence names the language ("```python"): shown above the block.
      const lang = (line.trim().replace(/^(```|~~~)+/, '').trim().split(/\s+/)[0] ?? '').replace(/[^\w+#.-]/g, '').slice(0, 20);
      for (i++; i < lines.length && !/^\s*(```|~~~)/.test(lines[i]); i++) code.push(lines[i]);
      out.push({ kind: 'code', text: code.join('\n'), lang });
      continue;
    }
    let m: RegExpExecArray | null;
    if (!line.trim()) { flush(); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flush();
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')) as ('left' | 'right' | 'center')[];
      const rows = [cells(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      out.push({ kind: 'table', rows, align });
      continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); out.push({ kind: 'h', text: m[2], level: m[1].length }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ kind: 'hr', text: '' }); continue; }
    if ((m = /^(\s*)[-*•+]\s+(.*)$/.exec(line))) {
      flush();
      const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      let text = m[2];
      let n = depth ? '◦' : '•';
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) { n = task[1].trim() ? '☑' : '☐'; text = task[2]; }
      out.push({ kind: 'li', text, n, depth });
      continue;
    }
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'ol', text: m[3], n: `${m[2]}.`, depth: Math.min(3, Math.floor(m[1].length / 2)) });
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); out.push({ kind: 'quote', text: m[1] }); continue; }
    // A wrapped continuation of a list item belongs to that item, not a new paragraph.
    const prev = out[out.length - 1];
    if (!para.length && prev && (prev.kind === 'li' || prev.kind === 'ol') && /^\s{2,}\S/.test(line) && lines[i - 1]?.trim()) { prev.text += ` ${line.trim()}`; continue; }
    para.push(line);
  }
  flush();
  return out;
}

// Inline marks, as the website's GFM renderer shows them: bold, strike, code, images, links, bare URLs,
// *italic* and _italic_ (only between spaces or punctuation, so snake_case names stay as they are).
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|(?:^|(?<=[\s(]))_[^_\s][^_]*_(?=$|[\s.,;:!?)])|https?:\/\/[^\s)]+)/g;

/** Only web and mail links open from a message; anything else (intent:, file:, javascript:, app schemes) stays text. */
export function safeUrl(url: string): string | null {
  // A plain check: React Native's URL class does not implement every part (protocol among them on some versions).
  const u = url.trim();
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(u) ? u : null;
}
const open = (url: string) => { const u = safeUrl(url); if (u) Linking.openURL(u).catch(() => toast("Couldn't open that link.")); };
/** A long press on a link copies its address. */
const copyLink = (url: string) => { const u = safeUrl(url); if (u) Clipboard.setStringAsync(u).then(() => { tap('light'); toast('Link copied'); }, () => {}); };

function inline(text: string, ink: string, key = 'i'): React.ReactNode[] {
  const parts = text.split(INLINE).filter((p) => p !== '' && p !== undefined);
  return parts.map((p, i) => {
    const k = `${key}${i}`;
    if (/^(\*\*[^*]+\*\*|__[^_]+__)$/.test(p)) return <Text key={k} style={{ fontWeight: '600' }}>{inline(p.slice(2, -2), ink, k)}</Text>;
    if (p.startsWith('~~') && p.endsWith('~~') && p.length > 4) return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{inline(p.slice(2, -2), ink, k)}</Text>;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <Text key={k} style={{ fontFamily: 'monospace', fontSize: 14, backgroundColor: color.codeFill }}>{p.slice(1, -1)}</Text>;
    let m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(p);
    // A picture in a message: shown as a link to it (opened in the browser), named by its alt text.
    if (m) { const url = safeUrl(m[2]); return url ? <Text key={k} style={{ color: color.link, textDecorationLine: 'underline' }} onPress={() => open(url)} onLongPress={() => copyLink(url)} accessibilityRole="link">🖼 {m[1] || 'Picture'}</Text> : (m[1] || ''); }
    m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    if (m) { const url = safeUrl(m[2]); return url ? <Text key={k} style={{ color: color.link, textDecorationLine: 'underline' }} onPress={() => open(url)} onLongPress={() => copyLink(url)} accessibilityRole="link">{m[1]}</Text> : <Text key={k}>{m[1]}</Text>; }
    if (/^https?:\/\//.test(p)) return <Text key={k} style={{ color: color.link, textDecorationLine: 'underline' }} onPress={() => open(p)} onLongPress={() => copyLink(p)} accessibilityRole="link">{p}</Text>;
    if ((m = /^\*(.+)\*$/.exec(p)) && p.length > 2) return <Text key={k} style={{ fontStyle: 'italic' }}>{m[1]}</Text>;
    if ((m = /^_(.+)_$/.exec(p)) && p.length > 2) return <Text key={k} style={{ fontStyle: 'italic' }}>{m[1]}</Text>;
    return p;
  });
}

/** How many characters a cell shows once its Markdown marks are gone. */
const plainLen = (s: string) => s.replace(/\*\*|__|~~|`|\[([^\]]*)\]\([^)]*\)/g, '$1').length;

const HEADING = [0, 19, 17.5, 16.5, 16, 16, 16];

/**
 * A table drawn as plain rows that wrap inside the bubble. It used to sit in a sideways ScrollView with cells that
 * grew from a 72 px basis; on Android (new architecture) those cells were measured at the narrow basis but drawn
 * wider, so the table took far more height than its text (a big blank block, Leonard's briefing, 2026-11-25) and
 * the bubble's height no longer matched what was drawn (the end of the message spilled under the buttons).
 * Up to three columns stay side by side; wider tables become one small block per row ("Header: value" lines),
 * which reads better on a phone than a sideways scroll.
 */
function Table({ rows, align, ink }: { rows: string[][]; align: ('left' | 'right' | 'center')[]; ink: string }) {
  const cols = Math.max(...rows.map((r) => r.length));
  const { width } = useWindowDimensions();
  // Every row shares the same column widths: each column's share follows its longest cell, and the table asks the
  // bubble for about the room its text needs (never more than a chat bubble can be wide).
  const longest = Array.from({ length: cols }, (_, ci) => Math.max(3, ...rows.map((r) => plainLen(r[ci] ?? ''))));
  const share = longest.map((n) => Math.min(n, 28));
  const want = Math.min(share.reduce((a, n) => a + n * sized(7.6), 0) + (cols - 1) * 12, width * 0.86 - 64);
  const line = (ri: number) => ({ borderBottomWidth: ri === rows.length - 1 ? 0 : 0.5, borderBottomColor: color.secondaryBorder, paddingVertical: 5 });
  const cell = { color: ink, fontSize: sized(14.5), lineHeight: sized(20), fontVariant: ['tabular-nums' as const] };
  if (cols <= 3) return (
    <View style={{ minWidth: Math.max(0, want) }}>
      {rows.map((r, ri) => (
        <View key={ri} style={[{ flexDirection: 'row', gap: 12 }, line(ri)]}>
          {Array.from({ length: cols }, (_, ci) => (
            <Text key={ci} selectable style={[cell, { flexGrow: share[ci], flexShrink: 1, flexBasis: 0, fontWeight: ri === 0 ? '600' : '400', textAlign: align[ci] ?? 'left' }]}>
              {inline(r[ci] ?? '', ink, `t${ri}-${ci}`)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
  const [head, ...body] = rows;
  return (
    <View>
      {body.map((r, ri) => (
        <View key={ri} style={[{ gap: 1 }, { ...line(ri + 1), borderBottomWidth: ri === body.length - 1 ? 0 : 0.5 }]}>
          <Text selectable style={[cell, { fontWeight: '600' }]}>{inline(r[0] ?? '', ink, `t${ri}-0`)}</Text>
          {Array.from({ length: cols - 1 }, (_, k) => k + 1).filter((ci) => (r[ci] ?? '').trim()).map((ci) => (
            <Text key={ci} selectable style={cell}>
              <Text style={{ color: color.inkSecondary }}>{head[ci] ? `${head[ci]}: ` : ''}</Text>
              {inline(r[ci] ?? '', ink, `t${ri}-${ci}`)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function Raw({ summary, text, ink }: { summary: string; text: string; ink: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderWidth: 0.5, borderColor: color.secondaryBorder, borderRadius: 10, backgroundColor: color.codeBlock, overflow: 'hidden' }}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${summary}. ${open ? 'Hide' : 'Show'} details`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text style={{ color: color.inkSecondary, fontSize: 13, width: 10 }}>{open ? '⌄' : '›'}</Text>
        <Text numberOfLines={2} style={{ flex: 1, color: color.inkSecondary, fontSize: 13.5 }}>{summary}</Text>
        <Text style={{ color: color.inkSecondary, fontSize: 12.5, opacity: 0.8 }}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {open && (
        <ScrollView horizontal style={{ borderTopWidth: 0.5, borderTopColor: color.secondaryBorder, maxHeight: 320 }}>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 18, color: ink, padding: 10 }}>{text}</Text>
        </ScrollView>
      )}
    </View>
  );
}

/** A code block: its language and a Copy button on top (as on the web), the code scrolling sideways under them. */
function CodeBlock({ text, lang, ink }: { text: string; lang: string; ink: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    Clipboard.setStringAsync(text).then(() => {
      tap('light');
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    }, () => {});
  };
  return (
    <View style={{ backgroundColor: color.codeFill, borderRadius: 10, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 10, paddingRight: 2, minHeight: 32, borderBottomWidth: 0.5, borderBottomColor: color.secondaryBorder }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, fontWeight: '600', color: color.inkMuted }}>{lang || 'Code'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy this code'} onPress={copy} hitSlop={8}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 32, borderRadius: 8, opacity: pressed ? 0.6 : 1 })}>
          <Icon name={copied ? 'check' : 'copy'} size={14} color={color.inkSecondary} />
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: color.inkSecondary }}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ fontFamily: 'monospace', fontSize: 13.5, lineHeight: 19, color: ink, padding: 10 }}>{text}</Text>
      </ScrollView>
    </View>
  );
}

function MarkdownBlocks({ text, ink }: { text: string; ink: string }) {
  const base = { color: ink, fontSize: sized(16), lineHeight: sized(22) };
  const bs = useMemo(() => blocks(text), [text]);
  return (
    <>
      {bs.map((b, i) => {
        if (b.kind === 'h') return <Text key={i} selectable accessibilityRole="header" style={[base, { fontWeight: '600', fontSize: HEADING[b.level], lineHeight: HEADING[b.level] + 6, marginTop: i ? 6 : 0 }]}>{inline(b.text, ink)}</Text>;
        if (b.kind === 'hr') return <View key={i} style={{ height: 0.5, backgroundColor: color.secondaryBorder, marginVertical: 4 }} />;
        if (b.kind === 'table') return <Table key={i} rows={b.rows} align={b.align} ink={ink} />;
        if (b.kind === 'code') return <CodeBlock key={i} text={b.text} lang={b.lang} ink={ink} />;
        if (b.kind === 'quote') return <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: color.secondaryBorder, paddingLeft: 10 }}><Text selectable style={[base, { color: color.inkSecondary }]}>{inline(b.text, ink)}</Text></View>;
        if (b.kind === 'li' || b.kind === 'ol') return (
          <View key={i} style={{ flexDirection: 'row', gap: 8, paddingRight: 4, paddingLeft: b.depth * 18, marginTop: -2 }}>
            <Text style={[base, { minWidth: b.kind === 'ol' ? (b.n.length > 2 ? 30 : 20) : 12 }]}>{b.n}</Text>
            <Text selectable style={[base, { flex: 1 }]}>{inline(b.text, ink)}</Text>
          </View>
        );
        return <Text key={i} selectable style={base}>{inline(b.text, ink)}</Text>;
      })}
    </>
  );
}

export function Markdown({ text, ink = color.ink }: { text: string; ink?: string }) {
  // A scoped sign-in's view (src/simple.ts) leaves raw tool output out when the answer has words of its own.
  const simple = useSimple();
  const all = useMemo(() => splitRawOutput(text), [text]);
  const segments = simple && all.some((s) => s.kind === 'md' && s.text.trim()) ? all.filter((s) => s.kind === 'md') : all;
  return (
    <View style={{ gap: 8 }}>
      {segments.map((s, i) => (s.kind === 'md'
        ? <MarkdownBlocks key={i} text={s.text} ink={ink} />
        : <Raw key={i} summary={s.summary} text={s.text} ink={ink} />))}
    </View>
  );
}
