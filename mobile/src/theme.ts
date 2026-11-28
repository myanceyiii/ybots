// Tokens from the design (theme-tokens.md v2): the base look follows Grok Bot screen for screen.
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { AvatarColor, AvatarShape } from '@shared/types';

export const appName = 'YBots';

/** Light colours (theme-tokens.md v2). */
const light = {
  ground: '#FAFAFA',
  surface: '#FFFFFF',
  fill: '#EFEFEF',
  secondaryButton: '#E6E6E6',
  secondaryBorder: '#D6D6D6',
  ink: '#111111',
  inkSecondary: '#555555',
  inkMuted: '#6B6B6B',
  timestamp: '#9A9A9A',
  primary: '#111111',
  onPrimary: '#FFFFFF',
  /** Count or second line on a selected (primary) chip. */
  onPrimaryMuted: '#CFCFCF',
  signIn: '#111827',
  danger: '#FB2B3E',
  computer: '#000000',
  computerControl: '#2A2A2A',
  pressed: '#E7E7E7',
  hairline: '#E2E2E2',
  problemFill: '#FDECEE',
  problemInk: '#B3261E',
  link: '#1E6FD9',
  /** Your own chat bubbles. */
  bubbleMine: '#111111',
  onBubbleMine: '#FFFFFF',
  /** Light blue tags and highlights (a task that is working, a block a bot just changed). */
  infoFill: '#E6F0FC',
  /** "Needs you" rows on the home list. */
  alertFill: '#FFF6F6',
  alertBorder: '#F3C9CD',
  /** The last message under a bot's name on the home list. */
  previewInk: '#3D3D3D',
  /** Inline code and code blocks. */
  codeFill: 'rgba(0,0,0,0.06)',
  codeBlock: 'rgba(0,0,0,0.03)',
  /** The "via Slack" tag. */
  slackFill: 'rgba(124,77,255,0.12)',
  slackInk: '#6B3FD9',
  /** Words that say something went well, or needs care (a status tag, a waiting member). */
  goodInk: '#1E7B3A',
  warnInk: '#9A5B00',
};
type Palette = typeof light;

/** Dark colours, matching the web app's dark theme (web/src/styles/tokens.css). Flat, no shadows. */
const dark: Palette = {
  ground: '#121212',
  surface: '#1F1F1F',
  fill: '#262626',
  secondaryButton: '#2C2C2C',
  secondaryBorder: '#3A3A3A',
  ink: '#F5F5F5',
  inkSecondary: '#C9C9C9',
  inkMuted: '#A3A3A3',
  timestamp: '#7C7C7C',
  primary: '#F5F5F5',
  onPrimary: '#121212',
  onPrimaryMuted: '#555555',
  signIn: '#F5F5F5',
  danger: '#FF5A66',
  computer: '#000000',
  computerControl: '#2A2A2A',
  pressed: '#2C2C2C',
  hairline: '#2E2E2E',
  problemFill: '#3A1A1D',
  problemInk: '#FF8A80',
  link: '#5AA2FF',
  bubbleMine: '#3A3A3A',
  onBubbleMine: '#F5F5F5',
  infoFill: '#1B2A3D',
  alertFill: '#2A1A1C',
  alertBorder: '#5A2A30',
  previewInk: '#BDBDBD',
  codeFill: 'rgba(255,255,255,0.09)',
  codeBlock: 'rgba(255,255,255,0.04)',
  slackFill: 'rgba(124,77,255,0.24)',
  slackInk: '#B79BFF',
  goodInk: '#5BD08A',
  warnInk: '#F0B45A',
};

/**
 * The colours in use. Screens read `color.x` while they render, so App.tsx switches the whole palette
 * (applyScheme) before it renders and every screen follows. Never copy a colour into a module-level constant.
 */
export const color: Palette = { ...light };

