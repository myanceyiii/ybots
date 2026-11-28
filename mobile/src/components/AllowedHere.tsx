import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Client, Row } from '../api';
import { allowedHere, allowedHereLine } from '../allowedHere';
import { color } from '../theme';
import { Icon } from './Icon';

/**
 * "Allow for this conversation" (server/src/conversation-allows.ts) on Android: one quiet line above the
 * message box saying what this conversation allows without asking, with Turn off. The same line as the web
 * and Windows apps (web/src/components/AllowedHere.tsx); it ends by itself with a new conversation.
 */
export function AllowedHere({ api, chatId, rows }: { api: Client; chatId: string; rows: Row[] }) {
  const list = useMemo(() => allowedHere(rows as any), [rows]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!list.length) return null;
  const off = async () => {
    setBusy(true); setError(null);
    try { await api.turnOffAllowedHere(chatId); }
    catch (e: any) { setError(e?.message ?? 'That didn’t go through'); }
    finally { setBusy(false); }
  };
  return (
    <View style={{ marginHorizontal: 16, marginTop: 6 }}>
      <View accessibilityRole="summary" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 12, paddingRight: 4, borderRadius: 18, backgroundColor: color.fill }}>
        <Icon name="check" size={14} color={color.inkMuted} />
        <Text numberOfLines={2} style={{ flex: 1, fontSize: 13, color: color.inkSecondary }}>{allowedHereLine(list)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Turn off what this conversation allows" disabled={busy} onPress={off} hitSlop={8}
          style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: pressed ? color.pressed : 'transparent', opacity: busy ? 0.5 : 1 })}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: color.primary }}>Turn off</Text>
        </Pressable>
      </View>
      {error && <Text style={{ fontSize: 12, color: color.danger, marginTop: 4, marginLeft: 12 }}>{error}</Text>}
    </View>
  );
}
