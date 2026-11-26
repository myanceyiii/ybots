import type { Bot, ChatFile, ChatFileEntry, FilePreview, ComputerState, EngineInfo, FallbackChoice, ProviderCheckResult, HermesSkillDetail, HermesSkillList, LibraryFile, Memory, Page, PageOp, PageOpResult, PageShelfItem, PageVersionInfo, ModelUsageSummary, Routine, Skill, Task, Toolkit } from '@shared/types';
import type { HelperRun, HelperSettings, HelpersView } from '@shared/helpers';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Signed out elsewhere, or the session ran out: App.tsx goes back to the sign-in screen (as lib/api.ts does).
  if (res.status === 401) window.dispatchEvent(new Event('cleftbot:signed-out'));
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode' | 'chatColor' | 'visuals' | 'webSearch' | 'phoneActions' | 'busySend'>>;

export interface HelpersBundle { helpers: HelpersView; models: string[]; canEdit: boolean; runs: HelperRun[] }

export const configApi = {
  helpers: (botId: string) => req<HelpersBundle>('GET', `/bots/${botId}/helpers`),
  setHelpers: (botId: string, s: HelperSettings) => req<HelpersBundle>('PUT', `/bots/${botId}/helpers`, s),
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),
  moveSkillToAgent: (id: string) => req<{ skill: HermesSkillDetail }>('POST', `/skills/${id}/to-hermes`),

  // The bot's own Hermes skills (server/src/engine-skills.ts).
  agentSkills: (botId: string, fresh = false) => req<HermesSkillList>('GET', `/bots/${botId}/hermes-skills${fresh ? '?fresh=1' : ''}`),
  agentSkill: (botId: string, name: string) => req<{ skill: HermesSkillDetail }>('GET', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`),
  createAgentSkill: (botId: string, s: { name: string; category?: string; description: string; body: string }) => req<{ skill: HermesSkillDetail }>('POST', `/bots/${botId}/hermes-skills`, s),
  saveAgentSkill: (botId: string, name: string, s: { description?: string; body?: string; content?: string }) => req<{ skill: HermesSkillDetail }>('PUT', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`, s),
  setAgentSkillEnabled: (botId: string, name: string, enabled: boolean) => req<{ ok: true }>('PUT', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}/enabled`, { enabled }),
  setAgentSkillsAutoSave: (botId: string, on: boolean) => req<{ ok: true; autoSave: boolean }>('PUT', `/bots/${botId}/hermes-skills/auto-save`, { on }),
  markAgentSkillsSeen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/hermes-skills/seen`),
  deleteAgentSkill: (botId: string, name: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/hermes-skills/${encodeURIComponent(name)}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  setRoutineQuiet: (id: string, quiet: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { quiet }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),
  // The file pane (server/src/files.ts).
  filePreview: (botId: string, path: string) => req<FilePreview>('GET', `/bots/${botId}/files/preview?path=${encodeURIComponent(path)}`),
  saveFileText: (botId: string, path: string, text: string, modifiedAt?: number) => req<ChatFile>('PUT', `/bots/${botId}/files/text`, { path, text, modifiedAt }),
  // Pages (server/src/pages.ts).
  page: (botId: string, path: string) => req<Page>('GET', `/bots/${botId}/pages?path=${encodeURIComponent(path)}`),
  newPage: (botId: string, title: string, markdown?: string) => req<{ path: string; page: Page }>('POST', `/bots/${botId}/pages`, { title, markdown }),
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
  pageExport: (botId: string, path: string, format: string, table?: string) => req<ChatFile>('POST', `/bots/${botId}/pages/export`, { path, format, table }),
  chatFiles: (botId: string) => req<{ files: ChatFileEntry[] }>('GET', `/bots/${botId}/chat-files`),
  fileRawUrl: (botId: string, path: string, v?: number) => `/api/bots/${botId}/files/raw?inline=1&path=${encodeURIComponent(path)}${v ? `&v=${Math.round(v)}` : ''}`,
  filePageUrl: (botId: string, path: string, n: number, v?: number) => `/api/bots/${botId}/files/page?n=${n}&path=${encodeURIComponent(path)}${v ? `&v=${Math.round(v)}` : ''}`,

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),
  /** The live screen gave up after its quiet retries: logged on the server so a flaky view can be traced. */
  screenProblem: (botId: string, p: { tries: number; cause: string }) => req<{ ok: true }>('POST', `/bots/${botId}/screen/problem`, { ...p, client: 'web' }),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: {
    provider?: string | null; model?: string | null;
    modelMode?: 'manual' | 'auto'; modelTiers?: EngineInfo['modelTiers']; providerLock?: string | null;
    fallbacks?: FallbackChoice[]; allowSubscription?: boolean; acknowledgeSubscriptionTerms?: boolean;
  }) => req<{ engine: EngineInfo; notes?: string[] }>('PATCH', `/bots/${botId}/engine`, p),
  /** One real request from the bot's own agent to this provider and model (shared provider catalog). */
  checkProvider: (botId: string, provider: string, model: string) =>
    req<{ result: ProviderCheckResult; engine: EngineInfo }>('POST', `/bots/${botId}/engine/check`, { provider, model }),
  /** Turns per tier and model over the last `days` days. */
  engineUsage: (botId: string, days = 7) => req<{ usage: ModelUsageSummary }>('GET', `/bots/${botId}/engine/usage?days=${days}`),
  /** Opens the provider's sign-in flow in a terminal on the bot's screen. */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  allowRules: (botId?: string) => req<{ rules: AllowRule[]; log: AllowRuleUse[]; freeRun?: FreeRunBot[] }>('GET', `/allow-rules${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`),
  deleteAllowRule: (id: string) => req<{ ok: true }>('DELETE', `/allow-rules/${encodeURIComponent(id)}`),
  setFreeTerminal: (botId: string, on: boolean) => req<{ ok: true; on: boolean }>('PUT', `/bots/${encodeURIComponent(botId)}/free-terminal`, { on }),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};

/** A standing "Always allow" rule: one Bot, one tool (server/src/allow-rules.ts). */
export interface AllowRule { id: string; botId: string; botName: string; tool: string; label: string; createdBy: string; createdVia: string; createdAt: number; uses: number; lastUsedAt: number | null; risk: string | null }
/** One call a rule let through without a card. */
/** The maintainer bot's free-run switch: every terminal command runs without a card (server/src/maintainer-guard.ts). */
export interface FreeRunBot { botId: string; botName: string; on: boolean; canChange: boolean }
export interface AllowRuleUse { id: number; ruleId: string; botId: string; botName: string; tool: string; label: string; detail: string; at: number }
