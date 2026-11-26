// A copy of the server's pose rules (server/src/avatar-poses.ts): which pose a bot shows now.
// Keep the two in step.

export type AvatarPose =
  | 'idle' | 'listening' | 'thinking' | 'talking' | 'working' | 'searching'
  | 'waiting' | 'happy' | 'celebrating' | 'sleeping' | 'oops';

export const POSE_LABELS: [AvatarPose, string][] = [
  ['idle', 'Idle'], ['listening', 'Listening'], ['thinking', 'Thinking'], ['talking', 'Talking'], ['working', 'Working'],
  ['searching', 'Searching'], ['waiting', 'Waiting on you'], ['happy', 'Done'], ['celebrating', 'Celebrating'], ['sleeping', 'Resting'], ['oops', 'Oops'],
];

export interface LiveState {
  botId: string; isRunning: boolean; activity: { kind: string; detail?: string; since?: number } | null; awaiting: unknown | null;
  /** When the current turn began, a short line from the model's live reasoning, and tool calls so far. */
  startedAt?: number | null; caption?: string | null; steps?: number;
  /** The whole thought behind `caption` (server/src/caption.ts), shown when the thinking bubble is expanded. */
  captionFull?: string | null;
  /** A group chat's members answering it right now (server/src/agent/room-runs.ts). */
  members?: { id: string; name: string; state: 'queued' | 'working' | 'waiting'; since: number; model?: LiveModel | null }[];
  /** The model answering this turn and its effort (server/src/model-badge.ts), shown on the picture while it works. */
  model?: LiveModel | null;
}

/** Same shape as the server's LiveModel (server/src/types.ts). */
export interface LiveModel {
  id: string | null; provider: string | null; effort: 'low' | 'medium' | 'high' | 'xhigh';
  tier: 'light' | 'standard' | 'heavy' | null; mode: 'manual' | 'auto'; fallback: boolean; short: string; name: string;
}

const SEARCHING = ['searching_web', 'reading_web', 'browsing_web'];
const DONE_MS = 8_000;
const SLEEP_MS = 6 * 3600_000;

export function poseFor(s: { now: number; running?: boolean; activity?: string | null; awaiting?: boolean; finishedAt?: number | null; celebrateUntil?: number | null; lastActivityAt?: number | null }): AvatarPose {
  if (s.celebrateUntil && s.now < s.celebrateUntil) return 'celebrating';
  if (s.awaiting || s.activity === 'waiting_for_you') return 'waiting';
  if (s.running) {
    if (!s.activity || s.activity === 'thinking') return 'thinking';
    if (SEARCHING.includes(s.activity)) return 'searching';
    return 'working';
  }
  if (s.finishedAt && s.now - s.finishedAt < DONE_MS) return 'happy';
  if (s.lastActivityAt && s.now - s.lastActivityAt > SLEEP_MS) return 'sleeping';
  return 'idle';
}

/** The server's activity kinds (ActivityKind in server/src/types.ts), in words. */
export const ACTIVITY_LABEL: Record<string, string> = {
  thinking: 'Thinking', working: 'Working', searching_web: 'Searching the web', reading_web: 'Reading a page',
  browsing_web: 'Browsing', on_its_computer: 'Using its computer', running_commands: 'Running commands',
  waiting_on_command: 'Waiting on a command', messaging_named: 'Messaging', connecting_service: 'Connecting a service',
  waiting_for_you: 'Waiting on you', drafting_file: 'Writing a file', remembering: 'Remembering',
};

