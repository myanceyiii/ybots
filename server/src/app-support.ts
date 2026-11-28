// Which installed apps this server still works with (docs/api-contract.md). An app older than its minimum
// shows "Update YBots" instead of failing in ways that are hard to understand. No imports: the web app reads
// it as @shared/app-support and the Android app keeps a word-for-word copy (mobile/src/appSupport.ts).
//
// Raise a minimum only when a change really needs it, and say why beside it. Never lower one.

/** Bumped only for a change that cannot go beside the old (none so far). */
export const API_VERSION = 1;

export const MIN_APP = {
  // 0.1.53: approval cards must send their digest (the 2026-11-23 audit); older phones cannot answer them.
  android: '0.1.53',
  // 0.7.3: the same audit's digest rule for the Windows app's own pages.
  windows: '0.7.3',
} as const;

export type AppPlatform = keyof typeof MIN_APP;

/** True when version `v` (x.y.z) is older than `min`. A version that cannot be read is never called old. */
export function versionBelow(v: string | null | undefined, min: string): boolean {
  const parse = (s: string) => (/^\d+(\.\d+){0,3}$/.test(s) ? s.split('.').map(Number) : null);
  const a = v ? parse(v.trim()) : null, b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The Windows app's version from its browser's user agent ("... YBots/0.13.1 Chrome/... Electron/..."), else null. */
export function desktopVersion(userAgent: string | null | undefined): string | null {
  const m = /\/(\d+\.\d+\.\d+) Chrome\/[\d.]+ Electron\//.exec(userAgent ?? '');
  return m ? m[1] : null;
}
