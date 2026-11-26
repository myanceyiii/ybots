import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { IconData } from '../cardIcon';

/**
 * The app logo or action glyph on an approval card (mobile/src/cardIcon.ts, a copy of the server's
 * card-icon.ts): a brand mark in its colour on a white tile, or a white glyph on a coloured tile.
 */
export function IconTile({ icon, size = 40, radius = 10 }: { icon: IconData; size?: number; radius?: number }) {
  const brand = icon.kind === 'brand';
  const inner = size * (brand ? 0.58 : 0.56);
  return (
    <View
      accessible={false}
      style={{
        width: size, height: size, borderRadius: radius, alignItems: 'center', justifyContent: 'center',
        backgroundColor: brand ? '#FFFFFF' : icon.color,
        ...(brand ? { borderWidth: 0.5, borderColor: '#1C1C1C1F' } : {}),
      }}
    >
      <Svg width={inner} height={inner} viewBox="0 0 24 24"
        {...(brand ? { fill: icon.color } : { fill: 'none', stroke: '#FFFFFF', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })}>
        {icon.d.map((d, i) => <Path key={i} d={d} />)}
      </Svg>
    </View>
  );
}
