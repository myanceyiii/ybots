import type { CSSProperties } from 'react';
import {
  ArrowDown, ArrowUp, AudioLines, AudioWaveform, BadgeCheck, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock,
  CircleHelp, ClipboardPaste, Command, Copy, Ellipsis, Eye, FileText, Hash, Keyboard, LayoutGrid, Maximize2, MessageCircle, Mic, Minimize2, Monitor, MousePointer2,
  PanelLeft, Paperclip, Play, Plus, Reply, RotateCw, Search, Share, SmilePlus, Square, SquarePen, Star, X, Trash2, Volume2, ZoomIn, ZoomOut, BellOff, Pin, Download, History, WifiOff, Image as ImageIcon, type LucideIcon } from 'lucide-react';

export type IconName =
  | 'apps' | 'arrow_down' | 'chat_filled' | 'check' | 'chev_down' | 'chev_left' | 'chev_right' | 'clock' | 'close'
  | 'composer_plus' | 'copy' | 'edit' | 'file' | 'mic' | 'paperclip' | 'plus' | 'record' | 'save'
  | 'search' | 'share' | 'sidebar' | 'slack' | 'star' | 'voice_a' | 'voice_b' | 'verified'
  | 'arrow_up' | 'stop' | 'more' | 'monitor' | 'refresh'
  | 'eye' | 'pointer' | 'expand' | 'shrink'
  | 'keyboard' | 'keys' | 'zoom_in' | 'zoom_out' | 'help' | 'play' | 'paste' | 'reply' | 'react' | 'chat' | 'trash' | 'bell_off' | 'pin' | 'download' | 'history' | 'offline' | 'image' | 'speaker';

/** Icon name → Lucide glyph (ISC, see THIRD_PARTY_NOTICES.md). `filled` paints the shape solid. */
const ICONS: Record<IconName, { icon: LucideIcon; filled?: boolean }> = {
  apps: { icon: LayoutGrid },
  bell_off: { icon: BellOff },
  pin: { icon: Pin },
  download: { icon: Download },
  history: { icon: History },
  offline: { icon: WifiOff },
  image: { icon: ImageIcon },
  arrow_down: { icon: ArrowDown },
  arrow_up: { icon: ArrowUp },
  chat_filled: { icon: MessageCircle, filled: true },
  chat: { icon: MessageCircle },
  trash: { icon: Trash2 },
  check: { icon: Check },
  chev_down: { icon: ChevronDown },
  chev_left: { icon: ChevronLeft },
  chev_right: { icon: ChevronRight },
  clock: { icon: Clock },
  close: { icon: X },
  composer_plus: { icon: Plus },
  copy: { icon: Copy },
  paste: { icon: ClipboardPaste },
  edit: { icon: SquarePen },
  expand: { icon: Maximize2 },
  eye: { icon: Eye },
  file: { icon: FileText },
  help: { icon: CircleHelp },
  keyboard: { icon: Keyboard },
  keys: { icon: Command },
  mic: { icon: Mic },
  monitor: { icon: Monitor },
  more: { icon: Ellipsis },
  paperclip: { icon: Paperclip },
  plus: { icon: Plus },
  pointer: { icon: MousePointer2 },
  record: { icon: Circle, filled: true },
  reply: { icon: Reply },
  react: { icon: SmilePlus },
  refresh: { icon: RotateCw },
  save: { icon: Bookmark },
  play: { icon: Play, filled: true },
  search: { icon: Search },
  share: { icon: Share },
  shrink: { icon: Minimize2 },
  sidebar: { icon: PanelLeft },
  slack: { icon: Hash },
  star: { icon: Star, filled: true },
  stop: { icon: Square, filled: true },
  speaker: { icon: Volume2 },
  verified: { icon: BadgeCheck },
  voice_a: { icon: AudioLines },
  voice_b: { icon: AudioWaveform },
  zoom_in: { icon: ZoomIn },
  zoom_out: { icon: ZoomOut },
};

interface Props { name: IconName; size?: number; opacity?: number; className?: string; style?: CSSProperties; color?: string }

/** Single-color line icon that inherits `currentColor` (or `color`). */
export function Icon({ name, size = 16, opacity, className, style, color }: Props) {
  const { icon: Glyph, filled } = ICONS[name] ?? ICONS.more;
  return (
    <Glyph
      aria-hidden
      className={className}
      size={size}
      strokeWidth={size <= 12 ? 2.25 : 2}
      fill={filled ? 'currentColor' : 'none'}
      style={{ display: 'inline-block', flexShrink: 0, opacity, color, ...style }}
    />
  );
}
