import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { Bot, Client, Row } from '../api';
import { BOARD_TIMES, boardLine, boardState, stoppedBar, type BoardState } from '../boardPin';
import { botColor, color } from '../theme';
import { useSimple } from '../simple';
import { BotAvatar } from './BotAvatar';
import { Icon } from './Icon';
import { ViewCard } from './ViewCard';

/**
 * Pinned boards (server/src/board-pin.ts) on Android: a bot's progress or checklist view kept in reach just
 * above the message box, however far the chat has moved on. One line (title, bar, %); a tap opens it in a
 * bottom sheet as the live card, so ticks and updates are the same as in the chat. The original card stays
 * where it was. Several boards: "+N" and tabs, each with its bot's face (groups). The web and Windows apps have the same dock (web/src/components/BoardDock.tsx).
 * Title and step are whole-phrase summaries (boardLine) that wrap to two lines, never cut mid-word; the open
 * board has the full words. A stopped board says so, has Dismiss, and lets go by itself after an hour.
 */

type Board = { row: Row; body: any; state: BoardState };

export function pinnedBoards(rows: Row[], now: number): Board[] {
  const out: Board[] = [];
  for (const row of rows) {
    const b: any = row.body;
    if (b?.type !== 'card' || b.card !== 'view' || !b.pin?.on) continue;
    const state = boardState(b, row.createdAt, now);
    if (state) out.push({ row, body: b, state });
  }
  // Work still going first, then finished, then stopped; newest change first within each.
  const rank = (x: Board) => (x.state === 'stopped' ? 2 : x.state === 'done' ? 1 : 0);
  const last = (x: Board) => Math.max(x.body.updatedAt ?? 0, x.row.createdAt, x.body.pin?.at ?? 0);
  return out.sort((a, b) => rank(a) - rank(b) || last(b) - last(a));
}

export const boardSummary = (body: any, o?: { title?: number; step?: number }) => boardLine(body, o);

