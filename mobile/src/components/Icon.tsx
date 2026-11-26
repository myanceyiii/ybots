import { color as themeColor } from '../theme';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const paths = {
  back: () => <Path d="M19 12H5M11 5l-7 7 7 7" />,
  search: () => <><Circle cx="11" cy="11" r="7" /><Path d="M20 20l-3.5-3.5" /></>,
  plus: () => <Path d="M12 5v14M5 12h14" />,
  close: () => <Path d="M6 6l12 12M18 6L6 18" />,
  monitor: () => <><Rect x="3" y="4" width="18" height="12" rx="2" /><Path d="M8 20h8M12 16v4" /></>,
  keyboard: () => <><Rect x="3" y="6" width="18" height="12" rx="2" /><Path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" /></>,
  more: () => <><Circle cx="5" cy="12" r="1" /><Circle cx="12" cy="12" r="1" /><Circle cx="19" cy="12" r="1" /></>,
  mic: () => <><Rect x="9" y="3" width="6" height="11" rx="3" /><Path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  arrow: () => <Path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: () => <Path d="M9 6l6 6-6 6" />,
  send: () => <Path d="M12 19V5M6 11l6-6 6 6" />,
  sparkle: () => <Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  upload: () => <Path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  download: () => <Path d="M12 4v12M7 11l5 5 5-5M5 20h14" />,
  image: () => <><Rect x="3" y="4" width="18" height="16" rx="3" /><Circle cx="9" cy="10" r="2" /><Path d="M21 16l-5-5-9 9" /></>,
  camera: () => <><Path d="M4 8h3l2-3h6l2 3h3v11H4z" /><Circle cx="12" cy="13" r="3.5" /></>,
  file: () => <><Path d="M7 3h7l5 5v13H7z" /><Path d="M14 3v5h5" /></>,
  link: () => <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  clipboard: () => <><Rect x="6" y="4" width="12" height="17" rx="2" /><Path d="M9 4h6v3H9z" /></>,
  phone: () => <Path d="M4 14c4.5-4 11.5-4 16 0l-2 3-3-1v-2.5a9 9 0 0 0-6 0V16l-3 1z" />,
  // Lucide "audio-lines" (ISC): voice chat.
  voice: () => <Path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" />,
  text: () => <Path d="M4 6h16M4 12h16M4 18h10" />,
  sliders: () => <><Path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><Circle cx="16" cy="7" r="2" /><Circle cx="10" cy="17" r="2" /></>,
  micoff: () => <Path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.3M12 18v3" />,
  palette: () => <><Path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-1.2-1-1.5-1-2.6 0-.9.7-1.7 1.7-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" /><Circle cx="7.5" cy="11" r="1" /><Circle cx="10" cy="7" r="1" /><Circle cx="15" cy="7.5" r="1" /></>,
  signout: () => <Path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11" />,
  // A QR code: three corner squares and a few dots (Sign in another device).
  qr: () => <Path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" />,
  group: () => <><Circle cx="9" cy="8" r="3.2" /><Path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5" /><Circle cx="17" cy="9" r="2.6" /><Path d="M16.5 14c2.4.1 4 1.6 4.5 4.5" /></>,
  // A checklist: two ticked lines and one to go (the web sidebar's Tasks glyph).
  tasks: () => <Path d="M3.5 6l1.6 1.6L8 4.6M3.5 12l1.6 1.6L8 10.6M11.5 6.5H20M11.5 12.5H20M4.5 18.5h.01M11.5 18.5H20" />,
  check: () => <Path d="M5 12.5l4.5 4.5L19 7" />,
  play: (c?: string) => <Path d="M8 5.5v13l10.5-6.5z" fill={c} />,
  // A loudspeaker with two sound waves: Listen (a reply read aloud).
  speaker: () => <><Path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" /><Path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  stop: (c?: string) => <Path d="M7 7h10v10H7z" fill={c} />,
  expand: () => <Path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  shrink: () => <Path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  refresh: () => <Path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  pointer: () => <Path d="M5 3l14 7-6 2-2 6z" />,
  puzzle: () => <Path d="M9 4.5a2 2 0 1 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 1 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 1 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 1 0 0-4H4V7a1 1 0 0 1 1-1h4z" />,
  folder: () => <Path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
  table: () => <><Rect x="3" y="4" width="18" height="16" rx="2" /><Path d="M3 10h18M3 15h18M9 4v16" /></>,
  slides: () => <><Rect x="3" y="4" width="18" height="12" rx="2" /><Path d="M12 16v4M8 20h8" /></>,
  eye: () => <><Path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><Circle cx="12" cy="12" r="3" /></>,
  eyeoff: () => <Path d="M3 3l18 18M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  copy: () => <><Rect x="8" y="8" width="13" height="13" rx="2" /><Path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  share: () => <><Circle cx="18" cy="5" r="2.6" /><Circle cx="6" cy="12" r="2.6" /><Circle cx="18" cy="19" r="2.6" /><Path d="M8.3 13.3l7.4 4.4M15.7 6.3l-7.4 4.4" /></>,
  chat: () => <Path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  pin: () => <Path d="M9 4h6l-1 5 4 4H6l4-4zM12 13v7" />,
  bookmark: () => <Path d="M6 4h12v17l-6-4-6 4z" />,
  calc: () => <><Rect x="5" y="3" width="14" height="18" rx="2" /><Path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" /></>,
  chart: () => <Path d="M4 20V10M10 20V4M16 20v-8M3 20h18" />,
  history: () => <><Path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><Path d="M3 3v5h5M12 7v5l3 2" /></>,
  belloff: () => <Path d="M3 3l18 18M8.6 4.3A6 6 0 0 1 18 9c0 2.6.6 4.4 1.3 5.6M6 9c0 5-2 6.5-2 6.5h12.5M10 20a2 2 0 0 0 4 0" />,
  trash: () => <Path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  edit: () => <Path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  reply: () => <Path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1" />,
  // Lucide "smile-plus" (ISC).
  react: () => <Path d="M22 11v1a10 10 0 1 1-9-10M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6" />,
  // Reminders, today, and the kinds of things to ask.
  bell: () => <Path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9zM10 20a2 2 0 0 0 4 0" />,
  sun: () => <><Circle cx="12" cy="12" r="4" /><Path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  cart: () => <><Path d="M3 4h2.5l2.2 10.5h9.6L19.5 7H7" /><Circle cx="9" cy="19" r="1.4" /><Circle cx="16.5" cy="19" r="1.4" /></>,
  bowl: () => <Path d="M3 11h18a9 9 0 0 1-18 0zM8 20h8M9 7c0-1.5 1.5-1.5 1.5-3M13.5 7c0-1.5 1.5-1.5 1.5-3" />,
  coin: () => <><Circle cx="12" cy="12" r="9" /><Path d="M14.8 9.2c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 3 5.8 1.3 5.8 4.3 0 1.3-1.3 2.1-3 2.1-1.4 0-2.5-.6-3-1.6M12 6v1.8M12 16.3V18" /></>,
  tag: () => <><Path d="M3 12.5V4.5A1.5 1.5 0 0 1 4.5 3h8l8.5 8.5-9.5 9.5z" /><Circle cx="8" cy="8" r="1.3" /></>,
  house: () => <Path d="M4 11l8-7 8 7v9h-5.5v-6h-5v6H4z" />,
  bulb: () => <Path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  star: () => <Path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" />,
  pause: () => <Path d="M8 5v14M16 5v14" />,
  minus: () => <Path d="M5 12h14" />,
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 22, color = themeColor.ink, strokeWidth = 1.9 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {paths[name](color)}
    </Svg>
  );
}
