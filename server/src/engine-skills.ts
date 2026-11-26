import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { db } from './db.js';
import { env } from './env.js';
import { engineHome, engineKind } from './engine.js';
import { isSilo } from './silo.js';
import type { HermesSkill, HermesSkillDetail } from './types.js';

/**
 * A bot's real skills: the ones its Hermes agent keeps in `<home>/skills/[category/]<name>/SKILL.md`
 * (built-in, installed from the hub, or written by the bot or the person). The app lists them and lets
 * the person view, edit, create, delete and turn them off.
 *
 * Every read and change goes through Hermes' own skill code (server/box/hermes-skills.py, run with the
 * Python of the Hermes install that serves the bot, as the owner of its home), so validation, locks,
 * the audit ledger and usage records are Hermes' own. A change made here is the signed-in person's own
 * action, like an edit in Hermes' dashboard, so it is not staged for approval. A bot changing a skill
 * still goes through skill_manage and the approval card.
 */

export class SkillsError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 | 502 = 400) { super(message); }
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SKILL_CATEGORY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** "Weekly report!" -> "weekly-report": the folder name Hermes accepts. */
export function skillSlug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').replace(/-{2,}/g, '-').slice(0, 64);
}

// ---------- which Python runs Hermes for this bot ----------

interface Runtime { python: string; root: string }
const runtimes = new Map<string, Runtime | null>();

function onPath(bin: string): string | null {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, bin);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Hermes' launcher is a shell script: either a one-line shim (`exec /path/hermes "$@"`) or the real
 * launcher, which runs `exec <python3> -I -c '...sys.path.insert(0, '<agent root>')...'`.
 */
export function parseLauncher(file: string, depth = 0): Runtime | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 20000); } catch { return null; }
  const py = /^exec\s+(\/\S*python3[\d.]*)\s/m.exec(text);
  const root = /sys\.path\.insert\(0,\s*'"'"'([^']+)'"'"'\)|sys\.path\.insert\(0,\s*'([^']+)'\)/.exec(text);
  if (py && root) return { python: py[1], root: root[1] ?? root[2] };
  const shim = /^exec\s+("?)(\/[^"\s]+)\1\s+"\$@"/m.exec(text);
  return shim && depth < 4 ? parseLauncher(shim[2], depth + 1) : null;
}

function runtimeFor(home: string, primary: boolean): Runtime | null {
  const key = `${primary ? 'p' : 'm'}:${home}`;
  if (runtimes.has(key)) return runtimes.get(key)!;
  const candidates = [
    process.env.HERMES_SKILLS_LAUNCHER,
    // The primary agent is its own install; managed bots run on HERMES_BIN.
    primary ? path.join(home, 'hermes-agent', '.hermes', 'bin', 'hermes') : undefined,
    onPath(env.hermesBin) ?? undefined,
  ].filter(Boolean) as string[];
  let rt: Runtime | null = null;
  for (const c of candidates) if ((rt = parseLauncher(c))) break;
  runtimes.set(key, rt);
  return rt;
}

// ---------- running the bridge ----------

const BRIDGE = new URL('../box/hermes-skills.py', import.meta.url);
let bridgeCode: string | null = null;

export interface SkillsTarget { botId: string; home: string; runtime: Runtime }

/** Where this bot's skills live, or why the app cannot reach them. */
export function skillsTarget(botId: string): SkillsTarget | { reason: string } {
  if (isSilo(botId)) return { reason: 'This bot runs in its own walled-off container, so its skills are managed there.' };
  const kind = engineKind(botId);
  const home = engineHome(botId);
  if (!home || !kind) return { reason: 'This bot has no agent of its own, so it has no agent skills.' };
  if (!fs.existsSync(path.join(home, 'skills')) && !fs.existsSync(path.join(home, 'config.yaml'))) return { reason: "This bot's agent hasn't been set up yet." };
  const runtime = runtimeFor(home, kind === 'primary');
  if (!runtime) return { reason: "Couldn't find the Hermes install that runs this bot, so its skills can't be read from the app." };
  return { botId, home, runtime };
}

