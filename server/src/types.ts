// Shared API contract between server and web (web imports these as types only).
import type { Reaction } from './reactions.js';

export type AvatarShape =
  | 'blob' | 'pebble' | 'bean' | 'egg' | 'squircle' | 'tablet' | 'capsule' | 'cylinder' | 'hex'
  | 'gem' | 'crystal' | 'wedge' | 'shield' | 'dome' | 'arch' | 'cloud' | 'teardrop' | 'leaf'
  | 'square' | 'sparkle' | 'clover' | 'flower' | 'heart' | 'house' | 'star';

export type AvatarColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';

export interface User {
  id: string; email: string; name: string; avatarUrl: string | null;
  /** Who this device shows as signed in (a person's name, or the team's), from /auth/me. Display only. */
  displayName?: string;
  /** Set when this sign-in sees only some bots (SCOPED_PEOPLE, server lib/scope.ts): their ids. Apps hide team-wide menus. */
  scope?: { bots: string[] };
}

export interface Bot {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  /**
   * The bot's colour in chats (chat-colors.ts): its name, bar and bubble tint where it posts in another
   * bot's chat or a group. Null for a group. `chatColorAuto` = picked for it, not set in settings.
   */
  chatColor?: import('./chat-colors.js').ChatColor | null;
  chatColorAuto?: boolean;
  /** A picture that replaces the shape (GET it with the session), or null for the shape. */
  avatarImageUrl: string | null;
  /** Pictures of the bot's character in each pose (avatar-poses.ts), made from its picture. Empty for a shape. */
  avatarPoses: Partial<Record<import('./avatar-poses.js').AvatarPose, string>>;
  /** Making the poses: 'making' while it runs; done/total count the poses. */
  avatarPoseJob: AvatarPoseJob | null;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  /** Set for an outside member (outside.ts): it lives elsewhere and is reached through a link. */
  outside?: { via: 'slack'; channelName: string; status: 'ready' | 'paused' | 'offline' | 'not-set-up'; waiting: number; callUrl: string };
  /** Messages this bot or group sent to an outside member that are still waiting for an answer. */
  waitingFor?: { id: string; name: string; since: number }[];
  pinned: boolean;
  /**
   * Hidden from the owner's own view (Alex hid a bot): apps leave it out of the home list, pickers and
   * unread counts, and the server sends no notifications about it to the main profile. The bot works as
   * before (other bots and groups still reach it, it stays on the team), and a scoped sign-in (Sam) never
   * sees this as true.
   */
  ownerHidden?: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** How often it uses answer views, calculators, tap choices and Pages (visuals-level.ts). Not on a group. */
  visuals?: import('./visuals-level.js').VisualsLevel;
  /** What a message sent while it works does (steer-mode.ts): steer (default), queue or interrupt. */
  busySend?: import('./steer-mode.js').BusySend;
  /** Searches the web and reads pages by API (web-search.ts); off = no web_search/web_extract. Not on a group. */
  webSearch?: boolean;
  /** May set timers and alarms in the phone's Clock app (phone.ts). Not on a group. */
  phoneActions?: boolean;
  /** Voice chat settings: xAI voice id, speed multiplier (0.7–1.5), BCP-47 language or 'auto'. */
  voice: string;
  voiceSpeed: number;
  voiceLanguage: string;
  /** Hermes engine: model id and provider for this bot; null = the engine's default. */
  model: string | null;
  provider: string | null;
  /** 'auto' = each turn picks a tier from modelTiers by how hard it looks (server/src/model-router.ts). */
  modelMode: 'manual' | 'auto';
  modelTiers: Partial<Record<ModelTier, ModelTierChoice>> | null;
  /** When set, the bot never runs on another provider. */
  providerLock: string | null;
  generation: number;
  unread: number;
  /** Its side chats (side-chats.ts), when it has any: how many, unread replies in them, and how many are working now. */
  sideChats?: { count: number; unread: number; running: number };
  /** The list's line under the name: whole sentences, never cut mid-text (list-preview.ts). */
  lastPreview: string | null;
  /** The same line in at most 48 characters, for rows too narrow for lastPreview. */
  previewShort?: string | null;
  /** Every whole form of the line, longest first (lastPreview ... previewShort); apps show the first that fits. */
  previewForms?: string[] | null;
  /** Who the line is about: the bot's own words, a group member's, you or another sender, a card, an event, or an AI summary. */
  previewBy?: 'bot' | 'member' | 'you' | 'other' | 'card' | 'event' | 'summary' | null;
  lastActivityAt: number;
  createdAt: number;
}

