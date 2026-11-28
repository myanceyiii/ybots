import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, PanResponder, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import type { Bot, Client, Row } from '../api';
import { CHART_DARK, CHART_LIGHT, chartSvg } from '../pageChart';
import { color, type, currentScheme, useAnswerVisuals } from '../theme';
import { formatCalc, runCalc, type CalcInput, type CalcOutput } from '../calc';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { PillButton } from './ui';
import { useRevealOnFocus } from './KeyboardSafe';
import { A2uiView } from './A2uiView';

/**
 * An answer view in the chat (server/src/views.ts): tables, charts, stats, checklists, picks, forms and
 * buttons a bot puts under its reply. Plain data drawn with fixed components; nothing in it runs. Ticking,
 * picking and typing save on the card; Send (or a single pick) posts a chat message as you, so approval
 * cards still guard anything the bot then does. Same card as the web and Windows apps
 * (web/src/components/cards/ViewCard.tsx).
 */

type B = { id: string; type: string; sentAt?: number } & Record<string, any>;
export type Change = Record<string, unknown> & { op: string; block: string };
const box = () => ({ backgroundColor: color.surface, borderRadius: 12, borderWidth: 1, borderColor: color.hairline } as const);
const TONE: Record<string, string> = { good: '#00854A', warn: '#AA6300', bad: '#B3261E' };
/** https only, checked again here: the app never trusts a link just because the server passed it. */
const httpsOnly = (u: unknown) => { try { return typeof u === 'string' && new URL(u).protocol === 'https:' ? u : null; } catch { return null; } };

