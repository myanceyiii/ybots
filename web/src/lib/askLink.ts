import { composeInto } from './compose';

/**
 * A link that opens the app with words ready in the message box: `/?ask=<words>` (the phone apps take
 * `cleftbot://ask?text=…`). For a bookmark or a home-screen shortcut such as "Add to the grocery list: ".
 * The words are only placed in the box of the chat that opens; nothing is sent. The link is tidied
 * from the address bar so a reload does not put them back.
 */
let pending: string | null | undefined;
function read(): string | null {
  if (pending !== undefined) return pending;
  pending = null;
  try {
    const u = new URL(window.location.href);
    const ask = u.searchParams.get('ask');
    if (ask !== null) {
      pending = ask.slice(0, 8000) || null;
      u.searchParams.delete('ask');
      window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    }
  } catch { /* no address to read */ }
  return pending;
}
/** Call when a chat is on screen: fills its message box once with the words from the link, if any. */
export function applyAskLink(chatId: string) {
  const text = read();
  if (!text) return;
  pending = null;
  // After the composer for this chat has mounted and is listening.
  window.setTimeout(() => composeInto(chatId, text), 150);
}
