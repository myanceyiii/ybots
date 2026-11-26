import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import EventSource from 'react-native-sse';
import type { LiveState } from './poses';
import { File as FsFile } from 'expo-file-system';
// The app's fetch for bodies of bytes (see src/voice/upload.ts for why).
import { fetch as expoFetch } from 'expo/fetch';
import { onKick, requestFailed, requestOk, streamData, streamDown, streamOpened, serverRestarting, serverUpdating } from './connection';

/**
 * How long a request may take before the app gives up on it. Without a limit, a request made while the
 * phone changes networks can hang for minutes with a spinner that never ends. Reads answer fast; a few
 * calls do real work on the server before they answer (a provider check, an export), so they get longer.
 */
const READ_TIMEOUT = 25_000;
const WRITE_TIMEOUT = 75_000;

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/** A message found by search (server/src/chat-extras.ts). `current` is false for one in an earlier conversation. */
export interface SearchHit { chatId: string; botId: string; sideTitle: string | null; generation: number; seq: number; current: boolean; who: 'you' | 'bot'; from: string | null; snippet: string; at: number; len: number; createdAt: number }
/** One conversation a chat has had (the open one has `current`). */
export interface ConversationInfo { generation: number; current: boolean; title: string; messages: number; startedAt: number; lastAt: number }

/** What the phone keeps: the server's address and its session token (in the Android Keystore). */
/** `name`: who this phone shows as signed in (the person's or the team's name); `email` is the account's. */
export interface Session { server: string; token: string; email: string; name?: string; access?: AccessToken }

/**
 * What this phone is called in the server's list of signed-in devices ("YBots for Android, Pixel 9"),
 * sent as a header on every request. Without it every phone shows as "Phone app (Android)".
 */
export const deviceName = (() => {
  const app = 'YBots';
  if (Platform.OS !== 'android') return `${app} preview`;
  const c = Platform.constants as { Model?: string; Brand?: string; Manufacturer?: string };
  const model = String(c?.Model ?? '').trim();
  const brand = String(c?.Brand ?? c?.Manufacturer ?? '').trim();
  const phone = model ? (brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand.charAt(0).toUpperCase()}${brand.slice(1)} ${model}` : model) : 'phone';
  // Header values are plain ASCII.
  return `${app} for Android, ${phone}`.replace(/[^\x20-\x7E]/g, '').slice(0, 80);
})();
const deviceHeader = { 'x-cleft-device': deviceName };

/**
 * A Cloudflare Access service token for this phone, when the server sits behind Access. It reaches
 * the phone in the sign-in QR code's #fragment (never sent to the server, never built into the app)
 * and goes out as two headers on every request. Each phone has its own, so one can be revoked alone.
 */
export interface AccessToken { id: string; secret: string }
const accessHeaders = (a?: AccessToken): Record<string, string> =>
  a ? { 'CF-Access-Client-Id': a.id, 'CF-Access-Client-Secret': a.secret } : {};

/** Reads `#cfa=<client id>:<client secret>` from a sign-in link. */
function accessFromHash(hash: string): AccessToken | undefined {
  const m = /^#cfa=([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/.exec(hash);
  return m ? { id: m[1], secret: m[2] } : undefined;
}

const KEY = 'cleftbot.session';

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch { return null; }
}

export async function saveSession(s: Session | null) {
  if (s) await SecureStore.setItemAsync(KEY, JSON.stringify(s));
  else await SecureStore.deleteItemAsync(KEY);
}

export type NotifyProfile = 'main';
export interface NotifyPrefs {
  channels: { messages: boolean; approvals: boolean; jobs: boolean };
  /** Bot or group id -> muted until (ms), 0 = until turned back on. */
  muted: Record<string, number>;
  dndUntil: number;
  quiet: { on: boolean; start: string; end: string; tz: string; approvalsRing: boolean };
  preview: boolean;
}
export type NotifyPatch = Partial<Omit<NotifyPrefs, 'quiet' | 'channels' | 'muted'>> & {
  quiet?: Partial<NotifyPrefs['quiet']>; channels?: Partial<NotifyPrefs['channels']>;
  mute?: { botId: string; until: number }; unmute?: string;
};

export interface LookRun { id: string; state: 'making' | 'done' | 'failed'; createdAt: number; seen: boolean; error?: string; ask: { description: string; style: string | null; count?: number; intent: 'new' | 'tweak' } }

/** One place this account is signed in (server/src/auth.ts). */
export interface DeviceSession { id: string; device: string | null; who: string; kind: 'person' | 'script'; current: boolean; createdAt: number; lastSeenAt: number | null; expiresAt: number }
export interface UsageCounts { turns: number; failed: number; inputTokens: number; outputTokens: number }
/** How much the bots were used (server/src/usage.ts). Counts only, no prices. */
export interface UsageReport {
  days: number; since: number; totals: UsageCounts;
  byDay: ({ day: string } & UsageCounts)[];
  byBot: ({ botId: string; name: string; lastAt: number | null; topModel: string | null } & UsageCounts)[];
  byModel: ({ provider: string | null; model: string } & UsageCounts)[];
}
export type CheckState = 'ok' | 'warn' | 'bad';
/** The server's own report on itself (server/src/status.ts). */
export interface ServerStatus {
  at: number;
  server: { version: string; commit: string | null; startedAt: number; uptimeSec: number; node: string; host: string; memoryMb: number; load: number; cpus: number };
  db: { path: string; bytes: number; walBytes: number; integrity: string | null; integrityAt: number | null; snapshots: { name: string; bytes: number; at: number }[]; snapshotsKeep: number; lastSnapshotError: string | null; lastMaintenanceAt: number | null; lastMaintenance: string | null };
  disk: { freeBytes: number; totalBytes: number } | null;
  bots: { id: string; name: string; engine: string | null; state: string; error: string | null; busy: boolean; awaiting: boolean; model: string | null; provider: string | null }[];
  scheduler: { on: boolean; routines: number; nextRunAt: number | null; nextName: string | null };
  apps: { listening: number };
  backup: { tag: string; at: number | null; ok: boolean } | null;
  requests: { total: number; errors: number; slow: number; lastErrorAt: number | null; slowest: { path: string; ms: number; at: number }[] };
  problems: { at: number; level: 'warn' | 'error'; text: string; count: number }[];
  problemTotals: { warn: number; error: number };
  checks: { id: string; label: string; state: CheckState; detail: string }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: any) { super(message); }
}

/** A card as the server knows it: its place and the conversation it belongs to, so a card left over from an earlier conversation is refused. */
type CardRef = { seq: number; generation: number };
const cardPath = (botId: string, card: CardRef, action: string) => `/bots/${botId}/cards/${card.seq}/${action}?generation=${card.generation}`;

/** A reason a person can act on when the server itself did not give one (a proxy page, a restart, no network). */
export function plainReason(status: number, msg?: string | null): string {
  if (msg && String(msg).trim()) return String(msg);
  if (status === 0) return "Couldn't reach the server. It may be restarting, or the connection dropped. Try again in a moment.";
  if (status === 524 || status === 504) return 'The server took too long to answer, so the connection was closed. Try again.';
  if ([502, 503, 520, 521, 522, 523].includes(status)) return 'The server was restarting or out of reach. Try again in a moment.';
  return `The server answered with an error (${status}).`;
}

/**
 * Trade a sign-in link (scanned from the QR code sign-in-link.sh prints) for a session token.
 * The link's own origin is the server, so one scan gives both. Only https addresses are accepted:
 * the server is reached through Tailscale Serve, never over plain http.
 */