export interface AvatarPoseJob { state: 'making' | 'ready' | 'stopped'; done: number; total: number; failed: number; error?: string }

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody =
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody;

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /**
   * Set when a message came from another bot, a routine, a voice call, or a program signed in to the
   * account ('agent': a Claude thread, a test script) rather than the user typing.
   */
  from?: { kind: 'bot' | 'routine' | 'voice' | 'agent'; id: string; name: string; via?: 'slack'; link?: string;
    /** Who an outside member's message went to (shown "Sheldon to Leonard" in Sheldon's own chat). */
    to?: { id: string; name: string } };
  citations?: { url: string; title?: string }[];
  /** Emoji reactions (reactions.ts). A reaction is feedback only, never an approval of anything. */
  reactions?: Reaction[];
  /** On a message you edited (message-edit.ts): the seq of its new version, shown "Edited". */
  editedTo?: number;
  /** On the new version of a message you edited: the seq of the earlier one. */
  editOf?: number;
  /** Pictures and files sent with the message (chat-extras.ts): saved in the bot's Library under uploads/. */
  attachments?: ChatFile[];
  /**
   * A message sent while the bot was working, taken into the reply in progress (steer-mode.ts):
   * 'pending' until the bot reaches a safe point, 'read' once handed to it, 'next' when the reply ended
   * first and the message became the next turn. Shown as a small "Steering" marker.
   */
  steer?: 'pending' | 'read' | 'next';
  /**
   * A handoff between bots (bot-handoffs.ts). 'ask': the task as the answering bot's chat shows it.
   * 'answer': the answering bot's reply, written word for word into the asking chat under its name
   * (`from`). Shown "Answer to <askedBy>'s handoff" (kind 'mention': "Answer to your @mention"). Information only: never an approval.
   */
  handoff?: { id: string; role: 'ask' | 'answer'; askedBy?: string; kind?: 'ask' | 'mention' };
}

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied';
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      title: string;
      detail: string;
      tool: string;
      /** Every tool this card asks about; "Always allow" covers exactly these. Absent on older cards. */
      tools?: string[];
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
      /** Hash of what this card shows; a client sends it back with its answer (absent on older cards). */
      digest?: string;
      /** "Always allow" is offered (the card lists what it covers; allow-rules.ts). Absent on older cards. */
      canAlways?: boolean;
      /** No listed tool is in a risky class. Notifications offer Allow/Deny only on these. */
      lowRisk?: boolean;
      /** The risky class of a listed tool (shell, files, delete, message, money, host, install, browser, computer, schedule). */
      risk?: string;
      /** A one-line warning for a risky tool, shown next to "Always allow". */
      alwaysNote?: string;
      status: 'pending' | 'allowed' | 'always' | 'conversation' | 'denied' | 'expired';
      /** "Allow for this conversation" is offered (conversation-allows.ts): wherever "Always allow" is, but mail, calls, browser cards and plans. */
      canConversation?: boolean;
      /** When the person turned off what this card allowed for the conversation (the line above the message box). */
      convOff?: number;
      /** The kind of action (action-kinds.ts: delete, send, share, post, pay, credentials), its short name and what it does. */
      kind?: string;
      kindName?: string;
      kindSays?: string;
      /** A hand-off: the person does it themselves (a password change on a website). "I did it myself" / "Don't do it". */
      handoff?: boolean;
      /** Who answered, and from where ("web", "Windows app", "phone app", "voice call"). Absent on older cards. */
      answeredBy?: string;
      answeredVia?: string;
      /**
       * Set on an email send (allow-rules.ts isMailSend): the whole email, shown in full. The card's Send is
       * "allow"; it never offers "Always allow" and cannot be answered from a notification.
       */
      mail?: { from: string; to: string; cc: string; bcc: string; subject: string; body: string; html: boolean; attachments: string[]; replyAll: boolean; threadId: string; forwardOf: string; text?: string; other?: { name: string; value: string }[]; incomplete?: string };
      /** What the real send returned after Send was pressed. */
      sendResult?: { ok: boolean; detail: string; at: number };
      /**
       * A secure input card (browser-cards.ts): the person types a password, code or card detail into a masked
       * box and the server types it into this field of the bot's browser. The value is never on the card.
       */
      secret?: SecretOnCard;
      /** A purchase card (browser-cards.ts): what the checkout page shows, read by the server, not the bot. */
      purchase?: PurchaseOnCard;
      /** A needs-you card: a CAPTCHA, passkey or app approval the person does on the bot's screen. */
      screenHelp?: { reason: string; site: string; note: string };
      /** A saved-login card (vault.ts): the owner's Sign in types a saved login into the bot's page. No values. */
      vault?: VaultOnCard;
      /**
       * A posting plan card (posting.ts): every day's video, cover and posts, with a switch per day. The
       * answer carries the days left on (routes.ts /approvals/:id/plan).
       */
      postingPlan?: PostingPlanOnCard;
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      options: string[];
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | {
      type: 'card';
      card: 'connect';
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
      status: 'pending' | 'connected' | 'skipped';
    }
  | {
      type: 'card';
      card: 'plugin';
      /** The plugin that made it, and its name as the owner knows it. */
      pluginId: string;
      pluginName: string;
      /** Validated data only (plugins/ui-schema.ts); the apps render it, nothing in it runs. */
      view: import('./plugins/ui-schema.js').PluginCard;
    }
  | {
      type: 'card';
      card: 'plugin-plan';
      /** A bot's plan for a new plugin (plugins/builder.ts). Only the owner's Build starts it. */
      draftId: string;
      title: string;
      purpose: string;
      tools: { name: string; description: string; writes: boolean }[];
      network: string[];
      status: 'pending' | 'building' | 'built' | 'dismissed';
    }
  | {
      type: 'card';
      card: 'plugin-review';
      /** The checked draft. Install sends `digest` back; only the owner can, and never by voice. */
      draftId: string;
      title: string;
      digest: string;
      checks: { name: string; ok: boolean; detail: string }[];
      notes: string[];
      tools: { name: string; description: string; writes: boolean }[];
      network: string[];
      files: string[];
      pluginId?: string;
      status: 'pending' | 'failed' | 'installed' | 'rejected' | 'removed' | 'superseded';
    }
  | {
      type: 'card';
      card: 'look';
      /**
       * A bot offering new looks for itself (avatars.ts). Nothing changes until the owner picks one;
       * the bot cannot choose. Pictures are served from /api/bots/:id/look/:candidateId.
       */
      intent: 'tweak' | 'new' | 'default';
      description: string;
      style?: string;
      count: number;
      candidates: string[];
      chosen?: string | null;
      error?: string;
      status: 'making' | 'pending' | 'applied' | 'dismissed' | 'failed';
      /** How many times drawing was started again after a server restart (avatars.ts resumeLookWork). */
      resumes?: number;
    }
  | {
      type: 'card';
      card: 'files';
      /** Files a turn wrote in the bot's workspace (files.ts changedSince); each opens in the file pane. */
      files: ChatFile[];
    }
  | {
      type: 'card';
      card: 'look-reveal';
      /** The chosen picture (a candidate id), shown big with a share button and follow-up ideas. */
      candidateId: string;
      suggestions: string[];
    }
  | {
      type: 'card';
      card: 'skill-proposal';
      /**
       * A group member proposing a group skill after working on something together (rooms.ts).
       * Nothing is saved until a person presses Save; a bot cannot answer this card.
       */
      fromBotId: string;
      fromBotName: string;
      name: string;
      description: string;
      body: string;
      /** The saved skill's id (skills table, bot_id = the group). */
      skillId?: string;
      status: 'pending' | 'saved' | 'dismissed';
    }
  | {
      type: 'card';
      card: 'view';
      /**
       * An answer view (views.ts): tables, charts, picks, forms and checklists a bot puts in its reply. Data only;
       * the apps draw it. A press or a Send posts a chat message as the person, so it is never an approval.
       */
      title: string;
      blocks: ViewBlock[];
      /** The same content as markdown, for previews, voice, other bots and apps that cannot draw it. */
      text: string;
      /** Set when a group member posted it. */
      from?: { id: string; name: string };
      /** The id the bot uses to change this view later (update_view), and when it last did. */
      viewId?: string;
      updatedAt?: number;
      /** The Page a person made from it (Open as Page), in the bot's workspace. */
      pagePath?: string;
      /**
       * Choice buttons (choices.ts): one choice block drawn as a row of buttons under the reply, no card
       * around it. `auto` when the server spotted the question rather than the bot offering them.
       */
      quick?: boolean;
      auto?: boolean;
      /**
       * Check-in offer (checkin-offer.ts): the choice buttons offer to keep an eye on `subject`, and a tap makes
       * a quiet routine for the bot instead of posting a chat message. Never an approval.
       */
      checkin?: { subject: string; focus?: string; link?: string; timezone?: string };
      /** Pinned board (board-pin.ts): kept in reach above the message box until it is done or let go. */
      pin?: { on: boolean; by: 'auto' | 'bot' | 'person'; at: number; doneAt?: number };
    }
  | {
      type: 'card';
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
      digest?: string;
      status: 'pending' | 'sent' | 'discarded';
    };

