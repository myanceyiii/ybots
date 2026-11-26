import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { color, type } from '../theme';

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|private[_-]?key/i;

/** The exact arguments the action will run with, as readable JSON; values under secret-sounding names are hidden (same as the web card). */
export function argsText(args: unknown): string {
  return JSON.stringify(args, (k, v) => (k && SECRET_KEY.test(k) && v !== null && v !== '' ? '•••• (hidden)' : v), 2) ?? '';
}

/** "Show every detail" on an approval card: the summary leaves out long text and extra fields; this shows the whole call. */
export function ArgsDetails({ args }: { args: unknown }) {
  const [open, setOpen] = useState(false);
  if (args === undefined || args === null || (typeof args === 'object' && !Object.keys(args as object).length)) return null;
  return (
    <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} hitSlop={8}>
        <Text style={[type.caption, { color: color.inkSecondary, textDecorationLine: 'underline' }]}>{open ? 'Hide the full details' : 'Show every detail of this action'}</Text>
      </Pressable>
      {open && (
        <ScrollView style={{ maxHeight: 320, backgroundColor: color.surface, borderRadius: 12 }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 17, color: color.ink }}>{argsText(args)}</Text>
        </ScrollView>
      )}
    </View>
  );
}
