import { touchesSecret } from './maintainer-guard.js';

/**
 * The Hermes MCP connector (`hermes-mcp`, the Hermes GPT sidecar on 127.0.0.1:4750, Howard only).
 *
 * Its server marks none of its tools read-only (no readOnlyHint), so every call asked on a card, even
 * "hermes plan list" (Alex, 2026-11-24: "Of course he can"). This file sorts each of its tools by what it
 * does, checked against the tool's own description and parameters as the server publishes them:
 *
 *  - `read`:  looks and changes nothing (list, get, status, read, search, tail, validate, ...). Runs without
 *             a card. Marked like a server read-only hint (local-apps.ts), so the Tools tab counts it as a read.
 *  - `risky`: runs commands or writes files as the owner, changes Hermes' config or environment, restarts the
 *             gateway, revokes sign-ins, approves, or sends work to another machine. Always a card, which
 *             can never be "Always allow"ed.
 *  - anything else (creating or changing missions, plans, cron jobs, skills, starting a run, cancelling):
 *             a card, which the owner may "Always allow" as before.
 *
 * Most of the server's write tools default to dry_run, but one argument turns that off, so the sort is by
 * tool, not by arguments. A tool this list does not know asks, so a new one is never let through silently.
 * The file readers still ask when the path names a secret file (.env, keys, tokens; maintainer-guard.ts).
 */
export const HERMES_MCP_APP = 'hermes-mcp';

export const HERMES_MCP_READ = new Set([
  // Sessions and Bot Chat: reading transcripts and job results.
  'hermes_session_list', 'hermes_session_read', 'hermes_session_search', 'hermes_session_export',
  'hermes_session_job_status', 'hermes_session_job_result', 'hermes_bot_chat_get',
  // Missions: dashboards and records ("force_refresh" only refreshes the read cache).
  'hermes_mission_list', 'hermes_mission_get', 'hermes_mission_overview', 'hermes_mission_health',
  'hermes_mission_approvals', 'hermes_mission_audit', 'hermes_mission_codex', 'hermes_mission_cron',
  'hermes_mission_delegations', 'hermes_mission_failures', 'hermes_mission_fleet', 'hermes_mission_profiles',
  'hermes_mission_usage', 'hermes_mission_vault', 'hermes_mission_ledger', 'hermes_mission_ledger_replay',
  // Plans: reading, reviewing, validating, and the pure decomposition preview ("read-only").
  'hermes_plan_list', 'hermes_plan_get', 'hermes_plan_review', 'hermes_plan_validate', 'hermes_plan_decompose',
  // Placement, budget, controller, failure taxonomy (each described "read-only").
  'hermes_placement_candidates', 'hermes_placement_get', 'hermes_placement_list',
  'hermes_budget_get', 'hermes_budget_check',
  'hermes_controller_status', 'hermes_controller_lease_list', 'hermes_controller_plan_list',
  'hermes_failure_taxonomy', 'hermes_recovery_matrix', 'hermes_capability_manifest',
  // Contracts: checking a contract document or its status, never dispatching it.
  'hermes_contract_validate', 'hermes_contract_status',
  // Delegations, runners, jobs, Codex jobs: lists and status.
  'hermes_delegation_list', 'hermes_delegation_get', 'hermes_runner_list', 'hermes_runner_status',
  'hermes_job_status', 'hermes_job_wait', 'hermes_codex_status', 'hermes_codex_jobs',
  'hermes_codex_job_status', 'hermes_codex_job_result',
  // Fleet: peers, their status, task summaries and results, authority drift (no tokens shown).
  'hermes_fleet_list', 'hermes_fleet_status', 'hermes_fleet_task', 'hermes_fleet_result', 'hermes_fleet_authority_drift',
  // Swarm workflows: list, status, validate.
  'hermes_swarm_workflow_list', 'hermes_swarm_workflow_status', 'hermes_swarm_workflow_validate',
  // Events and the operator: timelines, audit tail, health checks, policy (never secrets).
  'hermes_events_query', 'hermes_events_tail', 'hermes_live_events_cursor', 'hermes_live_events_since',
  'hermes_operator_status', 'hermes_operator_snapshot', 'hermes_operator_policy', 'hermes_operator_doctor',
  'hermes_operator_audit_tail',
  // Hermes' own setup: config values, which env keys are set (not their values), gateway, sign-in expiry,
  // cron jobs, skills (a diff only previews a change).
  'hermes_config_get', 'hermes_env_status', 'hermes_gateway_status', 'hermes_oauth_status',
  'hermes_cron_list', 'hermes_cron_status', 'hermes_skill_list', 'hermes_skill_view', 'hermes_skill_diff',
  // Files and git: reading and searching (secret paths still ask, see secretRead), git status and diff.
  'hermes_read_file', 'hermes_search_files', 'hermes_workspace_read', 'hermes_git_status', 'hermes_git_diff',
]);

export const HERMES_MCP_RISKY = new Set([
  // As the owner: run a command, write or patch any file.
  'hermes_owner_run_command', 'hermes_owner_write_file', 'hermes_owner_patch',
  // Hermes' config and environment, its gateway, its sign-ins.
  'hermes_config_set', 'hermes_config_patch', 'hermes_env_set_nonsecret', 'hermes_env_copy_nonsecret',
  'hermes_gateway_restart', 'hermes_oauth_revoke',
  // Approvals and review acceptances: a bot never approves.
  'hermes_mission_approve', 'hermes_swarm_approve', 'hermes_review_accept',
  // Sending work to another machine or agent.
  'hermes_fleet_dispatch', 'hermes_fleet_dispatch_work_order', 'hermes_contract_dispatch',
  'hermes_delegation_dispatch', 'hermes_swarm_stage_dispatch',
  // Deleting a skill.
  'hermes_skill_delete',
]);

/** Arguments of the file readers that name a path or a file pattern. */
const PATH_ARGS = ['path', 'file_glob', 'workdir', 'pathspec'];
const FILE_READERS = new Set(['hermes_read_file', 'hermes_search_files', 'hermes_workspace_read', 'hermes_git_diff']);

export type HermesMcpKind = 'read' | 'risky' | 'other';

export function hermesMcpKind(tool: string): HermesMcpKind {
  const t = tool.toLowerCase();
  if (HERMES_MCP_RISKY.has(t)) return 'risky';
  if (HERMES_MCP_READ.has(t)) return 'read';
  return 'other';
}

/** A file reader pointed at a secret file (.env, keys, tokens, ~/.ssh, ...): asks, like Howard's terminal. */
export function secretRead(tool: string, args: unknown): boolean {
  if (!FILE_READERS.has(tool.toLowerCase())) return false;
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  return PATH_ARGS.some((k) => typeof a[k] === 'string' && touchesSecret(` ${a[k] as string}`));
}

/** The Hermes MCP connector's tool name inside a Hermes tool name (`mcp_hermes-mcp_hermes_plan_list`), if it is one. */
export function hermesMcpToolOf(raw: string): string | null {
  const m = /^mcp_+hermes[-_]mcp_+(hermes_.+)$/i.exec(raw);
  return m ? m[1] : null;
}
