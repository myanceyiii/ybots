import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import '../db-config.js'; // bots.auto_save_skills
import type { Policy } from '../agent/tools.js';
import { runStages, stricter, type Decision } from './policy.js';
import { ruleFor } from '../allow-rules.js';
import { freeRunVerdict, maintainerVerdict } from '../maintainer-guard.js';
import { hermesMcpKind, hermesMcpToolOf, secretRead } from '../hermes-mcp-tools.js';

/**
 * Approval for Hermes' own tools (terminal, write_file, browser, computer_use, ...).
 *
 * Tools served through /mcp are checked by policyFor. Hermes' built-in tools never pass through this
 * server, so each managed bot's Hermes home gets our gate plugin (server/hermes-plugins/cleft-bot-gate,
 * a pre_tool_call hook) which asks POST /mcp/<bot>/gate before every one of them. The decision:
 *
 *  1. tools that only read run without asking (the list below, checked against Hermes' source);
 *  2. otherwise a stored "Don't allow" for `hermes__<tool>` refuses it, and this bot's "Always allow" rule
 *     (allow-rules.ts) lets it run;
 *  3. otherwise it asks;
 *  4. plugin approval stages (policy.ts) may make it stricter, as for any tool.
 *
 * The maintainer bot (Howard) is decided per command and per file instead of per tool
 * (maintainer-guard.ts): inspection commands and edits in his working copy run, privileged, destructive
 * and secret-touching ones always ask on a card that has no "Always allow", even under a terminal rule.
 *
 * Free-run (Alex, 2026-11-24): while the owner's switch is on, every terminal command of the maintainer
 * bot runs without a card, sudo and deploys included. Commands across Sheldon's firm-data boundary still
 * ask, a stored "Don't allow" still wins, each command is logged (mcp.ts), and the output of commands that
 * touch secret files is redacted by the gate plugin. File writes (write_file, patch) keep the guard.
 *
 * One owner switch loosens step 3: "Auto-save its own skills" on a bot (bots.auto_save_skills, set
 * only from the signed-in app) lets that bot's skill_manage create and improve skills without a card.
 * Deleting a skill or removing one of its files still asks, and a stored "Don't allow" still wins.
 *
 * A tool this list does not know asks, so a new Hermes tool is never let through silently.
 */
export const HERMES_READ_ONLY = new Set([
  'read_file', 'search_files', 'web_search', 'web_extract', 'x_search', 'session_search', 'skills_list',
  'skill_view', 'todo_list', 'clarify', 'vision_analyze', 'video_analyze', 'read_terminal', 'show_tip',
  // Hermes' tool search (tools/tool_search.py): reading its own catalog of tools it keeps out of the prompt.
  'tool_search', 'tool_describe',
]);

/**
 * Hermes' `tool_call` bridge runs a tool it keeps behind tool search (most MCP tools once a bot has many,
 * including this app's own show_view, update_view and offer_choices). Hermes unwraps it and fires this
 * gate again for the real tool (model_tools.handle_function_call: "tool_call is unwrapped so every
 * downstream hook sees the real tool name"; a connector batch is re-dispatched the same way), so the
 * wrapper itself needs no card: the real tool gets its own check here, or in policyFor for the app's
 * own tools. Asking about the wrapper put a card titled "use tool call" in front of the owner and held
 * the bot's tools while it waited (Leonard, 2026-11-23).
 */
export const HERMES_BRIDGE = new Set(['tool_call']);

const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;
export const hermesKey = (tool: string) => `hermes__${tool}`;
const PLAIN: Record<string, string> = {
  terminal: 'run a terminal command', execute_code: 'run code', write_file: 'write a file', patch: 'edit a file',
  computer_use: 'use its computer', delegate_task: 'hand a task to a helper', memory: 'change its memory',
  skill_manage: 'change its skills', cronjob_manage: 'change scheduled jobs', process_manage: 'manage running programs',
  image_generate: 'make an image', text_to_speech: 'make speech audio', close_terminal: 'close a terminal',
};
/** "Hermes: run a terminal command"; the approval card shows the part after the colon. */
export const hermesTitle = (tool: string) => hermesMcpToolOf(tool) ? `Hermes MCP: ${hermesMcpToolOf(tool)!.replace(/_/g, ' ')}` : `Hermes: ${PLAIN[tool] ?? (tool.startsWith('browser_') ? `use the browser (${tool.slice(8).replace(/_/g, ' ')})` : `use ${tool.replace(/[_-]+/g, ' ').toLowerCase()}`)}`;

/** Skill changes the auto-save switch covers: writing and improving, never deleting. */
const AUTO_SAVE_ACTIONS = new Set(['create', 'patch', 'edit', 'write_file']);

/** A skill_manage call made only of create/improve steps (the flat shape or the batch `operations` shape). */
export function isSkillSave(args: unknown): boolean {
  const a = (args && typeof args === 'object' ? args : {}) as { action?: unknown; operations?: unknown };
  if (Array.isArray(a.operations)) {
    return a.operations.length > 0 && a.operations.every((op) => op && typeof op === 'object' && AUTO_SAVE_ACTIONS.has(String((op as { action?: unknown }).action)));
  }
  return AUTO_SAVE_ACTIONS.has(String(a.action));
}