export async function signInWithLink(link: string): Promise<Session> {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new Error("That code isn't a sign-in link."); }
  if (url.protocol !== 'https:' || !/^\/api\/auth\/link\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error("That code isn't a sign-in link for this app.");
  const access = accessFromHash(url.hash);
  url.hash = '';
  let res: Response;
  try { res = await fetch(url.toString(), { headers: { accept: 'application/json', ...deviceHeader, ...accessHeaders(access) } }); }
  catch { throw new Error(url.hostname.endsWith('.ts.net') ? "Couldn't reach your server. This code uses the Tailscale address, so Tailscale has to be on. Make a new code from a signed-in device to use the public address." : "Couldn't reach your server. Check this phone's internet connection and try again."); }
  if (res.redirected || (res.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Cloudflare Access turned this phone away. Make a new code with this phone\'s access token.');
  if (res.status === 410) throw new Error('That sign-in code was already used or has expired. Make a new one.');
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  const { token, user } = (await res.json()) as { token: string; user: { email: string; name?: string; displayName?: string } };
  return { server: url.origin, token, email: user.email, name: user.displayName ?? user.name, access };
}

export function client(s: Session) {
  const base = { authorization: `Bearer ${s.token}`, ...deviceHeader, ...accessHeaders(s.access) };
  const req = async <T,>(method: string, path: string, body?: unknown, tries = 0): Promise<T> => {
    let res: Response;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, method === 'GET' ? READ_TIMEOUT : WRITE_TIMEOUT);
    try {
      res = await fetch(`${s.server}/api${path}`, {
        method,
        headers: { ...base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch {
      clearTimeout(timer);
      requestFailed();
      throw new ApiError(0, timedOut ? "The server didn't answer in time. The connection may be slow, or the server busy. Try again in a moment." : plainReason(0));
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* no body, or a proxy's error page */ } finally { clearTimeout(timer); }
    // A gateway error is the proxy talking, not the server: the server is still out of reach.
    if ([502, 503, 504, 520, 521, 522, 523, 524].includes(res.status)) requestFailed(); else requestOk();
    // A proxy's own 502/503 page (not JSON) on a read usually means the server is restarting: ask again, twice
    // at most. The server's own 502/503 are JSON and mean what they say.
    if (method === 'GET' && (res.status === 502 || res.status === 503) && data === null && tries < 2) {
      await new Promise((r) => setTimeout(r, 1200 * (tries + 1)));
      return req<T>(method, path, body, tries + 1);
    }
    // A server fault carries a reference that finds it in the server's log; show it so it can be passed on.
    if (!res.ok) throw new ApiError(res.status, plainReason(res.status, data?.error) + (res.status >= 500 && typeof data?.ref === 'string' && data.ref ? ` (ref ${data.ref.slice(0, 24)})` : ''), data);
    return data as T;
  };
  return {
    server: s.server,
    authHeader: base,
    me: () => req<{ user: { email: string; name: string; displayName?: string; scope?: { bots: string[] } } | null }>('GET', '/auth/me'),
    logout: () => req('POST', '/auth/logout', {}),
    status: () => req<ServerStatus>('GET', '/status'),
    usage: (days: number) => req<UsageReport>('GET', `/usage?days=${days}&tz=${-new Date().getTimezoneOffset()}`),
    snapshotNow: () => req<{ ok: true; snapshot: { name: string; bytes: number; at: number } | null }>('POST', '/status/snapshot'),
    sessions: () => req<{ sessions: DeviceSession[] }>('GET', '/auth/sessions'),
    signOutDevice: (id: string) => req<{ sessions: DeviceSession[] }>('DELETE', `/auth/sessions/${id}`),
    signOutOthers: () => req<{ signedOut: number; sessions: DeviceSession[] }>('POST', '/auth/sessions/sign-out-others', {}),
    signOutScripts: () => req<{ signedOut: number; sessions: DeviceSession[] }>('POST', '/auth/sessions/sign-out-others', { only: 'scripts' }),
    clearProblems: () => req<{ ok: true; cleared: number }>('POST', '/status/problems/clear', {}),
    /** Everything this account holds, as one file: every conversation as Markdown, bot instructions and routines. */
    accountExport: () => req<{ exportedAt: string; counts: { bots: number; conversations: number; messages: number } } & Record<string, unknown>>('GET', '/export/account'),
    bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
    createBot: (b: { name: string; avatarShape: string; avatarColor: string }) => req<{ bot: Bot }>('POST', '/bots', b),
    updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
    // A bot's settings, as on the web's settings window (server/src/routes-config.ts, routes.ts, voice.ts).
    settings: (botId: string) => req<SettingsBundle>('GET', `/bots/${botId}/settings`),
    deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
    // Group chats (server/src/routes-rooms.ts): a group is a bot with kind 'room' whose members answer.
    createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
    roomMembers: (roomId: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${roomId}/members`),
    setRoomMembers: (roomId: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${roomId}/members`, { botIds }),
    // Tasks the bots are tracking (server/src/routes.ts): all of them, or one bot's.
    tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
    botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),
    makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
    /** Sign in another device: a one-time link (15 minutes, one use) for this account (server routes.ts /auth/device-link). */
    deviceLink: () => req<{ url: string; appLink: string; expiresAt: number }>('POST', '/auth/device-link'),
    /** A bot outside the app (Sheldon): every exchange the other bots had with it, and the link's pause switch (server outside.ts). */
    exchanges: (botId: string) => req<{ exchanges: OutsideExchange[]; error: string | null }>('GET', `/bots/${botId}/exchanges`),
    setLinkPaused: (botId: string, paused: boolean) => req<{ ok: true }>('POST', `/bots/${botId}/link`, { paused }),
    fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),
    /** Undo "New conversation" (409 with the reason once something was said in the new chat, or after 10 minutes). */
    freshUndo: (botId: string) => req<{ ok: true; generation: number }>('POST', `/bots/${botId}/fresh/undo`),
    /**
     * Stops the bot's current turn: the engine run is cancelled, what it already wrote stays, its open approval cards expire.
     * In a group chat it stops every member answering the group, or only `member`.
     */
    interrupt: (botId: string, member?: string) => req<{ ok: true; stopped?: string[] }>('POST', `/bots/${botId}/interrupt`, member ? { member } : undefined),
    /** Add or take back your emoji reaction on a Bot's message (a toggle). */
    react: (botId: string, seq: number, emoji: string) => req<{ ok: true; added: boolean }>('POST', `/bots/${botId}/rows/${seq}/reactions`, { emoji }),
    deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),
    createSkill: (botId: string, k: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, k),
    updateSkill: (id: string, k: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, k),
    deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),
    moveSkillToAgent: (id: string) => req<{ skill: AgentSkillDetail }>('POST', `/skills/${id}/to-hermes`, {}),
    // The bot's own Hermes skills (server/src/engine-skills.ts), as on the web's Skills tab.
    agentSkills: (botId: string, fresh = false) => req<AgentSkillList>('GET', `/bots/${botId}/hermes-skills${fresh ? '?fresh=1' : ''}`),
    agentSkill: (botId: string, name: string) => req<{ skill: AgentSkillDetail }>('GET', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`),
    createAgentSkill: (botId: string, k: { name: string; category?: string; description: string; body: string }) => req<{ skill: AgentSkillDetail }>('POST', `/bots/${botId}/hermes-skills`, k),
    saveAgentSkill: (botId: string, name: string, k: { description?: string; body?: string; content?: string }) => req<{ skill: AgentSkillDetail }>('PUT', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`, k),
    setAgentSkillEnabled: (botId: string, name: string, enabled: boolean) => req<{ ok: true }>('PUT', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}/enabled`, { enabled }),
    setAgentSkillsAutoSave: (botId: string, on: boolean) => req<{ ok: true; autoSave: boolean }>('PUT', `/bots/${botId}/hermes-skills/auto-save`, { on }),
    markAgentSkillsSeen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/hermes-skills/seen`, {}),
    deleteAgentSkill: (botId: string, name: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`),
    systemdTimers: (id: string, probe = false) => req<{ checkedAt?: number; hosts: { host: string; label?: string; reachable: boolean; timers: { name: string; state: string; next: number | null; last: number | null; activates?: string | null }[] }[] }>('GET', `/bots/${id}/systemd-timers${probe ? '?probe=1' : ''}`),
    changeSystemdTimer: (id: string, host: string, unit: string, action: 'enable' | 'disable') => req<{ state: string }>('POST', `/bots/${id}/systemd-timers/change`, { host, unit, action }),
    routines: (botId: string) => req<{ routines: Routine[] }>('GET', `/bots/${botId}/routines`),
    setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
    setRoutineQuiet: (id: string, quiet: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { quiet }),
    runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
    deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),
    engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
    setEngine: (botId: string, p: { provider?: string | null; model?: string | null; modelMode?: 'manual' | 'auto'; modelTiers?: EngineInfo['modelTiers']; providerLock?: string | null;
      fallbacks?: FallbackChoice[]; allowSubscription?: boolean; acknowledgeSubscriptionTerms?: boolean }) =>
      req<{ engine: EngineInfo; notes?: string[] }>('PATCH', `/bots/${botId}/engine`, p),
    checkProvider: (botId: string, provider: string, model: string) =>
      req<{ result: ProviderCheckResult; engine: EngineInfo }>('POST', `/bots/${botId}/engine/check`, { provider, model }),
    engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
    restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
    stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),
    // Helpers: the sub-agents a bot's agent may start (server/src/helpers.ts). Only the owner can change them.
    helpers: (botId: string) => req<HelpersBundle>('GET', `/bots/${botId}/helpers`),
    setHelpers: (botId: string, s: HelperSettings) => req<HelpersBundle>('PUT', `/bots/${botId}/helpers`, s),
    // Tools: the connected servers (MCP apps and plugins) each bot can use (server/src/plugins/routes.ts).
    // The owner's per-bot switch applies at once (flipPlugin; the app shows Undo). Installs, restores
    // and deletes are proposed, then confirmed with the digest the server showed.
    plugins: () => req<{ owner: boolean; plugins: PluginInfo[]; pending: PluginChange[]; drafts?: PluginDraft[] }>('GET', '/plugins'),
    flipPlugin: (pluginId: string, botId: string, enabled: boolean | null) => req<PluginSwitchResult>('POST', '/plugins/switch', { pluginId, botId, enabled }),
    proposePlugin: (b: { action: 'enable' | 'disable' | 'install' | 'remove' | 'restore' | 'delete'; pluginId?: string; botId?: string; spec?: string; digest?: string }) => req<PluginChange>('POST', '/plugins/changes', b),
    // Plugins made with a bot (server/src/plugins/builder.ts): Create plugin, Build, read the code, Install, Undo.
    createPlugin: (botId: string, idea: string) => req<{ botId: string }>('POST', '/plugins/create', { botId, idea }),
    pluginCode: (draftId: string) => req<DraftFiles>('GET', `/plugins/drafts/${draftId}/files`),
    buildPlugin: (draftId: string) => req<{ ok: true }>('POST', `/plugins/drafts/${draftId}/build`),
    dismissPlugin: (draftId: string) => req<{ ok: true }>('POST', `/plugins/drafts/${draftId}/dismiss`),
    installPlugin: (draftId: string, digest: string, bots: string[]) => req<{ pluginId: string }>('POST', `/plugins/drafts/${draftId}/install`, { digest, bots }),
    undoPlugin: (draftId: string) => req<{ ok: true }>('POST', `/plugins/drafts/${draftId}/undo`),
    savePluginSettings: (id: string, values: Record<string, unknown>) => req<{ values: PluginInfo['values'] }>('PUT', `/plugins/${id}/settings`, values),
    confirmPlugin: (id: string, digest: string) => req<PluginChange>('POST', `/plugins/changes/${id}/confirm`, { digest }),
    cancelPlugin: (id: string) => req<PluginChange>('POST', `/plugins/changes/${id}/cancel`),
    // Connectors: every MCP server, past and present (server/src/connectors-routes.ts).
    connectors: () => req<ConnectorList>('GET', '/connectors'),
    scanConnectors: () => req<ConnectorScan>('POST', '/connectors/scan', {}),
    proposeConnector: (b: { action: 'add' | 'remove'; connectorId: string; bots?: string[] }) => req<ConnectorChange>('POST', '/connectors/changes', b),
    confirmConnector: (id: string, digest: string) => req<ConnectorChange>('POST', `/connectors/changes/${id}/confirm`, { digest }),
    cancelConnector: (id: string) => req<ConnectorChange>('POST', `/connectors/changes/${id}/cancel`, {}),
    // Connect a server by its MCP address (server/src/connectors-custom.ts). A sign-in server answers with the page to open.
    createConnector: (b: NewConnector) => req<{ connectorId: string; signInUrl?: string }>('POST', '/connectors/custom', { ...b, returnTo: s.server }),
    signInConnector: (id: string) => req<{ signInUrl: string }>('POST', `/connectors/custom/${encodeURIComponent(id)}/signin`, { returnTo: s.server }),
    removeConnector: (id: string) => req<{ ok: true }>('POST', `/connectors/custom/${encodeURIComponent(id)}/delete`, {}),
    // Changes the admin bot made to connections, each allowed on its own card (server/src/connector-admin.ts).
    /** Web search by API (server/src/web-search.ts): service, key set or not, each bot's use this month. Never the key. */
    webSearch: () => req<WebSearchStatus>('GET', '/connectors/web-search'),
    adminChanges: () => req<{ changes: AdminChange[] }>('GET', '/connectors/admin-changes'),
    // Settings › Connections (server/src/connections-routes.ts).
    connections: () => req<ConnectionList>('GET', '/connections'),
    reconnectConnection: (id: string, write?: boolean) => req<{ signInUrl?: string; note: string }>('POST', `/connections/${encodeURIComponent(id)}/reconnect`, { ...(write === undefined ? {} : { write }), returnTo: s.server }),
    setConnectionTool: (id: string, tool: string, rule: ToolRule | null) => req<{ tool: ConnTool }>('PUT', `/connections/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}`, { rule }),
    proposeConnection: (id: string, action: string) => req<ConnProposal>('POST', `/connections/${encodeURIComponent(id)}/changes`, { action }),
    confirmConnection: (cid: string, digest: string) => req<ConnProposal>('POST', `/connections/changes/${encodeURIComponent(cid)}/confirm`, { digest }),
    cancelConnection: (cid: string) => req<ConnProposal>('POST', `/connections/changes/${encodeURIComponent(cid)}/cancel`, {}),
    undoAdminChange: (id: string) => req<{ id: string; summary: string }>('POST', `/connectors/admin-changes/${encodeURIComponent(id)}/undo`, {}),
    // Google accounts (server/src/google-accounts.ts): setup state, the one-time client upload, the sign-in page.
    googleConnector: () => req<{ configured: boolean; redirectUri: string; audienceUrl?: string }>('GET', '/connectors/google'),
    googleClient: (json: string) => req<{ ok: true }>('POST', '/connectors/google/client', { json }),
    googleStart: (write: boolean) => req<{ signInUrl: string }>('POST', '/connectors/google/start', { write }),
    voiceOptions: () => req<VoiceOptions>('GET', '/voice/options'),
    // Voice calls (server/src/voice.ts): start one, and end it with what was said. Each turn is an upload (src/voice/call.ts).
    voiceSession: (botId: string) => req<VoiceSession>('POST', '/voice/session', { botId }),
    voiceEnd: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string) =>
      req<{ ok: true }>('POST', '/voice/end', { botId, callId, transcript, error }),
    rows: (botId: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${botId}/rows?limit=200`),
    // The rows just before `beforeSeq`: earlier messages, loaded when the chat is scrolled to its top.
    rowsBefore: (botId: string, beforeSeq: number) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${botId}/rows?beforeSeq=${beforeSeq}&limit=200`),
    /** `clientId` names this send, so sending it again after a dropped connection can never post it twice. */
    send: (botId: string, text: string, opts: { editOf?: number; attachments?: string[]; clientId?: string } = {}) =>
      req<{ row: Row; duplicate?: boolean }>('POST', `/bots/${botId}/messages`, { text, ...(opts.editOf ? { editOf: opts.editOf } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.clientId ? { clientId: opts.clientId } : {}) }),
    /** Put a picture or file from the phone in the bot's Library (uploads/), to send with a message (server chat-extras.ts). */
    attach: async (botId: string, uri: string, name: string): Promise<ChatFile> => {
      let bytes: Uint8Array;
      try { bytes = await new FsFile(uri).bytes(); } catch { throw new ApiError(-1, "That file couldn't be read on this phone."); }
      if (bytes.length > MAX_ATTACHMENT) throw new ApiError(413, 'That file is larger than 25 MB, which is the most a message can carry.');
      let res: Response;
      try {
        res = await expoFetch(`${s.server}/api/bots/${botId}/attachments?name=${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...base, 'content-type': 'application/octet-stream' }, body: bytes.buffer as ArrayBuffer }) as unknown as Response;
      } catch { throw new ApiError(0, plainReason(0)); }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, res.status === 413 && !data?.error ? 'That file is larger than 25 MB, which is the most a message can carry.' : plainReason(res.status, data?.error), data);
      return (data as { file: ChatFile }).file;
    },
    /** Every message of every chat with all these words (the open conversations and earlier ones). */
    search: (q: string) => req<{ q: string; hits: SearchHit[] }>('GET', `/search?q=${encodeURIComponent(q)}`),
    /** Removes one earlier conversation for good (never the open one). */
    deleteConversation: (botId: string, generation: number) => req<{ ok: true; conversations: ConversationInfo[] }>('DELETE', `/bots/${botId}/conversations/${generation}`),
    conversations: (botId: string) => req<{ conversations: ConversationInfo[] }>('GET', `/bots/${botId}/conversations`),
    conversationRows: (botId: string, generation: number, beforeSeq?: number) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${botId}/conversations/${generation}/rows?limit=200${beforeSeq ? `&beforeSeq=${beforeSeq}` : ''}`),
    /** Carry on an earlier conversation; the one that was open stays in the list. */
    openConversation: (botId: string, generation: number) => req<{ ok: true; generation: number }>('POST', `/bots/${botId}/conversations/${generation}/open`, {}),
    exportChat: (botId: string, generation?: number) => req<{ name: string; markdown: string }>('GET', `/bots/${botId}/export${generation ? `?generation=${generation}` : ''}`),
    markUnread: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/unread`, {}),
    version: () => req<{ version: string; commit: string | null; startedAt: number }>('GET', '/version'),
    read: (botId: string) => req('POST', `/bots/${botId}/read`, {}),
    // Side chats (server/src/side-chats.ts): more conversations with the same bot. Each one is read and written
    // like a chat with its own id (rows, send, read, interrupt, fresh, cards).
    sideChats: (botId: string) => req<{ chats: SideChat[]; allowed: boolean }>('GET', `/bots/${botId}/side-chats`),
    newSideChat: (botId: string) => req<{ chat: SideChat }>('POST', `/bots/${botId}/side-chats`, {}),
    renameSideChat: (id: string, title: string) => req<{ ok: true; chats: SideChat[] }>('PATCH', `/side-chats/${id}`, { title }),
    deleteSideChat: (id: string) => req<{ ok: true; undoUntil: number }>('DELETE', `/side-chats/${id}`),
    restoreSideChat: (id: string) => req<{ ok: true; chats: SideChat[] }>('POST', `/side-chats/${id}/restore`, {}),
    // Notification settings (server/src/notify.ts), profile 'main' (YBots, web, Windows).
    // Chat list AI summaries (server/src/list-summary.ts), the same setting as the web's Settings › General.
    listSummary: () => req<ListSummaryInfo>('GET', '/list-summary'),
    setListSummary: (patch: Partial<ListSummaryPrefs>) => req<{ prefs: ListSummaryPrefs }>('PUT', '/list-summary', patch),
    notifyPrefs: (profile: NotifyProfile) => req<{ prefs: NotifyPrefs }>('GET', `/notify/prefs?profile=${profile}`),
    setNotifyPrefs: (profile: NotifyProfile, patch: NotifyPatch) => req<{ prefs: NotifyPrefs }>('PUT', `/notify/prefs?profile=${profile}`, patch),
    // The phone always sends the card's digest (the server refuses an answer without it), "always" included.
    connectApp: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
    // A secure input card (server/src/browser-cards.ts): the typed value goes to the bot's browser, never the chat.
    secretInput: (approvalId: string, value: string, digest: string) =>
      req<{ ok: true; approval: Readback }>('POST', `/approvals/${approvalId}/secret`, { value, digest }),
    // A posting plan card (server/src/posting.ts): the days left switched on, approved once or always.
    postingPlan: (approvalId: string, days: string[], decision: 'allow' | 'always', digest: string) =>
      req<{ ok: true; approval: Readback }>('POST', `/approvals/${approvalId}/plan`, { days, decision, digest }),
    approve: (approvalId: string, decision: 'allow' | 'always' | 'deny', digest: string) =>
      req<{ ok: true; approval: Readback }>('POST', `/approvals/${approvalId}`, { decision, digest }),
    // "Always allow" rules for one bot (server/src/allow-rules.ts): list, what they let through, remove.
    allowRules: (botId?: string) => req<{ rules: AllowRule[]; log: AllowRuleUse[]; freeRun?: FreeRunBot[] }>('GET', `/allow-rules${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`),
    /** Older per-tool choices for every bot (Settings › Permissions on the web). */
    policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
    deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),
    deleteAllowRule: (id: string) => req<{ ok: true }>('DELETE', `/allow-rules/${encodeURIComponent(id)}`),
    // The maintainer bot's free-run switch (server/src/maintainer-guard.ts): every terminal command runs without a card.
    setFreeTerminal: (botId: string, on: boolean) => req<{ ok: true; on: boolean }>('PUT', `/bots/${encodeURIComponent(botId)}/free-terminal`, { on }),
    answer: (botId: string, card: CardRef, answer: string) => req('POST', cardPath(botId, card, 'answer'), { answer }),
    dismiss: (botId: string, card: CardRef) => req('POST', cardPath(botId, card, 'dismiss'), {}),
    // A change to an answer view (server/src/views.ts): check, pick, field or send. Answers with the updated row.
    viewChange: (botId: string, card: CardRef, change: Record<string, unknown>) => req<{ ok: true; row: Row }>('POST', cardPath(botId, card, 'view'), change),
    // Pin or unpin a board above the message box (server/src/board-pin.ts).
    pinBoard: (botId: string, card: CardRef, on: boolean) => req<{ ok: true; row: Row }>('POST', cardPath(botId, card, 'pin'), { on }),
    viewPage: (botId: string, card: CardRef) => req<{ ok: true; path: string }>('POST', cardPath(botId, card, 'page'), {}),
    saveProposedSkill: (botId: string, card: CardRef, edit?: { name: string; description: string; body: string }) => req<{ ok: true; skillId: string }>('POST', cardPath(botId, card, 'save-skill'), edit ?? {}),
    setAvatar: (botId: string, image: string | null) => req<{ bot: Bot }>('PUT', `/bots/${botId}/avatar`, { image }),
    /** Start drawing pictures (the server answers at once with a run to ask about; a long request would be cut off by the proxy). */
    startLooks: (botId: string, a: LookAsk) =>
      req<{ run?: string; candidates?: string[] }>('POST', `/bots/${botId}/avatar/generate`, { prompt: a.description, style: a.style ?? undefined, count: a.count, intent: a.intent, reference: a.reference, wait: false }),
    /**
     * Ask about a picture run until it is done. The run lives on the server (it even survives a restart)
     * and asking again is safe, so while the app is in the background, asks that fail (Android pauses
     * the network for apps it puts to sleep) don't count; only a run the server no longer knows (404)
     * or ten failures in a row with the app in front end the wait.
     */
    waitLookRun: async (botId: string, run: string, isActive: () => boolean = () => true): Promise<{ candidates: string[] }> => {
      for (let misses = 0; ;) {
        await new Promise((r) => setTimeout(r, 3000));
        let st: { state: 'making' | 'done' | 'failed'; candidates?: string[]; error?: string };
        try { st = await req('GET', `/bots/${botId}/avatar/generate/${run}`); }
        catch (e) {
          if (e instanceof ApiError && e.status === 404) throw e;
          if (!isActive() || ++misses < 10) continue;
          throw e;
        }
        misses = 0;
        if (st.state === 'done') return { candidates: st.candidates ?? [] };
        if (st.state === 'failed') throw new ApiError(502, st.error || 'The image service failed without saying why.');
      }
    },
    /** Picture runs not shown yet (and any still drawing): what was drawn while the app was closed or asleep. */
    lookRuns: (botId: string) => req<{ runs: LookRun[] }>('GET', `/bots/${botId}/avatar/runs`),
    lookRunSeen: (botId: string, run: string) => req<{ ok: true }>('POST', `/bots/${botId}/avatar/generate/${run}/seen`, {}),
    /** The address the background watcher asks (modules/cleft-background), with the same sign-in headers. */
    lookRunWatch: (botId: string, run: string) => ({ url: `${s.server}/api/bots/${botId}/avatar/generate/${run}`, headers: base as Record<string, string> }),
    // Looks (server/src/avatars.ts): options, poses, and a bot's look cards in the chat.
    looksOptions: () => req<{ styles: { id: string; label: string }[]; maxCount: number; generating: boolean }>('GET', '/looks/options'),
    remakePoses: (botId: string, poses?: string[], note?: string) => req('POST', `/bots/${botId}/avatar/poses`, { ...(poses ? { poses } : {}), ...(note ? { note } : {}) }),
    removePoses: (botId: string) => req('DELETE', `/bots/${botId}/avatar/poses`),
    chooseLook: (botId: string, seq: number, candidateId: string | null) => req('POST', `/bots/${botId}/look-cards/${seq}/choose`, { candidateId }),
    moreLooks: (botId: string, seq: number, a: LookAsk) => req('POST', `/bots/${botId}/look-cards/${seq}/more`, a),
    /** A look card straight away, without asking the bot (for a bot outside the app). */
    askLooks: (botId: string, a: { description: string; intent?: 'tweak' | 'new' }) => req('POST', `/bots/${botId}/look-cards`, a),
    lookUrl: (botId: string, candidateId: string) => `${s.server}/api/bots/${botId}/look/${candidateId}`,
    // The file pane (server/src/files.ts): the bot's workspace, this chat's files, previews and text edits.
    files: (botId: string, path = '', wake = false) => req<FileListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
    chatFiles: (botId: string) => req<{ files: ChatFileEntry[] }>('GET', `/bots/${botId}/chat-files`),
    filePreview: (botId: string, path: string) => req<FilePreview>('GET', `/bots/${botId}/files/preview?path=${encodeURIComponent(path)}`),
    saveFileText: (botId: string, path: string, text: string, modifiedAt?: number) => req<ChatFile>('PUT', `/bots/${botId}/files/text`, { path, text, modifiedAt }),
    page: (botId: string, path: string) => req<Page>('GET', `/bots/${botId}/pages?path=${encodeURIComponent(path)}`),
    newPage: (botId: string, title: string) => req<{ path: string; page: Page }>('POST', `/bots/${botId}/pages`, { title }),
    pageOps: (botId: string, path: string, ops: PageOp[]) => req<{ page: Page; results: PageOpResult[] }>('POST', `/bots/${botId}/pages/ops`, { path, ops }),
    pageHistory: (botId: string, path: string) => req<{ versions: PageVersionInfo[] }>('GET', `/bots/${botId}/pages/history?path=${encodeURIComponent(path)}`),
    pageVersion: (botId: string, path: string, v: number) => req<Page>('GET', `/bots/${botId}/pages/version?v=${v}&path=${encodeURIComponent(path)}`),
    pageRestore: (botId: string, path: string, version: number | 'undo') => req<Page>('POST', `/bots/${botId}/pages/restore`, version === 'undo' ? { path, undo: true } : { path, version }),
    // The Pages tab (server/src/page-shelf.ts).
    pageList: (botId: string) => req<{ pages: PageShelfItem[] }>('GET', `/bots/${botId}/pages/list`),
    pagePin: (botId: string, path: string, pinned: boolean) => req<{ ok: true }>('POST', `/bots/${botId}/pages/pin`, { path, pinned }),
    pageDelete: (botId: string, path: string) => req<{ id: string }>('POST', `/bots/${botId}/pages/delete`, { path }),
    pageUndelete: (botId: string, id: string) => req<{ path: string }>('POST', `/bots/${botId}/pages/undelete`, { id }),
    pageRename: (botId: string, path: string, title: string) => req<{ page: Page }>('POST', `/bots/${botId}/pages/ops`, { path, ops: [{ op: 'title', title }] }),
    pageExport: (botId: string, path: string, format: string) => req<ChatFile>('POST', `/bots/${botId}/pages/export`, { path, format }),
    fileRawUrl: (botId: string, path: string, v?: number) => `${s.server}/api/bots/${botId}/files/raw?inline=1&path=${encodeURIComponent(path)}${v ? `&v=${Math.round(v)}` : ''}`,
    fileDownloadUrl: (botId: string, path: string) => `${s.server}/api/bots/${botId}/files/raw?path=${encodeURIComponent(path)}`,
    filePageUrl: (botId: string, path: string, n: number, v?: number) => `${s.server}/api/bots/${botId}/files/page?n=${n}&path=${encodeURIComponent(path)}${v ? `&v=${Math.round(v)}` : ''}`,
    // A bot's computer screen (server/src/vnc.ts): wake the shared computer, then stream its screen.
    computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
    ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
    /** The shared computer's screens and sleep timer (Settings › Computer on the web). */
    computerDetails: () => req<{ computer: ComputerState; screens: { botId: string; screenId: string; lastUsedAt: number }[]; hibernation: { idleMinutes: number; viewers: number; dryRun: boolean } }>('GET', '/computer/details'),
    suspendComputer: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
    resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
    /** Tells the bot the person has stopped driving its screen. */
    handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),
    /** The live screen gave up after its quiet retries: logged on the server so a flaky view can be traced. */
    screenProblem: (botId: string, p: { tries: number; cause: string; code?: number; opened?: boolean; ms?: number }) =>
      req<{ ok: true }>('POST', `/bots/${botId}/screen/problem`, { ...p, client: 'android' }),
    // Paired PCs (docs/remote-pc.md). Pairing: the PC shows a short code; the phone looks it up and allows it.
    machines: () => req<{ machines: Machine[] }>('GET', '/machines'),
    setMachineBots: (id: string, bots: string[]) => req<{ machine: Machine }>('PATCH', `/machines/${id}`, { bots }),
    removeMachine: (id: string) => req<{ ok: true }>('DELETE', `/machines/${id}`),
    machineLog: (id: string) => req<{ log: MachineLogEntry[] }>('GET', `/machines/${id}/log`),
    pairByCode: (code: string) => req<{ id: string; code: string; device: string; kind: 'sign-in' | 'machine'; expiresAt: number }>('GET', `/auth/pair-code/${encodeURIComponent(code)}`),
    /** A computer's pairing, from the id in its QR code: its name and short code to match (server routes.ts). */
    pairInfo: (id: string) => req<{ code: string; device: string; kind: 'sign-in' | 'machine'; expiresAt: number }>('GET', `/auth/pair/${encodeURIComponent(id)}/info`),
    pairAnswer: (id: string, allow: boolean) => req<{ ok: boolean; state: string }>('POST', `/auth/pair/${id}/answer`, { allow }),
    // Copy and paste with a bot's screen or a PC while driving it (server/src/clipboard.ts, machines.ts).
    getClipboard: (kind: 'bot' | 'pc', id: string) => req<{ text?: string; cut?: boolean }>('GET', `/${kind === 'bot' ? 'bots' : 'machines'}/${id}/clipboard`),
    setClipboard: (kind: 'bot' | 'pc', id: string, text: string) => req<{ ok: true }>('PUT', `/${kind === 'bot' ? 'bots' : 'machines'}/${id}/clipboard`, { text }),
    /** A paired PC's screen socket: watch only, whatever is asked. */
    pcScreenSocket: (id: string, mode: 'watch' | 'control' = 'watch') => ({ url: `${s.server.replace(/^http/, 'ws')}/api/machines/${id}/screen?mode=${mode}`, headers: base }),
    /** The screen socket. The phone sends its token as a header, which the server accepts in place of a cookie. */
    /** Live dictation (/api/voice/live): the address and the headers the socket needs. */
    liveSocket: () => ({ url: `${s.server.replace(/^http/, 'ws')}/api/voice/live`, headers: base }),
    screenSocket: (botId: string, mode: 'watch' | 'control') => ({ url: `${s.server.replace(/^http/, 'ws')}/api/bots/${botId}/screen?mode=${mode}`, headers: base }),
    /**
     * The live event stream (/api/events) with the bearer token. Returns a function that closes it.
     *
     * react-native-sse only reconnects when the server ends the stream cleanly. A dropped connection (the
     * phone switching networks, a proxy closing the stream, the server restarting) ends with status 0, after
     * which it stays silent for good, and a half-open connection on a mobile network never ends at all.
     * Either way the app kept showing a bot as "Thinking" after its reply had gone out. So this watches the
     * stream itself: the server sends something at least every 20 s (a ping), and if nothing arrives for
     * 45 s, or the stream reports an error, it is replaced with a new one. A (re)connect calls `onOpen` when
     * the server could not send what was missed, so the caller fetches it.
     */
    events(onEvent: (ev: any) => void, onError?: (e: unknown) => void, onOpen?: () => void): () => void {
      let es: EventSource | null = null;
      let lastData = Date.now();
      let retry: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let fails = 0;
      let lastId = '';
      let helloWait: ReturnType<typeof setTimeout> | null = null;
      const connect = () => {
        if (closed) return;
        es?.removeAllEventListeners();
        es?.close();
        lastData = Date.now();
        // Every event carries a number. A reconnect sends the last one seen and the server sends exactly what
        // was missed (hello.resumed), so a short drop loses nothing and fetches nothing. Only when it cannot
        // (away too long, the server restarted, or an older server that sends no hello) is everything fetched.
        const s2 = new EventSource(`${s.server}/api/events${lastId ? `?after=${encodeURIComponent(lastId)}` : ''}`, { headers: base, pollingInterval: 3000 });
        es = s2;
        if (helloWait) { clearTimeout(helloWait); helloWait = null; }
        s2.addEventListener('open', () => {
          if (es !== s2) return;
          lastData = Date.now(); fails = 0; streamOpened();
          if (helloWait) clearTimeout(helloWait);
          helloWait = setTimeout(() => { helloWait = null; if (es === s2 && !closed) onOpen?.(); }, 4000);
        });
        s2.addEventListener('message', (e: any) => {
          if (es !== s2) return;
          lastData = Date.now();
          streamData();
          if (e.lastEventId) lastId = String(e.lastEventId);
          let ev: any;
          try { ev = JSON.parse(e.data); } catch { return; /* not json */ }
          // The server is about to stop for an update: say so, and look for it every second until it is back.
          if (ev?.type === 'restarting') { serverRestarting(); return; }
          if (ev?.type === 'hello') {
            if (helloWait) { clearTimeout(helloWait); helloWait = null; }
            if (!ev.resumed) onOpen?.();
          }
          onEvent(ev);
        });
        s2.addEventListener('error', (e: any) => {
          if (es !== s2) return;
          if (!serverUpdating()) streamDown();
          onError?.(e);
          if (retry) return;
          // Try again soon at first, then less often (3 s, 6 s, 12 s, at most 20 s), so a long outage does not drain the battery.
          const wait = serverUpdating() ? 1000 : Math.min(20_000, 3000 * 2 ** Math.min(fails, 3));
          fails++;
          retry = setTimeout(() => { retry = null; connect(); }, wait);
        });
      };
      connect();
      const watchdog = setInterval(() => { if (!closed && Date.now() - lastData > 45_000) { streamDown(); connect(); } }, 10_000);
      // "Try now" on the connection banner, and the app coming back to the front.
      const unkick = onKick(() => { if (closed) return; if (retry) { clearTimeout(retry); retry = null; } fails = 0; connect(); });
      return () => {
        closed = true;
        unkick();
        clearInterval(watchdog);
        if (retry) clearTimeout(retry);
        if (helloWait) clearTimeout(helloWait);
        es?.removeAllEventListeners();
        es?.close();
      };
    },
  };
}
export type Client = ReturnType<typeof client>;

