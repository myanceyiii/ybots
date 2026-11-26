import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { Bot, Client, Page, PageBlock, PageOp, PageVersionInfo } from '../api';
import { Header, HeaderTitle, Notice, PillButton, RoundButton, Sheet, SheetRow } from '../components/ui';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { onPageEvent } from '../pageBus';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '../pageChart';
import { color, type, currentScheme } from '../theme';
import { DownloadedNote, downloadToPhone, type Downloaded } from './Files';
import { Calc, type Change } from '../components/ViewCard';
import { formatCalc, runCalc, type CalcInput } from '../calc';

/** The message "Send these numbers" posts from a Page; the same words as server/src/calc-block.ts calcMessage. */
function calcMessage(b: any, where = ''): string {
  const vals: Record<string, number> = Object.fromEntries((b.inputs as CalcInput[]).map((i) => [i.id, Number.isFinite(b.values?.[i.id]) ? b.values[i.id] : i.value]));
  const text = (i: CalcInput, v: number) => (i.kind === 'choice' ? i.options?.find((o) => o.value === v)?.label ?? String(v) : i.kind === 'toggle' ? (v ? 'yes' : 'no') : formatCalc(v, { prefix: i.prefix ?? '', unit: i.unit }));
  const res = runCalc(b.inputs, b.outputs, vals);
  return `${b.title ? `${b.title}${where}` : `Calculator${where}`}:\n${(b.inputs as CalcInput[]).map((i) => `- ${i.label}: ${text(i, vals[i.id])}`).join('\n')}\n${res.map((r) => `- ${r.label}: ${r.text}`).join('\n')}`;
}

/**
 * A Page on the phone: the same blocks, editing, history and export as the web and Windows file pane
 * (web/src/components/files/PageView.tsx; server/src/pages.ts). Each edit is a small change the server
 * numbers and records; the bot's changes arrive live and get a short highlight. Buttons and forms only
 * send a chat message as you.
 */

type B = PageBlock & Record<string, any>;
type Ops = (l: PageOp[]) => Promise<unknown>;

const EXPORTS: { format: string; label: string; table?: boolean }[] = [
  { format: 'md', label: 'Markdown' }, { format: 'docx', label: 'Word' }, { format: 'pdf', label: 'PDF' },
  { format: 'html', label: 'Web page (HTML)' }, { format: 'odt', label: 'OpenDocument' }, { format: 'txt', label: 'Plain text' },
  { format: 'csv', label: 'Table as CSV', table: true }, { format: 'xlsx', label: 'Table as Excel', table: true },
];
const NEW_BLOCKS: { label: string; block: Record<string, unknown> }[] = [
  { label: 'Text', block: { type: 'text', md: '' } },
  { label: 'Heading', block: { type: 'heading', text: 'Heading', level: 2 } },
  { label: 'Checklist', block: { type: 'checklist', items: [{ text: '', done: false }] } },
  { label: 'Table', block: { type: 'table', columns: ['Item', 'Amount'], rows: [['', '']] } },
  { label: 'Note', block: { type: 'callout', tone: 'info', md: '' } },
  { label: 'Choice', block: { type: 'choice', question: 'Which one?', options: ['Option 1', 'Option 2'] } },
  { label: 'Divider', block: { type: 'divider' } },
];
const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const box = () => ({ backgroundColor: color.surface, borderRadius: 12, borderWidth: 1, borderColor: color.hairline } as const);