/** One piece of an answer view. Its fields depend on `type` (views.ts VIEW_TYPES). `sentAt` marks a sent choice, form or button. */
export interface ViewBlock { id: string; type: string; sentAt?: number; [field: string]: unknown }

export interface EventBody {
  type: 'event';
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'task-changed' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  summary?: string;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  tasks?: string[];
}

export interface VoiceOption {
  id: string;
  name: string;
  gender?: string;
  /** e.g. en-us, en-gb, ja (from the speech server). */
  language?: string;
  /** Heading the voice is listed under in the settings, e.g. "British English". */
  group?: string;
}

export interface NoticeBody { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error' }

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering';

export interface LiveState {
  botId: string;
  isRunning: boolean;
  activity: { kind: ActivityKind; detail?: string; since: number } | null;
  awaiting: { reason: string; since: number } | null;
  startedAt: number | null;
  /** Short one-line recap of the model's live reasoning, shown next to "Thinking" (caption.ts). Never cut mid-sentence. */
  caption?: string | null;
  /** The whole thought behind `caption`, shown when the person expands the bubble. Null when it says no more. */
  captionFull?: string | null;
  /** Tool calls made so far in the current turn. */
  steps?: number;
  /**
   * Group chats only (agent/room-runs.ts): the members answering the group's messages right now.
   * queued: waiting behind other work; working: on it; waiting: one of its approval cards needs you.
   */
  members?: { id: string; name: string; state: 'queued' | 'working' | 'waiting'; since: number; model?: LiveModel | null }[];
  /**
   * The model answering the current turn and its reasoning effort (model-badge.ts), shown as a small badge
   * on the bot's picture while it works. It follows the model actually used: when Hermes falls back to
   * another model mid-turn this changes and `fallback` is set. Null when idle.
   */
  model?: LiveModel | null;
}

export interface LiveModel {
  /** The model id, or null when the engine's own default answers. */
  id: string | null;
  provider: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** Auto mode's tier for this turn; null in manual mode. */
  tier: 'light' | 'standard' | 'heavy' | null;
  mode: 'manual' | 'auto';
  /** True once Hermes moved this turn to a fallback model. */
  fallback: boolean;
  /** Fits on the picture: "Opus", "GPT-5.5", "5.4 mini". */
  short: string;
  /** "Claude Opus 5.5". */
  name: string;
}

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
  /** Post only when something is found: a run with nothing to report leaves no message in the chat. */
  quiet: boolean;
  /** Failed runs in a row, and the last one's error (routines.ts, the fatigue rule). */
  failCount?: number; lastError?: string | null;
  /** Set when it switched itself off after 10 failures in a row; cleared when it is turned back on. */
  autoOffAt?: number | null;
}

