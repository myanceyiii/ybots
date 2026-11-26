/** Keyboard hints in this device's own words: ⌘ on a Mac, Ctrl everywhere else (Windows app included). */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
/** "⌘K" on a Mac, "Ctrl+K" elsewhere. `shift` adds ⇧ / Shift+, `alt` adds ⌥ / Alt+. */
export function keyHint(key: string, opts: { shift?: boolean; alt?: boolean; mod?: boolean } = {}): string {
  const mod = opts.mod !== false;
  if (isMac) return `${opts.alt ? '⌥' : ''}${opts.shift ? '⇧' : ''}${mod ? '⌘' : ''}${key}`;
  return `${mod ? 'Ctrl+' : ''}${opts.alt ? 'Alt+' : ''}${opts.shift ? 'Shift+' : ''}${key}`;
}
