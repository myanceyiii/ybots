import { useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useLive } from '../live';
import type { LiveModel } from '../poses';
import { color } from '../theme';

// The model and effort a working bot is using, as a chip on its picture (server/src/model-badge.ts names
// the model, so the words match the web and Windows apps). Neutral ink, never a bot colour.

const LEVEL: Record<LiveModel['effort'], number> = { low: 1, medium: 2, high: 3, xhigh: 4 };
const WORD: Record<LiveModel['effort'], string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
const FALLBACK = '#DA830E';

export function modelSummary(m: LiveModel): string {
  const how = m.fallback ? 'switched to this fallback model mid-task' : m.mode === 'auto' ? `Auto picked the ${m.tier ?? ''} tier`.replace('  ', ' ') : 'chosen in settings';
  return `${m.name}, ${WORD[m.effort]} effort, ${how}`;
}

/** The model a bot is answering with right now, or null when idle. */
export function useLiveModel(botId: string | undefined): LiveModel | null {
  const l = useLive(botId ?? '');
  return botId && l?.isRunning && l.model ? l.model : null;
}

function Dots({ effort, tint, size = 3 }: { effort: LiveModel['effort']; tint: string; size?: number }) {
  const n = LEVEL[effort] ?? 2;
  return (
    <View style={{ flexDirection: 'row', gap: 1.5, alignItems: 'center' }}>
      {[1, 2, 3, 4].map((i) => <View key={i} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint, opacity: i <= n ? 1 : 0.32 }} />)}
    </View>
  );
}

/** The chip. A tap opens a small card with the full name, effort and why this model. */
export function ModelBadge({ model, inline, maxWidth }: { model: LiveModel; inline?: boolean; maxWidth?: number }) {
  const [open, setOpen] = useState(false);
  const bg = model.fallback ? FALLBACK : color.ink;
  const fg = model.fallback ? '#FFFFFF' : color.surface;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Using ${modelSummary(model)}`} accessibilityHint="Shows the model details" onPress={() => setOpen(true)} hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 18, paddingHorizontal: 6, borderRadius: 9, backgroundColor: bg, maxWidth,
          ...(inline ? null : { borderWidth: 1.5, borderColor: color.ground }) }}>
        {model.fallback && <Text style={{ color: fg, fontSize: 10, fontWeight: '700' }}>↺</Text>}
        <Text numberOfLines={1} style={{ flexShrink: 1, color: fg, fontSize: 10.5, lineHeight: 13, fontWeight: '700' }}>{model.short}</Text>
        <Dots effort={model.effort} tint={fg} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <View style={{ backgroundColor: color.surface, borderRadius: 18, padding: 18, gap: 6, minWidth: 240, maxWidth: 340 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: color.ink }}>{model.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 15, color: color.inkMuted }}>Effort <Text style={{ fontWeight: '600', color: color.ink }}>{WORD[model.effort]}</Text></Text>
              <Dots effort={model.effort} tint={color.ink} size={5} />
            </View>
            <Text style={{ fontSize: 15, lineHeight: 20, color: color.inkMuted }}>
              {model.fallback ? 'Fallback: the first model failed, so this one took over mid-task.' : model.mode === 'auto' ? `Auto: ${model.tier ? `${model.tier} tier` : 'picked'} for this task.` : 'Manual: the model set in settings.'}
            </Text>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * A picture with the chip hanging off its lower-left edge while the bot works (the primary bot's star is
 * on the right). Nothing extra is drawn when idle, so the layout never moves.
 */
export function WithModelBadge({ botId, children }: { botId: string | undefined; children: ReactNode }) {
  return (
    <View>
      {children}
      <ModelBadgeOverlay botId={botId} />
    </View>
  );
}

/** Just the hanging chip, for a picture's own positioned box (place it last so it draws on top). */
export function ModelBadgeOverlay({ botId }: { botId: string | undefined }) {
  const model = useLiveModel(botId);
  if (!model) return null;
  return <View style={{ position: 'absolute', left: -4, bottom: -8, zIndex: 3 }}><ModelBadge model={model} /></View>;
}

/** The chip on its own (no positioning), only while the bot works. */
export function ModelBadgeInline({ botId, maxWidth }: { botId: string | undefined; maxWidth?: number }) {
  const model = useLiveModel(botId);
  return model ? <ModelBadge model={model} maxWidth={maxWidth} /> : null;
}
