// Server handlers answer contract calls (api-contract.ts) through answer(), so a handler that stops sending
// what the contract promises fails the typecheck instead of an installed app.
import type { Context } from 'hono';
import type { ApiOp, ApiRes } from '../api-contract.js';

/** `return answer(c, 'GET /api/tasks', { tasks })`: c.json with the body checked against the contract. */
export const answer = <K extends ApiOp>(c: Context, _op: K, body: ApiRes<K>) => c.json(body as object);

// The contract's copy of a shape that lives in a server file the apps cannot read (agent/loop.ts imports the
// engine): these lines fail the typecheck the moment the two differ.
import type { ApprovalAnswer } from '../api-contract.js';
import type { ApprovalReadback } from '../agent/loop.js';
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const approvalAnswerMatches: Same<ApprovalAnswer, ApprovalReadback> = true;
