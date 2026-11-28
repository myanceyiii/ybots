import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, Linking, Modal, PanResponder, Pressable, ScrollView, Text, TextInput, View, type ImageStyle, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import {
  A2UI_LIMITS, buttonAction, childrenOf, evalText, evaluate, failedChecks, getAt, inputValue, safeMediaUrl, setAt, sliderMax, sliderMin, valuePath,
  type A2uiComponent, type A2uiCtx, type A2uiSurface,
} from '../a2ui';
import { A2UI_ICON_PATHS } from '../a2uiIcons';
import { color, type } from '../theme';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { useRevealOnFocus } from './KeyboardSafe';

/**
 * An A2UI 1.0 interface in an answer view, drawn with this app's own pieces. The reading of bindings,
 * functions and checks is the shared engine (src/a2ui.ts, a word-for-word copy of server/src/a2ui.ts); this
 * file only draws. Typing and picking save on the card (a2ui-set); a Button sends a chat message as you plus
 * the standard A2UI action for the bot (a2ui-action), never an approval. Pictures and sounds from other sites
 * wait for a tap. A video opens in the browser (this app has no video player). Same as the web and Windows
 * apps: web/src/components/cards/A2uiView.tsx.
 */

type Change = Record<string, unknown> & { op: string; block: string };
type Edit = { component: string; scope: string; value: unknown };
const JUSTIFY: Record<string, ViewStyle['justifyContent']> = { start: 'flex-start', end: 'flex-end', center: 'center', spaceBetween: 'space-between', spaceAround: 'space-around', spaceEvenly: 'space-evenly', stretch: 'flex-start' };
const ALIGN: Record<string, ViewStyle['alignItems']> = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
const IMG: Record<string, ViewStyle> = {
  icon: { width: 24, height: 24, borderRadius: 4 }, avatar: { width: 40, height: 40, borderRadius: 20 }, smallFeature: { width: 72, height: 72, borderRadius: 8 },
  mediumFeature: { width: '100%', height: 160, borderRadius: 8 }, largeFeature: { width: '100%', height: 240, borderRadius: 8 }, header: { width: '100%', height: 130, borderRadius: 8 },
};
const FIT: Record<string, 'contain' | 'cover' | 'stretch' | 'center'> = { contain: 'contain', cover: 'cover', fill: 'stretch', none: 'center', scaleDown: 'contain' };
const keyOf = (c: A2uiComponent, ctx: A2uiCtx) => `${c.id}@${ctx.scope}`;
const field = () => ({ fontSize: 15, color: color.ink, paddingVertical: 7, paddingHorizontal: 9, borderWidth: 1, borderColor: color.secondaryBorder, borderRadius: 8, backgroundColor: color.surface } as const);

