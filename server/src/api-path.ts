// Turns a contract call's name (server/src/api-contract.ts) into its method and address, so no app writes an
// address by hand: `apiPath('GET /api/bots/{id}/rows', { id }, { limit: 200 })` -> GET /api/bots/b1/rows?limit=200.
// No imports: the web app reads it as @shared/api-path and the Android app keeps a word-for-word copy
// (mobile/src/apiPath.ts, written by scripts/shared-copies.mjs).

export function apiPath(op: string, params: Record<string, string | number> = {}, query?: object): { method: string; path: string } {
  const space = op.indexOf(' ');
  const method = op.slice(0, space);
  const path = op.slice(space + 1).replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === '') throw new Error(`${op}: no value for {${name}}`);
    return encodeURIComponent(String(v));
  });
  const q = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return { method, path: q.length ? `${path}?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : path };
}
