import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginsApi, type PluginInfo, type SwitchResult } from '../../lib/pluginsApi';

type Data = { plugins: PluginInfo[] } | null;

/**
 * A plugin's per-bot switch, as the owner flips it: applied at once (no confirm step), shown straight
 * away, then replaced by what the server read back. A short "Undo" toast puts the previous state back
 * (including "default" when it was on the plugin's default).
 */
export function usePluginSwitch<T extends Data>(setData: (f: (d: T) => T) => void, onError: (msg: string) => void,
  /** Paints the switch in a list of another shape (Connections), instead of a { plugins } list. */
  paintOther?: (pluginId: string, botId: string, enabled: boolean, fromDefault: boolean) => void) {
  const [toast, setToast] = useState<SwitchResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (r: SwitchResult | null) => {
    clearTimeout(timer.current);
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
      const r = await pluginsApi.flip(pluginId, botId, on);
      paint(pluginId, botId, r.after.enabled, r.after.fromDefault);
      show(undo ? null : r);
    } catch (e) {
      // Refused (another bot has a one-bot-only plugin) or not sent: the switch goes back to where it was.
      if (on !== null) paint(pluginId, botId, !on, false);
      onError((e as Error).message);
      show(null);
      throw e;
    } finally {
      setPending((k) => (k === key ? null : k));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = useCallback(() => {
    if (!toast) return;
    const { pluginId, botId, before } = toast;
    show(null);
    void flip(pluginId, botId, before.fromDefault ? null : before.enabled, true).catch(() => {});
  }, [toast, flip]);

  const node = toast && (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>{toast.pluginName} {toast.after.enabled ? 'on' : 'off'} for {toast.botName}</span>
      <button type="button" className="undo-toast__btn" onClick={undo}>Undo</button>
    </div>
  );
  return { flip: (pluginId: string, botId: string, on: boolean) => flip(pluginId, botId, on).catch(() => {}), pending, toast: node };
}
