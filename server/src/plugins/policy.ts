import { redact } from '../lib/redact.js';
/**
 * Approval stages that plugins (code in this repository) can add to the approval check.
 *
 * The check for an app tool runs in this order (agent/tools.ts, policyFor):
 *
 *   1. the plugin is off for this bot          -> block
 *   2. apps.json rules and the server's hints   -> allow / ask / block (block and ask are fixed)
 *   3. what the user stored on a card           -> may turn a non-fixed ask into allow, or block
 *   4. every registered stage                   -> may only say ask or block
 *
 * The result is the strictest of steps 3 and 4. A stage can therefore make a call ask or refuse it,
 * but nothing a stage returns can let a call run that would otherwise ask: "allow" from a stage is
 * ignored (and logged once). A stage that throws counts as block, so a broken stage fails closed. A
 * stage never answers an approval card either: cards are answered only by the signed-in user
 * (agent/loop.ts, resolveApproval).
 */

export type StageDecision = 'ask' | 'block';

export interface StageInput {
  userId: string;
  botId?: string;
  /** The bot-facing name, `<app>__<tool>`. */
  name: string;
  appId: string;
  tool: string;
  args: unknown;
}

export type PolicyStage = (input: StageInput) => StageDecision | undefined | null | void;

const stages = new Map<string, PolicyStage>();
const warned = new Set<string>();

/** Add a stage. Returns a function that removes it again. */
export function registerPolicyStage(name: string, stage: PolicyStage): () => void {
  stages.set(name, stage);
  return () => { if (stages.get(name) === stage) stages.delete(name); };
}

const RANK = { allow: 0, ask: 1, block: 2 } as const;
export type Decision = keyof typeof RANK;
export const stricter = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

/** The strictest thing any stage says about this call, with the names of the stages that said it. */
export function runStages(input: StageInput): { decision: Decision; by: string[] } {
  let decision: Decision = 'allow';
  let by: string[] = [];
  for (const [name, stage] of stages) {
    let d: unknown;
    try {
      d = stage(input);
    } catch (e) {
      console.warn(`[plugins] approval stage ${name} failed (${redact((e as Error).message)}); the call is refused`);
      d = 'block';
    }
    if (d === undefined || d === null) continue;
    if (d !== 'ask' && d !== 'block') {
      if (!warned.has(name)) { warned.add(name); console.warn(`[plugins] approval stage ${name} returned ${JSON.stringify(d)}; stages may only say "ask" or "block", so this is ignored`); }
      continue;
    }
    if (RANK[d] > RANK[decision]) { decision = d; by = [name]; } else if (d === decision) by.push(name);
  }
  return { decision, by };
}