export function A2uiView({ b, change }: { b: { id: string; surface: A2uiSurface }; change: (c: Change) => Promise<boolean> }) {
  const surface = b.surface;
  const revealOnFocus = useRevealOnFocus();
  const [data, setData] = useState<any>(surface.data);
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const pending = useRef(new Map<string, Edit>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (!pending.current.size) setData(surface.data); }, [surface]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = async () => {
    clearTimeout(timer.current);
    const list = [...pending.current.values()];
    pending.current.clear();
    for (const e of list) await change({ op: 'a2ui-set', block: b.id, ...e });
  };
  const readValue = (c: A2uiComponent, ctx: A2uiCtx) => {
    const p = valuePath(c, ctx);
    return p ? getAt(data, p) : keyOf(c, ctx) in local ? local[keyOf(c, ctx)] : evaluate(c.value, ctx);
  };
  const setValue = (c: A2uiComponent, ctx: A2uiCtx, raw: unknown, soon = false) => {
    const v = inputValue(c, ctx, raw);
    if (v === null) return;
    setTouched((t) => new Set(t).add(keyOf(c, ctx)));
    const p = valuePath(c, ctx);
    if (!p) { setLocal((o) => ({ ...o, [keyOf(c, ctx)]: v })); return; }
    setData((d: any) => setAt(d, p, v));
    pending.current.set(keyOf(c, ctx), { component: c.id, scope: ctx.scope, value: v });
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, soon ? 0 : 600);
  };
  const press = async (c: A2uiComponent, ctx: A2uiCtx) => {
    const act = buttonAction({ ...surface, data }, c, ctx);
    if (!act) return;
    if (act.kind === 'open') { if (act.url) Linking.openURL(act.url); return; }
    clearTimeout(timer.current);
    const edits = [...pending.current.values()];
    pending.current.clear();
    setBusy(keyOf(c, ctx));
    const ok = await change({ op: 'a2ui-action', block: b.id, component: c.id, scope: ctx.scope, ...(ctx.index !== undefined ? { index: ctx.index } : {}), edits });
    setBusy(null);
    if (ok) { setSent(keyOf(c, ctx)); setTimeout(() => setSent(null), 2500); }
  };
  const hasOutside = useMemo(() => Object.values(surface.components).some((c) => c.component === 'Image' || c.component === 'AudioPlayer' || c.component === 'Video'), [surface]);

  const draw = (id: string, ctx: A2uiCtx, depth: number, opts?: { trigger?: () => void; inRow?: boolean; inSlot?: boolean }): ReactNode => {
    const c = surface.components[id];
    if (!c || depth > A2UI_LIMITS.depth || c['@accessibility']?.hidden) return null;
    const k = `${id}@${ctx.scope}`;
    const t = (v: unknown) => evalText(v, ctx);
    // Inside a Row or Column the slot around a component takes its weight, so the component itself just fills it.
    const grow: ViewStyle | undefined = opts?.inSlot ? undefined : c.weight ? { flexGrow: c.weight, flexShrink: 1, flexBasis: 0, minWidth: 0 } : undefined;
    const aria = c['@accessibility']?.label !== undefined ? t(c['@accessibility'].label) : undefined;
    const checks = c['@checks'] ? failedChecks(c, ctx) : [];
    const problem = touched.has(k) && checks.length ? <Text style={[type.caption, { fontSize: 12.5, color: color.problemInk }]}>{checks[0]}</Text> : null;
    switch (c.component) {
      case 'Text': {
        const text = t(c.text);
        return c.variant === 'caption'
          ? <Text style={[type.caption, { fontSize: 13 }, grow]}>{text}</Text>
          : <View style={grow}><Markdown text={text} /></View>;
      }
      case 'Image': {
        const url = safeMediaUrl(t(c.url), true);
        const alt = c.description !== undefined ? t(c.description) : '';
        const size = IMG[c.variant ?? 'mediumFeature'] ?? IMG.mediumFeature;
        if (!url) return alt ? <Text style={type.caption}>{alt}</Text> : null;
        if (!showMedia && !url.startsWith('data:')) {
          return (
            <Pressable onPress={() => setShowMedia(true)} accessibilityRole="button" accessibilityLabel={`Show picture${alt ? `: ${alt}` : ''}`}
              style={[size, { alignItems: 'center', justifyContent: 'center', backgroundColor: color.secondaryButton, borderWidth: 1, borderStyle: 'dashed', borderColor: color.secondaryBorder, padding: 4 }]}>
              <Icon name="image" size={16} color={color.inkMuted} />
              {(size.width === '100%') && <Text numberOfLines={1} style={[type.caption, { fontSize: 12 }]}>{alt || 'Picture'}</Text>}
            </Pressable>
          );
        }
        return <Image source={{ uri: url }} accessibilityLabel={alt} resizeMode={FIT[c.fit ?? 'fill'] ?? 'cover'} style={[size as ImageStyle, { backgroundColor: color.secondaryButton }, grow as ImageStyle | undefined]} />;
      }
      case 'Icon': return <A2uiIcon name={typeof c.name === 'string' ? c.name : evaluate(c.name, ctx)} label={aria} />;
      case 'AudioPlayer': {
        const url = safeMediaUrl(t(c.url));
        return url ? <AudioRow url={url} label={c.description !== undefined ? t(c.description) : 'Audio'} allowed={showMedia} onAllow={() => setShowMedia(true)} /> : null;
      }
      case 'Video': {
        const url = safeMediaUrl(t(c.url));
        if (!url) return null;
        return (
          <Pressable onPress={() => Linking.openURL(url)} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: color.secondaryButton }}>
            <Icon name="arrow" size={16} color={color.ink} />
            <Text style={[type.body, { fontSize: 15, flexShrink: 1 }]} numberOfLines={1}>Play video ({hostOf(url)})</Text>
          </Pressable>
        );
      }
      case 'Row': case 'Column': case 'List': {
        const row = c.component === 'Row' || (c.component === 'List' && c.direction === 'horizontal');
        const kids = childrenOf(c, ctx).map((x) => <View key={x.key} style={row ? slotRow(surface.components[x.id]) : surface.components[x.id]?.weight ? { flexGrow: surface.components[x.id].weight } : undefined}>{draw(x.id, x.ctx, depth + 1, { inRow: row, inSlot: true })}</View>);
        const style: ViewStyle = { flexDirection: row ? 'row' : 'column', flexWrap: 'nowrap', gap: 8, justifyContent: JUSTIFY[c.justify ?? 'start'], alignItems: row ? (ALIGN[c.align ?? 'center'] ?? 'center') : ALIGN[c.align ?? 'stretch'], ...grow };
        if (c.component === 'List' && row) return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={style} accessibilityLabel={aria}>{kids}</ScrollView>;
        return <View style={style} accessibilityLabel={aria}>{kids}</View>;
      }
      case 'Card': return <View style={[{ backgroundColor: color.surface, borderRadius: 12, borderWidth: 1, borderColor: color.hairline, padding: 12 }, grow]}>{draw(c.child, ctx, depth + 1)}</View>;
      case 'Divider': return c.axis === 'vertical' ? <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: color.hairline }} /> : <View style={{ height: 1, alignSelf: 'stretch', backgroundColor: color.hairline }} />;
      case 'Tabs': {
        const on = Math.min(Number(ui[k] ?? 0), c.tabs.length - 1);
        return (
          <View style={[{ gap: 10 }, grow]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }} style={{ borderBottomWidth: 1, borderBottomColor: color.hairline }}>
              {c.tabs.map((tab: any, i: number) => (
                <Pressable key={i} accessibilityRole="tab" accessibilityState={{ selected: i === on }} onPress={() => setUi((u) => ({ ...u, [k]: i }))}
                  style={{ paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 2, borderBottomColor: i === on ? color.primary : 'transparent' }}>
                  <Text style={{ fontSize: 14.5, fontWeight: i === on ? '600' : '400', color: i === on ? color.ink : color.inkMuted }}>{t(tab.title)}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {draw(c.tabs[on].child, ctx, depth + 1)}
          </View>
        );
      }
      case 'Modal': {
        const open = !!ui[k];
        const close = () => setUi((u) => ({ ...u, [k]: false }));
        return (
          <>
            {draw(c.trigger, ctx, depth + 1, { trigger: () => setUi((u) => ({ ...u, [k]: true })) })}
            <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
              <Pressable onPress={close} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 16 }}>
                <Pressable onPress={() => {}} style={{ backgroundColor: color.ground, borderRadius: 20, padding: 18, paddingTop: 36, maxHeight: '85%' }}>
                  <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={{ position: 'absolute', top: 10, right: 10, padding: 4 }}><Icon name="close" size={18} color={color.inkMuted} /></Pressable>
                  <ScrollView>{draw(c.content, ctx, depth + 1)}</ScrollView>
                </Pressable>
              </Pressable>
            </Modal>
          </>
        );
      }
      case 'Button': {
        const blocked = !opts?.trigger && checks.length > 0;
        const variant = c.variant ?? 'default';
        const primary = variant === 'primary';
        const off = blocked || busy !== null;
        return (
          <Pressable accessibilityRole="button" accessibilityLabel={aria} accessibilityState={{ disabled: off }} disabled={off}
            onPress={() => (opts?.trigger ? opts.trigger() : press(c, ctx))}
            style={({ pressed }) => [{ minHeight: 40, borderRadius: 20, paddingHorizontal: variant === 'borderless' ? 6 : 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
              backgroundColor: primary ? color.primary : variant === 'borderless' ? 'transparent' : color.secondaryButton, opacity: off ? 0.45 : pressed ? 0.8 : 1 }, grow]}>
            {sent === k
              ? <><Icon name="check" size={15} color={primary ? color.onPrimary : color.ink} /><Text style={{ fontSize: 15, fontWeight: '500', color: primary ? color.onPrimary : color.ink }}>Sent</Text></>
              : busy === k ? <Text style={{ fontSize: 15, color: primary ? color.onPrimary : color.ink }}>Sending…</Text>
                : <ButtonLabel s={surface} id={c.child} ctx={ctx} tint={primary ? color.onPrimary : variant === 'borderless' ? color.link : color.ink} />}
          </Pressable>
        );
      }
      case 'TextField': {
        const v = readValue(c, ctx);
        return (
          <View style={[{ gap: 4 }, grow]}>
            <Text style={[type.caption, { fontSize: 13 }]}>{t(c.label)}</Text>
            <TextInput value={v == null ? '' : String(v)} placeholder={c.placeholder !== undefined ? t(c.placeholder) : undefined} placeholderTextColor={color.timestamp}
              secureTextEntry={c.variant === 'obscured'} keyboardType={c.variant === 'number' ? 'decimal-pad' : 'default'} multiline={c.variant === 'longText'} onFocus={revealOnFocus}
              onChangeText={(x) => setValue(c, ctx, x)} onBlur={() => { setTouched((s) => new Set(s).add(k)); void flush(); }}
              style={[field(), c.variant === 'longText' ? { minHeight: 72, textAlignVertical: 'top' } : null, problem ? { borderColor: color.problemInk } : null]} />
            {problem}
          </View>
        );
      }
      case 'CheckBox': {
        const on = !!readValue(c, ctx);
        const flip = () => setValue(c, ctx, !on, true);
        return (
          <View style={grow}>
            <Pressable onPress={flip} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 }}>
              <Box on={on} />
              <Text style={[type.body, { flex: 1 }]}>{t(c.label)}</Text>
            </Pressable>
            {problem}
          </View>
        );
      }
      case 'ChoicePicker': return <Picker c={c} ctx={ctx} value={readValue(c, ctx)} onChange={(v) => setValue(c, ctx, v, true)} problem={problem} style={grow} />;
      case 'Slider': {
        const lo = sliderMin(c), hi = sliderMax(c);
        const v = Number(readValue(c, ctx) ?? lo);
        return (
          <View style={[{ gap: 6 }, grow]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[type.caption, { fontSize: 13, flexShrink: 1 }]}>{c.label !== undefined ? t(c.label) : ''}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink, fontVariant: ['tabular-nums'] }}>{String(+v.toFixed(2))}</Text>
            </View>
            <Slider lo={lo} hi={hi} value={v} steps={Number.isInteger(c.steps) && c.steps > 0 ? c.steps : 100} label={c.label !== undefined ? t(c.label) : 'Value'} onChange={(x) => setValue(c, ctx, x)} />
            {problem}
          </View>
        );
      }
      case 'DateTimeInput': {
        const hint = c.enableTime && c.enableDate ? 'YYYY-MM-DD HH:MM' : c.enableTime ? 'HH:MM' : 'YYYY-MM-DD';
        const raw = String(readValue(c, ctx) ?? '');
        return (
          <View style={[{ gap: 4 }, grow]}>
            <Text style={[type.caption, { fontSize: 13 }]}>{c.label !== undefined ? t(c.label) : 'Date'}</Text>
            <TextInput value={raw.replace('T', ' ').slice(0, 16)} placeholder={hint} placeholderTextColor={color.timestamp} onFocus={revealOnFocus}
              keyboardType="numbers-and-punctuation" onChangeText={(x) => setValue(c, ctx, x.trim().replace(' ', 'T'))} onBlur={() => { setTouched((s) => new Set(s).add(k)); void flush(); }} style={field()} />
            {problem}
          </View>
        );
      }
    }
    return null;
  };

  return (
    <View style={{ gap: 8 }}>
      {hasOutside && !showMedia && (
        <Pressable onPress={() => setShowMedia(true)} accessibilityRole="button" style={{ alignSelf: 'flex-start', paddingVertical: 2 }}>
          <Text style={[type.caption, { fontSize: 13, color: color.link }]}>Show pictures from other sites</Text>
        </Pressable>
      )}
      {draw('root', { data, scope: '' }, 0)}
    </View>
  );
}

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
function slotRow(c: A2uiComponent | undefined): ViewStyle | undefined {
  return c?.weight ? { flexGrow: c.weight, flexShrink: 1, flexBasis: 0, minWidth: 0 } : { flexShrink: 1, minWidth: 0 };
}

