// Which addresses a message may link to or show as a picture. Pure functions with no imports, used by the
// server and the web app (via @shared). The Android app already shows pictures as links and opens only
// web links (mobile/src/components/Markdown.tsx safeUrl).

/** The address when it is an ordinary web link (http or https), else null: never javascript:, data: and the like. */
export function safeLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/**
 * Whether a picture in a message may load on its own. Only this app's own pictures (a path on this server)
 * and pictures already in the message (data: or blob:) do; a picture on another site waits for a tap,
 * since loading it would tell that site whatever the address carries.
 */
export function loadsOnItsOwn(src: unknown): boolean {
  if (typeof src !== 'string' || !src) return false;
  if (/^data:image\//i.test(src) || /^blob:/i.test(src)) return true;
  return src.startsWith('/') && !src.startsWith('//');
}