export interface Task {
  id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number;
  /** Marked "working" but untouched for hours while its bot is idle (store.ts taskStale). */
  stale?: boolean;
}

/** A task the person deleted, whole, so the app's Undo can put it back exactly (POST /bots/<id>/tasks/restore). */
export interface RemovedTask { id: string; title: string; state: Task['state']; note: string; createdAt: number; updatedAt: number }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

/**
 * A skill in the bot's own Hermes agent (server/src/engine-skills.ts). `source`: own = written by the
 * bot or the person; builtin = shipped with Hermes; hub = installed from a skills hub; external = from
 * a folder Hermes reads but does not own.
 */
export type HermesSkillSource = 'own' | 'builtin' | 'hub' | 'external';
export interface HermesSkill {
  name: string; description: string; category: string; source: HermesSkillSource; enabled: boolean;
  uses: number; lastUsedAt: number | null; updatedAt: number;
  /** The bot's own latest change (created or improved it), from Hermes' skill ledger. */
  botChangedAt: number | null; botAction: 'created' | 'changed' | null;
  /** The bot made or changed it since the person last opened it here. */
  isNew: boolean;
}
export interface HermesSkillDetail {
  name: string; description: string; body: string; content: string; category: string;
  source: HermesSkillSource; enabled: boolean; files: string[];
}
/** GET /bots/:id/hermes-skills. `available` false: the bot has no Hermes skills the app can reach (reason says why). */
export interface HermesSkillList {
  available: boolean; reason?: string; skills: HermesSkill[];
  /** The bot saves its own skills without asking (hermes-gate.ts); only the owner changes it. */
  autoSave?: boolean; canChangeAutoSave?: boolean;
}

