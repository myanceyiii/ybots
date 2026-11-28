import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { appendRow, emitBot, getBotRow, getRow, updateRow } from '../store.js';
import { isOwner } from './owner.js';
import { PluginError } from './registry.js';
import { InstallError, inspectPackage, treeDigest, walk } from './install.js';
import { launchConfig, pluginsDir, type PluginRow } from './store.js';
import { confirmChange, proposeChange, proposeInstallFromDir } from './changes.js';

/**
 * Plugins made with a bot, in the conversation (docs/plugins.md, "Making a plugin with a bot").
 *
 *  1. The bot calls propose_plugin: a plan card appears (what it will do, its tools, the sites it
 *     talks to). Nothing is built.
 *  2. The owner presses Build. That authorizes building this plan only; the bot is told to go ahead.
 *  3. The bot sends the files with submit_plugin_draft, refused unless the plan is being built.
 *  4. The server checks the draft in a sandbox (no network, read-only, no secrets): file rules, the
 *     package, a secret scan, a dry run that lists its tools (they must match the plan), its own
 *     tests. Every submission is committed to a local git repository.
 *  5. A review card shows the result and the package's fingerprint. Only the owner's Install, sent
 *     with that fingerprint, installs it (switched off, or on for the bots picked on the card), and
 *     Undo removes it again (Restore brings it back). Voice cannot answer these cards.
 *
 * The bot never installs anything, never answers a card, and its messages are never approvals.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS plugin_drafts (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_seq INTEGER,
  review_seq INTEGER,
  digest TEXT,
  checks TEXT,
  plugin_id TEXT,
  submissions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export interface PlanTool { name: string; description: string; writes: boolean }
export interface Plan { title: string; purpose: string; tools: PlanTool[]; network: string[] }
export interface Check { name: string; ok: boolean; detail: string }
export type DraftStatus = 'planned' | 'building' | 'checking' | 'checked' | 'failed' | 'installed' | 'rejected' | 'dismissed' | 'removed';

const MAX_SUBMISSIONS = 8;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const draftsDir = () => path.join(pluginsDir(), 'drafts');
const kitFile = () => path.resolve(new URL('.', import.meta.url).pathname, '../../plugin-kit/cleftbot-mcp.mjs');

interface DraftRow { id: string; bot_id: string; user_id: string; plan: string; status: DraftStatus; plan_seq: number | null; review_seq: number | null; digest: string | null; checks: string | null; plugin_id: string | null; submissions: number; created_at: number; updated_at: number }
const getDraft = (id: string) => db.prepare('SELECT * FROM plugin_drafts WHERE id=?').get(id) as DraftRow | undefined;
const setDraft = (id: string, patch: Partial<DraftRow>) => {
  const keys = Object.keys(patch);
  db.prepare(`UPDATE plugin_drafts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...keys.map((k) => (patch as any)[k]), now(), id);
};

function patchCard(botId: string, seq: number | null, patch: Record<string, unknown>) {
  if (seq === null) return;
  const r = getRow(botId, seq);
  if (r && r.body.type === 'card') updateRow(botId, seq, { ...r.body, ...patch } as any);
}

// ---------- 1. the plan ----------

export function validatePlan(a: any): Plan {
  const title = typeof a?.title === 'string' ? a.title.trim().slice(0, 80) : '';
  const purpose = typeof a?.purpose === 'string' ? a.purpose.trim().slice(0, 1000) : '';
  if (!title || !purpose) throw new PluginError('A plan needs a title and a purpose.');
  if (!Array.isArray(a.tools) || !a.tools.length || a.tools.length > 12) throw new PluginError('A plan needs 1 to 12 tools.');
  const tools: PlanTool[] = a.tools.map((t: any) => {
    if (!TOOL_NAME.test(String(t?.name ?? ''))) throw new PluginError(`Tool name "${t?.name}" must be lower_case letters, digits and _.`);
    return { name: t.name, description: String(t.description ?? '').slice(0, 300), writes: t.writes !== false };
  });
  if (new Set(tools.map((t) => t.name)).size !== tools.length) throw new PluginError('Tool names must be different.');
  const network = Array.isArray(a.network) ? a.network.map(String) : [];
  if (network.length > 10 || !network.every((h: string) => HOST.test(h))) throw new PluginError('network must be up to 10 host names, like api.example.com.');
  return { title, purpose, tools, network };
}

export function proposePlugin(userId: string, botId: string, args: unknown): { draftId: string } {
  const plan = validatePlan(args);
  const open = (db.prepare("SELECT count(*) n FROM plugin_drafts WHERE bot_id=? AND status IN ('planned','building','checking')").get(botId) as { n: number }).n;
  if (open >= 3) throw new PluginError('This bot already has three plugin plans open. Finish or drop one first.');
  const id = newId('pdr');
  const t = now();
  db.prepare('INSERT INTO plugin_drafts(id,bot_id,user_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, botId, userId, JSON.stringify(plan), 'planned', t, t);
  const row = appendRow(botId, 'card', { type: 'card', card: 'plugin-plan', draftId: id, ...plan, status: 'pending' } as any);
  setDraft(id, { plan_seq: row.seq });
  emitBot(botId);
  return { draftId: id };
}

// ---------- 2. the owner's Build ----------

/** A Build or Install card older than this is stale: the person is asked to start again rather than act on it. */
export const DRAFT_DECISION_MS = 3 * 24 * 3600_000;