/** `docked`: drawn in the pinned-board sheet (BoardDock), without its own title and buttons. */
export function ViewCard({ api, bot, row, onOpenPage, docked }: { api: Client; bot: Bot; row: Row; onOpenPage?: (path: string) => void; docked?: boolean }) {
  const [body, setBody] = useState<any>(row.body);
  useEffect(() => setBody(row.body), [row.body]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const visuals = useAnswerVisuals();
  // Simple (Settings) shows the answer as text; each card can still be switched either way.
  const [flip, setFlip] = useState(false);
  const simple = (visuals === 'simple') !== flip;
  const [opening, setOpening] = useState(false);
  const openPage = async () => {
    if (!onOpenPage) return;
    setError(null); setOpening(true);
    try { const r = await api.viewPage(bot.id, row); setBody((o: any) => ({ ...o, pagePath: r.path })); onOpenPage(r.path); }
    catch (e: any) { setError(e?.message ?? 'Couldn’t make the Page'); }
    finally { setOpening(false); }
  };
  // Save to Pages: the same Page as Open as Page, kept in the bot's Pages list without opening it now.
  const savePage = async () => {
    setError(null); setOpening(true);
    try { const r = await api.viewPage(bot.id, row); setBody((o: any) => ({ ...o, pagePath: r.path })); }
    catch (e: any) { setError(e?.message ?? 'Couldn’t save the Page'); }
    finally { setOpening(false); }
  };
  const change = async (c: Change) => {
    setError(null);
    try {
      const r: any = await api.viewChange(bot.id, row, c);
      if (r?.row?.body) setBody(r.row.body);
      return true;
    } catch (e: any) { setError(e?.message ?? 'That didn’t go through'); return false; }
  };
  // Check-in offer (server/src/checkin-offer.ts): the same buttons with a heading; a tap makes the check-in.
  if (body.quick && body.checkin && body.blocks?.[0]?.type === 'choice') return <CheckInOffer body={body} change={change} error={error} />;
  if (body.quick && body.blocks?.[0]?.type === 'choice') return <QuickChoices b={body.blocks[0]} group={!!body.from} change={change} error={error} />;
  // Pinned boards (server/src/board-pin.ts): any view can be pinned above the message box, or unpinned.
  const pinned = !!body.pin?.on;
  const togglePin = async () => {
    setError(null);
    try { const r: any = await api.pinBoard(bot.id, row, !pinned); if (r?.row?.body) setBody(r.row.body); } catch (e: any) { setError(e?.message ?? 'That didn’t go through'); }
  };
  if (docked) {
    return (
      <View style={{ gap: 12, backgroundColor: color.fill, borderRadius: 20, padding: 14 }}>
        {simple ? <Markdown text={String(body.text ?? '')} /> : (body.blocks as B[]).map((b) => <Block key={b.id} b={b} all={body.blocks} change={change} />)}
        {!!error && <Text style={[type.caption, { fontSize: 13, color: color.problemInk }]}>{error}</Text>}
      </View>
    );
  }
  return (
    <View style={{ alignSelf: 'flex-start', width: '94%', backgroundColor: color.fill, borderRadius: 20, padding: 14, gap: 12 }}>
      {(!!body.title || !!body.from || pinned) && (
        <View style={{ gap: 2 }}>
          {!!body.from && <Text style={[type.caption, { fontSize: 13, fontWeight: '600' }]}>{body.from.name}</Text>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {!!body.title && <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: color.ink }}>{body.title}</Text>}
            {pinned && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' }}><Icon name="pin" size={12} color={color.inkMuted} /><Text style={[type.caption, { fontSize: 12 }]}>Pinned</Text></View>}
          </View>
        </View>
      )}
      {simple ? <Markdown text={String(body.text ?? '').replace(/^\*\*[^\n]*\*\*\n\n/, body.title ? '' : '$&')} /> : (body.blocks as B[]).map((b) => <Block key={b.id} b={b} all={body.blocks} change={change} />)}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 4 }}>
        {!!error ? <Text style={[type.caption, { flex: 1, fontSize: 13, color: color.problemInk }]}>{error}</Text>
          : !!body.updatedAt && <Text style={[type.caption, { flex: 1, fontSize: 12 }]}>Updated {new Date(body.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>}
        <FootButton icon={simple ? 'image' : 'text'} label={simple ? 'Show visuals' : 'Show as text'} onPress={() => setFlip((f) => !f)} />
        {!body.from && !!onOpenPage && (body.pagePath ? <FootButton icon="check" label="In Pages" a11y="Saved in Pages" onPress={() => {}} />
          : <FootButton icon="bookmark" label="Save to Pages" onPress={() => { if (!opening) savePage(); }} />)}
        {!body.from && !!onOpenPage && <FootButton icon="file" label={opening ? 'Opening…' : body.pagePath ? 'Open Page' : 'Open as Page'} onPress={() => { if (!opening) openPage(); }} />}
        <FootButton icon="pin" label={pinned ? 'Unpin' : 'Pin'} a11y={pinned ? 'Stop keeping this above the message box' : 'Keep this above the message box'} onPress={togglePin} />
        <FootButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} a11y="Copy as text"
          onPress={async () => { await Clipboard.setStringAsync(body.text ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1600); }} />
      </View>
    </View>
  );
}

function FootButton({ icon, label, onPress, a11y }: { icon: 'image' | 'text' | 'file' | 'check' | 'copy' | 'bookmark' | 'pin'; label: string; onPress: () => void; a11y?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y ?? label} hitSlop={6} onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 }}>
      <Icon name={icon} size={15} color={color.inkMuted} />
      <Text style={[type.caption, { fontSize: 13 }]}>{label}</Text>
    </Pressable>
  );
}

