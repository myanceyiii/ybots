/** Per-browser settings in localStorage under `cleftbot.<name>`. Values saved under earlier names (`bothq.<name>`, `grokbot.<name>`) are still read. */
export function lsGet(name: string): string | null {
  try { return localStorage.getItem(`cleftbot.${name}`) ?? localStorage.getItem(`bothq.${name}`) ?? localStorage.getItem(`grokbot.${name}`); } catch { return null; }
}

export function lsSet(name: string, value: string) {
  try { localStorage.setItem(`cleftbot.${name}`, value); } catch { /* storage unavailable */ }
}
