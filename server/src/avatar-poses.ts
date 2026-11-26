// Picture styles, the pose set made from a bot's picture, and which pose shows when.
// Shared by the server and the web app (the web imports it through @shared); the phone app keeps a
// copy of poseFor in mobile/src/poses.ts.

import type { ActivityKind } from './types.js';

export type AvatarPose =
  | 'idle' | 'listening' | 'thinking' | 'talking' | 'working' | 'searching'
  | 'waiting' | 'happy' | 'celebrating' | 'sleeping' | 'oops';

/** Every pose, in the order they are made (idle first: it is the one shown most). */
export const AVATAR_POSES: { id: AvatarPose; label: string; prompt: string }[] = [
  { id: 'idle', label: 'Idle', prompt: 'calm and relaxed, a gentle smile, facing the viewer' },
  { id: 'listening', label: 'Listening', prompt: 'leaning in slightly and listening closely, attentive interested eyes, one hand cupped near the ear' },
  { id: 'thinking', label: 'Thinking', prompt: 'thinking, eyes looking up, a finger on the chin' },
  { id: 'talking', label: 'Talking', prompt: 'talking mid-sentence, mouth open, a friendly open-hand gesture' },
  { id: 'working', label: 'Working', prompt: 'focused and busy, typing on a small laptop' },
  { id: 'searching', label: 'Searching', prompt: 'searching for something, holding a magnifying glass, curious look' },
  { id: 'waiting', label: 'Waiting on you', prompt: 'looking at the viewer expectantly, head tilted, a small questioning smile' },
  { id: 'happy', label: 'Done', prompt: 'a big warm smile, giving a thumbs up' },
  { id: 'celebrating', label: 'Celebrating', prompt: 'celebrating with both arms raised, a little confetti around' },
  { id: 'sleeping', label: 'Resting', prompt: 'eyes closed, peacefully dozing' },
  { id: 'oops', label: 'Oops', prompt: 'a sheepish apologetic expression, one hand behind the head' },
];

export const POSE_IDS = AVATAR_POSES.map((p) => p.id);
export const isPose = (v: unknown): v is AvatarPose => typeof v === 'string' && (POSE_IDS as string[]).includes(v);

/** Picture styles offered when making a look. */
export const AVATAR_STYLES: { id: string; label: string; prompt: string }[] = [
  { id: 'illustrated', label: 'Illustrated', prompt: 'flat illustrated character, clean shapes, soft shading' },
  { id: 'clay', label: '3D clay', prompt: '3D clay render, soft studio light' },
  { id: 'plush', label: 'Plush toy', prompt: 'soft plush toy, fuzzy fabric, stitched details, soft studio light' },
  { id: 'cartoon-3d', label: '3D cartoon', prompt: 'polished 3D animated-film character, soft lighting' },
  { id: 'anime', label: 'Anime', prompt: 'anime illustration, clean line art, cel shading' },
  { id: 'watercolor', label: 'Watercolour', prompt: 'loose watercolour illustration, soft paper texture' },
  { id: 'sticker', label: 'Sticker', prompt: 'die-cut sticker, bold outline, bright flat colours' },
  { id: 'pixel', label: 'Pixel', prompt: 'pixel art, limited palette' },
  { id: 'low-poly', label: 'Low-poly', prompt: 'low-poly 3D model, faceted surfaces' },
  { id: 'paper', label: 'Paper cut', prompt: 'layered paper-cut craft, soft shadows' },
  { id: 'line-art', label: 'Line art', prompt: 'simple line art, one colour on white' },
  { id: 'photo', label: 'Photo-real', prompt: 'photo-realistic portrait' },
];

export const styleById = (id?: string | null) => AVATAR_STYLES.find((s) => s.id === id);

/** One-tap follow-ups offered after a new look is chosen. */
export const LOOK_SUGGESTIONS = [
  'Add a hat', 'Give me glasses', 'Make me a plush toy', 'Try a different style',
  'Make me more colourful', 'Zoom in so my face is bigger', 'Add a little scarf',
];

export interface PoseInput {
  now: number;
  /** A voice call with this bot: what is happening on it. */
  voice?: 'speaking' | 'listening' | 'thinking' | 'working' | 'connecting' | null;
  running?: boolean;
  activity?: ActivityKind | null;
  awaiting?: boolean;
  /** When the last turn ended (ms), to show "done" for a moment. */
  finishedAt?: number | null;
  /** The last turn ended badly. */
  failed?: boolean;
  /** Show the celebration until then (a new look was just chosen). */
  celebrateUntil?: number | null;
  /** Last time anything happened in this chat. */
  lastActivityAt?: number | null;
}

const SEARCHING: ActivityKind[] = ['searching_web', 'reading_web', 'browsing_web'];
const DONE_MS = 8_000;
const SLEEP_MS = 6 * 3600_000;

/** Which pose a bot shows right now. */
export function poseFor(s: PoseInput): AvatarPose {
  if (s.celebrateUntil && s.now < s.celebrateUntil) return 'celebrating';
  if (s.voice === 'speaking') return 'talking';
  if (s.voice === 'listening') return 'listening';
  if (s.voice === 'thinking' || s.voice === 'connecting') return 'thinking';
  if (s.voice === 'working') return 'working';
  if (s.awaiting || s.activity === 'waiting_for_you') return 'waiting';
  if (s.running) {
    if (!s.activity || s.activity === 'thinking') return 'thinking';
    if (SEARCHING.includes(s.activity)) return 'searching';
    return 'working';
  }
  if (s.finishedAt && s.now - s.finishedAt < DONE_MS) return s.failed ? 'oops' : 'happy';
  if (s.lastActivityAt && s.now - s.lastActivityAt > SLEEP_MS) return 'sleeping';
  return 'idle';
}
