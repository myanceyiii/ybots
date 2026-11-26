import { create } from 'zustand';
import type { ReplyTarget } from '@shared/message-text';

/** The message each chat's composer is replying to, set by a bubble's Reply button. */
export const useReply = create<{ to: Record<string, ReplyTarget | undefined>; set(botId: string, to: ReplyTarget | undefined): void }>((set) => ({
  to: {},
  set: (botId, to) => set((s) => ({ to: { ...s.to, [botId]: to } })),
}));

/** The message of yours each chat's composer is editing, set by a bubble's Edit button. */
export interface EditTarget { seq: number; text: string }
export const useEdit = create<{ of: Record<string, EditTarget | undefined>; set(botId: string, of: EditTarget | undefined): void }>((set) => ({
  of: {},
  set: (botId, of) => set((s) => ({ of: { ...s.of, [botId]: of } })),
}));