/** A Button's words or icon, tinted for the button. */
function ButtonLabel({ s, id, ctx, tint }: { s: A2uiSurface; id: string; ctx: A2uiCtx; tint: string }) {
  const c = s.components[id];
  if (!c) return null;
  if (c.component === 'Icon') return <A2uiIcon name={typeof c.name === 'string' ? c.name : evaluate(c.name, ctx)} tint={tint} />;
  if (c.component === 'Text') return <Text style={{ fontSize: 15, fontWeight: '500', color: tint }}>{evalText(c.text, ctx).replace(/[*_`#]+/g, '').trim()}</Text>;
  const kids = childrenOf(c, ctx);
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{kids.map((k) => <ButtonLabel key={k.key} s={s} id={k.id} ctx={k.ctx} tint={tint} />)}</View>;
}

function Box({ on, round }: { on: boolean; round?: boolean }) {
  return (
    <View style={{ width: 22, height: 22, borderRadius: round ? 11 : 6, borderWidth: 2, borderColor: on ? color.ink : color.secondaryBorder, backgroundColor: on ? color.ink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
      {on && <Icon name="check" size={14} color={color.onPrimary} strokeWidth={2.6} />}
    </View>
  );
}

function Picker({ c, ctx, value, onChange, problem, style }: { c: A2uiComponent; ctx: A2uiCtx; value: unknown; onChange: (v: string[]) => void; problem: ReactNode; style?: ViewStyle }) {
  const [filter, setFilter] = useState('');
  const picked = new Set(Array.isArray(value) ? (value as string[]) : []);
  const multi = c.variant === 'multipleSelection';
  const options = (c.options as { label: unknown; value: string }[]).map((o) => ({ label: evalText(o.label, ctx), value: o.value }))
    .filter((o) => !filter || o.label.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (v: string) => onChange(multi ? (picked.has(v) ? [...picked].filter((x) => x !== v) : [...picked, v]) : [v]);
  return (
    <View style={[{ gap: 6 }, style]}>
      {c.label !== undefined && <Text style={[type.body, { fontWeight: '600' }]}>{evalText(c.label, ctx)}</Text>}
      {c.filterable && <TextInput value={filter} onChangeText={setFilter} placeholder="Filter" placeholderTextColor={color.timestamp} style={field()} />}
      {c.displayStyle === 'chips'
        ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {options.map((o) => {
              const on = picked.has(o.value);
              return (
                <Pressable key={o.value} onPress={() => toggle(o.value)} accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: on ? color.ink : color.secondaryBorder, backgroundColor: on ? color.secondaryButton : color.surface }}>
                  {on && <Icon name="check" size={13} color={color.ink} />}
                  <Text style={{ fontSize: 14.5, color: color.ink }}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )
        : options.map((o) => {
          const on = picked.has(o.value);
          return (
            <Pressable key={o.value} onPress={() => toggle(o.value)} accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 }}>
              <Box on={on} round={!multi} />
              <Text style={[type.body, { flex: 1 }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      {problem}
    </View>
  );
}

function Slider({ lo, hi, value, steps, label, onChange }: { lo: number; hi: number; value: number; steps: number; label: string; onChange: (v: number) => void }) {
  const width = useRef(1);
  const latest = useRef(onChange); latest.current = onChange;
  const step = (hi - lo) / steps;
  const at = (x: number) => latest.current(lo + (Math.min(Math.max(x, 0), width.current) / width.current) * (hi - lo));
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => at(e.nativeEvent.locationX),
    onPanResponderMove: (e) => at(e.nativeEvent.locationX),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const frac = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0;
  const bump = (d: number) => onChange(Math.min(hi, Math.max(lo, value + d * step)));
  const stepBtn = (sign: number, text: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${sign < 0 ? 'Less' : 'More'} ${label}`} hitSlop={6} onPress={() => bump(sign)}
      style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.secondaryButton }}>
      <Text style={{ fontSize: 18, color: color.ink, lineHeight: 20 }}>{text}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {stepBtn(-1, '−')}
      <View {...pan.panHandlers} onLayout={(e) => { width.current = Math.max(1, e.nativeEvent.layout.width); }}
        accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min: lo, max: hi, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={{ flex: 1, height: 32, justifyContent: 'center' }}>
        <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: color.hairline }}>
          <View style={{ width: `${frac * 100}%`, height: 6, borderRadius: 3, backgroundColor: color.primary }} />
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', left: `${frac * 100}%`, marginLeft: -11, width: 22, height: 22, borderRadius: 11, backgroundColor: color.primary, borderWidth: 3, borderColor: color.surface }} />
      </View>
      {stepBtn(1, '+')}
    </View>
  );
}

