import { Hono } from 'hono';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';
import { createRoom, eligibleMembers, roomMembers, RoomError } from './agent/rooms.js';

/** /api/rooms: group chat membership. A room is a bot row with kind='room'. */
export const roomsApi = new Hono<AuthVars>();
roomsApi.use('*', requireUser);

const ownRoom = (userId: string, id: string) =>
  db.prepare("SELECT * FROM bots WHERE id=? AND user_id=? AND kind='room'").get(id, userId) as any;

roomsApi.get('/:id/members', (c) => {
  const room = ownRoom(c.get('user').id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const members = roomMembers(room.id).map((m) => {
    const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(m.id) as any;
    return { id: b.id, name: b.name, label: b.label, avatarShape: b.avatar_shape, avatarColor: b.avatar_color };
  });
  return c.json({ members });
});

/** Create a group from the UI: { name, botIds[] }. */
roomsApi.post('/', async (c) => {
  const user = c.get('user');
  const { name, botIds } = await c.req.json<{ name: unknown; botIds: unknown }>().catch(() => ({ name: '', botIds: [] as unknown }));
  // A siloed or hidden bot is left out of every new group (eligibleMembers).
  if (typeof name !== 'string' || !name.trim() || eligibleMembers(user.id, botIds).length < 2) return c.json({ error: 'A group needs a name and at least 2 Bots.' }, 400);
  try {
    return c.json({ id: createRoom(user.id, name.trim().slice(0, 60), botIds as string[]) });
  } catch (e) {
    if (e instanceof RoomError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

roomsApi.put('/:id/members', async (c) => {
  const user = c.get('user');
  const room = ownRoom(user.id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const { botIds } = await c.req.json<{ botIds: unknown }>().catch(() => ({ botIds: null as unknown }));
  if (!Array.isArray(botIds) || botIds.some((id) => typeof id !== 'string')) return c.json({ error: 'botIds must be a list of Bot ids.' }, 400);
  const before = new Set(roomMembers(room.id).map((m) => m.id));
  // Same rule as a new group, except a member already in it stays even if it was hidden since.
  const next = eligibleMembers(user.id, botIds, before);
  // A group with one Bot is just that Bot's chat, and with none nobody answers.
  if (next.length < 2) return c.json({ error: 'A group needs at least 2 Bots. Delete the group if you no longer want it.' }, 400);
  // The count line is only a stand-in: an About the person wrote for the group is kept.
  const about = /^Group chat with \d+ Bots$/.test(String(room.description ?? '').trim()) || !String(room.description ?? '').trim() ? `Group chat with ${next.length} Bots` : room.description;
  db.prepare('UPDATE bots SET members=?, description=?, updated_at=? WHERE id=?').run(JSON.stringify(next), about, now(), room.id);
  const name = (id: string) => (db.prepare('SELECT name FROM bots WHERE id=?').get(id) as any)?.name ?? id;
  const added = next.filter((id) => !before.has(id)).map(name);
  const removed = [...before].filter((id) => !next.includes(id)).map(name);
  if (added.length || removed.length) {
    appendRow(room.id, 'event', { type: 'event', event: 'bot-message', text: [added.length ? `${added.join(', ')} joined` : '', removed.length ? `${removed.join(', ')} left` : ''].filter(Boolean).join(' · ') });
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true, members: next });
});
