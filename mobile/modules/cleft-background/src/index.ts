import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type NotifyChannel = 'messages' | 'approvals' | 'jobs' | 'link';

/** Android only (modules/cleft-background/android). Elsewhere, and in the web preview, every call does nothing. */
interface Native {
  status(): { ignoringBatteryOptimizations: boolean; notificationsAllowed: boolean; manufacturer: string; sdk: number };
  requestBatteryExemption(): boolean;
  openBatterySettings(): boolean;
  openAppSettings(): boolean;
  watchJob(o: { id: string; url: string; headers: Record<string, string>; working: string; doneTitle: string; doneBody: string; failTitle: string }): boolean;
  stopWatch(id: string): boolean;
  notifyStart(o: { server: string; headers: Record<string, string>; profile: 'main'; scheme: string; appName: string; account?: string }): boolean;
  notifyStop(): boolean;
  notifyFocus(visible: boolean, openChat: string | null): boolean;
  notifyStatus(): { enabled: boolean; signedOut: boolean; lastId: number };
  notifyCancel(tags: string[]): boolean;
  openNotificationSettings(channel: NotifyChannel | null): boolean;
  saveToDownloads(src: string, name: string): Promise<{ uri: string; name: string; mime: string }>;
  openDownload(uri: string, mime: string): boolean;
  takeShared(): string | null;
  takeAssist(): boolean;
  assistantHeld(): boolean | null;
  openAssistantSettings(): boolean;
  canStartInBackground(): boolean;
  openOverlaySettings(): boolean;
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('CleftBackground') : null;
// An app built before the notification link has the module without these functions.
const has = (k: keyof Native) => !!native && typeof (native as any)[k] === 'function';

export const background = {
  available: !!native,
  status: () => native?.status() ?? { ignoringBatteryOptimizations: false, notificationsAllowed: false, manufacturer: '', sdk: 0 },
  requestBatteryExemption: () => native?.requestBatteryExemption() ?? false,
  openBatterySettings: () => native?.openBatterySettings() ?? false,
  openAppSettings: () => native?.openAppSettings() ?? false,
  watchJob: (o: Parameters<Native['watchJob']>[0]) => native?.watchJob(o) ?? false,
  stopWatch: (id: string) => native?.stopWatch(id) ?? false,
  notifyAvailable: has('notifyStart'),
  notifyStart: (o: Parameters<Native['notifyStart']>[0]) => (has('notifyStart') ? native!.notifyStart(o) : false),
  notifyStop: () => (has('notifyStop') ? native!.notifyStop() : false),
  notifyFocus: (visible: boolean, openChat: string | null) => (has('notifyFocus') ? native!.notifyFocus(visible, openChat) : false),
  notifyStatus: () => (has('notifyStatus') ? native!.notifyStatus() : { enabled: false, signedOut: false, lastId: 0 }),
  notifyCancel: (tags: string[]) => (has('notifyCancel') ? native!.notifyCancel(tags) : false),
  /** Android 10+ with an app built after Download was added: copy a fetched file into the phone's Downloads. */
  downloadsAvailable: has('saveToDownloads') && (Platform.Version as number) >= 29,
  saveToDownloads: (src: string, name: string) => native!.saveToDownloads(src, name),
  openDownload: (uri: string, mime: string) => (has('openDownload') ? native!.openDownload(uri, mime) : false),
  /** Text or a link shared to the app from another app, handed over once (src/quick.ts). */
  takeShared: (): string | null => (has('takeShared') ? native!.takeShared() : null),
  /** The phone's assistant gesture opened the app (it is the default digital assistant), handed over once (src/quick.ts). */
  takeAssist: (): boolean => (has('takeAssist') ? native!.takeAssist() : false),
  /** An app built with assistant support: it can be picked as the phone's default digital assistant. */
  assistantAvailable: has('openAssistantSettings'),
  /** Whether this app is the default digital assistant now (Android 10+); null when Android can't say. */
  assistantHeld: (): boolean | null => (has('assistantHeld') ? native!.assistantHeld() : null),
  /** Android's own default digital assistant screen, where the person picks this app. */
  openAssistantSettings: () => (has('openAssistantSettings') ? native!.openAssistantSettings() : false),
  /** An app built with phone timers and alarms (server phone.ts): its notification link takes them. */
  phoneActionsAvailable: has('canStartInBackground'),
  /** Whether Android lets the app open the Clock app while it is in the background ("Display over other apps"). */
  canStartInBackground: (): boolean => (has('canStartInBackground') ? native!.canStartInBackground() : false),
  /** Android's "Display over other apps" screen for this app. */
  openOverlaySettings: () => (has('openOverlaySettings') ? native!.openOverlaySettings() : false),
  openNotificationSettings: (channel: NotifyChannel | null = null) => (has('openNotificationSettings') ? native!.openNotificationSettings(channel) : native?.openAppSettings() ?? false),
};