/** Teach a bot by showing it (server/src/teach.ts). */
export type TeachStatus = 'recording' | 'drafting' | 'stopped' | 'ready' | 'saved' | 'discarded';
export type TeachStepKind = 'page' | 'click' | 'type' | 'choose' | 'check' | 'press';
/** One recorded step, already masked: a sensitive field has `sensitive` and never a `text`. */
export interface TeachStep {
  at: number; kind: TeachStepKind; name: string; role: string; origin: string;
  url?: string; text?: string; checked?: boolean; sensitive?: boolean;
}
export interface TeachDraft { name: string; description: string; body: string }
export interface TeachRecording {
  id: string; botId: string; status: TeachStatus; steps: TeachStep[];
  /** Each step in plain words, as the review shows it. */
  lines: string[];
  note: string; draft: TeachDraft | null; model: string | null;
  /** Why the bot's model didn't write the draft (it was then written from the steps alone). */
  error: string | null;
  skillName: string | null; startedAt: number; stoppedAt: number | null;
}
/** GET /bots/:id/teach. `blocked`: why this bot can't be taught here, or null. */
export interface TeachState { blocked: string | null; recording: TeachRecording | null }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

/** How the file pane shows a file (server/src/files.ts). 'office' = Word/PowerPoint pages, 'sheet' = spreadsheet tables. */
export type FileKind = 'markdown' | 'text' | 'code' | 'table' | 'image' | 'pdf' | 'office' | 'sheet' | 'page' | 'other';
/** A file in a bot's workspace; `path` is relative to the workspace. */
export interface ChatFile { path: string; name: string; size: number; modifiedAt: number; kind: FileKind }
export interface FilePreview extends ChatFile {
  editable: boolean;
  /** markdown / text / code / csv: the file's text (first 1 MB). */
  text?: string;
  lang?: string;
  /** pdf / office: page count; each page is a PNG at /api/bots/:id/files/page?path=&n=. */
  pages?: number;
  /** csv / spreadsheets: the sheets as rows of cells (first 500 rows, 40 columns). */
  sheets?: { name: string; rows: string[][]; truncated: boolean }[];
  truncated?: boolean;
  /** Why no preview could be made (the file can still be downloaded). */
  error?: string;
}
/** GET /api/bots/:id/chat-files: files from this conversation's file cards, newest first, still there or not. */
export interface ChatFileEntry extends ChatFile { seq: number; missing?: boolean }

export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  orgoId: string | null;
  error: string | null;
  /** One screen per bot on the shared computer. width/height are the screen's pixel size. */
  screens: { botId: string; screenId: string; width?: number; height?: number }[];
  /** How many bots can have their own screen at once. */
  maxScreens?: number;
}

/** A model provider Hermes can use (subscription sign-in or API key). */
export interface EngineProvider {
  id: string;
  name: string;
  kind: 'subscription' | 'api_key';
  connected: boolean;
  /** Suggested model ids for this provider. */
  models: string[];
  /** Offered only after the owner switches it on for this bot, after a warning (the Claude subscription route). */
  optIn?: boolean;
  /** For an opt-in provider: switched on for this bot. Picking it while off asks to switch it on first. */
  enabled?: boolean;
}

