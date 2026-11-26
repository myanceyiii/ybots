import { useState } from 'react';

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|private[_-]?key/i;

/** The exact arguments the action will run with, as readable JSON; values under secret-sounding names are hidden. */
export function argsText(args: unknown): string {
  return JSON.stringify(args, (k, v) => (k && SECRET_KEY.test(k) && v !== null && v !== '' ? '•••• (hidden)' : v), 2) ?? '';
}

/**
 * "Show every detail" on an approval card: the short summary above it leaves out long text, extra fields
 * and deep lists, so the whole call is one tap away before anything is allowed (audit G16).
 */
export function ArgsDetails({ args }: { args: unknown }) {
  const [open, setOpen] = useState(false);
  if (args === undefined || args === null || (typeof args === 'object' && !Object.keys(args as object).length)) return null;
  return (
    <div className="card__body args-details">
      <button type="button" className="link-btn link-btn--small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide the full details' : 'Show every detail of this action'}
      </button>
      {open && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0', fontSize: 12, maxHeight: 360, overflow: 'auto' }}>{argsText(args)}</pre>}
    </div>
  );
}
