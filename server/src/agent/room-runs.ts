import { newId } from '../lib/ids.js';
import { appendRow, getLive, onLive, setLive } from '../store.js';
import type { LiveModel, LiveState } from '../types.js';

/**
 * What a group chat is doing right now.
 *
 * A group has no turn of its own: a message in it becomes one turn for each member that answers
 * (rooms.ts). This keeps a list of those member turns per group, from the moment they are queued
 * until they finish, so the group can show who is working and Stop can end them all, or one.
 *
 * The group's live state (store.ts) is the sum of its members' turns: running while any is queued
 * or working, with each member's state in `members`. The apps show Stop from `isRunning`, exactly as
 * in a one-Bot chat, and POST /bots/:roomId/interrupt lands in stopRoom() below.
 *
 * Stopping a member's turn is the same as pressing Stop in its own chat (loop.ts interrupt): its open
 * approval cards expire and the engine call is aborted; whatever it already posted stays. A queued
 * member turn that was stopped never starts. Other turns the member has queued (its own chat, a
 * routine, another group) are left alone, unless the member is busy with one of those right now,
 * in which case only the group turn behind it is dropped.
 */

export type MemberRunState = NonNullable<LiveState['members']>[number]['state'];

interface Entry { run: string; botId: string; name: string; state: 'queued' | 'working'; since: number }

const byRoom = new Map<string, Entry[]>();

export const newRun = () => newId('run');

/** A member turn was queued for a group message. */
export function queued(roomId: string, run: string, botId: string, name: string) {
  const list = byRoom.get(roomId) ?? [];
  list.push({ run, botId, name, state: 'queued', since: Date.now() });
  byRoom.set(roomId, list);
  publish(roomId);
}

/** The member's queue reached this group turn. False when it was stopped while queued: skip the turn. */
export function starting(roomId: string, run: string, botId: string): boolean {
  const e = byRoom.get(roomId)?.find((x) => x.run === run && x.botId === botId);
  if (!e) return false;
  e.state = 'working';
  e.since = Date.now();
  publish(roomId);
  return true;
}

/** The member's group turn ended (answered, stayed silent, failed or was stopped). */
export function finished(roomId: string, run: string, botId: string) {
  const list = byRoom.get(roomId);
  if (!list) return;
  const i = list.findIndex((x) => x.run === run && x.botId === botId);
  if (i < 0) return;
  list.splice(i, 1);
  if (!list.length) byRoom.delete(roomId);
  publish(roomId);
}

/**
 * Stop the group's member turns: all of them, or one member's. `interrupt` is loop.ts's, for a turn
 * that is running now. Returns the names stopped (empty: nothing was running or queued).
 */
export function stopRoom(roomId: string, interrupt: (botId: string) => void, opts: { only?: string; quiet?: boolean } = {}): string[] {
  const onlyBotId = opts.only;
  const list = byRoom.get(roomId) ?? [];
  const hit = list.filter((e) => !onlyBotId || e.botId === onlyBotId);
  if (!hit.length) return [];
  // Dropped first, so a queued turn finds nothing at start and the group is free for the next message at once.
  byRoom.set(roomId, list.filter((e) => !hit.includes(e)));
  if (!byRoom.get(roomId)!.length) byRoom.delete(roomId);
  for (const e of hit) if (e.state === 'working') interrupt(e.botId);
  publish(roomId);
  const names = [...new Set(hit.map((e) => e.name))];
  if (!opts.quiet) appendRow(roomId, 'notice', { type: 'notice', text: onlyBotId ? `Stopped ${joinNames(names)}.` : 'Stopped.', tone: 'info' });
  return names;
}

/** The group whose turn a member is working on right now, if any. */
export function workingRoomOf(botId: string): string | null {
  for (const [roomId, list] of byRoom) if (list.some((e) => e.botId === botId && e.state === 'working')) return roomId;
  return null;
}

/** The group run a member is working on in this group right now, if any. */
export function workingRunOf(botId: string, roomId: string): string | null {
  return byRoom.get(roomId)?.find((e) => e.botId === botId && e.state === 'working')?.run ?? null;
}

/** For tests. */
export const roomRunState = (roomId: string) => (byRoom.get(roomId) ?? []).map((e) => ({ ...e }));

function joinNames(n: string[]) {
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

function memberState(e: Entry): MemberRunState {
  if (e.state === 'queued') return 'queued';
  return getLive(e.botId).awaiting ? 'waiting' : 'working';
}

function publish(roomId: string) {
  const list = byRoom.get(roomId) ?? [];
  if (!list.length) {
    setLive(roomId, { isRunning: false, activity: null, awaiting: null, startedAt: null, caption: null, captionFull: null, steps: 0, members: [] });
    return;
  }
  // One row per member, its most advanced state first (a member can have several group messages queued).
  const order: Record<MemberRunState, number> = { waiting: 0, working: 1, queued: 2 };
  const seen = new Map<string, { id: string; name: string; state: MemberRunState; since: number; model: LiveModel | null }>();
  for (const e of list) {
    const s = memberState(e);
    const had = seen.get(e.botId);
    // The member's own model badge (model-badge.ts), shown on its picture in the group's live rows.
    if (!had || order[s] < order[had.state]) seen.set(e.botId, { id: e.botId, name: e.name, state: s, since: e.since, model: s === 'working' ? getLive(e.botId).model ?? null : null });
  }
  const members = [...seen.values()];
  const anyWorking = members.some((m) => m.state !== 'queued');
  const allWaiting = members.every((m) => m.state === 'waiting');
  const startedAt = Math.min(...list.map((e) => e.since));
  setLive(roomId, {
    isRunning: true,
    activity: { kind: allWaiting ? 'waiting_for_you' : anyWorking ? 'working' : 'thinking', since: startedAt },
    // The group itself never waits for an answer here: its members' cards are in their own chats.
    awaiting: null,
    startedAt,
    caption: null,
    captionFull: null,
    members,
  });
}

// A member's own live state changed (it started waiting for an approval, say): refresh its groups.
onLive((botId) => {
  for (const [roomId, list] of byRoom) if (list.some((e) => e.botId === botId)) publish(roomId);
});