export type ModelTier = 'light' | 'standard' | 'heavy';
export interface ModelTierChoice { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' }

/** The model one turn ran on, and why. */
export interface ModelRouteInfo {
  at: number;
  mode: 'manual' | 'auto';
  tier: ModelTier | null;
  provider: string | null;
  model: string | null;
  reason: string;
  ok: boolean;
}

export interface ModelUsageSummary {
  days: number;
  rows: { tier: ModelTier | 'manual'; model: string | null; turns: number; inputTokens: number; outputTokens: number }[];
}

/** The Hermes agent that runs one bot. */
export interface EngineInfo {
  botId: string;
  /** Hermes profile name ('default' for the primary bot). */
  profile: string;
  status: 'ready' | 'starting' | 'stopped' | 'error';
  error: string | null;
  model: string | null;
  provider: string | null;
  version: string | null;
  providers: EngineProvider[];
  modelMode: 'manual' | 'auto';
  modelTiers: Partial<Record<ModelTier, ModelTierChoice>> | null;
  providerLock: string | null;
  /** Suggested auto tiers per provider id. */
  tierPresets: Record<string, { label: string; tiers: Partial<Record<ModelTier, ModelTierChoice>> }>;
  lastRoute: ModelRouteInfo | null;
  /** Hermes is running a private screen of its own for this agent, so its computer work is not on the screen the app shows. */
  ownScreen: boolean;
  /** The app may change this bot's provider setup: a bot whose agent it runs, or the owner's own agent (Howard). */
  appManaged?: boolean;
  /** A change waits for the agent to restart (the owner's own agent restarts only when idle). */
  restartNote?: string | null;
  /** The shared provider catalog with this bot's access to each (provider-catalog.ts). */
  catalog?: ProviderStatus[];
  /** The bot's explicit fallback chain, tried in order when its default fails. Empty = none. */
  fallbacks?: FallbackChoice[];
  /** The owner switched the experimental Claude subscription route on for this bot. */
  subscriptionAllowed?: boolean;
}

export interface FallbackChoice { provider: string; model: string }

/** What one Check request found. `answeredBy` is the model the agent says answered, when it says. */
export interface ProviderCheckResult { ok: boolean; provider: string; model: string; answeredBy: string | null; detail: string; ms: number; at: number }

/**
 * One provider for one bot. `listed`, `access` and `verified` are three separate facts: a provider in
 * the catalog may have no credential, and a credential is not proof the model answers.
 */
export interface ProviderStatus {
  id: string;
  name: string;
  route: 'api_key' | 'subscription' | 'sign_in';
  experimental: boolean;
  /** Off for every bot until the owner switches it on for that bot. */
  optIn: boolean;
  billing: string;
  warning: string | null;
  /** 'catalog' = the app's shared list; 'agent' = defined in this bot's own agent config. */
  source: 'catalog' | 'agent';
  eligible: boolean;
  eligibleNote: string | null;
  access: 'ready' | 'needs_key' | 'not_signed_in' | 'off' | 'not_installed' | 'unknown';
  accessNote: string;
  models: string[];
  /** The models came from the bot's agent (its account's list), not the catalog's suggestions. */
  modelsFromAgent: boolean;
  /** The last real request made from this bot's agent with Check. */
  verified: { at: number; model: string; ok: boolean; detail: string | null; ms: number | null } | null;
  /** The last chat turn that ran on this provider. */
  lastTurn: { at: number; model: string | null; ok: boolean } | null;
}

export interface Toolkit {
  slug: string; name: string; logo?: string; description?: string; categories: string[];
  managedAuth: boolean; noAuth: boolean; connected: boolean;
  /** A local app's state (apps.json): ready, error (failed to start), stopped, or disabled. */
  status?: 'ready' | 'error' | 'stopped' | 'disabled';
}

/** Server-sent events on GET /api/events */
export type ServerEvent =
  /**
   * First on every connection. `resumed`: the events since the app's last one follow, so it need not fetch
   * afresh. `commit` and `web` name the build (web = the web app's entry script), so an open page can tell
   * the server was updated under it.
   */
  | { type: 'hello'; serverTime: number; resumed?: boolean; commit?: string | null; web?: string | null }
  /** The server is stopping for an update and will be back in a moment: apps say so and reconnect quickly. */
  | { type: 'restarting' }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  /** "New conversation" was undone: the chat is back on an earlier generation; fetch its rows again. */
  | { type: 'restored'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'bot'; bot: Bot }
  /** A bot's side chats changed (one was added, renamed, deleted, got a reply, started or stopped working): the whole list. */
  | { type: 'side-chats'; botId: string; chats: SideChat[] }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'tasks'; botId: string }
  | { type: 'memories'; botId: string }
  | { type: 'connections' }
  | { type: 'machines' }
  /** A picture run from a bot's Look settings finished (avatars.ts), so a page in the background can say so. */
  | { type: 'look-run'; botId: string; run: string; state: 'done' | 'failed' }
  /** A Page changed (pages.ts); an open Page reloads, and the bot's edits are marked for a moment. */
  | { type: 'page'; botId: string; path: string; version: number; by: string; byKind: 'person' | 'bot' }
  /** A bot's Pages list changed (pinned, deleted, put back, or a Page's origin noted): the Pages tab reloads. */
  | { type: 'pages'; botId: string }
  /** Something worth a notification (notify.ts). Already filtered by the stream's mutes and quiet hours. */
  | { type: 'notify'; n: Notice }
  /** A notification no longer applies (an approval was answered, a chat was read); apps take it down. */
  | { type: 'notify-clear'; tags: string[] }
  | { type: 'ping' };