const autoSaves = (botId: string) => !!(db.prepare('SELECT auto_save_skills FROM bots WHERE id=?').get(botId) as { auto_save_skills?: number } | undefined)?.auto_save_skills;

export function hermesPolicy(userId: string, botId: string, tool: string, args: unknown, hints: { danger?: unknown } = {}): Policy {
  const key = hermesKey(tool);
  if (!TOOL.test(tool)) return { decision: 'block', key, title: hermesTitle(tool), asks: [] };
  let base: Decision;
  let rememberable = false;
  let viaRule: string | undefined;
  const stored = (db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=? COLLATE NOCASE').get(userId, key) as { mode?: string } | undefined)?.mode;
  // The maintainer bot (Howard): each command and file write is sorted (maintainer-guard.ts). Risky ones
  // always ask on a card that cannot be "Always allow"ed, whatever standing rule covers the tool.
  const free = stored === 'blocked' ? null : freeRunVerdict(botId, tool, args);
  if (free && !('firm' in free)) {
    const staged = runStages({ userId, botId, name: key, appId: 'hermes', tool, args });
    const decision = stricter('allow', staged.decision);
    return {
      decision, key, toolkit: 'hermes', title: hermesTitle(tool), asks: [],
      ...(decision === 'allow' ? { freeRun: { command: free.command, secret: free.secret, risky: free.reasons } } : {}),
    };
  }
  const findings = Array.isArray(hints.danger) ? hints.danger.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
  const guard = stored === 'blocked' ? null : maintainerVerdict(botId, tool, args, findings);
  if (guard?.kind === 'danger') {
    const staged = runStages({ userId, botId, name: key, appId: 'hermes', tool, args });
    const what = tool === 'terminal' ? String((args as any)?.command ?? '') : String((args as any)?.path ?? (args as any)?.file_path ?? '');
    return {
      decision: stricter('ask', staged.decision), key, toolkit: 'hermes', title: hermesTitle(tool), asks: [],
      detail: `Needs your OK every time: ${guard.reasons.join('; ')}.\n\n${what.slice(0, 1800)}`,
    };
  }
  // The Hermes MCP connector if a Hermes home loads it directly (`mcp_hermes-mcp_hermes_*`): sorted as in
  // hermes-mcp-tools.ts. Reads run; risky tools ask on a card that cannot be "Always allow"ed.
  const viaMcp = hermesMcpToolOf(tool);
  const mcpKind = viaMcp ? (secretRead(viaMcp, args) ? 'risky' : hermesMcpKind(viaMcp)) : null;
  if (stored !== 'blocked' && mcpKind === 'risky') {
    const staged = runStages({ userId, botId, name: key, appId: 'hermes', tool, args });
    return { decision: stricter('ask', staged.decision), key, toolkit: 'hermes', title: hermesTitle(tool), asks: [] };
  }
  if (stored === 'blocked') base = 'block';
  else if (HERMES_READ_ONLY.has(tool) || HERMES_BRIDGE.has(tool) || mcpKind === 'read') base = 'allow';
  else if (guard?.kind === 'read') base = 'allow';
  // An older "Always allow" stored for every bot still counts.
  else if (stored === 'always_allow') base = 'allow';
  else if (tool === 'skill_manage' && isSkillSave(args) && autoSaves(botId)) base = 'allow';
  else if ((viaRule = ruleFor(botId, key) ?? undefined)) base = 'allow';
  else { base = 'ask'; rememberable = true; }
  const staged = runStages({ userId, botId, name: key, appId: 'hermes', tool, args });
  const decision = stricter(base, staged.decision);
  return {
    decision, key, toolkit: 'hermes', title: hermesTitle(tool),
    asks: decision === 'ask' && rememberable && staged.decision === 'allow' ? [key] : [],
    ...(decision === 'allow' && viaRule ? { viaRule } : {}),
  };
}

/** Where the gate plugin's files are in this repository. */
export const gatePluginSource = () => path.resolve(new URL('.', import.meta.url).pathname, '../../hermes-plugins/cleft-bot-gate');

/**
 * Put the gate plugin into a Hermes home and point it at this server. Returns the plugin name for
 * plugins.enabled. gate.json carries the bot's /mcp token, so it is written mode 600.
 */
export function installGate(home: string, url: string, token: string): string {
  const dest = path.join(home, 'plugins', 'cleft-bot-gate');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of ['plugin.yaml', '__init__.py']) fs.copyFileSync(path.join(gatePluginSource(), f), path.join(dest, f));
  const cfg = path.join(dest, 'gate.json');
  fs.writeFileSync(cfg, JSON.stringify({ url, token, timeout: 1560 }), { mode: 0o600 });
  fs.chmodSync(cfg, 0o600);
  return 'cleft-bot-gate';
}