export type ThemePref = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';
let scheme: Scheme = 'light';
export const currentScheme = () => scheme;
export function applyScheme(s: Scheme) {
  if (s === scheme && color.ground === (s === 'dark' ? dark : light).ground) return;
  scheme = s;
  Object.assign(color, s === 'dark' ? dark : light);
}

// The light/dark choice on this phone (Settings: System, Light, Dark), as on the web. Kept on the phone only.
const THEME_KEY = 'cleftbot.theme';
function readPref(): ThemePref {
  try { const v = SecureStore.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
let pref: ThemePref = readPref();
const prefListeners = new Set<(p: ThemePref) => void>();
export const themePref = () => pref;
export function setThemePref(p: ThemePref) {
  pref = p;
  SecureStore.setItemAsync(THEME_KEY, p).catch(() => {});
  for (const fn of prefListeners) fn(p);
}
export const resolveScheme = (p: ThemePref, system: string | null | undefined): Scheme => (p === 'system' ? (system === 'dark' ? 'dark' : 'light') : p);
// Applied at once, so the first frame already has the right colours.
applyScheme(resolveScheme(pref, Appearance.getColorScheme()));

/** The scheme to draw with: the phone's own setting while on System, else the person's choice. */
export function useScheme(): { scheme: Scheme; pref: ThemePref } {
  const system = useColorScheme();
  const [p, setP] = useState<ThemePref>(pref);
  useEffect(() => { prefListeners.add(setP); return () => { prefListeners.delete(setP); }; }, []);
  return { scheme: resolveScheme(p, system), pref: p };
}

// Answer views (ViewCard): 'rich' draws charts, checklists and calculators; 'simple' shows the same answer as text.
// Kept on the phone only, like the theme; the web keeps its own (configStore answerVisuals).
export type AnswerVisuals = 'rich' | 'simple';
const VISUALS_KEY = 'cleftbot.answerVisuals';
let visuals: AnswerVisuals = (() => { try { return SecureStore.getItem(VISUALS_KEY) === 'simple' ? 'simple' : 'rich'; } catch { return 'rich'; } })();
const visualsListeners = new Set<(v: AnswerVisuals) => void>();
export function setAnswerVisuals(v: AnswerVisuals) {
  visuals = v;
  SecureStore.setItemAsync(VISUALS_KEY, v).catch(() => {});
  for (const fn of visualsListeners) fn(v);
}
export function useAnswerVisuals(): AnswerVisuals {
  const [v, setV] = useState<AnswerVisuals>(visuals);
  useEffect(() => { visualsListeners.add(setV); return () => { visualsListeners.delete(setV); }; }, []);
  return v;
}

/** Type scale (theme-tokens.md v2). Android's own sans (Roboto) stands in for Inter. */
export const type = {
  get welcome() { return { fontSize: 44, fontWeight: '600' as const, letterSpacing: -1.2, color: color.ink }; },
  get screenTitle() { return { fontSize: 20, fontWeight: '600' as const, color: color.ink }; },
  get name() { return { fontSize: 17, fontWeight: '500' as const, color: color.ink }; },
  get body() { return { fontSize: 16, lineHeight: 22, color: color.ink }; },
  get preview() { return { fontSize: 15, color: color.inkMuted }; },
  get caption() { return { fontSize: 14, color: color.inkMuted }; },
  get time() { return { fontSize: 14, color: color.timestamp }; },
  button: { fontSize: 17, fontWeight: '500' as const },
};

/** Bot colours (BOT_COLORS[].fill in the web app). */
export const botColor: Record<string, string> = {
  black: '#000000', brown: '#A06B39', red: '#FB2B3E', orange: '#FD690F', yellow: '#F59312', green: '#14C16F',
  cyan: '#13B7A2', blue: '#1E86FC', violet: '#8F59F9', magenta: '#F93498', gray: '#959595',
};

export const PICKER_SHAPES: AvatarShape[] = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'];
export const COLOR_ORDER: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];
