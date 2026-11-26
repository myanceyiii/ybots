import { create } from 'zustand';
import { lsGet, lsSet } from './storage';
import { useStore } from '../store';

/**
 * What is typed in each chat's message box and not sent yet. Kept in this browser per account, so a
 * reload, a restart of the Windows app or a closed tab does not lose it.
 */
export interface Draft { text: string; sending: boolean }
export const emptyDraft: Draft = { text: '', sending: false };
export const useDrafts = create<Record<string, Draft>>(() => ({}));

const KEY = () => `drafts.${useStore.getState().user?.id ?? 'none'}`;
let timer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const texts: Record<string, string> = {};
    for (const [id, d] of Object.entries(useDrafts.getState())) if (d.text.trim()) texts[id] = d.text.slice(0, 20_000);
    lsSet(KEY(), JSON.stringify(texts));
  }, 300);
};

export function updateDraft(id: string, update: (old: Draft) => Draft) {
  useDrafts.setState((drafts) => {
    const draft = update(drafts[id] ?? emptyDraft);
    if (draft.text || draft.sending) return { ...drafts, [id]: draft };
    const next = { ...drafts };
    delete next[id];
    return next;
  }, true);
  save();
}

/** The drafts this account left in this browser. */
export function restoreDrafts() {
  try {
    const texts = JSON.parse(lsGet(KEY()) ?? '{}') as Record<string, string>;
    const next: Record<string, Draft> = {};
    for (const [id, text] of Object.entries(texts ?? {})) if (typeof text === 'string' && text) next[id] = { text, sending: false };
    useDrafts.setState({ ...next, ...useDrafts.getState() }, true);
  } catch { /* nothing saved */ }
}

// Drafts belong to the account they were typed in.
if (typeof window !== 'undefined') window.addEventListener('cleftbot:account-changed', () => useDrafts.setState({}, true));