/** One notification (notify.ts). Same shape on every app: Android, web and Windows. */
export interface Notice {
  id: number;
  channel: 'messages' | 'approvals' | 'jobs';
  /** One per thing: a new notice with the same tag replaces the old one on every app. */
  tag: string;
  botId: string;
  /** The chat a tap opens: the bot, or the group a message was posted in. */
  title: string;
  body: string;
  /** Row to scroll to when the chat opens. */
  seq?: number;
  /** Shown with no sound or vibration (quiet hours). */
  silent?: boolean;
  /** Missed while the app was away; shown quietly. */
  catchUp?: boolean;
  /** Only on a low-risk approval card (lowRisk true): Allow and Deny right in the notification. */
  approval?: { id: string; digest: string };
  /**
   * Choice buttons (choices.ts): up to three answers as notification buttons. A tap sends the same pick the
   * chat's buttons send (POST /bots/:chat/cards/:seq/view): a chat reply, never an approval.
   */
  choices?: { seq: number; generation: number; block: string; options: string[] };
  group?: boolean;
  /** Set when it is about one of the bot's side chats: a tap opens that side chat (an older app opens the main chat). */
  chatId?: string;
  chatTitle?: string;
  /**
   * Who it is from: the bot that wrote the message (in a group, the member who posted), so apps can show
   * that bot's face. `face` is its face-centred picture (changes address when the picture changes), or
   * null for a bot with no picture, which apps draw as its initial on `color`.
   */
  sender?: NoticeFace;
  /** A group message: the group itself (its name and picture), for the conversation's own picture. */
  room?: NoticeFace;
  createdAt: number;
}

export interface NoticeFace { id: string; name: string; face: string | null; color: string }

/**
 * One of a bot's side chats (side-chats.ts): a conversation of its own with the same bot, beside its main
 * chat. Its rows, live state and cards are read and sent with `id` like any chat (/bots/<id>/rows,
 * /bots/<id>/messages, /bots/<id>/interrupt...); the bot it belongs to is `botId`.
 */
export interface SideChat {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  lastPreview: string | null;
  unread: number;
  generation: number;
  live: LiveState;
}

/** A PC paired through the Windows app (docs/remote-pc.md). */
export interface Machine {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  /** Folders shared on the PC itself; bots can't reach anything outside them. */
  folders: { name: string; path: string }[];
  /** Whether the PC's own "Allow commands" switch is on. */
  commands: boolean;
  /** Whether the PC's own "Allow screen viewing" switch is on. */
  screen: boolean;
  /** Whether the PC lets its person take control of the mouse and keyboard (needs screen viewing too). */
  control: boolean;
  /** Whether the PC's own "copy and paste" switch is on (needs taking control too). Off by default. */
  clipboard: boolean;
  /** Bots that may use this PC. */
  bots: string[];
  /** Bots that can never use any PC (blocked on the server), by id. */
  blockedBots: string[];
  /** Bot names the PC itself refuses, as the PC reports them. */
  pcBlocked: string[];
  version: string | null;
}

export interface MachineLogEntry { id: number; botId: string | null; botName: string | null; tool: string; outcome: string; detail: string | null; at: number }

/** One message to or from an outside member, with the replies it got (its page in the app). */
export interface OutsideExchange {
  id: number;
  direction: 'out' | 'in';
  botId: string | null;
  botName: string | null;
  roomId: string | null;
  type: string | null;
  text: string;
  link: string | null;
  state: string;
  error: string | null;
  createdAt: number;
  answeredAt: number | null;
  replies: { text: string; link: string | null; createdAt: number }[];
}

// ---------- Pages (pages.ts) ----------

export interface PageActor { kind: 'person' | 'bot'; id: string; name: string }
/** One block of a Page. Its content fields depend on `type` (see pages.ts `content`). */
export interface PageBlock {
  id: string;
  type: 'text' | 'heading' | 'checklist' | 'table' | 'form' | 'choice' | 'chart' | 'callout' | 'button' | 'file' | 'code' | 'toggle' | 'divider' | 'calc';
  /** The page version of this block's last change, and who made it. */
  rev: number;
  by: string;
  byKind: 'person' | 'bot';
  at: number;
  /** A person's edit that arrived after someone else changed the block, waiting to be picked. */
  alt?: { by: string; byKind: 'person' | 'bot'; at: number; fields: Record<string, unknown> };
  [field: string]: unknown;
}
export interface Page { cleftPage: 1; id: string; title: string; version: number; blocks: PageBlock[]; updatedAt: number }
/** GET /api/bots/:id/pages?path= : the Page, the chat its buttons send into (page-shelf.ts shelfInfo) and whether it is pinned. */
export interface PageAnswer extends Page { sendTo: string; sendToTitle: string; pinned: boolean }
export type PageOp = { op: string; [k: string]: any };
export interface PageOpResult { ok: boolean; id?: string; item?: string; error?: string; conflict?: boolean; current?: unknown }
/** One Page in a bot's Pages tab (page-shelf.ts). */
export interface PageShelfItem {
  path: string;
  id: string;
  title: string;
  updatedAt: number;
  version: number;
  blocks: number;
  /** What the Page is mostly for, for its icon. */
  kind: 'calculator' | 'chart' | 'form' | 'checklist' | 'table' | 'doc';
  snippet: string;
  pinned: boolean;
  /** The chat it was made in (null when nobody noted it, e.g. Pages made before the Pages tab). */
  origin: { chatId: string; chatTitle: string; kind: 'view' | 'bot' | 'person'; seq?: number } | null;
  /** The chat its buttons and calculators send into: where it came from while that chat is there, else the main chat. */
  sendTo: string;
}
export interface PageVersionInfo { version: number; by: string; byKind: 'person' | 'bot'; at: number; summary: string }