export function PageScreen({ api, bot, path, onBack, onOpenFile }: { api: Client; bot: Bot; path: string; onBack: () => void; onOpenFile?: (p: string) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [saved, setSaved] = useState<Downloaded>(null);
  const [sheet, setSheet] = useState<'menu' | 'export' | 'history' | 'add' | null>(null);
  const [history, setHistory] = useState<PageVersionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const lastVersion = useRef(0);
  // A version from History being looked at before restoring it (read-only).
  const [peek, setPeek] = useState<Page | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Answers can come back out of order (a load racing an edit): an older version never replaces a newer one.
  const [dest, setDest] = useState<{ sendTo?: string; sendToTitle?: string }>({});
  const accept = (p: Page) => {
    if (p.version < lastVersion.current) return false;
    lastVersion.current = p.version;
    setPage(p);
    return true;
  };
  const addAfter = useRef<string>('end');

  const load = useCallback(async () => {
    try {
      const p = await api.page(bot.id, path);
      setDest({ sendTo: p.sendTo, sendToTitle: p.sendToTitle });
      if (p.version < lastVersion.current) return;
      setPage((old) => {
        if (old) {
          const changed = p.blocks.filter((b) => b.byKind === 'bot' && b.rev > old.version).map((b) => b.id);
          if (changed.length) { setFresh(new Set(changed)); setTimeout(() => setFresh(new Set()), 4000); }
        }
        return p;
      });
      lastVersion.current = p.version;
      setError(null);
    } catch (e: any) { setError(e?.message ?? 'Couldn’t open it'); }
  }, [api, bot.id, path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onPageEvent((ev) => { if (ev.botId === bot.id && ev.path === path && ev.version > lastVersion.current) load(); }), [bot.id, path, load]);

  const ops: Ops = useCallback(async (list) => {
    try {
      const r = await api.pageOps(bot.id, path, list);
      accept(r.page);
      const bad = r.results.find((x) => !x.ok && !x.conflict);
      if (bad) setNote({ text: bad.error ?? 'That change didn’t go in.', error: true });
      else if (r.results.some((x) => x.conflict)) setNote({ text: `${bot.name} changed that part just before you. Pick which version to keep on the block.` });
      return r;
    } catch (e: any) { setNote({ text: e?.message ?? 'Couldn’t save that', error: true }); return null; }
  }, [api, bot.id, bot.name, path]);

  // Buttons and calculators send into the chat the Page came from (a side chat while it is there), else the main chat.
  const say = useCallback(async (text: string) => {
    try {
      await api.send(dest.sendTo || bot.id, text);
      setNote({ text: `Sent to ${bot.name}${dest.sendTo && dest.sendTo !== bot.id && dest.sendToTitle ? ` in “${dest.sendToTitle}”` : ''}` });
      return true;
    }
    catch (e: any) { setNote({ text: e?.message ?? 'Couldn’t send it', error: true }); return false; }
  }, [api, bot.id, bot.name, dest]);

  const doExport = async (format: string) => {
    setSheet(null);
    setNote({ text: 'Making the file…' }); setSaved(null);
    try {
      // The server makes the file beside the Page (server/src/pages.ts); then it is downloaded like any file.
      const f = await api.pageExport(bot.id, path, format);
      const d = await downloadToPhone(api, bot.id, f.path);
      setNote(d ? null : { text: `Saved ${f.name} beside the Page.` });
      setSaved(d);
    } catch (e: any) { setNote({ text: `Couldn’t download it: ${e?.message ?? ''}`, error: true }); }
  };
  const restore = async (v: number | 'undo') => {
    setSheet(null);
    if (restoring) return;
    setRestoring(true);
    try { const p = await api.pageRestore(bot.id, path, v); accept(p); setPeek(null); setNote({ text: v === 'undo' ? 'Undone' : `Restored version ${v}` }); }
    catch (e: any) { setNote({ text: e?.message ?? 'Couldn’t do that', error: true }); }
    finally { setRestoring(false); }
  };
  const look = async (v: number) => {
    setSheet(null);
    try { setPeek(await api.pageVersion(bot.id, path, v)); }
    catch (e: any) { setNote({ text: e?.message ?? 'Couldn’t open that version', error: true }); }
  };
  const openHistory = async () => {
    setSheet('history');
    try { setHistory((await api.pageHistory(bot.id, path)).versions); } catch (e: any) { setNote({ text: e?.message ?? '', error: true }); }
  };

  const hasTable = !!page?.blocks.some((b) => b.type === 'table');
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{peek?.title ?? page?.title ?? path.split('/').pop()!.replace(/\.page\.json$/i, '')}</HeaderTitle>
        <RoundButton icon="more" label="Page menu" onPress={() => setSheet('menu')} />
      </Header>
      <Text style={[type.caption, { paddingHorizontal: 16, paddingBottom: 8, fontSize: 13 }]}>{page ? `Page · version ${page.version} · ${ago(page.updatedAt)}` : ''}</Text>
      {saved && <DownloadedNote d={saved} />}
      {note && <Pressable onPress={() => setNote(null)}><Text style={[type.caption, { paddingHorizontal: 16, paddingBottom: 8, color: note.error ? color.problemInk : color.inkMuted }]}>{note.text}</Text></Pressable>}
      {peek && (
        <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: color.infoFill, gap: 8 }}>
          <Text style={{ fontSize: 13.5, color: color.ink }}>{`Looking at version ${peek.version}. Nothing here can be edited; tap Restore to bring it back.`}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title={restoring ? 'Restoring…' : 'Restore this version'} disabled={restoring || peek.version === page?.version} onPress={() => restore(peek.version)} />
            <PillButton title="Close" kind="secondary" onPress={() => setPeek(null)} />
          </View>
        </View>
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, gap: 10 }} keyboardShouldPersistTaps="handled">
        {peek ? (
          <View pointerEvents="none" style={{ gap: 10 }}>
            {peek.blocks.map((b) => <BlockBody key={b.id} b={b as B} page={peek} api={api} bot={bot} ops={async () => null} say={async () => false} />)}
          </View>
        ) : error ? <Notice tone="problem">{error}</Notice> : !page ? <ActivityIndicator color={color.ink} /> : (
          <>
            {!page.blocks.length && <Text style={[type.caption, { textAlign: 'center', paddingVertical: 20 }]}>{`This Page is empty. Add a block, or ask ${bot.name} to fill it in.`}</Text>}
            {page.blocks.map((b, i) => (
              <Pressable key={b.id} onLongPress={() => setSelected(selected === b.id ? null : b.id)} delayLongPress={350}
                style={{ borderRadius: 10, padding: 4, marginHorizontal: -4, backgroundColor: fresh.has(b.id) ? color.infoFill : selected === b.id ? color.fill : 'transparent' }}>
                {b.alt && <Clash b={b as B} onKeep={(keep) => ops([{ op: 'resolve', id: b.id, keep }])} />}
                <BlockBody b={b as B} page={page} api={api} bot={bot} ops={ops} say={say} onOpenFile={onOpenFile} />
                {selected === b.id && (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <PillButton title="Up" kind="secondary" disabled={i === 0} onPress={() => ops([{ op: 'move', id: b.id, after: i <= 1 ? 'start' : page.blocks[i - 2].id }])} />
                    <PillButton title="Down" kind="secondary" disabled={i === page.blocks.length - 1} onPress={() => ops([{ op: 'move', id: b.id, after: page.blocks[i + 1].id }])} />
                    <PillButton title="Add below" kind="secondary" onPress={() => { addAfter.current = b.id; setSheet('add'); }} />
                    <PillButton title="Delete" kind="secondary" onPress={() => { setSelected(null); ops([{ op: 'delete', id: b.id }]); }} />
                  </View>
                )}
              </Pressable>
            ))}
            <PillButton title="Add a block" kind="secondary" icon="plus" onPress={() => { addAfter.current = 'end'; setSheet('add'); }} />
            <Text style={[type.caption, { fontSize: 12.5, textAlign: 'center' }]}>Tap text to edit it. Hold a block to move or delete it.</Text>
          </>
        )}
      </ScrollView>

      <Sheet visible={sheet === 'menu'} onClose={() => setSheet(null)} title="Page">
        <SheetRow icon="download" title="Download as…" onPress={() => setSheet('export')} />
        <SheetRow icon="refresh" title="Undo my last change" onPress={() => (peek ? setNote({ text: 'Close the version you are looking at to undo.' }) : restore('undo'))} />
        <SheetRow icon="text" title="History" onPress={openHistory} />
      </Sheet>
      <Sheet visible={sheet === 'export'} onClose={() => setSheet(null)} title="Download as">
        <ScrollView style={{ maxHeight: 460 }}>
          {EXPORTS.filter((x) => !x.table || hasTable).map((x) => <SheetRow key={x.format} icon={x.table ? 'table' : 'file'} title={x.label} onPress={() => doExport(x.format)} />)}
        </ScrollView>
      </Sheet>
      <Sheet visible={sheet === 'add'} onClose={() => setSheet(null)} title="Add a block">
        <ScrollView style={{ maxHeight: 460 }}>
          {NEW_BLOCKS.map((x) => <SheetRow key={x.label} icon="plus" title={x.label} onPress={() => { setSheet(null); setSelected(null); ops([{ op: 'insert', after: addAfter.current, block: x.block }]); }} />)}
        </ScrollView>
      </Sheet>
      <Sheet visible={sheet === 'history'} onClose={() => setSheet(null)} title="History (tap to look, then restore)">
        <ScrollView style={{ maxHeight: 480 }}>
          {!history ? <ActivityIndicator color={color.ink} /> : history.map((v) => (
            <Pressable key={v.version} disabled={v.version === page?.version} onPress={() => look(v.version)}
              style={({ pressed }) => ({ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: pressed ? color.fill : 'transparent' })}>
              <Text style={type.body}><Text style={{ fontWeight: '600' }}>{v.by}</Text> {v.summary}</Text>
              <Text style={[type.caption, { fontSize: 12.5 }]}>{`v${v.version} · ${ago(v.at)}${v.version === page?.version ? ' · current' : ''}`}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    </View>
  );
}

function Clash({ b, onKeep }: { b: B; onKeep: (k: 'mine' | 'theirs') => void }) {
  const f: any = b.alt?.fields ?? {};
  return (
    <View style={{ backgroundColor: color.problemFill, borderRadius: 10, padding: 10, gap: 6, marginBottom: 6 }}>
      <Text style={{ fontSize: 13, color: color.ink }}>{`${b.by} changed this just before ${b.alt!.by}’s edit arrived. ${b.alt!.by}’s version:`}</Text>
      <Text style={{ fontSize: 13, color: color.ink, backgroundColor: color.surface, padding: 8, borderRadius: 8 }}>{String(f.md ?? f.text ?? f.code ?? f.question ?? JSON.stringify(f)).slice(0, 400)}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <PillButton title={`Keep ${b.alt!.by}’s`} onPress={() => onKeep('mine')} />
        <PillButton title={`Keep ${b.by}’s`} kind="secondary" onPress={() => onKeep('theirs')} />
      </View>
    </View>
  );
}

/** Text shown normally; tapping it opens a box() that saves when you tap Done. */
function EditableText({ value, onSave, multiline = true, placeholder, render, style }: { value: string; onSave: (v: string) => void; multiline?: boolean; placeholder?: string; render?: (v: string) => React.ReactNode; style?: any }) {
  const [v, setV] = useState<string | null>(null);
  if (v === null) {
    return (
      <Pressable onPress={() => setV(value)} accessibilityRole="button" accessibilityHint="Edit">
        {value ? (render ? render(value) : <Text style={[type.body, style]}>{value}</Text>) : <Text style={[type.body, { color: color.inkMuted, fontStyle: 'italic' }, style]}>{placeholder ?? 'Tap to write'}</Text>}
      </Pressable>
    );
  }
  const done = () => { if (v !== value) onSave(v); setV(null); };
  return (
    <View style={{ gap: 6 }}>
      <TextInput value={v} onChangeText={setV} autoFocus multiline={multiline} onBlur={done} onSubmitEditing={multiline ? undefined : done} textAlignVertical="top"
        style={[{ ...box(), padding: 10, fontSize: 16, lineHeight: 22, color: color.ink, minHeight: multiline ? 90 : undefined }, style]} />
      {multiline && <View style={{ alignSelf: 'flex-end' }}><PillButton title="Done" onPress={done} /></View>}
    </View>
  );
}

/** One input that saves when you leave it. */
function Cell({ value, onSave, style, placeholder, keyboard }: { value: string; onSave: (v: string) => void; style?: any; placeholder?: string; keyboard?: 'numeric' | 'default' }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  return <TextInput value={v} placeholder={placeholder} placeholderTextColor={color.timestamp} keyboardType={keyboard}
    onFocus={() => { focused.current = true; }} onChangeText={setV} onBlur={() => { focused.current = false; if (v !== value) onSave(v); }}
    style={[{ fontSize: 15, color: color.ink, paddingVertical: 6, paddingHorizontal: 8 }, style]} />;
}

function Check({ on, round, onPress, label }: { on: boolean; round?: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole={round ? 'radio' : 'checkbox'} accessibilityState={{ checked: on }} accessibilityLabel={label} hitSlop={8}
      style={{ width: 22, height: 22, borderRadius: round ? 11 : 6, borderWidth: 2, borderColor: on ? color.ink : color.secondaryBorder, backgroundColor: on ? color.ink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
      {on && <Icon name="check" size={14} color={color.onPrimary} strokeWidth={2.6} />}
    </Pressable>
  );
}

function BlockBody({ b, page, api, bot, ops, say, onOpenFile }: { b: B; page: Page; api: Client; bot: Bot; ops: Ops; say: (t: string) => Promise<boolean>; onOpenFile?: (p: string) => void }) {
  const update = (set: Record<string, unknown>) => ops([{ op: 'update', id: b.id, base: b.rev, set }]);
  const { width } = useWindowDimensions();
  switch (b.type) {
    case 'text':
      return <EditableText value={b.md} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} />;
    case 'heading':
      return <EditableText value={b.text} multiline={false} onSave={(text) => update({ text })} style={{ fontSize: b.level === 1 ? 24 : b.level === 3 ? 17 : 20, fontWeight: '600', marginTop: 6 }} />;
    case 'checklist': return <Checklist b={b} ops={ops} />;
    case 'table': return <Table b={b} ops={ops} update={update} />;
    case 'form': return <Form b={b} page={page} ops={ops} say={say} />;
    case 'choice':
      return (
        <View style={{ gap: 8 }}>
          <Text style={[type.body, { fontWeight: '600' }]}>{b.question}</Text>
          {b.options.map((o: string, i: number) => {
            const on = b.picked.includes(i);
            const pick = () => ops([{ op: 'pick', id: b.id, picked: b.multi ? (on ? b.picked.filter((x: number) => x !== i) : [...b.picked, i]) : [i] }]);
            return <Pressable key={i} onPress={pick} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Check on={on} round={!b.multi} onPress={pick} label={o} /><Text style={type.body}>{o}</Text></Pressable>;
          })}
        </View>
      );
    case 'chart': {
      const w = Math.min(width - 32, 640);
      return <View style={{ ...box(), overflow: 'hidden' }}><SvgXml xml={chartSvg(b, page, 480, 280, currentScheme() === 'dark' ? CHART_DARK : CHART_LIGHT)} width={w} height={(w * 280) / 480} /></View>;
    }
    case 'callout': {
      const tone = b.tone === 'warn' ? '#F59312' : b.tone === 'good' ? '#14C16F' : '#1E86FC';
      return <View style={{ borderLeftWidth: 4, borderLeftColor: tone, backgroundColor: `${tone}1A`, borderRadius: 10, padding: 10 }}><EditableText value={b.md} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} /></View>;
    }
    case 'button': return <PageButton label={b.label} onPress={() => say(b.message || b.label)} />;
    case 'file':
      return /\.(png|jpe?g|gif|webp|bmp)$/i.test(b.path)
        ? <Image source={{ uri: api.fileRawUrl(bot.id, b.path), headers: api.authHeader }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 10 }} resizeMode="contain" accessibilityLabel={b.caption ?? b.path} />
        : <View style={{ alignSelf: 'flex-start' }}><PillButton title={b.caption || b.path.split('/').pop()} kind="secondary" icon="file" onPress={() => onOpenFile?.(b.path)} /></View>;
    case 'code':
      return <EditableText value={b.code} onSave={(code) => update({ code })} render={(v) => <ScrollView horizontal style={{ ...box() }} contentContainerStyle={{ padding: 10 }}><Text selectable style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19, color: color.ink }}>{v}</Text></ScrollView>} />;
    case 'toggle': return <Toggle b={b} update={update} />;
    case 'divider': return <View style={{ height: 1, backgroundColor: color.hairline, marginVertical: 8 }} />;
    case 'calc':
      // The same calculator as in the chat (ViewCard): numbers save on the Page, Send posts them as you.
      return <Calc b={b as any} change={async (c: Change) => {
        const values = c.values as Record<string, number> | undefined;
        if (c.op === 'calc') return !!(await ops([{ op: 'calc', id: b.id, values }]));
        if (c.op === 'send') {
          if (values) await ops([{ op: 'calc', id: b.id, values }]);
          return say(calcMessage({ ...b, values: values ?? b.values }, page.title && page.title !== b.title ? ` ("${page.title}")` : ''));
        }
        return false;
      }} />;
    default: return null;
  }
}

