import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Client, PluginInfo, PluginSwitchResult } from '../api';
import { color } from '../theme';

type Data = { plugins: PluginInfo[] } | null;

/**
 * A plugin's per-bot switch, as the owner flips it (same as the web and Windows apps): applied at
 * once with no confirm step, shown straight away, then replaced by what the server read back. A
 * short Undo bar puts the previous state back, including "default".
 * `floating`: a bar pinned to the bottom of the screen; otherwise it sits where `toast` is placed.
 */
export function usePluginSwitch<T extends Data>(api: Client, setData: (f: (d: T) => T) => void, onError: (msg: string) => void, floating = true,
  /** Paints the switch in a list of another shape (Connections), instead of a { plugins } list. */
  paintOther?: (pluginId: string, botId: string, enabled: boolean, fromDefault: boolean) => void) {
  const [toast, setToast] = useState<PluginSwitchResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = (r: PluginSwitchResult | null) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(r);
    if (r) timer.current = setTimeout(() => setToast(null), 6000);
  };
  const paint = (pluginId: string, botId: string, enabled: boolean, fromDefault: boolean) => paintOther ? paintOther(pluginId, botId, enabled, fromDefault) :
    setData((d) => (d ? { ...d, plugins: d.plugins.map((p) => (p.id !== pluginId ? p : { ...p, bots: p.bots.map((b) => (b.id === botId ? { ...b, enabled, fromDefault } : b)) })) } : d));

  const flip = useCallback(async (pluginId: string, botId: string, on: boolean | null, undo = false) => {
    const key = `${pluginId}:${botId}`;
    setPending(key);
    if (on !== null) paint(pluginId, botId, on, false);
    try {
      const r = await api.flipPlugin(pluginId, botId, on);
      paint(pluginId, botId, r.after.enabled, r.after.fromDefault);
      show(undo ? null : r);
    } catch (e: any) {
      onError(e?.message ?? 'Couldn’t change that.');
      show(null);
      throw e;
    } finally {
      setPending((k) => (k === key ? null : k));
    }
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = () => {
    if (!toast) return;
    const { pluginId, botId, before } = toast;
    show(null);
    flip(pluginId, botId, before.fromDefault ? null : before.enabled, true).catch(() => {});
  };

  const node = toast ? (
    <View accessibilityLiveRegion="polite" pointerEvents="box-none"
      style={floating ? { position: 'absolute', left: 16, right: 16, bottom: 24, alignItems: 'center' } : { marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: color.primary, borderRadius: 999, paddingLeft: 18, paddingRight: 6, paddingVertical: 6, maxWidth: '100%', elevation: 6 }}>
        <Text numberOfLines={1} style={{ color: color.onPrimary, fontSize: 15, flexShrink: 1 }}>{toast.pluginName} {toast.after.enabled ? 'on' : 'off'} for {toast.botName}</Text>
        <Pressable onPress={undo} accessibilityRole="button" accessibilityLabel="Undo" hitSlop={8}
          style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: pressed ? 'rgba(255,255,255,0.18)' : 'transparent' })}>
          <Text style={{ color: color.onPrimary, fontSize: 15, fontWeight: '700' }}>Undo</Text>
        </Pressable>
      </View>
    </View>
  ) : null;
  return { flip: (pluginId: string, botId: string, on: boolean) => { flip(pluginId, botId, on).catch(() => {}); }, pending, toast: node };
}
