import type { ApiBody, ApiOp, ApiQuery, ApiRes } from '@shared/api-contract';
import { apiPath } from '@shared/api-path';
import type { Bot, ChatFile, ComputerState, Machine, MachineLogEntry, OutsideExchange, Row, Toolkit, User } from '@shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A card as the server knows it: its place and the conversation it belongs to, so a card left over from an earlier conversation is refused. */
type CardRef = { seq: number; generation: number };
const cardPath = (botId: string, card: CardRef, action: string) => `/bots/${botId}/cards/${card.seq}/${action}?generation=${card.generation}`;

/** A reason a person can act on when the server itself did not give one (a proxy page, a restart, no network). */
export function plainReason(status: number, msg?: string | null): string {
  if (msg && msg.trim()) return msg;
  if (status === 0) return "Couldn't reach the server. It may be restarting, or the connection dropped. Try again in a moment.";
  if (status === 524 || status === 504) return 'The server took too long to answer, so the connection was closed. Try again.';
  if (status === 502 || status === 503 || status === 520 || status === 521 || status === 522 || status === 523) return 'The server was restarting or out of reach. Try again in a moment.';
  return `The server answered with an error (${status}).`;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Answers that can mean "the server is restarting or the connection blinked", worth another try for a read. */
const BLIP = new Set([502, 503, 520, 521, 522, 523]);

/**
 * One request to the server. `base` is the part after /api that a group of calls shares (plugins, connectors).
 *
 * A read (GET) that fails because the server is restarting or the connection dropped is tried again twice,
 * a moment apart, before anything is shown: an update takes a few seconds, and a page opened in the middle
 * of one used to show an error that a second look would not have. A change (POST and the rest) is never
 * repeated here: it may have reached the server.
 */
export async function request<T>(method: string, path: string, body?: unknown, base = ''): Promise<T> {
  const waits = method === 'GET' ? [700, 1800] : [];
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`/api${base}${path}`, {
        method,
        credentials: 'include',
        // A read that gets no answer in a minute is given up on (and tried again), not left spinning for good.
        signal: method === 'GET' && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(60_000) : undefined,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch { /* no answer at all */ }
    const status = res?.status ?? 0;
    // The server's own 502 and 503 answers are JSON and mean what they say (a bot's agent did not answer);
    // only a proxy's page or no answer at all is a blip.
    const blip = !res || (BLIP.has(status) && !/json/i.test(res.headers.get('content-type') ?? ''));
    if (blip && attempt < waits.length) { await pause(waits[attempt]); continue; }
    if (!res) throw new ApiError(0, plainReason(0));
    // The session ended (expired, or signed out elsewhere): the app goes back to its sign-in page (App.tsx).
    if (res.status === 401 && !(base === '' && path.startsWith('/auth/'))) window.dispatchEvent(new Event('cleftbot:signed-out'));
    if (!res.ok) {
      let msg: string | undefined;
      let ref: string | undefined;
      try { const j = (await res.json()) as { error?: string; ref?: string }; msg = j.error; ref = j.ref; } catch { /* not json: a proxy's page */ }
      // A failure inside the server names its line in the log, so it can be found (Settings, System).
      throw new ApiError(res.status, `${plainReason(res.status, msg)}${ref ? ` (ref ${ref})` : ''}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}
const req = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body);
/**
 * A call named in the contract (server/src/api-contract.ts): the address comes from the name, and what it sends
 * and answers are the server's own types, so the apps and the server cannot disagree unnoticed.
 */
export const call = <K extends ApiOp>(op: K, params: Record<string, string | number> = {}, body?: ApiBody<K>, query?: ApiQuery<K>): Promise<ApiRes<K>> => {
  const { method, path } = apiPath(op, params, query as object | undefined);
  return request<ApiRes<K>>(method, path.replace(/^\/api/, ''), body);
};

export interface NotifyPrefs {
  channels: { messages: boolean; approvals: boolean; jobs: boolean };
  muted: Record<string, number>;
  dndUntil: number;
  quiet: { on: boolean; start: string; end: string; tz: string; approvalsRing: boolean };
  preview: boolean;
}
export type NotifyPatch = Partial<Pick<NotifyPrefs, 'dndUntil' | 'preview'>> & {
  quiet?: Partial<NotifyPrefs['quiet']>; channels?: Partial<NotifyPrefs['channels']>;
  mute?: { botId: string; until: number }; unmute?: string;
};

/** Chat list AI summaries (server/src/list-summary.ts). model null = the automatic cheap pick. */
export interface ListSummaryPrefs { on: boolean; provider: string | null; model: string | null }
export interface ListSummaryInfo {
  prefs: ListSummaryPrefs;
  options: { providers: { id: string; name: string; models: string[] }[]; auto: { provider: string | null; model: string | null }; ready: boolean };
  lastError: { at: number; error: string } | null;
}

/** How this page can sign in without the server (see server routes /auth/me). */
export interface SignInInfo {
  /** The address behind Cloudflare Access, where opening the app signs you in. */
  accessUrl?: string;
  /** Access let this address through, but it is not on the app's allowed list. */
  accessRefused?: string;
  /** Access vouches for an allowed address; the browser signed out, so it waits for "Continue". */
  accessReady?: boolean;
}

/** A message found by search (server/src/chat-extras.ts). `current` is false for one in an earlier conversation. */
export interface SearchHit { chatId: string; botId: string; sideTitle: string | null; generation: number; seq: number; current: boolean; who: 'you' | 'bot'; from: string | null; snippet: string; at: number; len: number; createdAt: number }
/** One conversation a chat has had (the open one has `current`). */
export interface ConversationInfo { generation: number; current: boolean; title: string; messages: number; startedAt: number; lastAt: number }
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/** A picture or file in a bot's Library, as an address the page can show (`inline`) or download. */
export const fileUrl = (botId: string, path: string, inline = true) => `/api/bots/${botId}/files/raw?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;

export interface AppsResponse { apps: Toolkit[]; connected: string[]; categories: string[]; total: number; configFile?: string; error?: string }

export interface LooksOptions { styles: { id: string; label: string }[]; poses: { id: string; label: string }[]; maxCount: number; generating: boolean }
export const lookUrl = (botId: string, candidateId: string) => `/api/bots/${botId}/look/${candidateId}`;

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

export type LookAskBody = { prompt: string; style?: string; count?: number; intent?: 'new' | 'tweak'; reference?: string | null };
export interface LookRun { id: string; state: 'making' | 'done' | 'failed'; createdAt: number; seen: boolean; error?: string; ask: { description: string; style: string | null; count?: number; intent: 'new' | 'tweak' } }

export interface DeviceSession { id: string; device: string | null; who: string; kind: 'person' | 'script'; current: boolean; createdAt: number; lastSeenAt: number | null; expiresAt: number }
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
  sessions?: { people: number; scripts: number };
  stallMs?: number;
  backup: { tag: string; at: number | null; ok: boolean } | null;
  deploy?: { at: number | null; by: string; action: 'deploy' | 'rollback'; result: string; to: string } | null;
  requests: { total: number; errors: number; slow: number; lastErrorAt: number | null; slowest: { path: string; ms: number; at: number }[] };
  problems: { at: number; level: 'warn' | 'error'; text: string; count: number; before?: boolean }[];
  problemTotals: { warn: number; error: number };
  checks: { id: string; label: string; state: CheckState; detail: string }[];
}

export interface UsageCounts { turns: number; failed: number; inputTokens: number; outputTokens: number }
/** How much the bots were used (server/src/usage.ts). Counts only, no prices. */
export interface UsageReport {
  days: number; since: number; totals: UsageCounts;
  byDay: ({ day: string } & UsageCounts)[];
  byBot: ({ botId: string; name: string; lastAt: number | null; topModel: string | null } & UsageCounts)[];
  byModel: ({ provider: string | null; model: string } & UsageCounts)[];
}

/** A saved login as the apps see it (server/src/vault.ts): never the username or password. */
import type { LoginView, LoginInput } from '@shared/vault-types';
export type SavedLogin = LoginView;
export type SavedLoginInput = LoginInput;
/** The activity trail (server/src/activity.ts): every allowed, refused and failed action, and what started it. */
export type ActivityStarter = 'person' | 'script' | 'routine' | 'goal' | 'memory' | 'handoff' | 'self' | 'system' | 'earlier';
export type ActivityOutcome = 'allowed' | 'refused' | 'failed';
export interface ActivityRow {
  id: number; at: number; botId: string | null; botName: string | null; forName: string | null;
  by: { kind: ActivityStarter; id: string | null; name: string | null; text: string; phrase: string; unwatched: boolean };
  source: string; tool: string; title: string; outcome: ActivityOutcome; how: string | null; detail: string | null; looks: boolean;
}
export interface ActivityFilter { botId?: string; outcome?: ActivityOutcome; by?: ActivityStarter | 'unwatched'; looks?: boolean; q?: string; before?: number }
export interface ActivityPage { rows: ActivityRow[]; more: boolean; counts: { allowed: number; refused: number; failed: number; unwatched: number }; bots: { id: string; name: string }[] }
const activityQuery = (f: ActivityFilter) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  return p.toString();
};

export const api = {
  activity: (f: ActivityFilter) => req<ActivityPage>('GET', `/activity?${activityQuery(f)}`),
  activityExport: (f: ActivityFilter) => req<{ csv: string; rows: number; truncated: boolean; filename: string }>('POST', '/activity/export', { ...f, before: undefined }),
  /** Everything waiting on the person across every bot (server needs-you.ts). Reading only. */
  needsYou: () => call('GET /api/needs-you'),
  usage: (days: number) => req<UsageReport>('GET', `/usage?days=${days}&tz=${-new Date().getTimezoneOffset()}`),
  status: () => req<ServerStatus>('GET', '/status'),
  snapshotNow: () => req<{ ok: true; snapshot: { name: string; bytes: number; at: number } | null }>('POST', '/status/snapshot'),
  sessions: () => req<{ sessions: DeviceSession[] }>('GET', '/auth/sessions'),
  signOutDevice: (id: string) => req<{ sessions: DeviceSession[] }>('DELETE', `/auth/sessions/${id}`),
  signOutScripts: () => req<{ signedOut: number; sessions: DeviceSession[] }>('POST', '/auth/sessions/sign-out-others', { only: 'scripts' }),
  clearProblems: () => req<{ ok: true; cleared: number }>('POST', '/status/problems/clear'),
  accountExport: () => req<{ exportedAt: string; counts: { bots: number; conversations: number; messages: number } } & Record<string, unknown>>('GET', '/export/account'),
  signOutOthers: (scripts = false) => req<{ signedOut: number; sessions: DeviceSession[] }>('POST', '/auth/sessions/sign-out-others', scripts ? { scripts: true } : {}),
  me: () => req<{ user: User | null; devLogin: boolean; signIn?: SignInInfo }>('GET', '/auth/me'),
  accessSignIn: () => req<{ ok: true }>('POST', '/auth/access'),
  deviceLink: () => req<{ url: string; appLink: string; expiresAt: number }>('POST', '/auth/device-link'),
  pairInfo: (id: string) => req<{ code: string; device: string; kind?: 'sign-in' | 'machine'; createdAt: number; expiresAt: number }>('GET', `/auth/pair/${id}/info`),
  pairByCode: (code: string) => req<{ id: string; kind: 'sign-in' | 'machine' }>('GET', `/auth/pair-code/${encodeURIComponent(code)}`),
  machines: () => req<{ machines: Machine[] }>('GET', '/machines'),
  setMachineBots: (id: string, bots: string[]) => req<{ machine: Machine }>('PATCH', `/machines/${id}`, { bots }),
  removeMachine: (id: string) => req<{ ok: true }>('DELETE', `/machines/${id}`),
  machineLog: (id: string) => req<{ log: MachineLogEntry[] }>('GET', `/machines/${id}/log`),
  pairAnswer: (id: string, allow: boolean) => req<{ ok: boolean; state: string }>('POST', `/auth/pair/${id}/answer`, { allow }),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => call('GET /api/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
  // Notification settings (server/src/notify.ts), shared by the website, the Windows app and the YBots phone app.
  notifyPrefs: () => req<{ prefs: NotifyPrefs }>('GET', '/notify/prefs?profile=main'),
  setNotifyPrefs: (patch: NotifyPatch) => req<{ prefs: NotifyPrefs }>('PUT', '/notify/prefs?profile=main', patch),
  listSummary: () => req<ListSummaryInfo>('GET', '/list-summary'),
  setListSummary: (patch: Partial<ListSummaryPrefs>) => req<{ prefs: ListSummaryPrefs }>('PUT', '/list-summary', patch),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => call('GET /api/bots/{id}/rows', { id }),
  /** The rows just before `beforeSeq`, for "Show earlier messages". */
  rowsBefore: (id: string, beforeSeq: number) => call('GET /api/bots/{id}/rows', { id }, undefined, { beforeSeq, limit: 200 }),
  /** `clientId` names this send, so sending it again after a dropped connection can never post it twice. */
  send: (id: string, text: string, opts: { editOf?: number; attachments?: string[]; clientId?: string } = {}) =>
    call('POST /api/bots/{id}/messages', { id }, { text, ...(opts.editOf ? { editOf: opts.editOf } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.clientId ? { clientId: opts.clientId } : {}) }),
  /** Put a picture or file in the bot's Library (uploads/), to send with a message. */
  attach: async (id: string, file: Blob, name: string): Promise<ChatFile> => {
    let res: Response;
    try {
      res = await fetch(`/api/bots/${id}/attachments?name=${encodeURIComponent(name)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    } catch { throw new ApiError(0, plainReason(0)); }
    if (res.status === 401) window.dispatchEvent(new Event('cleftbot:signed-out'));
    if (!res.ok) {
      let msg: string | undefined;
      try { msg = ((await res.json()) as { error?: string }).error; } catch { /* a proxy's page */ }
      throw new ApiError(res.status, res.status === 413 && !msg ? 'That file is larger than 25 MB, which is the most a message can carry.' : plainReason(res.status, msg));
    }
    return ((await res.json()) as { file: ChatFile }).file;
  },
  /** Every message of every chat with all these words. */
  search: (q: string, botId?: string) => req<{ q: string; hits: SearchHit[] }>('GET', `/search?q=${encodeURIComponent(q)}${botId ? `&bot=${encodeURIComponent(botId)}` : ''}`),
  conversations: (id: string) => req<{ conversations: ConversationInfo[] }>('GET', `/bots/${id}/conversations`),
  conversationRows: (id: string, generation: number, beforeSeq?: number) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/conversations/${generation}/rows?limit=200${beforeSeq ? `&beforeSeq=${beforeSeq}` : ''}`),
  /** Carry on an earlier conversation; the one that was open stays in the list. */
  deleteConversation: (id: string, generation: number) => req<{ ok: true; conversations: ConversationInfo[] }>('DELETE', `/bots/${id}/conversations/${generation}`),
  openConversation: (id: string, generation: number) => req<{ ok: true; generation: number }>('POST', `/bots/${id}/conversations/${generation}/open`),
  exportChat: (id: string, generation?: number) => req<{ name: string; markdown: string }>('GET', `/bots/${id}/export${generation ? `?generation=${generation}` : ''}`),
  markUnread: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/unread`),
  setPinned: (id: string, pinned: boolean) => req<{ bot: Bot }>('PATCH', `/bots/${id}`, { pinned }),
  /** Hide a bot from your own list and notifications (or show it again). The bot itself carries on as before. */
  setOwnerHidden: (id: string, hidden: boolean) => req<{ bot: Bot }>('PATCH', `/bots/${id}`, { ownerHidden: hidden }),
  version: () => req<{ version: string; commit: string | null; startedAt: number }>('GET', '/version'),
  /** Stop the bot's turn; in a group chat, all members answering it, or one with `member`. */
  interrupt: (id: string, member?: string) => call('POST /api/bots/{id}/interrupt', { id }, member ? { member } : undefined),
  /** Add or take back your emoji reaction on a Bot's message. */
  react: (id: string, seq: number, emoji: string) => call('POST /api/bots/{id}/rows/{seq}/reactions', { id, seq }, { emoji }),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),
  /** Undo "New conversation"; 409 with the reason once something was said in the new chat or after 10 minutes. */
  freshUndo: (id: string) => req<{ ok: true; generation: number }>('POST', `/bots/${id}/fresh/undo`),

  // Side chats (server/src/side-chats.ts): more conversations with the same bot. Each is read and written like
  // a chat with its own id (rows, send, interrupt, fresh, read, cards).
  sideChats: (botId: string) => call('GET /api/bots/{id}/side-chats', { id: botId }),
  newSideChat: (botId: string, title?: string) => call('POST /api/bots/{id}/side-chats', { id: botId }, title ? { title } : {}),
  renameSideChat: (id: string, title: string) => call('PATCH /api/side-chats/{id}', { id }, { title }),
  deleteSideChat: (id: string) => call('DELETE /api/side-chats/{id}', { id }),
  restoreSideChat: (id: string) => call('POST /api/side-chats/{id}/restore', { id }),

  /** Turn off what this conversation allows without asking (server/src/conversation-allows.ts). */
  turnOffAllowedHere: (chatId: string, id?: string) => req<{ ok: true; turnedOff: number }>('POST', `/bots/${chatId}/allowed-here/off`, id ? { id } : {}),
  approve: (approvalId: string, decision: 'allow' | 'always' | 'conversation' | 'deny', digest: string | undefined) => {
    if (!digest) return Promise.reject(new Error('This card is too old to answer. Ask for a new card.'));
    return call('POST /api/approvals/{id}', { id: approvalId }, { decision, digest });
  },
  /** A secure input card (server/src/browser-cards.ts): the typed value goes to the bot's browser, never to the chat. */
  secretInput: (approvalId: string, value: string, digest: string | undefined, save = false) => {
    if (!digest) return Promise.reject(new Error('This card is too old to answer. Ask for a new card.'));
    return req<{ ok: true }>('POST', `/approvals/${approvalId}/secret`, { value, digest, ...(save ? { save: true } : {}) });
  },
  /** Sign in on a saved-login card (server/src/vault.ts): only the login's owner; the server types it into the page. */
  useSavedLogin: (approvalId: string, digest: string | undefined) => {
    if (!digest) return Promise.reject(new Error('This card is too old to answer. Ask for a new card.'));
    return req<{ ok: true }>('POST', `/approvals/${approvalId}/login`, { digest });
  },
  /** Settings > Saved logins: the signed-in person's own logins. Never their values. */
  vaultLogins: () => req<{ logins: SavedLogin[]; bots: { id: string; name: string }[] }>('GET', '/vault/logins'),
  addVaultLogin: (b: SavedLoginInput) => req<{ ok: true; login: SavedLogin }>('POST', '/vault/logins', b),
  updateVaultLogin: (id: string, b: Partial<SavedLoginInput>) => req<{ ok: true; login: SavedLogin }>('PATCH', `/vault/logins/${id}`, b),
  deleteVaultLogin: (id: string) => req<{ ok: true }>('DELETE', `/vault/logins/${id}`),
  /** A posting plan card (server/src/posting.ts): the days left switched on, approved once or always. */
  postingPlan: (approvalId: string, days: string[], decision: 'allow' | 'always', digest: string | undefined) => {
    if (!digest) return Promise.reject(new Error('This card is too old to answer. Ask for a new card.'));
    return req<{ ok: true }>('POST', `/approvals/${approvalId}/plan`, { days, decision, digest });
  },
  answer: (id: string, card: CardRef, answer: string) => req<{ ok: true }>('POST', cardPath(id, card, 'answer'), { answer }),
  /** A change to an answer view (server/src/views.ts): check, pick, field or send. */
  viewChange: (id: string, card: CardRef, change: Record<string, unknown>) => req<{ ok: true }>('POST', cardPath(id, card, 'view'), change),
  /** Open as Page: makes (once) a Page from an answer view and answers its path. */
  /** Pin or unpin a board above the message box (server/src/board-pin.ts). */
  pinBoard: (id: string, card: CardRef, on: boolean) => req<{ ok: true }>('POST', cardPath(id, card, 'pin'), { on }),
  viewPage: (id: string, card: CardRef) => req<{ ok: true; path: string }>('POST', cardPath(id, card, 'page'), {}),
  dismiss: (id: string, card: CardRef) => req<{ ok: true }>('POST', cardPath(id, card, 'dismiss')),
  saveProposedSkill: (id: string, card: CardRef, edit?: { name: string; description: string; body: string }) => req<{ ok: true; skillId: string }>('POST', cardPath(id, card, 'save-skill'), edit ?? {}),

  routines: (id: string) => call('GET /api/bots/{id}/routines', { id }),
  setRoutine: (rid: string, enabled: boolean) => call('PATCH /api/routines/{id}', { id: rid }, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  exchanges: (id: string) => req<{ exchanges: OutsideExchange[]; error: string | null }>('GET', `/bots/${id}/exchanges`),
  setLinkPaused: (id: string, paused: boolean) => req<{ ok: true }>('POST', `/bots/${id}/link`, { paused }),

  // looks (server/src/avatars.ts)
  looksOptions: () => req<LooksOptions>('GET', '/looks/options'),
  /** Start drawing pictures, then ask until they are done (a long request would be cut off by the proxy). */
  generateLooks: async (id: string, b: LookAskBody): Promise<{ candidates: string[] }> => {
    const started = await api.startLooks(id, b);
    if (started.candidates) return { candidates: started.candidates };
    return api.waitLookRun(id, started.run!);
  },
  startLooks: (id: string, b: LookAskBody) => req<{ run?: string; candidates?: string[] }>('POST', `/bots/${id}/avatar/generate`, { ...b, wait: false }),
  /**
   * Ask about a picture run until it is done. The run lives on the server (it even survives a restart),
   * so while the page is hidden or offline, failed asks are simply tried again; only a run the server
   * no longer knows (404) or ten failures in a row while the page is in front end the wait.
   */
  waitLookRun: async (id: string, run: string): Promise<{ candidates: string[] }> => {
    for (let misses = 0; ;) {
      await new Promise((r) => setTimeout(r, 3000));
      let s: { state: 'making' | 'done' | 'failed'; candidates?: string[]; error?: string };
      try { s = await req('GET', `/bots/${id}/avatar/generate/${run}`); }
      catch (e) {
        if (e instanceof ApiError && e.status === 404) throw e;
        if (document.visibilityState === 'hidden' || !navigator.onLine || ++misses < 10) continue;
        throw e;
      }
      misses = 0;
      if (s.state === 'done') return { candidates: s.candidates ?? [] };
      if (s.state === 'failed') throw new ApiError(502, s.error || 'The image service failed without saying why.');
    }
  },
  /** Picture runs not shown yet (and any still drawing), so a reloaded page picks up where it left off. */
  lookRuns: (id: string) => req<{ runs: LookRun[] }>('GET', `/bots/${id}/avatar/runs`),
  lookRunSeen: (id: string, run: string) => req<{ ok: true }>('POST', `/bots/${id}/avatar/generate/${run}/seen`, {}),
  setPicture: (id: string, image: string | null) => req<{ bot: Bot }>('PUT', `/bots/${id}/avatar`, { image }),
  remakePoses: (id: string, b: { poses?: string[]; note?: string } = {}) => req<{ ok: true }>('POST', `/bots/${id}/avatar/poses`, b),
  removePoses: (id: string) => req<{ ok: true }>('DELETE', `/bots/${id}/avatar/poses`),
  chooseLook: (id: string, seq: number, candidateId: string | null) => req<{ ok: true }>('POST', `/bots/${id}/look-cards/${seq}/choose`, { candidateId }),
  moreLooks: (id: string, seq: number, b: { intent?: 'new' | 'tweak'; description?: string; style?: string | null; count?: number; reference?: string | null }) => req<{ ok: true }>('POST', `/bots/${id}/look-cards/${seq}/more`, b),
  /** A look card straight away, without asking the bot (for a bot outside the app). */
  askLooks: (id: string, b: { description: string; intent?: 'tweak' | 'new' }) => req<{ seq: number }>('POST', `/bots/${id}/look-cards`, b),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
};

let connectPopup: Window | null = null;

/** Open a link in a centered popup. */
export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  connectPopup = window.open(url, 'cleftbot-connect', `width=${w},height=${h},left=${left},top=${top}`);
  return connectPopup;
}

/** The "app connected" note from our OAuth callback page: it must come from the popup we opened or from this app's own origin. */
export function isConnectedMessage(e: MessageEvent): boolean {
  if ((e.data as { type?: string } | null)?.type !== 'cleftbot-connected') return false;
  return e.origin === window.location.origin || (connectPopup !== null && e.source === connectPopup);
}
