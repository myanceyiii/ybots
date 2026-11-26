import { View } from 'react-native';
import { Icon } from './Icon';
import { color } from '../theme';

/** The tick on the picked picture in a look picker (top right, over the picture). */
export function CheckBadge() {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24, borderRadius: 12, backgroundColor: color.link, borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="check" size={14} color="#FFFFFF" strokeWidth={2.6} />
    </View>
  );
}