function bridge(t: SkillsTarget, req: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  bridgeCode ??= fs.readFileSync(BRIDGE, 'utf8');
  const st = fs.statSync(t.home);
  const asOwner = typeof process.getuid === 'function' && process.getuid() === 0 && st.uid !== 0;
  // Hermes writes skill files and its config as whoever runs it: run as the home's owner so the agent can keep editing them.
  const ownerHome = path.basename(t.home) === '.hermes' ? path.dirname(t.home) : process.env.HOME;
  return new Promise((resolve, reject) => {
    const child = spawn(t.runtime.python, ['-I', '-c', bridgeCode!, t.runtime.root], {
      cwd: t.home,
      // Only what Hermes needs: the server's own secrets stay out of the child.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8', HERMES_HOME: t.home, HOME: (asOwner ? ownerHome : process.env.HOME) ?? t.home },
      ...(asOwner ? { uid: st.uid, gid: st.gid } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new SkillsError('Hermes took too long to answer.', 502)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new SkillsError(`Couldn't start Hermes: ${e.message}`, 502)); });
    child.on('close', () => {
      clearTimeout(timer);
      let r: any;
      try { r = JSON.parse(out); } catch {
        console.warn(`[skills] bridge gave no answer for ${t.botId}: ${err.trim().split('\n').slice(-3).join(' | ')}`);
        return reject(new SkillsError("Hermes didn't answer. Try again in a moment.", 502));
      }
      if (r && typeof r === 'object' && 'error' in r) return reject(new SkillsError(String(r.error), r.status === 404 ? 404 : r.status === 500 ? 500 : 400));
      resolve(r);
    });
    child.stdin.end(JSON.stringify(req));
  });
}

// ---------- SKILL.md ----------

/** Split a SKILL.md into its frontmatter text (without the --- lines) and its body. */
export function splitSkill(content: string): { front: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  return m ? { front: m[1], body: m[2].replace(/^\r?\n/, '') } : { front: '', body: content };
}

