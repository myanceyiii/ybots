import { request } from './api';

/** /api/connections (server/src/connections.ts): every connection, worded by the server so every app says the same. */

export type ConnState = 'connected' | 'needs_reconnect' | 'not_working' | 'off';
export type ToolRule = 'runs' | 'asks' | 'off';
export interface ConnTool { name: string; label: string; rule: ToolRule; chosen: boolean; choices: ToolRule[]; note: string | null }
export interface ConnAction { id: 'turn_off' | 'turn_on' | 'remove' | 'delete' | 'restore'; label: string; danger: boolean; hint: string }
export interface Connection {
  id: string; name: string; logo?: string; kind: 'google' | 'service' | 'plugin';
  state: ConnState; stateText: string; summary: string; problem: string | null; usedBy: string;
  bots: { id: string; name: string; on: boolean; ownerName?: string }[];
  toolsLine: string; tools: ConnTool[];
  reconnect: { label: string; hint: string; write?: boolean; confirm?: boolean } | null;
  actions: ConnAction[]; firm: boolean; details: { label: string; value: string }[];
  pluginSettings?: { settings: unknown[]; values: Record<string, unknown> };
}
export interface ReadyConnection { id: string; name: string; summary: string; problem: string | null; needsSignIn: boolean; onlyBots: string[] | null; canDelete: boolean; reconnect: boolean }
export interface ConnectionList { owner: boolean; connections: Connection[]; ready: ReadyConnection[] }
export interface ConnProposal { id: string; summary: string; details: string[]; digest: string; danger: boolean; status: string; expiresAt: number; signInUrl?: string; note?: string }

const req = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, '/connections');
const enc = encodeURIComponent;

export const connectionsApi = {
  list: () => req<ConnectionList>('GET', ''),
  reconnect: (id: string, write?: boolean) => req<{ signInUrl?: string; note: string }>('POST', `/${enc(id)}/reconnect`, { ...(write === undefined ? {} : { write }), returnTo: window.location.origin }),
  setTool: (id: string, tool: string, rule: ToolRule | null) => req<{ tool: ConnTool }>('PUT', `/${enc(id)}/tools/${enc(tool)}`, { rule }),
  propose: (id: string, action: string) => req<ConnProposal>('POST', `/${enc(id)}/changes`, { action }),
  confirm: (cid: string, digest: string) => req<ConnProposal>('POST', `/changes/${enc(cid)}/confirm`, { digest }),
  cancel: (cid: string) => req<ConnProposal>('POST', `/changes/${enc(cid)}/cancel`, {}),
};