const ago = (ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

function Bar({ pct, width, tint }: { pct: number; width: number; tint: string }) {
  return (
    <View style={{ width: width < 0 ? '100%' : width, height: 6, borderRadius: 3, backgroundColor: color.fill, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: '100%', borderRadius: 3, backgroundColor: tint }} />
    </View>
  );
}

export function BoardDock({ api, bot, bots, rows, onJump }: { api: Client; bot: Bot; bots?: Bot[]; rows: Row[]; onJump?: (seq: number) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  // The simple view: a scoped sign-in (same rule as the rest of the chat).
  const simple = useSimple();
  const all = useMemo(() => pinnedBoards(rows, now), [rows, now]);
  const boards = simple ? all.slice(0, 1) : all;
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [undo, setUndo] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { height, width } = useWindowDimensions();
  // A phone puts the bar under the words so the title and step get the full width; a tablet keeps it beside them.
  const wide = width >= 600;
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 6000); return () => clearTimeout(t); }, [undo]);
  useEffect(() => { setOpen(false); setPick(null); setUndo(null); }, [bot.id]);

  const pin = async (row: Row, on: boolean) => {
    setError(null);
    try { await api.pinBoard(bot.id, row, on); setUndo(on ? null : row); if (!on) setOpen(false); }
    catch (e: any) { setError(e?.message ?? 'That didn’t go through'); }
  };

  if (!boards.length) {
    if (!undo) return null;
    return (
      <View style={{ marginHorizontal: 16, marginTop: 6, height: 44, borderRadius: 22, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 6 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: color.inkSecondary }}>Unpinned {undo.body.title || 'the board'}</Text>
        <Pressable accessibilityRole="button" onPress={() => pin(undo, true)} style={({ pressed }) => ({ height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center', backgroundColor: pressed ? color.pressed : color.fill })}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink }}>Undo</Text>
        </Pressable>
      </View>
    );
  }

  const current = boards.find((b) => b.row.seq === pick) ?? boards[0];
  const who = (b: Board): Bot => (b.body.from && bots?.find((x) => x.id === b.body.from.id)) || bot;
  const tint = (b: Board) => (b.state === 'done' ? '#14C16F' : b.state === 'stopped' ? color.inkMuted : botColor[who(b).avatarColor] ?? color.primary);
  const face = (b: Board, size: number) => <BotAvatar bot={who(b)} size={size} server={api.server} auth={api.authHeader} still crop="portrait" />;
  const sum = boardSummary(current.body, wide ? undefined : { title: 48 });
  const last = Math.max(current.body.updatedAt ?? 0, current.row.createdAt);
  const stop = stoppedBar(current.body.blocks);
  const leftMin = stop ? Math.max(1, Math.ceil((BOARD_TIMES.stoppedMs - (now - Math.max(stop.stopped!.at, current.body.pin?.at ?? 0))) / 60_000)) : 0;
  const stopped = current.state === 'stopped';
  const stateText = current.state === 'done' ? 'Done' : stopped ? `Stopped ${ago(now - last)} · goes away by itself in ${leftMin} min` : current.state === 'paused' ? `Paused · no update ${ago(now - last)}` : `Updated ${ago(now - last)}`;
  const dot = current.state === 'paused' || stopped ? '#DA830E' : '#14C16F';
  const stepText = current.state === 'done' ? 'All done' : sum.step;
  const meter = sum.pct === null ? null : (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: wide ? 0 : 4 }}>
      {wide ? <Bar pct={sum.pct} width={simple ? 48 : 52} tint={tint(current)} /> : <View style={{ flex: 1, maxWidth: 180 }}><Bar pct={sum.pct} width={-1} tint={tint(current)} /></View>}
      {!simple && <Text style={{ minWidth: 38, fontSize: 13, fontWeight: '600', color: stopped ? color.inkMuted : color.ink }}>{current.state === 'done' ? 'Done' : `${sum.pct}%`}</Text>}
    </View>
  );

  return (
    <>
      <View style={{ marginHorizontal: 16, marginTop: 6, minHeight: simple ? 52 : 44, borderRadius: simple ? 26 : 22, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, flexDirection: 'row', alignItems: 'center', paddingLeft: 6, paddingRight: 4, paddingVertical: 3, gap: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${sum.fullTitle}. ${sum.fullStep}`} onPress={() => setOpen(true)}
          style={({ pressed }) => ({ flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 4, borderRadius: 20, backgroundColor: pressed ? color.pressed : 'transparent' })}>
          {face(current, simple ? 30 : 26)}
          {!simple && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />}
          <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
            <Text numberOfLines={2} style={{ fontSize: simple ? 16 : 14, lineHeight: simple ? 20 : 18, fontWeight: '600', color: color.ink }}>{sum.title}</Text>
            {!!stepText && <Text numberOfLines={2} style={{ fontSize: simple ? 14 : 12, lineHeight: simple ? 18 : 16, color: color.inkSecondary }}>{stepText}</Text>}
            {!wide && meter}
          </View>
          {wide && meter}
        </Pressable>
        {!simple && boards.length > 1 && (
          <Pressable accessibilityRole="button" accessibilityLabel={`${boards.length - 1} more boards`} onPress={() => setOpen(true)} style={{ height: 26, paddingHorizontal: 8, borderRadius: 13, backgroundColor: color.fill, justifyContent: 'center' }}>
            <Text style={{ fontSize: 12, color: color.inkSecondary }}>+{boards.length - 1}</Text>
          </Pressable>
        )}
        {simple || stopped
          ? <Pressable accessibilityRole="button" onPress={() => pin(current.row, false)} style={({ pressed }) => ({ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: pressed ? color.pressed : color.fill })}>
            <Text style={{ fontSize: 14, color: color.inkSecondary }}>{simple ? 'Hide' : 'Dismiss'}</Text>
          </Pressable>
          : <Pressable accessibilityRole="button" accessibilityLabel="Unpin" onPress={() => pin(current.row, false)} hitSlop={6}
            style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Icon name="close" size={16} color={color.inkSecondary} />
          </Pressable>}
      </View>
      {!!error && !open && <Text style={{ marginHorizontal: 24, marginTop: 4, fontSize: 13, color: color.problemInk }}>{error}</Text>}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable accessibilityLabel="Close the board" style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={() => setOpen(false)} />
        <View style={{ maxHeight: height * 0.78, backgroundColor: color.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 18 }}>
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: color.hairline, marginTop: 10, marginBottom: 6 }} />
          {boards.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 4 }}>
              {boards.map((b) => {
                const on = b === current; const s = boardSummary(b.body, { title: 28 });
                return (
                  <Pressable key={b.row.seq} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setPick(b.row.seq)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingLeft: 4, paddingRight: 12, borderRadius: 16, backgroundColor: on ? color.primary : color.fill }}>
                    {face(b, 24)}
                    <Text numberOfLines={1} style={{ fontSize: 13, color: on ? color.onPrimary : color.inkSecondary }}>{s.title}{s.pct !== null ? ` · ${b.state === 'done' ? 'Done' : b.state === 'stopped' ? 'Stopped' : `${s.pct}%`}` : ''}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
            {face(current, 28)}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: color.ink }}>{sum.fullTitle}</Text>
              <Text style={{ fontSize: 13, color: color.inkMuted }}>{stateText}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setOpen(false)} style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : color.fill })}>
              <Icon name="close" size={18} color={color.inkSecondary} />
            </Pressable>
          </View>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12 }}>
            <ViewCard api={api} bot={bot} row={current.row} docked />
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
            {!!onJump && (
              <Pressable accessibilityRole="button" onPress={() => { setOpen(false); onJump(current.row.seq); }} style={({ pressed }) => ({ height: 40, paddingHorizontal: 14, borderRadius: 20, justifyContent: 'center', backgroundColor: pressed ? color.pressed : color.fill })}>
                <Text style={{ fontSize: 14, color: color.ink }}>Jump to message</Text>
              </Pressable>
            )}
            <View style={{ flex: 1 }} />
            <Pressable accessibilityRole="button" onPress={() => pin(current.row, false)} style={({ pressed }) => ({ height: 40, paddingHorizontal: 14, borderRadius: 20, justifyContent: 'center', backgroundColor: pressed ? color.pressed : color.fill })}>
              <Text style={{ fontSize: 14, color: color.ink }}>{simple ? 'Hide' : stopped ? 'Dismiss' : 'Unpin'}</Text>
            </Pressable>
          </View>
          {!!error && <Text style={{ marginHorizontal: 16, marginTop: 6, fontSize: 13, color: color.problemInk }}>{error}</Text>}
        </View>
      </Modal>
    </>
  );
}
