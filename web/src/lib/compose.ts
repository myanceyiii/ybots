/**
 * Put words in a chat's message box from elsewhere on the page (one-tap ideas, ask links).
 * The composer listens for this and fills its box for that chat; nothing is ever sent by itself.
 */
export const COMPOSE_EVENT = 'cleft:compose';
export type ComposeDetail = { botId: string; text: string };
export function composeInto(botId: string, text: string) {
  window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { botId, text } }));
}

/**
 * "Talk to a Bot" (the Windows app's Talk shortcut, a `/?talk` link; the phone's assistant gesture on Android):
 * open the Bot's chat and start dictation in its message box. Kept until that chat's composer is on screen.
 * Nothing is sent by itself.
 */
export const LISTEN_EVENT = 'cleft:listen';
let pendingListen: string | null = null;
export function listenIn(botId: string) {
  pendingListen = botId;
  window.dispatchEvent(new CustomEvent<string>(LISTEN_EVENT, { detail: botId }));
}
/** True once for the Bot whose composer should start dictating now. */
export function takeListen(botId: string): boolean {
  if (pendingListen !== botId) return false;
  pendingListen = null;
  return true;
}
