// The one-line summary and problem list shown on a bot's collapsed Engine section. Shared by the web and
// Windows apps (web/src/components/EngineSettings.tsx) and the phone (mobile/src/engineSummary.ts is an
// identical copy; tests/engine-summary.mjs checks that). No imports, so the copy needs no changes.
//
// A problem is something that stops or will stop this bot's turns: the agent is down, or the provider it
// uses (or one of its fallbacks) has no access or failed its latest request. Providers the bot does not
// use are not problems, even when they have no key.

type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/** The parts of EngineInfo (server/src/types.ts) the summary reads. */
export interface EngineSummaryInput {
  status: 'ready' | 'starting' | 'stopped' | 'error';
  provider: string | null;
  model: string | null;
  modelMode: 'manual' | 'auto';
  modelTiers?: Partial<Record<'light' | 'standard' | 'heavy', { model: string; effort: Effort }>> | null;
  providers?: { id: string; name: string; kind: 'subscription' | 'api_key'; connected: boolean }[];
  catalog?: {
    id: string; name: string;
    access: 'ready' | 'needs_key' | 'not_signed_in' | 'off' | 'not_installed' | 'unknown';
    verified: { at: number; ok: boolean } | null;
    lastTurn: { at: number; ok: boolean } | null;
  }[];
  fallbacks?: { provider: string; model: string }[];
}

export interface EngineSummary {
  /** For example "gpt-5.5 · Medium effort" or "Auto · 3 tiers". */
  line: string;
  /** The provider's name, when known, for a tooltip or a second line. */
  providerName: string | null;
  /** Plain sentences, most serious first. Empty when nothing is wrong. */
  problems: string[];
}

export const ENGINE_EFFORT_WORD: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Max' };

const ACCESS_PROBLEM: Record<string, string> = {
  needs_key: 'no key', not_signed_in: 'not signed in', off: 'switched off for this bot', not_installed: 'not installed',
};

type CatalogEntry = NonNullable<EngineSummaryInput['catalog']>[number];

/** The newer of the last Check and the last chat turn says whether the provider works now. */
function lastFailed(p: CatalogEntry): boolean {
  const v = p.verified;
  const t = p.lastTurn;
  const latest = v && t ? (t.at >= v.at ? t : v) : v ?? t;
  return !!latest && !latest.ok;
}

function providerProblem(e: EngineSummaryInput, id: string, label: (name: string) => string): string | null {
  const p = e.catalog?.find((x) => x.id === id);
  if (p) {
    const access = ACCESS_PROBLEM[p.access];
    if (access) return `${label(p.name)}: ${access}`;
    if (lastFailed(p)) return `${label(p.name)}: last request failed`;
    return null;
  }
  const old = e.providers?.find((x) => x.id === id);
  if (old && !old.connected) return `${label(old.name)}: ${old.kind === 'subscription' ? 'not signed in' : 'not connected'}`;
  return null;
}

export function engineSummary(e: EngineSummaryInput, effort?: Effort | null): EngineSummary {
  const providerName = (e.provider && (e.catalog?.find((p) => p.id === e.provider)?.name ?? e.providers?.find((p) => p.id === e.provider)?.name)) || e.provider || null;
  let line: string;
  if (e.modelMode === 'auto') {
    const n = Object.values(e.modelTiers ?? {}).filter((t) => t && t.model.trim()).length;
    line = n ? `Auto · ${n} tier${n === 1 ? '' : 's'}` : `Auto · ${e.model ?? 'default model'}`;
  } else {
    line = `${e.model ?? 'Default model'}${effort ? ` · ${ENGINE_EFFORT_WORD[effort]} effort` : ''}`;
  }

  const problems: string[] = [];
  if (e.status === 'error') problems.push('Agent has a problem');
  else if (e.status === 'stopped') problems.push('Agent is stopped');
  if (e.provider) {
    const p = providerProblem(e, e.provider, (name) => name);
    if (p) problems.push(p);
  }
  (e.fallbacks ?? []).forEach((f, i) => {
    if (f.provider === e.provider) return;
    const p = providerProblem(e, f.provider, (name) => `Fallback ${i + 1} (${name})`);
    if (p) problems.push(p);
  });
  return { line, providerName, problems: [...new Set(problems)] };
}