function staleCard(d: DraftRow, since: number) {
  if (since + DRAFT_DECISION_MS > now()) return;
  patchCard(d.bot_id, d.status === 'planned' ? d.plan_seq : d.review_seq, { status: 'expired' });
  emitBot(d.bot_id);
  throw new PluginError('That card is more than 3 days old. Ask the bot to plan or submit the plugin again.', 409);
}

function ownedDraft(userId: string, draftId: string): DraftRow {
  if (!isOwner(userId)) throw new PluginError('Only the owner of this server can build or install plugins.', 403);
  const d = getDraft(draftId);
  if (!d || d.user_id !== userId) throw new PluginError('No such plugin plan.', 404);
  return d;
}

/** Returns the notice to send the bot. The caller (routes.ts) enqueues it. */
export function startBuild(userId: string, draftId: string): { botId: string; notice: string } {
  const d = ownedDraft(userId, draftId);
  if (d.status !== 'planned') throw new PluginError(`That plan is ${d.status}.`, 409);
  staleCard(d, d.created_at);
  setDraft(d.id, { status: 'building' });
  patchCard(d.bot_id, d.plan_seq, { status: 'building' });
  const plan: Plan = JSON.parse(d.plan);
  return {
    botId: d.bot_id,
    notice: [
      `The owner pressed Build on your plugin plan "${plan.title}" (draft ${d.id}). Write it now and send it with submit_plugin_draft.`,
      'Rules: an ES module package with package.json (exact "version", "type": "module", "main": "index.mjs", no dependencies, no scripts),',
      'index.mjs that imports { serve } from "./cleftbot-mcp.mjs" (the server adds that file) and serves exactly these tools:',
      plan.tools.map((t) => `${t.name}${t.writes ? '' : ' (readOnly: true)'}`).join(', ') + '.',
      plan.network.length ? `It may talk to: ${plan.network.join(', ')}.` : 'It gets no network access.',
      'Optionally add cleftbot-plugin.json (name, description, network, ask, block, settings) and test.mjs (exits 0 when it passes).',
      'Never put keys or passwords in the files; ask for them as "secret" settings instead.',
    ].join(' '),
  };
}

