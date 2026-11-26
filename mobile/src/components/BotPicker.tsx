import { Pressable, Text, View } from 'react-native';
import type { Bot, Client } from '../api';
import { color, type } from '../theme';
import { BotAvatar } from './BotAvatar';
import { Icon } from './Icon';

/**
 * Tick bots on and off for a group chat: one large row per bot (avatar, name and label, a round tick on
 * the right), so the whole row is the touch target. Used by New group and a group's Members settings.
 */
export function BotPicker({ api, bots, picked, onToggle, disabled }: {
  api: Client; bots: Bot[]; picked: string[]; onToggle: (id: string) => void; disabled?: boolean;
}) {
  if (!bots.length) return <Text style={[type.caption, { padding: 16, textAlign: 'center' }]}>No bots yet. Make a bot first, then a group.</Text>;
  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }}>
      {bots.map((b, i) => {
        const on = picked.includes(b.id);
        return (
          <Pressable key={b.id} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} accessibilityLabel={b.name}
            onPress={disabled ? undefined : () => onToggle(b.id)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: pressed ? color.pressed : 'transparent', opacity: disabled ? 0.55 : 1, borderBottomWidth: i === bots.length - 1 ? 0 : 1, borderBottomColor: color.hairline })}>
            <BotAvatar bot={b} size={44} server={api.server} auth={api.authHeader} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={type.name}>{b.name}</Text>
              {!!b.label && b.label !== b.name && <Text numberOfLines={1} style={[type.caption, { fontSize: 13 }]}>{b.label}</Text>}
            </View>
            <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? color.primary : 'transparent', borderWidth: on ? 0 : 2, borderColor: color.secondaryBorder }}>
              {on && <Icon name="check" size={17} color={color.onPrimary} strokeWidth={2.4} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Bots that can be in a group: every bot that is not itself a group (the web app's rule). A bot hidden from the
 * list (Bot.ownerHidden) is not offered, unless it is already a member (`keep`), so it can still be taken out.
 */
export const groupable = (bots: Bot[], keep: string[] = []) => bots.filter((b) => b.kind !== 'room' && (!b.ownerHidden || keep.includes(b.id)));