function Checklist({ b, ops }: { b: B; ops: Ops }) {
  const [adding, setAdding] = useState('');
  const done = b.items.filter((i: any) => i.done).length;
  return (
    <View style={{ gap: 4 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      {b.items.map((it: any) => (
        <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Check on={it.done} onPress={() => ops([{ op: 'check', id: b.id, item: it.id, done: !it.done }])} label={it.text || 'item'} />
          <Cell value={it.text} placeholder="Item" style={{ flex: 1, textDecorationLine: it.done ? 'line-through' : 'none', color: it.done ? color.inkMuted : color.ink }}
            onSave={(text) => ops(text ? [{ op: 'check', id: b.id, item: it.id, text }] : [{ op: 'remove_item', id: b.id, item: it.id }])} />
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="plus" size={18} color={color.inkMuted} />
        <TextInput value={adding} onChangeText={setAdding} placeholder="Add an item" placeholderTextColor={color.timestamp} returnKeyType="done"
          onSubmitEditing={() => { if (adding.trim()) { ops([{ op: 'add_item', id: b.id, text: adding.trim() }]); setAdding(''); } }}
          style={{ flex: 1, fontSize: 15, color: color.ink, paddingVertical: 6, paddingHorizontal: 8 }} />
      </View>
      {b.items.length > 1 && <Text style={[type.caption, { fontSize: 12.5 }]}>{`${done} of ${b.items.length} done`}</Text>}
    </View>
  );
}

function Table({ b, ops, update }: { b: B; ops: Ops; update: (s: Record<string, unknown>) => unknown }) {
  const width = Math.max(b.columns.length, ...b.rows.map((r: string[]) => r.length), 1);
  const cols = Array.from({ length: width }, (_, i) => i);
  const total = useMemo(() => (b.total ? cols.map((i) => {
    if (i === 0) return 'Total';
    const nums = b.rows.map((r: string[]) => r[i]).filter((v: string) => v !== undefined && v !== '' && Number.isFinite(Number(String(v).replace(/[$,\s]/g, '')))).map((v: string) => Number(String(v).replace(/[$,\s]/g, '')));
    return nums.length ? String(+nums.reduce((a: number, c: number) => a + c, 0).toFixed(2)) : '';
  }) : null), [b.rows, b.total, width]); // eslint-disable-line react-hooks/exhaustive-deps
  const cell = { width: 120, borderRightWidth: 1, borderBottomWidth: 1, borderColor: color.hairline } as const;
  return (
    <View style={{ gap: 6 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      <ScrollView horizontal style={{ ...box() }}>
        <View>
          <View style={{ flexDirection: 'row', backgroundColor: color.fill }}>
            {cols.map((i) => <View key={i} style={cell}><Cell value={b.columns[i] ?? ''} style={{ fontWeight: '600' }} onSave={(v) => { const c = [...b.columns]; while (c.length <= i) c.push(''); c[i] = v; update({ columns: c }); }} /></View>)}
            <View style={{ width: 34 }} />
          </View>
          {b.rows.map((r: string[], ri: number) => (
            <View key={ri} style={{ flexDirection: 'row' }}>
              {cols.map((ci) => <View key={ci} style={cell}><Cell value={r[ci] ?? ''} onSave={(value) => ops([{ op: 'cell', id: b.id, row: ri, col: ci, value }])} /></View>)}
              <Pressable onPress={() => ops([{ op: 'remove_row', id: b.id, at: ri }])} accessibilityLabel="Remove row" style={{ width: 34, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={14} color={color.inkMuted} /></Pressable>
            </View>
          ))}
          {total && <View style={{ flexDirection: 'row', backgroundColor: color.fill }}>{total.map((v, i) => <View key={i} style={cell}><Text style={{ fontSize: 15, fontWeight: '600', padding: 8, color: color.ink }}>{v}</Text></View>)}</View>}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PillButton title="Row" icon="plus" kind="secondary" onPress={() => ops([{ op: 'add_row', id: b.id, values: [] }])} />
        <PillButton title="Column" icon="plus" kind="secondary" onPress={() => update({ columns: [...b.columns, `Column ${width + 1}`] })} />
        <Text style={type.caption}>Total row</Text>
        <Switch value={!!b.total} onValueChange={(v) => { update({ total: v }); }} />
      </View>
    </View>
  );
}

function Form({ b, page, ops, say }: { b: B; page: Page; ops: Ops; say: (t: string) => Promise<boolean> }) {
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    const lines = b.fields.map((f: any) => `- ${f.label}: ${f.value || '(blank)'}`).join('\n');
    if (await say(`Form${b.title ? ` "${b.title}"` : ''} on the Page "${page.title}":\n${lines}`)) await ops([{ op: 'submitted', id: b.id }]);
    setSending(false);
  };
  return (
    <View style={{ ...box(), padding: 12, gap: 10 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      {b.fields.map((f: any) => (
        <View key={f.id} style={{ gap: 4 }}>
          <Text style={[type.caption, { fontSize: 13 }]}>{f.label}{f.kind === 'date' ? ' (YYYY-MM-DD)' : ''}</Text>
          {f.kind === 'choice' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(f.options ?? []).map((o: string) => <PillButton key={o} title={o} kind={f.value === o ? 'primary' : 'secondary'} onPress={() => ops([{ op: 'field', id: b.id, field: f.id, value: o }])} />)}
            </View>
          ) : (
            <Cell value={f.value} keyboard={f.kind === 'number' ? 'numeric' : 'default'} style={{ borderWidth: 1, borderColor: color.secondaryBorder, borderRadius: 8, minHeight: f.kind === 'longtext' ? 70 : undefined }}
              onSave={(value) => ops([{ op: 'field', id: b.id, field: f.id, value }])} />
          )}
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <PillButton title={sending ? 'Sending…' : b.submitLabel || 'Send'} icon="send" disabled={sending} onPress={submit} />
        {!!b.submittedAt && <Text style={type.caption}>{`Sent ${ago(b.submittedAt)}`}</Text>}
      </View>
    </View>
  );
}

function Toggle({ b, update }: { b: B; update: (s: Record<string, unknown>) => unknown }) {
  const [open, setOpen] = useState(!!b.open);
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Text style={{ fontSize: 13, color: color.inkMuted }}>{open ? '▾' : '▸'}</Text>
        <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>
      </Pressable>
      {open && <EditableText value={b.md} onSave={(md) => update({ md })} render={(v) => <Markdown text={v} />} />}
    </View>
  );
}

function PageButton({ label, onPress }: { label: string; onPress: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <PillButton title={state === 'sent' ? 'Sent' : label} kind="secondary" icon={state === 'sent' ? 'check' : undefined} disabled={state === 'busy'}
        onPress={async () => { setState('busy'); setState((await onPress()) ? 'sent' : 'idle'); setTimeout(() => setState('idle'), 2500); }} />
    </View>
  );
}