export function dismissPlan(userId: string, draftId: string) {
  const d = ownedDraft(userId, draftId);
  if (!['planned', 'building', 'failed', 'checked'].includes(d.status)) throw new PluginError(`That plan is ${d.status}.`, 409);
  setDraft(d.id, { status: d.status === 'checked' ? 'rejected' : 'dismissed' });
  patchCard(d.bot_id, d.plan_seq, { status: 'dismissed' });
  patchCard(d.bot_id, d.review_seq, { status: 'rejected' });
}

// ---------- 3 and 4. the bot's files, checked ----------

const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const FILE_EXT = /\.(mjs|js|cjs|json|md|txt)$/;
const SECRETS: [string, RegExp][] = [
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /xox[abposr]-[A-Za-z0-9-]{10,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Google key', /AIza[0-9A-Za-z_-]{35}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['password in the code', /\b(password|passwd|secret|api_?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i],
];
const NOTES: [string, RegExp][] = [
  ['starts other programs (child_process)', /\bchild_process\b/],
  ['writes files', /\b(writeFile|appendFile|createWriteStream|rmSync|unlink|rename)\w*\(/],
  ['uses the network', /\b(fetch\(|https?\.request|net\.connect|WebSocket)/],
  ['runs generated code (eval)', /\beval\(|new Function\(/],
];

function writeFiles(dir: string, files: unknown): string[] {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new PluginError('files must be an object of "path": "content".');
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.length || entries.length > 40) throw new PluginError('Send 1 to 40 files.');
  let total = 0;
  for (const [p, c] of entries) {
    if (!FILE_PATH.test(p) || p.split('/').includes('..') || !FILE_EXT.test(p)) throw new PluginError(`File name ${p} is not allowed (.mjs, .js, .cjs, .json, .md, .txt; no folders up).`);
    if (p.startsWith('node_modules/') || p === 'cleftbot-mcp.mjs') throw new PluginError(`${p} is provided by the server; do not send it.`);
    if (typeof c !== 'string' || c.length > 256_000) throw new PluginError(`${p} must be text up to 256 KB.`);
    total += c.length;
  }
  if (total > 512_000) throw new PluginError('The files add up to more than 512 KB.');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  for (const [p, c] of entries) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c as string, { mode: 0o640 });
  }
  fs.copyFileSync(kitFile(), path.join(dir, 'cleftbot-mcp.mjs'));
  return entries.map(([p]) => p);
}

function commitDraft(repo: string, message: string) {
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=YBots', '-c', 'user.email=cleft-bot@localhost', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
    if (!fs.existsSync(path.join(repo, '.git'))) git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
  } catch (e) {
    console.warn(`[plugins] could not record the draft in git: ${(e as Error).message.split('\n')[0]}`);
  }
}

// Each run gets its own digest, so two drafts checked at once never share a sandbox container name.
/** Start the draft in the sandbox (never with network) and list its tools. */
async function dryRun(dir: string, manifest: any): Promise<string[]> {
  const row: PluginRow = { id: 'draft', version: '0.0.0', digest: `dry${crypto.randomBytes(3).toString('hex')}`, name: 'draft', source: 'draft', manifest: { ...manifest, network: [] }, dir, status: 'installed', installedAt: 0, installedBy: '' };
  const cfg = launchConfig(row);
  const client = new Client({ name: 'cleft-bot-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: cfg.command!, args: cfg.args, cwd: cfg.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stderr: 'ignore' });
  const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('did not answer within 20 s')), 20_000))]);
  try {
    await timeout(client.connect(transport));
    const r = await timeout(client.listTools());
    return r.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
}

