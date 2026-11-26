// A live wave beside the mic while dictating (as on the web: web/src/components/Composer.tsx MicWave):
// bars that move with your voice, newest on the right. Grey and gently pulsing while the last words
// are being written down.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { color } from '../theme';

const BARS = 14;

export function MicWave({ level, busy }: { level: () => number; busy: boolean }) {
  const [hist, setHist] = useState<number[]>(() => new Array(BARS).fill(0));
  useEffect(() => {
    let tick = 0;
    const t = setInterval(() => {
      tick++;
      setHist((h) => [...h.slice(1), busy ? 0.15 + 0.2 * (0.5 + 0.5 * Math.sin(tick / 2)) : Math.min(1, Math.sqrt(level()) * 1.6)]);
    }, 80);
    return () => clearInterval(t);
  }, [level, busy]);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={busy ? 'Finishing the words' : 'Listening'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 24, marginBottom: 12, marginHorizontal: 4 }}>
      {hist.map((v, i) => (
        <View key={i} style={{ width: 3, borderRadius: 2, height: Math.max(3, Math.round(24 * v)), backgroundColor: busy ? color.inkSecondary : color.danger }} />
      ))}
    </View>
  );
}