function Block({ b, all, change }: { b: B; all: B[]; change: (c: Change) => Promise<boolean> }) {
  const { width } = useWindowDimensions();
  switch (b.type) {
    case 'heading': return <Text style={{ fontSize: 16, fontWeight: '600', color: color.ink }}>{b.text}</Text>;
    case 'text': return <Markdown text={b.md} />;
    case 'callout': {
      const tone = b.tone === 'warn' ? '#F59312' : b.tone === 'good' ? '#14C16F' : '#1E86FC';
      return <View style={{ borderLeftWidth: 4, borderLeftColor: tone, backgroundColor: `${tone}1A`, borderRadius: 10, padding: 10 }}><Markdown text={b.md} /></View>;
    }
    case 'table': return <Table b={b} />;
    case 'chart': {
      // The card is 94% of the chat column (16 px gutters) less its own 14 px padding and the box() border.
      const w = Math.min((width - 32) * 0.94 - 30, 640);
      return (
        <View style={{ ...box(), overflow: 'hidden' }}><SvgXml xml={chartSvg(b, { blocks: all }, 480, 280, currentScheme() === 'dark' ? CHART_DARK : CHART_LIGHT)} width={w} height={(w * 280) / 480} /></View>
      );
    }
    case 'stats': return (
      <View style={{ gap: 6 }}>
        {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {b.items.map((x: any, i: number) => (
            <View key={i} style={{ ...box(), paddingVertical: 10, paddingHorizontal: 12, flexGrow: 1, flexBasis: '40%' }}>
              <Text style={{ fontSize: 20, fontWeight: '600', color: x.tone ? TONE[x.tone] : color.ink }}>{x.value}</Text>
              <Text style={[type.caption, { fontSize: 13 }]}>{x.label}</Text>
              {!!x.note && <Text style={[type.caption, { fontSize: 12, color: color.timestamp }]}>{x.note}</Text>}
            </View>
          ))}
        </View>
      </View>
    );
    case 'progress': {
      const pct = b.max > 0 && Number.isFinite(b.value) ? Math.max(0, Math.min(100, Math.round((b.value / b.max) * 100))) : 0;
      return (
        <View style={{ gap: 4 }} accessibilityRole="progressbar" accessibilityLabel={b.label} accessibilityValue={{ min: 0, max: b.max, now: b.value }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={[type.body, { fontSize: 14 }]}>{b.label}</Text><Text style={[type.caption, { fontSize: 13 }]}>{`${pct}%`}</Text></View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: color.secondaryButton, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: '100%', backgroundColor: color.primary }} /></View>
          {!!b.note && <Text style={[type.caption, { fontSize: 12 }]}>{b.note}</Text>}
        </View>
      );
    }
    case 'checklist': {
      const done = b.items.filter((i: any) => i.done).length;
      return (
        <View style={{ gap: 6 }}>
          {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
          {b.items.map((it: any) => {
            const flip = () => change({ op: 'check', block: b.id, item: it.id, done: !it.done });
            return (
              <Pressable key={it.id} onPress={flip} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Check on={it.done} onPress={flip} label={it.text} />
                <Text style={[type.body, { flex: 1, textDecorationLine: it.done ? 'line-through' : 'none', color: it.done ? color.inkMuted : color.ink }]}>{it.text}</Text>
              </Pressable>
            );
          })}
          {b.items.length > 1 && <Text style={[type.caption, { fontSize: 12.5 }]}>{`${done} of ${b.items.length} done`}</Text>}
        </View>
      );
    }
    case 'choice': return <Choice b={b} change={change} />;
    case 'form': return <Form b={b} change={change} />;
    case 'button': return <Button b={b} change={change} />;
    case 'calc': return <Calc b={b} change={change} />;
    case 'link': {
      const u = httpsOnly(b.url);
      return u ? <View style={{ alignSelf: 'flex-start' }}><PillButton title={b.label} kind="secondary" icon="link" onPress={() => Linking.openURL(u)} /></View> : null;
    }
    case 'code': return <ScrollView horizontal style={{ ...box() }} contentContainerStyle={{ padding: 10 }}><Text selectable style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19, color: color.ink }}>{b.code}</Text></ScrollView>;
    case 'divider': return <View style={{ height: 1, backgroundColor: color.hairline }} />;
    case 'a2ui': return <A2uiView b={b as any} change={change} />;
    default: return null;
  }
}