/** A sound from the bot's interface: Play / Pause, loaded only once the person allows pictures and sounds from other sites. */
function AudioRow({ url, label, allowed, onAllow }: { url: string; label: string; allowed: boolean; onAllow: () => void }) {
  const [playing, setPlaying] = useState(false);
  const player = useRef<AudioPlayer | null>(null);
  useEffect(() => () => { try { player.current?.remove(); } catch { /* gone */ } }, []);
  const toggle = () => {
    if (!allowed) { onAllow(); return; }
    if (!player.current) {
      void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      player.current = createAudioPlayer({ uri: url });
      player.current.addListener('playbackStatusUpdate', (s) => { setPlaying(!!s.playing); if (s.didJustFinish) setPlaying(false); });
    }
    if (playing) player.current.pause(); else player.current.play();
  };
  return (
    <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={`${playing ? 'Pause' : 'Play'} ${label}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: color.secondaryButton }}>
      <A2uiIcon name={playing ? 'pause' : 'play'} tint={color.ink} size={18} />
      <Text style={[type.body, { fontSize: 15, flexShrink: 1 }]} numberOfLines={1}>{allowed ? label : `${label} (${hostOf(url)})`}</Text>
    </Pressable>
  );
}

export function A2uiIcon({ name, label, tint, size = 20 }: { name: unknown; label?: string; tint?: string; size?: number }) {
  const custom = name && typeof name === 'object' && typeof (name as any).svgPath === 'string' ? [(name as any).svgPath as string] : null;
  const paths = custom ?? A2UI_ICON_PATHS[typeof name === 'string' ? name : ''] ?? A2UI_ICON_PATHS.help;
  const ink = tint ?? color.inkMuted;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel={label} accessible={!!label}>
      {paths.map((d, i) => <Path key={i} d={d} fill={custom ? ink : 'none'} stroke={custom ? 'none' : ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
    </Svg>
  );
}
