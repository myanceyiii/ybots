import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { BotShape } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { appName, color, type } from '../theme';

// Grok Bot's welcome screen layout, with our own characters floating around the title.
// Positions are fractions of the screen so they land the same on any phone: [shape, colour, size, x, y, tilt].
const FLOATERS: [string, string, number, number, number, number][] = [
  ['blob', 'violet', 62, 0.11, 0.14, -8], ['wedge', 'magenta', 58, 0.52, 0.04, 12], ['egg', 'orange', 52, 0.82, 0.19, 10], ['cylinder', 'gray', 50, 0.05, 0.32, -10],
  ['hex', 'cyan', 60, 0.82, 0.56, 14], ['teardrop', 'blue', 54, 0.15, 0.76, -6], ['tablet', 'yellow', 50, 0.68, 0.9, 8], ['cloud', 'green', 50, 0.7, 0.7, -12],
];

export function Welcome({ onSignIn }: { onSignIn: () => void }) {
  const { width, height } = useWindowDimensions();
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      {FLOATERS.map(([shape, c, size, x, y, tilt], i) => (
        <View key={i} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', left: x * width, top: y * height, transform: [{ rotate: `${tilt}deg` }] }}><BotShape shape={shape} color={c} size={size} /></View>
      ))}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Text style={type.welcome}>{appName}</Text>
        <Text style={{ marginTop: 8, marginBottom: 26, fontSize: 17, lineHeight: 24, color: color.inkSecondary, textAlign: 'center' }}>
          {'Your own team of bots that\nkeep working while you’re away.'}
        </Text>
        <Pressable accessibilityRole="button" onPress={onSignIn}
          style={({ pressed }) => ({ height: 46, paddingHorizontal: 26, borderRadius: 23, backgroundColor: color.signIn, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.85 : 1 })}>
          <Text style={{ color: color.onPrimary, fontSize: 17, fontWeight: '500' }}>Sign in</Text>
          <Icon name="arrow" size={18} color={color.onPrimary} />
        </Pressable>
      </View>
    </View>
  );
}
