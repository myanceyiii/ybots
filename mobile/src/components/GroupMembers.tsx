import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { Bot, Client } from '../api';
import { color, type } from '../theme';
import { BotPicker, groupable } from './BotPicker';
import { Notice } from './ui';

/**
 * A group's members (Settings > Members): tick a bot to add it, untick to take it out. Each tap saves,
 * like the web app's Members card, and a group keeps at least 2 bots.
 */
export function GroupMembers({ api, room, bots }: { api: Client; room: Bot; bots: Bot[] }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.roomMembers(room.id).then((r) => setIds(r.members.map((m) => m.id))).catch((e) => setError(e?.message ?? 'Could not load the members.'));
  }, [api, room.id]);
  useEffect(load, [load]);

  const toggle = async (id: string) => {
    if (!ids) return;
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    if (next.length < 2) { setError('A group needs at least 2 bots. Add another before taking this one out.'); return; }
    setBusy(true); setError(null); setIds(next);
    try { setIds((await api.setRoomMembers(room.id, next)).members); }
    catch (e: any) { setError(e?.message ?? 'Could not change the members.'); load(); }
    finally { setBusy(false); }
  };

  if (!ids) return error ? <Notice tone="problem">{error}</Notice> : <View style={{ padding: 24 }}><ActivityIndicator color={color.ink} /></View>;
  return (
    <View>
      {error && <View style={{ marginBottom: 12 }}><Notice tone="problem">{error}</Notice></View>}
      <BotPicker api={api} bots={groupable(bots, ids)} picked={ids} onToggle={toggle} disabled={busy} />
      <Text style={[type.caption, { fontSize: 13, marginTop: 8, marginHorizontal: 4 }]}>
        {ids.length} bots in this group. @name a bot to ask just them; otherwise the group answers.
      </Text>
    </View>
  );
}
