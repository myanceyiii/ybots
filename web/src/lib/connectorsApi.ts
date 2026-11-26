import { request } from './api';

/** /api/connectors (server/src/connectors-routes.ts): every MCP server, past and present. */

export type ConnectorStatus = 'active' | 'stopped' | 'retired' | 'gone' | 'unknown' | 'wanted';
/** A connection wanted for the bots and not set up yet (server/src/connectors.ts Wanted). */
export interface ConnectorWanted { rank?: number; unlocks: string; bots?: string[]; skills?: string[]; setup?: string[]; needs?: string; state?: string; via?: 'browser' }
export type ConnectorReach = 'cleft' | 'needs-setup' | 'cloud' | 'native';
export interface ConnectorInfo {
  id: string; name: string; machine: string | null; transport: string | null; address: string | null; access: string | null; auth: string | null;
  reach: ConnectorReach; description: string | null; notes: string | null; firm: boolean; status: ConnectorStatus; source: string;
  firstSeen: number | null; lastSeen: number | null; goneAt: number | null;
  apps: { id: string; name: string; status: string; bots: string[] }[]; canAdd: boolean; added: boolean; onlyBots?: string[] | null; wanted?: ConnectorWanted | null; custom?: boolean; needsSignIn?: boolean;
  /** A site bots will use through the shared browser (a store, Marketplace), not a connection of its own. */
  browserSite?: boolean;
}
/** A server connected by address: none = no key, key = a header kept on the server, oauth = the server's own sign-in. */
export interface NewConnector { name: string; url: string; auth: 'none' | 'key' | 'oauth'; headerName?: string; headerValue?: string; remote?: boolean; readOnly?: boolean }
export interface ConnectorScan { at: number; answered: string[]; found: number; added: number; gone: number; error?: string | null }
export interface ConnectorChange { id: string; summary: string; details: string[]; digest: string; status: string; expiresAt: number }
export interface ConnectorList { owner: boolean; scanHosts: number; lastScan: ConnectorScan | null; bots: { id: string; name: string }[]; connectors: ConnectorInfo[] }

// The shared request (lib/api.ts): the same plain reasons, retries of reads and sign-out handling as the rest of the app.
const req = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, '/connectors');

export interface WebSearchStatus {
  service: string; keySet: boolean; extract: string; fallback: string | null; cacheMinutes: number; monthStart: number;
  bots: { id: string; name: string; on: boolean; ownSetup: boolean; searches: number | null; reads: number | null }[];
}

export const connectorsApi = {
  list: () => req<ConnectorList>('GET', ''),
  scan: () => req<ConnectorScan>('POST', '/scan', {}),
  propose: (b: { action: 'add' | 'remove'; connectorId: string; bots?: string[] }) => req<ConnectorChange>('POST', '/changes', b),
  confirm: (id: string, digest: string) => req<ConnectorChange>('POST', `/changes/${id}/confirm`, { digest }),
  cancel: (id: string) => req<ConnectorChange>('POST', `/changes/${id}/cancel`, {}),
  /** Connect a server by its MCP address. A sign-in server answers with the page to open. */
  create: (b: NewConnector) => req<{ connectorId: string; signInUrl?: string }>('POST', '/custom', { ...b, returnTo: window.location.origin }),
  signIn: (id: string) => req<{ signInUrl: string }>('POST', `/custom/${encodeURIComponent(id)}/signin`, { returnTo: window.location.origin }),
  remove: (id: string) => req<{ ok: true }>('POST', `/custom/${encodeURIComponent(id)}/delete`, {}),
  /** Changes the admin bot made to connected apps, each allowed on its own card (server/src/connector-admin.ts). */
  /** Web search by API (server/src/web-search.ts): service, key set or not, each bot's use this month. */
  webSearch: () => req<WebSearchStatus>('GET', '/web-search'),
  adminChanges: () => req<{ changes: AdminChange[] }>('GET', '/admin-changes'),
  undoAdminChange: (id: string) => req<{ id: string; summary: string }>('POST', `/admin-changes/${encodeURIComponent(id)}/undo`, {}),
  /** Google accounts: whether sign-in is set up and the redirect address the Web client needs. */
  google: () => req<{ configured: boolean; redirectUri: string; audienceUrl?: string }>('GET', '/google'),
  googleClient: (json: string) => req<{ ok: true }>('POST', '/google/client', { json }),
  /** Google's sign-in page for a new account; read only unless write. */
  googleStart: (write: boolean) => req<{ signInUrl: string }>('POST', '/google/start', { write }),
};

/** Words for a connector's state, shared by the list rows. */
export const STATUS_LABEL: Record<ConnectorStatus, string> = { active: 'Running', stopped: 'Stopped', retired: 'Retired', gone: 'No longer found', unknown: 'Not checked yet', wanted: 'Wanted' };
export const REACH_LABEL: Record<ConnectorReach, string> = {
  cleft: 'Bots can use it', 'needs-setup': 'Needs setup before bots can use it', cloud: 'Cloud connector (claude.ai or ChatGPT)', native: 'Built into a Bot directly',
};

/** Wanted connections first by rank, then by name. */
export const byRank = (a: ConnectorInfo, b: ConnectorInfo) => (a.wanted?.rank ?? 99) - (b.wanted?.rank ?? 99) || a.name.localeCompare(b.name);

export interface AdminChange {
  id: string; app: string; action: string; summary: string; status: string; bot: string; at: string;
  appliedAt?: string; approvedBy?: string; via?: string; rollsBack?: string; rolledBackBy?: string; canRollBack: boolean;
  /** Made by a person in Connections (then `bot` is that person's name), not by the admin bot. */
  byPerson?: boolean;
}
