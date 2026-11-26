import * as Clipboard from 'expo-clipboard';
import type { Client } from './api';

/**
 * Copy and paste between the phone and a bot's screen or a paired PC (docs/remote-pc.md, "Copy and paste"),
 * when the person taps "Paste from phone" or "Copy to phone" in the screen's touch bar. Text only, at most
 * 256 KB, never in the background. The server (and a PC itself) checks again.
 */
export type ClipTarget = { kind: 'bot' | 'pc'; id: string; name: string };
const MAX_BYTES = 256 * 1024;

/** Runs one action; tells the page to press Ctrl+V after a paste, and what to show. */
export async function runClip(api: Client, target: ClipTarget, action: 'paste' | 'copy', toPage: (m: object) => void) {
  toPage({ t: 'clipBusy', on: true });
  try {
    if (action === 'paste') {
      const text = await Clipboard.getStringAsync();
      if (!text) { toPage({ t: 'note', text: 'Nothing to paste: the phone’s clipboard is empty.' }); return; }
      if (new TextEncoder().encode(text).length > MAX_BYTES) { toPage({ t: 'note', text: 'That is too much to paste at once (256 KB at most).' }); return; }
      await api.setClipboard(target.kind, target.id, text);
      toPage({ t: 'ctrlV' });
      toPage({ t: 'note', text: `Pasted on ${target.name}` });
    } else {
      const r = await api.getClipboard(target.kind, target.id);
      const text = r.text ?? '';
      if (!text) { toPage({ t: 'note', text: `Nothing is copied on ${target.name} yet. Select something and use Ctrl+C there first.` }); return; }
      await Clipboard.setStringAsync(text);
      toPage({ t: 'note', text: `Copied ${text.length.toLocaleString()} character${text.length === 1 ? '' : 's'} to the phone${r.cut ? ' (cut at 256 KB)' : ''}` });
    }
  } catch (e) {
    toPage({ t: 'note', text: (e as Error).message || 'Copy and paste failed.' });
  } finally {
    toPage({ t: 'clipBusy', on: false });
  }
}
