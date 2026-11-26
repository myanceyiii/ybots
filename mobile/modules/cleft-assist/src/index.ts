// The assistant card's link to Android (modules/cleft-assist). Android only; elsewhere `available` is false.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type ScreenState = 'none' | 'waiting' | 'ready' | 'blocked' | 'dropped';
export interface AssistState { invocation: number; screen: ScreenState; screenshot: string | null; pageUrl: string | null }

interface Native {
  state(): AssistState;
  dropScreenshot(): void;
  keepOpen(on: boolean): void;
  close(): void;
  openApp(url: string): boolean;
  openSettings(): boolean;
  serviceActive(): boolean | null;
  addListener(name: 'onScreen' | 'onInvoke', fn: (e: any) => void): { remove(): void };
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('CleftAssist') : null;

export const assistNative = {
  available: !!native,
  state: (): AssistState => native?.state() ?? { invocation: 0, screen: 'none', screenshot: null, pageUrl: null },
  dropScreenshot: () => { try { native?.dropScreenshot(); } catch { /* gone */ } },
  keepOpen: (on: boolean) => { try { native?.keepOpen(on); } catch { /* gone */ } },
  close: () => { try { native?.close(); } catch { /* gone */ } },
  openApp: (url: string) => { try { return native?.openApp(url) ?? false; } catch { return false; } },
  openSettings: () => { try { return native?.openSettings() ?? false; } catch { return false; } },
  serviceActive: (): boolean | null => { try { return native?.serviceActive() ?? null; } catch { return null; } },
  onScreen: (fn: (s: AssistState) => void) => native?.addListener('onScreen', fn) ?? { remove() {} },
  onInvoke: (fn: (e: { invocation: number }) => void) => native?.addListener('onInvoke', fn) ?? { remove() {} },
};