function frontField(front: string, key: string): string {
  try {
    const v = YAML.parse(front)?.[key];
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
}

/** A SKILL.md with this name, description and body, keeping any other frontmatter of `previous`. */
export function buildSkill(name: string, description: string, body: string, previous?: string): string {
  const prev = previous ? splitSkill(previous) : { front: '', body: '' };
  let front: string;
  if (prev.front && frontField(prev.front, 'description') === description.trim() && frontField(prev.front, 'name') === name) {
    front = prev.front; // unchanged: keep it byte for byte
  } else {
    let doc: YAML.Document;
    try { doc = prev.front ? YAML.parseDocument(prev.front) : new YAML.Document({}); } catch { doc = new YAML.Document({}); }
    if (!YAML.isMap(doc.contents)) doc = new YAML.Document({});
    doc.set('name', name);
    doc.set('description', description.trim().replace(/\s+/g, ' '));
    front = doc.toString({ lineWidth: 0 }).trimEnd();
  }
  return `---\n${front}\n---\n\n${body.replace(/^\s*\n/, '').trimEnd()}\n`;
}

// ---------- the operations ----------

const listCache = new Map<string, { at: number; skills: HermesSkill[] }>();
const LIST_TTL = 15_000;

// ---------- the New marker: what the bot changed since the person last opened a skill ----------

function seenMap(botId: string): Map<string, number> {
  const rows = db.prepare('SELECT name, seen_at FROM skill_reviews WHERE bot_id=?').all(botId) as { name: string; seen_at: number }[];
  return new Map(rows.map((r) => [r.name, r.seen_at]));
}

/** The person opened or changed this skill here: it is no longer New. */
export function markSkillSeen(botId: string, name: string) {
  db.prepare('INSERT INTO skill_reviews(bot_id,name,seen_at) VALUES (?,?,?) ON CONFLICT(bot_id,name) DO UPDATE SET seen_at=excluded.seen_at').run(botId, name, Date.now());
}

/** Mark every skill of this bot as looked at. */
export function markAllSkillsSeen(botId: string) {
  db.prepare('DELETE FROM skill_reviews WHERE bot_id=?').run(botId);
  markSkillSeen(botId, '*');
}

function withNew(botId: string, skills: HermesSkill[]): HermesSkill[] {
  const seen = seenMap(botId);
  let base = seen.get('*');
  if (base === undefined) { markSkillSeen(botId, '*'); base = Date.now(); } // first look: start from now
  return skills.map((s) => ({ ...s, isNew: !!s.botChangedAt && s.botChangedAt > Math.max(base!, seen.get(s.name) ?? 0) }));
}

export async function listHermesSkills(t: SkillsTarget, fresh = false): Promise<HermesSkill[]> {
  const hit = listCache.get(t.botId);
  if (!fresh && hit && Date.now() - hit.at < LIST_TTL) return withNew(t.botId, hit.skills);
  const r = await bridge(t, { action: 'list' });
  const skills = (Array.isArray(r?.skills) ? r.skills : []).map((s: any): HermesSkill => ({
    name: String(s.name),
    description: String(s.description ?? ''),
    category: String(s.category ?? ''),
    source: ['own', 'builtin', 'hub', 'external'].includes(s.source) ? s.source : 'own',
    enabled: s.enabled !== false,
    uses: Number(s.uses) || 0,
    lastUsedAt: s.lastUsedAt ? Date.parse(s.lastUsedAt) || null : null,
    updatedAt: Number(s.updatedAt) || 0,
    botChangedAt: s.botChangedAt ? Date.parse(s.botChangedAt) || null : null,
    botAction: s.botAction === 'create' ? 'created' : s.botAction ? 'changed' : null,
    isNew: false,
  }));
  listCache.set(t.botId, { at: Date.now(), skills });
  return withNew(t.botId, skills);
}

/** The number of skills last read for a bot, without asking Hermes (null if never read). */
export const cachedSkillCount = (botId: string): number | null => listCache.get(botId)?.skills.length ?? null;

function toDetail(r: any): HermesSkillDetail {
  const content = String(r.content ?? '');
  const { front, body } = splitSkill(content);
  return {
    name: String(r.name),
    description: frontField(front, 'description'),
    body,
    content,
    category: String(r.category ?? ''),
    source: ['own', 'builtin', 'hub', 'external'].includes(r.source) ? r.source : 'own',
    enabled: r.enabled !== false,
    files: Array.isArray(r.files) ? r.files.map(String) : [],
  };
}

const checkName = (name: string) => { if (!SKILL_NAME.test(name)) throw new SkillsError('That is not a skill name Hermes uses.', 404); };

export async function viewHermesSkill(t: SkillsTarget, name: string): Promise<HermesSkillDetail> {
  checkName(name);
  const d = toDetail(await bridge(t, { action: 'view', name }));
  markSkillSeen(t.botId, d.name);
  return d;
}

export async function createHermesSkill(t: SkillsTarget, p: { name: string; category?: string; description: string; body: string }): Promise<HermesSkillDetail> {
  const name = skillSlug(p.name);
  if (!name || !SKILL_NAME.test(name)) throw new SkillsError('Give the skill a name, using letters or numbers.');
  const category = p.category ? skillSlug(p.category) : '';
  if (p.category && !SKILL_CATEGORY.test(category)) throw new SkillsError("That group name won't work. Use letters, numbers and dashes.");
  if (!p.description.trim()) throw new SkillsError('Say when the bot should use this skill.');
  if (!p.body.trim()) throw new SkillsError('Write the steps for this skill.');
  const r = await bridge(t, { action: 'create', name, category: category || undefined, content: buildSkill(name, p.description, p.body) });
  listCache.delete(t.botId);
  markSkillSeen(t.botId, name);
  return toDetail(r);
}

/** Save a skill: either the whole SKILL.md (`content`) or a new description and body. */
export async function saveHermesSkill(t: SkillsTarget, name: string, p: { content?: string; description?: string; body?: string }): Promise<HermesSkillDetail> {
  checkName(name);
  let content: string;
  if (typeof p.content === 'string') {
    content = p.content;
  } else {
    const cur = await viewHermesSkill(t, name);
    const description = p.description ?? cur.description;
    const body = p.body ?? cur.body;
    if (!description.trim()) throw new SkillsError('Say when the bot should use this skill.');
    if (!body.trim()) throw new SkillsError('Write the steps for this skill.');
    // Keep the name the file already carries (it can differ from the folder name).
    const fileName = frontField(splitSkill(cur.content).front, 'name') || name;
    content = buildSkill(fileName, description, body, cur.content);
  }
  if (!content.trim()) throw new SkillsError('The skill is empty.');
  const r = await bridge(t, { action: 'save', name, content });
  listCache.delete(t.botId);
  markSkillSeen(t.botId, name);
  return toDetail(r);
}

export async function deleteHermesSkill(t: SkillsTarget, name: string): Promise<void> {
  checkName(name);
  await bridge(t, { action: 'delete', name });
  listCache.delete(t.botId);
  db.prepare('DELETE FROM skill_reviews WHERE bot_id=? AND name=?').run(t.botId, name);
}

export async function setHermesSkillEnabled(t: SkillsTarget, name: string, enabled: boolean): Promise<void> {
  checkName(name);
  await bridge(t, { action: 'toggle', name, enabled });
  listCache.delete(t.botId);
}
