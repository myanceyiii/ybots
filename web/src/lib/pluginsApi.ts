import type { SettingField } from '@shared/plugins/ui-schema';
import { request } from './api';

/**
 * /api/plugins (server/src/plugins/routes.ts). Per-bot switches apply at once (the owner is the approver;
 * the apps offer Undo). Installs, restores and deletes are proposed, then confirmed with the digest shown.
 */

export interface PluginBot { id: string; name: string; enabled: boolean; fromDefault: boolean; ownerName?: string }
export interface PluginInfo {
  id: string; name: string; origin: 'apps.json' | 'env' | 'installed' | string; exclusive: boolean; bots: PluginBot[];
  status: 'ready' | 'error' | 'stopped' | 'disabled'; error?: string; tools: number;
  /** Read-only mode: writes are blocked rather than asked. reads = tools that run without asking; blocked = never run. */
  readOnly?: boolean; reads?: number; blocked?: number; version?: string; digest?: string;
  network: string[]; description?: string; settings: SettingField[]; values: Record<string, string | number | boolean | { set: boolean }>;
  history: { version: string; digest: string; status: 'installed' | 'removed'; installedAt: number }[];
}
export type ChangeAction = 'enable' | 'disable' | 'install' | 'remove' | 'restore' | 'delete';
export interface PluginChange {
  id: string; action: ChangeAction; summary: string; details: string[]; digest: string;
  status: 'pending' | 'applied' | 'cancelled' | 'expired'; expiresAt: number; result?: unknown;
}
export interface SwitchResult {
  pluginId: string; botId: string; pluginName: string; botName: string;
  before: { enabled: boolean; fromDefault: boolean }; after: { enabled: boolean; fromDefault: boolean };
}
export interface PluginDraft {
  id: string; botId: string; botName: string; title: string; purpose: string; tools: { name: string; description: string; writes: boolean }[];
  network: string[]; status: string; digest?: string; checks?: { name: string; ok: boolean; detail: string }[]; pluginId?: string; submissions?: number; createdAt: number; updatedAt: number;
}
/** A draft's files as the server checked them. `text` is null for the server's own kit file. */
export interface DraftFiles {
  draftId: string; title: string; status: string; digest: string; matches: boolean;
  files: { path: string; size: number; text: string | null; kit?: boolean }[];
}

// The shared request (lib/api.ts): the same plain reasons, retries of reads and sign-out handling as the rest of the app.
const req = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, '/plugins');

export const pluginsApi = {
  list: () => req<{ owner: boolean; plugins: PluginInfo[]; pending: PluginChange[]; drafts?: PluginDraft[] }>('GET', ''),
  /** `enabled: null` puts the bot back on the plugin's default (Undo of a default). */
  flip: (pluginId: string, botId: string, enabled: boolean | null) => req<SwitchResult>('POST', '/switch', { pluginId, botId, enabled }),
  propose: (b: { action: ChangeAction; pluginId?: string; botId?: string; spec?: string; bots?: string[]; digest?: string }) => req<PluginChange>('POST', '/changes', b),
  confirm: (id: string, digest: string) => req<PluginChange>('POST', `/changes/${id}/confirm`, { digest }),
  cancel: (id: string) => req<PluginChange>('POST', `/changes/${id}/cancel`),
  build: (draftId: string) => req<{ ok: true }>('POST', `/drafts/${draftId}/build`),
  dismiss: (draftId: string) => req<{ ok: true }>('POST', `/drafts/${draftId}/dismiss`),
  installDraft: (draftId: string, digest: string, bots: string[]) => req<{ pluginId: string }>('POST', `/drafts/${draftId}/install`, { digest, bots }),
  undoDraft: (draftId: string) => req<{ ok: true }>('POST', `/drafts/${draftId}/undo`),
  create: (botId: string, idea: string) => req<{ botId: string }>('POST', '/create', { botId, idea }),
  draftFiles: (draftId: string) => req<DraftFiles>('GET', `/drafts/${draftId}/files`),
  saveSettings: (id: string, values: Record<string, unknown>) => req<{ values: PluginInfo['values'] }>('PUT', `/${id}/settings`, values),
};