function Check({ on, round, onPress, label, disabled }: { on: boolean; round?: boolean; onPress: () => void; label: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole={round ? 'radio' : 'checkbox'} accessibilityState={{ checked: on, disabled }} accessibilityLabel={label} hitSlop={8}
      style={{ width: 22, height: 22, borderRadius: round ? 11 : 6, borderWidth: 2, borderColor: on ? color.ink : color.secondaryBorder, backgroundColor: on ? color.ink : 'transparent', alignItems: 'center', justifyContent: 'center', opacity: disabled && !on ? 0.5 : 1 }}>
      {on && <Icon name="check" size={14} color={color.onPrimary} strokeWidth={2.6} />}
    </Pressable>
  );
}

function Table({ b }: { b: B }) {
  const width = Math.max(b.columns.length, ...b.rows.map((r: string[]) => r.length), 1);
  const cols = Array.from({ length: width }, (_, i) => i);
  const total = useMemo(() => (b.total ? cols.map((i) => {
    if (i === 0) return 'Total';
    const nums = b.rows.map((r: string[]) => String(r[i] ?? '').replace(/[$,\s]/g, '')).filter((v: string) => v !== '' && Number.isFinite(Number(v))).map(Number);
    return nums.length ? String(+nums.reduce((a: number, c: number) => a + c, 0).toFixed(2)) : '';
  }) : null), [b.rows, b.total, width]); // eslint-disable-line react-hooks/exhaustive-deps
  // One width per column for every row, from its longest text, so the columns line up.
  const widths = useMemo(() => cols.map((ci) => Math.max(72, Math.min(200, 22 + 8.2 * Math.max(String(b.columns[ci] ?? '').length, ...b.rows.map((r: string[]) => String(r[ci] ?? '').length))))), [b.columns, b.rows, width]); // eslint-disable-line react-hooks/exhaustive-deps
  const cell = { paddingVertical: 7, paddingHorizontal: 10, borderRightWidth: 1, borderBottomWidth: 1, borderColor: color.hairline } as const;
  const line = (r: string[], head?: boolean) => cols.map((ci) => <View key={ci} style={[cell, { width: widths[ci] }]}><Text style={{ fontSize: 14.5, color: color.ink, fontWeight: head ? '600' : '400' }}>{r[ci] ?? ''}</Text></View>);
  return (
    <View style={{ gap: 6 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      <ScrollView horizontal style={{ ...box() }}>
        <View>
          {b.columns.length > 0 && <View style={{ flexDirection: 'row', backgroundColor: color.fill }}>{line(b.columns, true)}</View>}
          {b.rows.map((r: string[], ri: number) => <View key={ri} style={{ flexDirection: 'row' }}>{line(r)}</View>)}
          {total && <View style={{ flexDirection: 'row', backgroundColor: color.fill }}>{line(total, true)}</View>}
        </View>
      </ScrollView>
    </View>
  );
}

function Choice({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const sent = !!b.sentAt;
  const [busy, setBusy] = useState(false);
  const pick = async (picked: number[]) => { setBusy(true); await change({ op: 'pick', block: b.id, picked }); setBusy(false); };
  return (
    <View style={{ gap: 8 }}>
      <Text style={[type.body, { fontWeight: '600' }]}>{b.question}</Text>
      {b.multi ? b.options.map((o: string, i: number) => {
        const on = b.picked.includes(i);
        const flip = () => pick(on ? b.picked.filter((x: number) => x !== i) : [...b.picked, i]);
        return <Pressable key={i} disabled={sent || busy} onPress={flip} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Check on={on} onPress={flip} label={o} disabled={sent || busy} /><Text style={type.body}>{o}</Text></Pressable>;
      }) : b.options.map((o: string, i: number) => {
        const on = b.picked.includes(i);
        return (
          <Pressable key={i} disabled={sent || busy} onPress={() => pick([i])} accessibilityRole="button" accessibilityState={{ selected: on, disabled: sent || busy }}
            style={({ pressed }) => ({ ...box(), flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, backgroundColor: on ? color.secondaryButton : pressed ? color.pressed : color.surface, opacity: sent && !on ? 0.55 : 1 })}>
            <Text style={[type.body, { flex: 1 }]}>{o}</Text>
            {on && <Icon name="check" size={16} color={color.ink} />}
          </Pressable>
        );
      })}
      {b.multi && <View style={{ alignSelf: 'flex-start' }}><PillButton title={sent ? 'Sent' : 'Send'} icon="send" disabled={sent || busy || !b.picked.length} onPress={() => change({ op: 'send', block: b.id })} /></View>}
      {!b.multi && sent && <Text style={[type.caption, { fontSize: 12.5 }]}>Sent</Text>}
    </View>
  );
}

function Form({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const revealOnFocus = useRevealOnFocus();
  const sent = !!b.sentAt;
  const [sending, setSending] = useState(false);
  // What is in the boxes now; it goes with Send, and each box() also saves when you leave it.
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(b.fields.map((f: any) => [f.id, f.value ?? ''])));
  const set = (id: string, v: string) => setVals((o) => ({ ...o, [id]: v }));
  return (
    <View style={{ ...box(), padding: 12, gap: 10 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      {b.fields.map((f: any) => (
        <View key={f.id} style={{ gap: 4 }}>
          <Text style={[type.caption, { fontSize: 13 }]}>{f.label}{f.kind === 'date' ? ' (YYYY-MM-DD)' : ''}</Text>
          {f.kind === 'choice' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(f.options ?? []).map((o: string) => <PillButton key={o} title={o} kind={vals[f.id] === o ? 'primary' : 'secondary'} disabled={sent} onPress={() => { set(f.id, o); change({ op: 'field', block: b.id, field: f.id, value: o }); }} />)}
            </View>
          ) : (
            <TextInput value={vals[f.id] ?? ''} editable={!sent} onFocus={revealOnFocus} onChangeText={(v) => set(f.id, v)} keyboardType={f.kind === 'number' ? 'numeric' : 'default'} multiline={f.kind === 'longtext'}
              onBlur={() => { if ((vals[f.id] ?? '') !== (f.value ?? '')) change({ op: 'field', block: b.id, field: f.id, value: vals[f.id] ?? '' }); }}
              style={{ fontSize: 15, color: color.ink, paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: color.secondaryBorder, borderRadius: 8, minHeight: f.kind === 'longtext' ? 70 : undefined, textAlignVertical: 'top' }} />
          )}
        </View>
      ))}
      <View style={{ alignSelf: 'flex-start' }}>
        <PillButton title={sent ? 'Sent' : sending ? 'Sending…' : b.submitLabel || 'Send'} icon={sent ? 'check' : 'send'} disabled={sent || sending}
          onPress={async () => { setSending(true); await change({ op: 'send', block: b.id, values: vals }); setSending(false); }} />
      </View>
    </View>
  );
}

function Button({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <PillButton title={state === 'sent' ? 'Sent' : b.label} kind="secondary" icon={state === 'sent' ? 'check' : undefined} disabled={state === 'busy'}
        onPress={async () => { setState('busy'); setState((await change({ op: 'send', block: b.id })) ? 'sent' : 'idle'); setTimeout(() => setState('idle'), 2500); }} />
    </View>
  );
}

/** A calculator: inputs the person moves, outputs worked out on the phone with the shared formula language (calc.ts). */
export function Calc({ b, change }: { b: B; change: (c: Change) => Promise<boolean> }) {
  const inputs = b.inputs as CalcInput[];
  const outputs = b.outputs as CalcOutput[];
  const start = () => Object.fromEntries(inputs.map((i) => [i.id, Number.isFinite(b.values?.[i.id]) ? b.values[i.id] : i.value]));
  const [vals, setVals] = useState<Record<string, number>>(start);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => { if (!dirty.current) setVals(start()); }, [b]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = (id: string, v: number) => {
    setVals((o) => {
      const next = { ...o, [id]: v };
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => { await change({ op: 'calc', block: b.id, values: next }); dirty.current = false; }, 700);
      return next;
    });
  };
  const results = useMemo(() => runCalc(inputs, outputs, vals), [inputs, outputs, vals]);
  return (
    <View style={{ ...box(), padding: 12, gap: 12 }}>
      {!!b.title && <Text style={[type.body, { fontWeight: '600' }]}>{b.title}</Text>}
      {inputs.map((i) => <CalcField key={i.id} i={i} value={vals[i.id]} onChange={(v) => set(i.id, v)} />)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityLiveRegion="polite">
        {results.map((r, k) => (
          <View key={r.id} style={{ flexGrow: 1, flexBasis: outputs[k].big ? '100%' : '40%', padding: 10, borderRadius: 12, backgroundColor: color.fill }}>
            <Text style={{ fontSize: outputs[k].big ? 24 : 18, fontWeight: '600', color: color.ink, fontVariant: ['tabular-nums'] }}>{r.text}</Text>
            <Text style={[type.caption, { fontSize: 13 }]}>{r.label}</Text>
          </View>
        ))}
      </View>
      <View style={{ alignSelf: 'flex-start' }}>
        <PillButton title={sent ? 'Sent' : sending ? 'Sending…' : b.sendLabel || 'Send these numbers'} kind="secondary" icon={sent ? 'check' : 'send'} disabled={sending}
          onPress={async () => { setSending(true); clearTimeout(timer.current); const ok = await change({ op: 'send', block: b.id, values: vals }); dirty.current = false; setSending(false); if (ok) { setSent(true); setTimeout(() => setSent(false), 2500); } }} />
      </View>
    </View>
  );
}

const decimalsOf = (step?: number) => (step && step < 1 ? String(step).split('.')[1]?.length ?? 2 : 0);
const snap = (i: CalcInput, v: number) => {
  const lo = i.min ?? 0; const hi = i.max ?? 100; const step = i.step && i.step > 0 ? i.step : (hi - lo) / 100;
  const n = Math.round((v - lo) / step) * step + lo;
  return Math.min(hi, Math.max(lo, Number(n.toFixed(decimalsOf(step) + 2))));
};

function CalcField({ i, value, onChange }: { i: CalcInput; value: number; onChange: (v: number) => void }) {
  const shown = formatCalc(value, { decimals: decimalsOf(i.step), prefix: i.prefix ?? '', unit: i.unit });
  const label = <Text style={[type.caption, { fontSize: 13 }]}>{i.label}</Text>;
  if (i.kind === 'slider') return <CalcSlider i={i} value={value} shown={shown} onChange={onChange} />;
  if (i.kind === 'choice') return (
    <View style={{ gap: 6 }}>
      {label}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(i.options ?? []).map((o) => <PillButton key={o.label} title={o.label} kind={value === o.value ? 'primary' : 'secondary'} onPress={() => onChange(o.value)} />)}
      </View>
    </View>
  );
  if (i.kind === 'toggle') return (
    <Pressable onPress={() => onChange(value ? 0 : 1)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessible={false}>
      <Check on={!!value} onPress={() => onChange(value ? 0 : 1)} label={i.label} />
      <Text style={[type.body, { flex: 1 }]}>{i.label}</Text>
    </Pressable>
  );
  return <CalcNumber i={i} value={value} onChange={onChange} />;
}

function CalcNumber({ i, value, onChange }: { i: CalcInput; value: number; onChange: (v: number) => void }) {
  const revealOnFocus = useRevealOnFocus();
  const [text, setText] = useState(String(value));
  useEffect(() => { if (Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ gap: 4 }}>
      <Text style={[type.caption, { fontSize: 13 }]}>{i.label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {!!i.prefix && <Text style={type.body}>{i.prefix}</Text>}
        <TextInput value={text} keyboardType="decimal-pad" accessibilityLabel={i.label} onFocus={revealOnFocus}
          onChangeText={(t) => { setText(t); const n = Number(t); if (t.trim() !== '' && Number.isFinite(n)) onChange(i.min !== undefined || i.max !== undefined ? Math.min(i.max ?? n, Math.max(i.min ?? n, n)) : n); }}
          style={{ flex: 1, fontSize: 15, color: color.ink, paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: color.secondaryBorder, borderRadius: 8, fontVariant: ['tabular-nums'] }} />
        {!!i.unit && <Text style={type.body}>{i.unit}</Text>}
      </View>
    </View>
  );
}

/** A slider drawn here (no slider package in the app): drag or tap the track, or use − and +. */
function CalcSlider({ i, value, shown, onChange }: { i: CalcInput; value: number; shown: string; onChange: (v: number) => void }) {
  const lo = i.min ?? 0; const hi = i.max ?? 100; const step = i.step && i.step > 0 ? i.step : (hi - lo) / 100;
  const width = useRef(1);
  const latest = useRef(onChange); latest.current = onChange;
  const at = (x: number) => latest.current(snap(i, lo + (Math.min(Math.max(x, 0), width.current) / width.current) * (hi - lo)));
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => at(e.nativeEvent.locationX),
    onPanResponderMove: (e) => at(e.nativeEvent.locationX),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const frac = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0;
  const bump = (d: number) => onChange(snap(i, value + d * step));
  const stepBtn = (sign: number, text: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${sign < 0 ? 'Less' : 'More'} ${i.label}`} hitSlop={6} onPress={() => bump(sign)}
      style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.secondaryButton }}>
      <Text style={{ fontSize: 18, color: color.ink, lineHeight: 20 }}>{text}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={[type.caption, { fontSize: 13, flexShrink: 1 }]}>{i.label}</Text>
        <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink, fontVariant: ['tabular-nums'] }}>{shown}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {stepBtn(-1, '−')}
        <View {...pan.panHandlers} onLayout={(e) => { width.current = Math.max(1, e.nativeEvent.layout.width); }}
          accessibilityRole="adjustable" accessibilityLabel={i.label} accessibilityValue={{ text: shown }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
          style={{ flex: 1, height: 32, justifyContent: 'center' }}>
          <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: color.hairline }}>
            <View style={{ width: `${frac * 100}%`, height: 6, borderRadius: 3, backgroundColor: color.primary }} />
          </View>
          <View pointerEvents="none" style={{ position: 'absolute', left: `${frac * 100}%`, marginLeft: -11, width: 22, height: 22, borderRadius: 11, backgroundColor: color.primary, borderWidth: 3, borderColor: color.surface }} />
        </View>
        {stepBtn(1, '+')}
      </View>
    </View>
  );
}

/**
 * Choice buttons (server/src/choices.ts): a row of answers under the bot's reply, no card around them.
 * A tap sends that answer as your message, and the chat then hides the row (Transcript / Chat answeredChoice),
 * so the answer shows once. The picked state below is only a fallback for other places a card is drawn. "Other" opens a box for your own words. Never an approval: it's a chat reply.
 * Same as the web and Windows apps (web/src/components/cards/ViewCard.tsx QuickChoices).
 */
/**
 * "Keep an eye on X?" (server/src/checkin-offer.ts): how often, or Not now. A tap only makes a check-in that
 * reads and posts when something needs you; it posts no message and approves nothing. Same card as the web
 * and Windows apps (web/src/components/cards/ViewCard.tsx CheckInOffer).
 */
function CheckInOffer({ body, change, error }: { body: any; change: (c: Change) => Promise<boolean>; error: string | null }) {
  const b: B = body.blocks[0];
  const link = httpsOnly(body.checkin?.link);
  const who = body.from?.name;
  return (
    <View style={{ ...box(), alignSelf: 'stretch', maxWidth: 560, padding: 14, gap: 12 }} accessibilityLabel={b.question}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View style={{ width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: color.hairline, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="eye" size={16} color={color.inkSecondary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '600' }]}>{b.question}</Text>
          <Text style={[type.caption, { lineHeight: 19 }]}>
            {who ? `${who} reads` : 'Reads'} it on a schedule and tells you when something there needs you. It only reads, never changes anything.
          </Text>
          {!!link && (
            <Pressable onPress={() => Linking.openURL(link)} accessibilityRole="link" hitSlop={8}>
              <Text style={[type.caption, { textDecorationLine: 'underline' }]}>Open</Text>
            </Pressable>
          )}
        </View>
      </View>
      <QuickChoices b={b} group={!!body.from} change={change} error={error} />
    </View>
  );
}

function QuickChoices({ b, group, change, error }: { b: B; group: boolean; change: (c: Change) => Promise<boolean>; error: string | null }) {
  const sent = !!b.sentAt;
  const [busy, setBusy] = useState<number | 'other' | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const pick = async (c: Change, which: number | 'other') => { setBusy(which); await change(c); setBusy(null); };
  const chip = { minHeight: 40, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: color.secondaryBorder, flexDirection: 'row', alignItems: 'center', gap: 6 } as const;
  if (sent) {
    const answer = b.otherText ?? b.options[b.picked?.[0]] ?? '';
    return (
      <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, maxWidth: '94%' }} accessibilityLabel={`Answered: ${answer}`}>
        <View style={{ ...chip, backgroundColor: color.secondaryButton, borderColor: color.secondaryButton }}>
          <Icon name="check" size={14} color={color.ink} />
          <Text style={[type.body, { flexShrink: 1 }]}>{answer}</Text>
        </View>
        {group && !!b.pickedBy && <Text style={[type.caption, { fontSize: 12.5 }]}>{b.pickedBy}</Text>}
      </View>
    );
  }
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '94%', gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityLabel={b.question}>
        {b.options.map((o: string, i: number) => (
          <Pressable key={i} disabled={busy !== null} onPress={() => pick({ op: 'pick', block: b.id, picked: [i] }, i)} accessibilityRole="button"
            style={({ pressed }) => ({ ...chip, backgroundColor: pressed ? color.pressed : color.surface, opacity: busy !== null && busy !== i ? 0.55 : 1 })}>
            <Text style={[type.body, { flexShrink: 1 }]}>{busy === i ? 'Sending…' : o}</Text>
          </Pressable>
        ))}
        {!!b.other && !typing && (
          <Pressable disabled={busy !== null} onPress={() => setTyping(true)} accessibilityRole="button"
            style={({ pressed }) => ({ ...chip, backgroundColor: pressed ? color.pressed : color.surface })}>
            <Text style={[type.body, { color: color.inkSecondary }]}>Other…</Text>
          </Pressable>
        )}
      </View>
      {!!b.other && typing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput autoFocus value={text} maxLength={500} placeholder="Your answer" placeholderTextColor={color.inkMuted} onChangeText={setText} editable={busy === null}
            onSubmitEditing={() => { if (text.trim()) pick({ op: 'pick', block: b.id, text: text.trim() }, 'other'); }} returnKeyType="send"
            style={{ flex: 1, minHeight: 40, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: color.secondaryBorder, backgroundColor: color.surface, color: color.ink, fontSize: 15 }} />
          <PillButton title="Send" icon="send" disabled={busy !== null || !text.trim()} onPress={() => pick({ op: 'pick', block: b.id, text: text.trim() }, 'other')} />
        </View>
      )}
      {!!error && <Text style={[type.caption, { fontSize: 13, color: color.problemInk }]}>{error}</Text>}
    </View>
  );
}
