/**
 * A short line at the bottom of the screen for something small that happened or could not happen
 * (a link that would not open, a link copied). Android's own toast; nothing on the web preview.
 */
import { Platform, ToastAndroid } from 'react-native';

export function toast(text: string) {
  if (Platform.OS === 'android') { try { ToastAndroid.show(text, ToastAndroid.LONG); } catch { /* no activity yet */ } }
  else console.warn(text);
}