/** The field a secure input card is for (browser-cards.ts). */
export interface SecretOnCard {
  kind: 'password' | 'username' | 'email' | 'one_time_code' | 'card_number' | 'card_expiry' | 'card_cvc' | 'other' | 'service_key';
  /** "Password", "One-time code"... */
  kindLabel: string;
  /** The page's own origin (https://accounts.example.com) and its host for big type. */
  origin: string; site: string;
  /** Set when the field is inside a frame from another origin (a card iframe). */
  frameOrigin?: string;
  /** The field's label as the page shows it. */
  fieldLabel: string;
  /** What the bot said it is for (its words; shown as such). */
  why: string;
  /** Shown masked; one-time codes and usernames may be shown as typed. */
  masked: boolean;
  /** Digits only (codes, card numbers): the apps show a number pad. */
  numeric: boolean;
  /** The card offers "Save to my logins" (vault.ts): a sign-in field on a page saved logins can fill. */
  canSave?: boolean;
  /** After Fill: filled, or why not. Never the value. `saved` when it was also saved to the person's logins. */
  result?: { ok: boolean; detail: string; at: number; saved?: boolean };
}

/** A saved-login card (vault.ts, browser-cards.ts useSavedLogin). Never carries a username or password. */
export interface VaultOnCard {
  /** The page's own origin and host, read from the browser. */
  origin: string; site: string;
  /** Set when the fields are inside a frame from another origin. */
  frameOrigin?: string;
  /** The saved login: its id, the site it was saved for, its label and a username hint ("a•••@example.com"). */
  login: string; savedSite: string; label: string; userHint: string;
  /** What will be typed, and the page's own labels for those fields. */
  fields: ('username' | 'password')[]; fieldLabels: string[];
  /** Whose login it is (first name), and whether that is a scoped sign-in (only that sign-in can press Sign in). */
  owner: string; forScoped: boolean;
  /** A mail, calendar or money site: the bots use connected apps there first. */
  connectorFirst: boolean;
  /** What the bot said it is for (its words). */
  why: string;
  /** After Sign in: which fields were filled, or why not. */
  result?: { ok: boolean; detail: string; at: number };
}

/** One day on a posting plan card (posting.ts). Files are the bot's own, read by the server. */
export interface PlanDayOnCard {
  date: string;
  label: string;
  video: { path: string; name: string; size: number; ok: boolean; sha?: string } | null;
  cover: { path: string; name: string; size: number; ok: boolean } | null;
  posts: { platform: string; time: string; kind: 'post' | 'reply' | 'comment'; caption: string; title?: string }[];
  warnings: string[];
}
/** A posting plan card: days with posts; `result` once answered (the days approved). */
export interface PostingPlanOnCard {
  days: PlanDayOnCard[];
  why: string;
  /** End of the last day, epoch ms, in `tz`. */
  expires: number;
  tz: string;
  result?: { days: string[]; at: number };
}

/** A checkout as the purchase card shows it (browser-cards.ts). Everything under `page` was read from the page. */
export interface PurchaseOnCard {
  page: {
    origin: string; site: string; title: string; url: string;
    total: { amount: string; currency: string; text: string } | null;
    card: { brand: string; last4: string } | null;
    items: string[]; shipping: string; shipTo: string; recurring: string;
    controls: string[]; processors: string[];
  };
  /** What the bot said it is buying (its words). */
  botSays: { amount: string; currency: string; merchant: string; items: string[]; paymentMethod: string; recurring: boolean; why: string };
  /** Plain warnings: totals differ, nothing read, recurring charge. */
  warnings: string[];
  /** After Approve: armed (the bot may place the order within 3 minutes), or why not. */
  result?: { ok: boolean; detail: string; at: number };
}