/** One message between a bot and an outside member (server types.ts OutsideExchange). */
export interface OutsideExchange {
  id: number; direction: 'out' | 'in'; botId: string | null; botName: string | null; roomId: string | null; type: string | null;
  text: string; link: string | null; state: string; error: string | null; createdAt: number; answeredAt: number | null;
  replies: { text: string; link: string | null; createdAt: number }[];
}
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export interface WebSearchStatus {
  service: string; keySet: boolean; extract: string; fallback: string | null; cacheMinutes: number; monthStart: number;
  bots: { id: string; name: string; on: boolean; ownSetup: boolean; searches: number | null; reads: number | null }[];
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'pinned' | 'effort' | 'mode' | 'voice' | 'voiceSpeed' | 'voiceLanguage' | 'chatColor' | 'visuals' | 'webSearch' | 'phoneActions' | 'busySend' | 'ownerHidden'>>;
export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number }
export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }
export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }
/** A skill in the bot's own Hermes agent (server/src/types.ts HermesSkill). */
export type AgentSkillSource = 'own' | 'builtin' | 'hub' | 'external';
export interface AgentSkill {
  name: string; description: string; category: string; source: AgentSkillSource; enabled: boolean;
  uses: number; lastUsedAt: number | null; updatedAt: number;
  botChangedAt: number | null; botAction: 'created' | 'changed' | null; isNew: boolean;
}
export interface AgentSkillDetail { name: string; description: string; body: string; content: string; category: string; source: AgentSkillSource; enabled: boolean; files: string[] }
export interface AgentSkillList { available: boolean; reason?: string; skills: AgentSkill[]; autoSave?: boolean; canChangeAutoSave?: boolean }
export interface Routine { id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string; enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string; quiet?: boolean }
export interface SettingsBundle {
  memories: Memory[]; skills: Skill[]; routines: Routine[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}
export type ModelTier = 'light' | 'standard' | 'heavy';
export interface ModelTierChoice { model: string; effort: Effort }
export interface HelperRoute { model: string; effort: Effort | null }
export interface HelperSettings { enabled: boolean; maxAtOnce: number; stepLimit: number; maxTier: ModelTier; defaultTier: ModelTier; routes: Partial<Record<ModelTier, HelperRoute>> }
export interface HelpersView extends HelperSettings { provider: string | null; perJobChoice: boolean; inheritsMainModel: boolean }
export interface HelperRun { id: string; state: string; startedAt: number; endedAt: number | null; goals: string[]; models: string[]; summary: string | null }
export type ConnectorStatus = 'active' | 'stopped' | 'retired' | 'gone' | 'unknown' | 'wanted';
export interface ConnectorWanted { rank?: number; unlocks: string; bots?: string[]; skills?: string[]; setup?: string[]; needs?: string; state?: string; via?: 'browser' }
export type ConnectorReach = 'cleft' | 'needs-setup' | 'cloud' | 'native';
export interface ConnectorInfo {
  id: string; name: string; machine: string | null; transport: string | null; address: string | null; access: string | null; auth: string | null;
  reach: ConnectorReach; description: string | null; notes: string | null; firm: boolean; status: ConnectorStatus; source: string;
  firstSeen: number | null; lastSeen: number | null; goneAt: number | null;
  apps: { id: string; name: string; status: string; bots: string[] }[]; canAdd: boolean; added: boolean; onlyBots?: string[] | null; wanted?: ConnectorWanted | null; custom?: boolean; needsSignIn?: boolean; browserSite?: boolean;
}
export interface NewConnector { name: string; url: string; auth: 'none' | 'key' | 'oauth'; headerName?: string; headerValue?: string; remote?: boolean; readOnly?: boolean }
export interface ConnectorScan { at: number; answered: string[]; found: number; added: number; gone: number; error?: string | null }
export interface AdminChange {
  id: string; app: string; action: string; summary: string; status: string; bot: string; at: string;
  appliedAt?: string; approvedBy?: string; via?: string; rollsBack?: string; rolledBackBy?: string; canRollBack: boolean;
  /** Made by a person in Connections (then `bot` is that person's name), not by the admin bot. */
  byPerson?: boolean;
}

/** Settings › Connections (server/src/connections.ts), worded by the server so web, Windows and Android say the same. */
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
export interface ConnectorChange { id: string; summary: string; details: string[]; digest: string; status: string; expiresAt: number }
export interface ConnectorList { owner: boolean; scanHosts: number; lastScan: ConnectorScan | null; bots: { id: string; name: string }[]; connectors: ConnectorInfo[] }

export interface PluginInfo {
  id: string; name: string; description?: string; origin: string; exclusive: boolean;
  bots: { id: string; name: string; enabled: boolean; fromDefault: boolean; ownerName?: string }[];
  status: 'ready' | 'error' | 'stopped' | 'disabled'; error?: string; tools: number;
  /** Read-only mode: writes are blocked rather than asked. reads = tools that run without asking; blocked = never run. */
  readOnly?: boolean; reads?: number; blocked?: number;
  version?: string; digest?: string; network?: string[];
  settings?: PluginSetting[]; values?: Record<string, string | number | boolean | { set: boolean }>;
  history?: { version: string; digest: string; status: 'installed' | 'removed'; installedAt: number }[];
}
/** A plugin's settings form field (server/src/plugins/ui-schema.ts). */
export type PluginSetting =
  | { key: string; label: string; type: 'text'; help?: string; required?: boolean; placeholder?: string }
  | { key: string; label: string; type: 'secret'; help?: string; required?: boolean }
  | { key: string; label: string; type: 'boolean'; help?: string }
  | { key: string; label: string; type: 'number'; help?: string; required?: boolean; min?: number; max?: number }
  | { key: string; label: string; type: 'select'; help?: string; required?: boolean; options: { value: string; label: string }[] };
export interface PluginDraft {
  id: string; botId: string; botName: string; title: string; purpose: string; tools: { name: string; description: string; writes: boolean }[];
  network: string[]; status: string; digest?: string; checks?: { name: string; ok: boolean; detail: string }[]; pluginId?: string; createdAt: number; updatedAt: number;
}
export interface DraftFiles {
  draftId: string; title: string; status: string; digest: string; matches: boolean;
  files: { path: string; size: number; text: string | null; kit?: boolean }[];
}
export interface PluginSwitchResult {
  pluginId: string; botId: string; pluginName: string; botName: string;
  before: { enabled: boolean; fromDefault: boolean }; after: { enabled: boolean; fromDefault: boolean };
}
export interface PluginChange { id: string; action?: string; summary: string; details: string[]; digest: string; status: 'pending' | 'applied' | 'cancelled' | 'expired'; expiresAt: number }
export interface HelpersBundle { helpers: HelpersView; models: string[]; canEdit: boolean; runs: HelperRun[] }
export interface EngineInfo {
  botId: string; profile: string; status: 'ready' | 'starting' | 'stopped' | 'error'; error: string | null;
  model: string | null; provider: string | null; version: string | null;
  /** optIn: offered only after the owner switches it on for this bot (the Claude subscription); enabled: it is on. */
  providers: { id: string; name: string; kind: 'subscription' | 'api_key'; connected: boolean; models: string[]; optIn?: boolean; enabled?: boolean }[];
  modelMode: 'manual' | 'auto'; modelTiers: Partial<Record<ModelTier, ModelTierChoice>> | null; providerLock: string | null;
  tierPresets: Record<string, { label: string; tiers: Partial<Record<ModelTier, ModelTierChoice>> }>;
  lastRoute: { at: number; mode: 'manual' | 'auto'; tier: ModelTier | null; provider: string | null; model: string | null; reason: string; ok: boolean } | null;
  ownScreen: boolean;
  /** Shared provider catalog (server/src/provider-catalog.ts). Missing on an older server. */
  appManaged?: boolean;
  catalog?: ProviderStatus[];
  fallbacks?: FallbackChoice[];
  subscriptionAllowed?: boolean;
  /** A change waits for the agent to restart (the owner's own agent restarts only when idle). */
  restartNote?: string | null;
}
export interface FallbackChoice { provider: string; model: string }
/** One provider for one bot: listed, access and verified are separate facts. */
export interface ProviderStatus {
  id: string; name: string; route: 'api_key' | 'subscription' | 'sign_in'; experimental: boolean; optIn: boolean; billing: string; warning: string | null;
  source: 'catalog' | 'agent'; eligible: boolean; eligibleNote: string | null;
  access: 'ready' | 'needs_key' | 'not_signed_in' | 'off' | 'not_installed' | 'unknown'; accessNote: string;
  models: string[]; modelsFromAgent: boolean;
  verified: { at: number; model: string; ok: boolean; detail: string | null; ms: number | null } | null;
  lastTurn: { at: number; model: string | null; ok: boolean } | null;
}
export interface ProviderCheckResult { ok: boolean; provider: string; model: string; answeredBy: string | null; detail: string; ms: number; at: number }
export interface VoiceSession { callId: string; startSeq: number; voice: string; speed: number; language: string; greeting: string; approvalsByVoice: boolean }
export interface VoiceOptions { voices: { id: string; name: string; gender?: string; language?: string; group?: string }[]; languages: { code: string; name: string }[]; speeds: number[]; defaultVoice?: string; live?: boolean }

/** What to draw: keep the bot and change it, or a new character; a style id; how many; a picture to start from. */
export interface LookAsk { description: string; intent: 'tweak' | 'new'; style: string | null; count: number; reference: string | null }

/** Chat list AI summaries. model null = the automatic cheap pick. */
export interface ListSummaryPrefs { on: boolean; provider: string | null; model: string | null }
export interface ListSummaryInfo {
  prefs: ListSummaryPrefs;
  options: { providers: { id: string; name: string; models: string[] }[]; auto: { provider: string | null; model: string | null }; ready: boolean };
  lastError: { at: number; error: string } | null;
}

export interface Bot {
  id: string; name: string; label: string; avatarShape: string; avatarColor: string; avatarImageUrl: string | null;
  /** Its colour in chats (chatColors.ts); null for a group. `chatColorAuto` = picked for it, not chosen. */
  chatColor?: import('./chatColors').ChatColor | null; chatColorAuto?: boolean;
  /** How often it uses views, calculators, tap choices and Pages (server visuals-level.ts). Not on a group. */
  visuals?: 'minimal' | 'balanced' | 'rich';
  /** What a message sent while it works does (server steer-mode.ts): steer (default), queue or interrupt. */
  busySend?: 'steer' | 'queue' | 'interrupt';
  /** Searches the web and reads pages by API (server web-search.ts); false = off. Not on a group. */
  webSearch?: boolean;
  /** Sets timers and alarms in this phone's Clock app (server phone.ts). Not on a group. */
  phoneActions?: boolean;
  /** Pose pictures by pose name (made from the picture); empty for a shape. */
  avatarPoses?: Record<string, string>;
  avatarPoseJob?: { state: 'making' | 'ready' | 'stopped'; done: number; total: number; failed: number; error?: string } | null;
  isPrimary: boolean; kind: 'agent' | 'room'; pinned: boolean; unread: number; lastPreview: string | null; lastActivityAt: number;
  /** lastPreview in at most 48 characters, for rows too narrow for it; who the line is about (server/src/list-preview.ts). */
  previewShort?: string | null; previewForms?: string[] | null; previewBy?: 'bot' | 'member' | 'you' | 'other' | 'card' | 'event' | 'summary' | null;
  // Settings (the server sends them all; optional so old fixtures still type-check).
  description?: string; instructions?: string; effort?: Effort; mode?: 'personal' | 'teammate';
  voice?: string; voiceSpeed?: number; voiceLanguage?: string; model?: string | null; provider?: string | null;
  /** Set for a bot that lives outside the app (Sheldon) and is reached through Slack. */
  outside?: { via: 'slack'; channelName: string; status: string; waiting: number; callUrl?: string } | null;
  /** Other bots this one is waiting on for an answer (same as server/src/types.ts). */
  waitingFor?: { id: string; name: string; since: number }[];
  /** Its side chats, when it has any: how many, unread replies in them, how many are working. */
  sideChats?: { count: number; unread: number; running: number };
  /** Hidden from this account's own list (Alex hid a bot): left out of Home, its counts and pickers, and the
   * server sends no notifications about it to the main profile. Never true on a scoped sign-in. */
  ownerHidden?: boolean;
}

/** One of a bot's side chats (same as server/src/types.ts SideChat). */
export interface SideChat {
  id: string; botId: string; title: string; createdAt: number; lastActivityAt: number;
  lastPreview: string | null; unread: number; generation: number; live: LiveState;
}
/** A member of a group chat, as GET /api/rooms/:id/members sends it. */
export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }
/** The shared computer the bots' screens live on (ComputerState in server/src/types.ts). */
export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  error: string | null;
  screens: { botId: string; screenId: string; width?: number; height?: number }[];
  maxScreens?: number;
}
export interface Machine {
  id: string; name: string; online: boolean; lastSeenAt: number | null; createdAt: number;
  folders: { name: string; path: string }[]; commands: boolean; screen: boolean; control: boolean;
  /** The PC's own "copy and paste" switch (needs taking control too). */
  clipboard?: boolean;
  bots: string[]; blockedBots: string[]; pcBlocked: string[]; version: string | null;
}
export interface MachineLogEntry { id: number; botId: string | null; botName: string | null; tool: string; outcome: string; detail: string | null; at: number }
/** Same shapes as server/src/types.ts (ChatFile, FilePreview). */
export type FileKind = 'markdown' | 'text' | 'code' | 'table' | 'image' | 'pdf' | 'office' | 'sheet' | 'page' | 'other';
export interface ChatFile { path: string; name: string; size: number; modifiedAt: number; kind: FileKind }
export interface ChatFileEntry extends ChatFile { seq: number; missing?: boolean }
export interface FilePreview extends ChatFile {
  editable: boolean; text?: string; lang?: string; pages?: number; truncated?: boolean; error?: string;
  sheets?: { name: string; rows: string[][]; truncated: boolean }[];
}
/** Pages (server/src/pages.ts; same shapes as server/src/types.ts). */
export interface PageBlock { id: string; type: string; rev: number; by: string; byKind: 'person' | 'bot'; at: number; alt?: { by: string; byKind: string; at: number; fields: Record<string, any> }; [k: string]: any }
export interface Page { cleftPage: 1; id: string; title: string; version: number; blocks: PageBlock[]; updatedAt: number; sendTo?: string; sendToTitle?: string }
/** One Page in a bot's Pages list (server/src/page-shelf.ts, PageShelfItem). */
export interface PageShelfItem {
  path: string; id: string; title: string; updatedAt: number; version: number; blocks: number;
  kind: 'calculator' | 'chart' | 'form' | 'checklist' | 'table' | 'doc'; snippet: string; pinned: boolean;
  origin: { chatId: string; chatTitle: string; kind: 'view' | 'bot' | 'person'; seq?: number } | null; sendTo: string;
}
export type PageOp = { op: string; [k: string]: any };
export interface PageOpResult { ok: boolean; id?: string; error?: string; conflict?: boolean }
export interface PageVersionInfo { version: number; by: string; byKind: 'person' | 'bot'; at: number; summary: string }
export interface FileListing { status: 'ok' | 'asleep' | 'error'; path: string; files: { name: string; size: number; modifiedAt: number; isDir: boolean }[]; error?: string }

export interface Row { seq: number; generation: number; kind: string; body: any; createdAt: number }
export interface Readback { id: string; status: string; title: string; resolvedAt: number | null }

/** A standing "Always allow" rule: one bot, one tool. */
export interface AllowRule { id: string; botId: string; botName: string; tool: string; label: string; createdBy: string; createdVia: string; createdAt: number; uses: number; lastUsedAt: number | null; risk: string | null }
/** One call a rule let through without a card. */
export interface FreeRunBot { botId: string; botName: string; on: boolean; canChange: boolean }
export interface AllowRuleUse { id: number; ruleId: string; botId: string; botName: string; tool: string; label: string; detail: string; at: number }
