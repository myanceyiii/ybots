/**
 * Page changes from the server's live stream (App.tsx forwards `page` events here), so an open Page
 * reloads when the bot or another device changes it, without a second connection.
 */
export interface PageEvent { type: 'page'; botId: string; path: string; version: number; by: string; byKind: 'person' | 'bot' }
const listeners = new Set<(ev: PageEvent) => void>();
export const onPageEvent = (fn: (ev: PageEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const emitPageEvent = (ev: PageEvent) => { for (const fn of listeners) { try { fn(ev); } catch { /* ignore */ } } };

/** A bot's Pages list changed (pinned, deleted, put back): App.tsx forwards `pages` events here for the Pages screen. */
export interface PagesEvent { type: 'pages'; botId: string }
const listListeners = new Set<(ev: PagesEvent) => void>();
export const onPagesEvent = (fn: (ev: PagesEvent) => void) => { listListeners.add(fn); return () => { listListeners.delete(fn); }; };
export const emitPagesEvent = (ev: PagesEvent) => { for (const fn of listListeners) { try { fn(ev); } catch { /* ignore */ } } };