function runTests(dir: string, manifest: any): Check {
  if (!fs.existsSync(path.join(dir, 'test.mjs'))) return { name: 'Its tests', ok: true, detail: 'No test.mjs; nothing to run.' };
  const row: PluginRow = { id: 'draft', version: '0.0.0', digest: `tst${crypto.randomBytes(3).toString('hex')}`, name: 'draft', source: 'draft', manifest: { ...manifest, entry: 'test.mjs', network: [] }, dir, status: 'installed', installedAt: 0, installedBy: '' };
  const cfg = launchConfig(row);
  try {
    execFileSync(cfg.command!, cfg.args ?? [], { cwd: cfg.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { name: 'Its tests', ok: true, detail: 'test.mjs passed.' };
  } catch (e) {
    const err = String((e as any).stderr ?? (e as any).stdout ?? (e as Error).message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return { name: 'Its tests', ok: false, detail: `test.mjs failed: ${err}` };
  }
}

export async function submitDraft(userId: string, botId: string, args: any): Promise<string> {
  const d = getDraft(String(args?.draft_id ?? ''));
  if (!d || d.bot_id !== botId) throw new PluginError('No such plugin draft for this bot.');
  if (d.status === 'planned') throw new PluginError('The owner has not pressed Build on this plan yet. Wait for them.');
  if (!['building', 'failed', 'checked'].includes(d.status)) throw new PluginError(`This draft is ${d.status}; it cannot be changed.`);
  if (d.submissions >= MAX_SUBMISSIONS) throw new PluginError('This draft was sent too many times. Tell the owner what is wrong instead.');
  const plan: Plan = JSON.parse(d.plan);
  const repo = path.join(draftsDir(), d.id);
  const pkg = path.join(repo, 'package');
  const names = writeFiles(pkg, args?.files);
  setDraft(d.id, { status: 'checking', submissions: d.submissions + 1 });
  patchCard(d.bot_id, d.review_seq, { status: 'superseded' });

  const checks: Check[] = [];
  const notes: string[] = [];
  let manifest: any = null;
  let digest = '';
  try {
    const staged = inspectPackage(pkg, `draft:${d.id}`);
    manifest = staged.manifest;
    digest = staged.digest;
    const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).dependencies ?? {});
    if (deps.length) checks.push({ name: 'The package', ok: false, detail: `It lists dependencies (${deps.join(', ')}); made plugins use the built-in kit instead.` });
    else checks.push({ name: 'The package', ok: true, detail: `Version ${staged.version}, start file ${manifest.entry}, no install scripts, no dependencies.` });
    const declared = manifest.network ?? [];
    const extra = declared.filter((h: string) => !plan.network.includes(h));
    if (extra.length) checks.push({ name: 'Network', ok: false, detail: `It asks for sites the plan did not name: ${extra.join(', ')}.` });
    // The container gets ordinary network access when any site is named: the list is what it says it uses, not a filter.
    else checks.push({ name: 'Network', ok: true, detail: declared.length ? `Says it uses ${declared.join(', ')}. It gets network access (other sites are not blocked).` : 'None.' });
  } catch (e) {
    checks.push({ name: 'The package', ok: false, detail: e instanceof InstallError ? e.message : String((e as Error).message) });
  }
  const code = walk(pkg).filter((f) => f !== 'cleftbot-mcp.mjs').map((f) => [f, fs.readFileSync(path.join(pkg, f), 'utf8')] as const);
  const found = SECRETS.filter(([, re]) => code.some(([, c]) => re.test(c))).map(([n]) => n);
  checks.push(found.length ? { name: 'Secrets', ok: false, detail: `Looks like it contains a ${found.join(', ')}. Use a secret setting instead.` } : { name: 'Secrets', ok: true, detail: 'None found.' });
  for (const [n, re] of NOTES) if (code.some(([, c]) => re.test(c))) notes.push(`It ${n}.`);

  if (manifest && checks.every((c) => c.ok)) {
    try {
      const tools = await dryRun(pkg, manifest);
      const want = plan.tools.map((t) => t.name);
      const missing = want.filter((t) => !tools.includes(t));
      const unplanned = tools.filter((t) => !want.includes(t));
      checks.push(missing.length || unplanned.length
        ? { name: 'Its tools', ok: false, detail: [missing.length ? `missing ${missing.join(', ')}` : '', unplanned.length ? `not in the plan: ${unplanned.join(', ')}` : ''].filter(Boolean).join('; ') }
        : { name: 'Its tools', ok: true, detail: `Started in the sandbox and listed ${tools.join(', ')}.` });
    } catch (e) {
      checks.push({ name: 'Its tools', ok: false, detail: `It did not start in the sandbox: ${(e as Error).message.slice(0, 200)}` });
    }
    if (checks.every((c) => c.ok)) checks.push(runTests(pkg, manifest));
  }
  // Nothing but the package itself is fingerprinted; the digest is computed after the runs above.
  if (manifest) digest = treeDigest(pkg);
  commitDraft(repo, `Submission ${d.submissions + 1} for ${plan.title}`);

  const ok = checks.every((c) => c.ok);
  setDraft(d.id, { status: ok ? 'checked' : 'failed', digest: ok ? digest : null, checks: JSON.stringify(checks) });
  const tools = plan.tools.map((t) => ({ name: t.name, description: t.description, writes: t.writes }));
  const review = appendRow(d.bot_id, 'card', {
    type: 'card', card: 'plugin-review', draftId: d.id, title: plan.title, digest: ok ? digest : '', checks, notes,
    tools, network: manifest?.network ?? [], files: names, status: ok ? 'pending' : 'failed',
  } as any);
  setDraft(d.id, { review_seq: review.seq });
  emitBot(d.bot_id);
  if (!ok) return `Checks failed:\n${checks.filter((c) => !c.ok).map((c) => `- ${c.name}: ${c.detail}`).join('\n')}\nFix the files and call submit_plugin_draft again (${MAX_SUBMISSIONS - d.submissions - 1} tries left).`;
  return 'All checks passed. The owner now sees a review card and decides whether to install it. Do not call anything else for this plugin; tell the owner it is ready for review.';
}

// ---------- 5. the owner's Install and Undo ----------

export function installDraft(userId: string, draftId: string, digest: string, bots: string[] = []) {
  const d = ownedDraft(userId, draftId);
  if (d.status === 'installed') return { pluginId: d.plugin_id };
  if (d.status !== 'checked' || !d.digest) throw new PluginError(`That draft is ${d.status}.`, 409);
  if (digest !== d.digest) throw new PluginError('That is not the version you were shown.', 409);
  staleCard(d, d.updated_at);
  const pkg = path.join(draftsDir(), d.id, 'package');
  if (treeDigest(pkg) !== d.digest) throw new PluginError('The files changed after the review card was made; nothing was installed.', 409);
  const ch = proposeInstallFromDir(userId, pkg, `draft:${d.id}`, bots);
  const done = confirmChange(userId, ch.id, d.digest);
  const pluginId = (done.result as any)?.installed?.id ?? null;
  setDraft(d.id, { status: 'installed', plugin_id: pluginId });
  patchCard(d.bot_id, d.review_seq, { status: 'installed', pluginId });
  patchCard(d.bot_id, d.plan_seq, { status: 'built' });
  return { pluginId, result: done.result };
}

export function undoDraft(userId: string, draftId: string) {
  const d = ownedDraft(userId, draftId);
  if (d.status !== 'installed' || !d.plugin_id) throw new PluginError('That plugin is not installed from this card.', 409);
  // The owner's Undo on their own card is the confirmation. Restore brings it back from the Plugins page.
  const hist = db.prepare("SELECT digest FROM plugins WHERE id=? AND status='installed'").get(d.plugin_id) as { digest: string } | undefined;
  if (hist) {
    const ch = proposeChange(userId, { action: 'remove', pluginId: d.plugin_id });
    confirmChange(userId, ch.id, ch.digest);
  }
  setDraft(d.id, { status: 'removed' });
  patchCard(d.bot_id, d.review_seq, { status: 'removed' });
}

/** A plugin was deleted from the Plugins page: its install cards show it as removed. */
export function markPluginDeleted(pluginId: string) {
  const rows = db.prepare("SELECT * FROM plugin_drafts WHERE plugin_id=? AND status='installed'").all(pluginId) as DraftRow[];
  for (const d of rows) {
    setDraft(d.id, { status: 'removed' });
    patchCard(d.bot_id, d.review_seq, { status: 'removed' });
  }
}

export function draftsFor(userId: string) {
  return (db.prepare("SELECT * FROM plugin_drafts WHERE user_id=? AND status NOT IN ('dismissed') ORDER BY updated_at DESC LIMIT 50").all(userId) as DraftRow[]).map((d) => ({
    id: d.id, botId: d.bot_id, botName: getBotRow(d.bot_id)?.name ?? '', ...(JSON.parse(d.plan) as Plan), status: d.status,
    digest: d.digest ?? undefined, checks: d.checks ? JSON.parse(d.checks) : undefined, pluginId: d.plugin_id ?? undefined,
    submissions: d.submissions, createdAt: d.created_at, updatedAt: d.updated_at,
  }));
}

// ---------- Create plugin (the Plugins page in every app) ----------

/**
 * The owner's "Create plugin" on the Plugins page: their request goes into the picked bot's chat as
 * their own message, word for word what they see, and the bot answers with a plan card
 * (propose_plugin). Nothing is planned, built or installed by this call; the usual loop takes over.
 */
export function createPluginRequest(userId: string, botId: string, idea: unknown): { botId: string; text: string } {
  if (!isOwner(userId)) throw new PluginError('Only the owner of this server can make plugins.', 403);
  const b = getBotRow(botId);
  if (!b || b.user_id !== userId) throw new PluginError('Pick one of your Bots.', 404);
  if (b.kind === 'room') throw new PluginError('Pick a Bot, not a group chat.');
  const text = typeof idea === 'string' ? idea.trim() : '';
  if (text.length < 8) throw new PluginError('Say in a sentence or two what the plugin should do.');
  if (text.length > 2000) throw new PluginError('Keep the description under 2,000 characters.');
  return {
    botId,
    text: `Please make me a plugin: ${text}\n\nStart by showing me a plan card (propose_plugin) with its tools and the sites it needs. If something is unclear, ask me first. Nothing gets built until I press Build, and I review the code before anything is installed.`,
  };
}

const CODE_EXT = /\.(mjs|js|cjs|json|md|txt)$/;

/**
 * The files of a draft as checked, for the owner's code review (web, Windows, Android). The server's
 * own kit file is listed but not sent. `matches` says whether the files on disk still have the
 * fingerprint the review card shows.
 */
export function draftFiles(userId: string, draftId: string) {
  const d = ownedDraft(userId, draftId);
  const pkg = path.join(draftsDir(), d.id, 'package');
  if (!fs.existsSync(pkg)) return { draftId: d.id, title: (JSON.parse(d.plan) as Plan).title, status: d.status, digest: d.digest ?? '', matches: false, files: [] as { path: string; size: number; text: string | null }[] };
  const files = walk(pkg).filter((f) => CODE_EXT.test(f)).sort((a, b) => (a === 'package.json' ? -1 : b === 'package.json' ? 1 : a.localeCompare(b))).map((f) => {
    const full = path.join(pkg, f);
    const size = fs.statSync(full).size;
    if (f === 'cleftbot-mcp.mjs') return { path: f, size, text: null, kit: true };
    return { path: f, size, text: size <= 256_000 ? fs.readFileSync(full, 'utf8') : null };
  });
  let matches = false;
  try { matches = !!d.digest && treeDigest(pkg) === d.digest; } catch { /* unreadable: not a match */ }
  return { draftId: d.id, title: (JSON.parse(d.plan) as Plan).title, status: d.status, digest: d.digest ?? '', matches, files };
}
