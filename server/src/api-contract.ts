// The API contract: each call the apps make, named once with what it takes and what it answers, and the
// live events. Types only and no server imports beyond other type files, so the web app (@shared) and the
// Android app (import type, stripped by its build) read this same file. docs/api-contract.md has the rules;
// `npm run api:generate` turns this file into api/openapi.json, and `npm run api:check` refuses a change to it
// that would take something from an installed app.
//
// Each key is `METHOD /api/path` with `{name}` for a path part. `query` and `body` are what the app sends
// (fields optional unless an app must send them), `res` is a 2xx answer. Any call can also answer ApiError.
// Server handlers answer through `answer()` (lib/contract.ts) so the server cannot drift from it either.
import type { Reaction } from './reactions.js';
import type { NeedsItem } from './needs-you-types.js';
import type { Bot, LiveState, Page, PageAnswer, PageOp, PageOpResult, RemovedTask, Routine, Row, ServerEvent, SideChat, Task } from './types.js';

/** What a refused or failed call answers (4xx, 5xx). `code` names a refusal an app can act on. */
export interface ApiError { error: string; code?: string; ref?: string }

/** An approval card after it was answered (agent/loop.ts approvalReadback). */
export interface ApprovalAnswer {
  id: string; botId: string; botName: string; tool: string; title: string; detail: string; status: string;
  resolvedAt: number | null; answeredBy: string | null; answeredVia: string | null;
}

export interface ApiOperations {
  /**
   * Which apps this server still works with (app-support.ts). Needs no sign-in, so an app can check before it
   * signs in. `updateUrl` is where to get a newer app, when the server is told (ANDROID_UPDATE_URL).
   */
  'GET /api/app-support': { res: { api: number; minApp: { android: string; windows: string }; updateUrl: { android: string | null } } };
  /** Every bot, group and side chat the sign-in may see, with what each is doing now. */
  'GET /api/bots': { res: { bots: Bot[]; live: LiveState[] } };
  /** A chat's rows, newest last: the latest `limit`, or the `limit` rows before `beforeSeq`. */
  'GET /api/bots/{id}/rows': { query: { beforeSeq?: number; limit?: number }; res: { generation: number; rows: Row[] } };
  /**
   * Send a message (or, with `editOf`, change one). `clientId` names the send: sending it again after a dropped
   * connection answers the row already there with `duplicate`.
   */
  'POST /api/bots/{id}/messages': {
    body: { text: string; editOf?: number; attachments?: string[]; clientId?: string };
    res: { row: Row; duplicate?: boolean };
  };
  /** Add an emoji to a message, or take it off again (`added` false). */
  'POST /api/bots/{id}/rows/{seq}/reactions': { body: { emoji: string }; res: { ok: true; reactions: Reaction[]; added: boolean } };
  /** Stop the chat's running turn, or in a group one `member`'s. `stopped` names who was stopped. */
  'POST /api/bots/{id}/interrupt': { body: { member?: string }; res: { ok: true; stopped: string[] } };
  /** A bot's side chats. `allowed` false (with `why`) when this bot cannot have them. */
  'GET /api/bots/{id}/side-chats': { res: { chats: SideChat[]; allowed: boolean; why: string | null } };
  /** Start a side chat, with an optional title. */
  'POST /api/bots/{id}/side-chats': { body: { title?: string }; res: { chat: SideChat } };
  /** Rename a side chat. Answers the bot's side chats after the change. */
  'PATCH /api/side-chats/{id}': { body: { title: string }; res: { ok: true; chats: SideChat[] } };
  /** Delete a side chat. It can be brought back (restore) until `undoUntil`. */
  'DELETE /api/side-chats/{id}': { res: { ok: true; undoUntil: number } };
  /** Undo a side chat's delete. */
  'POST /api/side-chats/{id}/restore': { res: { ok: true; chats: SideChat[] } };
  /** Everything waiting on the person across every bot (needs-you.ts). */
  'GET /api/needs-you': { res: { items: NeedsItem[] } };
  /** A bot's routines. */
  'GET /api/bots/{id}/routines': { res: { routines: Routine[] } };
  /** Switch a routine on or off, or set "post only when something is found". Send at least one. */
  'PATCH /api/routines/{id}': { body: { enabled?: boolean; quiet?: boolean }; res: { routine: Routine } };
  /** Run a routine now. */
  'POST /api/routines/{id}/run': { res: { ok: true } };
  /** Delete a routine. */
  'DELETE /api/routines/{id}': { res: { ok: true } };
  /** One bot's tasks. */
  'GET /api/bots/{id}/tasks': { res: { tasks: Task[] } };
  /** The person changes a task's title, note or state. */
  'PATCH /api/bots/{id}/tasks/{taskId}': { body: { title?: string; note?: string; state?: Task['state'] }; res: { task: Task } };
  /** Delete a task. `removed` is the whole task, for Undo. */
  'DELETE /api/bots/{id}/tasks/{taskId}': { res: { ok: true; removed: RemovedTask } };
  /** Undo a task's delete: send back the `removed` task. */
  'POST /api/bots/{id}/tasks/restore': { body: RemovedTask; res: { task: Task } };
  /** Answer an approval card, bound to the card by its `digest`. Only a person can (code agent_session). */
  'POST /api/approvals/{id}': { body: { decision: 'allow' | 'always' | 'conversation' | 'deny'; digest: string }; res: { ok: true; approval: ApprovalAnswer } };
  /** Answer a bot's question card. */
  'POST /api/bots/{id}/cards/{seq}/answer': { query: { generation?: number }; body: { answer: string }; res: { ok: true } };
  /** Every bot's tasks, newest first. */
  'GET /api/tasks': { res: { tasks: Task[] } };
  /** One Page, with the chat its buttons send into. */
  'GET /api/bots/{id}/pages': { query: { path: string }; res: PageAnswer };
  /** Change a Page: each op answers in `results`, in order. */
  'POST /api/bots/{id}/pages/ops': { body: { path: string; ops: PageOp[] }; res: { page: Page; results: PageOpResult[] } };
}

/**
 * GET /api/events: a text/event-stream of these, one JSON object per `data:` line, each with an `id:` the app
 * sends back (Last-Event-ID or ?after=) to get what it missed. Apps ignore a `type` they do not know.
 */
export type ApiEvent = ServerEvent;

export type ApiOp = keyof ApiOperations;
export type ApiRes<K extends ApiOp> = ApiOperations[K]['res'];
export type ApiBody<K extends ApiOp> = ApiOperations[K] extends { body: infer B } ? B : never;
export type ApiQuery<K extends ApiOp> = ApiOperations[K] extends { query: infer Q } ? Q : never;
