import { Pressable, View } from 'react-native';
import { BotShape } from './BotAvatar';
import { Label } from './ui';
import { botColor, color, COLOR_ORDER, PICKER_SHAPES } from '../theme';
import type { AvatarColor, AvatarShape } from '@shared/types';

/** The shape grid (five across) and the colour row, shared by New bot and a bot's look. */
export function ShapePicker({ shape, tint, onShape, onTint }: { shape: AvatarShape; tint: AvatarColor; onShape: (s: AvatarShape) => void; onTint: (c: AvatarColor) => void }) {
  return (
    <View>
      <Label>Shape</Label>
      <View style={{ backgroundColor: color.fill, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 6, flexDirection: 'row', flexWrap: 'wrap' }}>
        {PICKER_SHAPES.map((s) => {
          const on = s === shape;
          return (
            <Pressable key={s} accessibilityRole="button" accessibilityLabel={s} accessibilityState={{ selected: on }} onPress={() => onShape(s)}
              style={{ width: '20%', aspectRatio: 1, padding: 4 }}>
              <View style={{ flex: 1, borderRadius: 16, backgroundColor: on ? color.surface : 'transparent', borderWidth: on ? 2 : 0, borderColor: color.ink, alignItems: 'center', justifyContent: 'center' }}>
                <BotShape shape={s} color={tint} size={36} />
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={{ height: 18 }} />
      <Label>Colour</Label>
      <View style={{ backgroundColor: color.fill, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
        {COLOR_ORDER.map((c) => {
          const on = c === tint;
          return (
            <Pressable key={c} accessibilityRole="button" accessibilityLabel={c} accessibilityState={{ selected: on }} onPress={() => onTint(c)}
              style={{ width: `${100 / 6}%`, alignItems: 'center', paddingVertical: 5 }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, borderWidth: on ? 2 : 0, borderColor: color.ink, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: on ? 26 : 30, height: on ? 26 : 30, borderRadius: 15, backgroundColor: botColor[c] }} />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
