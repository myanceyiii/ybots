import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import './db-config.js'; // bots.free_terminal

/**
 * The maintainer guard: how Hermes' terminal and file tools are decided for the maintainer bot (Howard).
 *
 * Howard administers the homelab and maintains YBots from the app, as the same Hermes and the same
 * Linux account he uses from the Hermes dashboard and Relay. Per-tool cards are too coarse for that:
 * either every `ls` asks, or one "Always allow" on the terminal lets `sudo rm -rf` through too. So for
 * the maintainer bot each terminal command and each file write is sorted into one of three kinds:
 *
 *  - `read`:   looks and changes nothing (ls, systemctl status, journalctl, git log, ssh <host> <one of
 *              these>, ...). Runs without a card.
 *  - `danger`: privileged, destructive, security-sensitive or across Sheldon's firm-data boundary (sudo,
 *              service changes, deploys, deletes, firewall, packages, secret files, ...). Always shows a
 *              card, which can never be "Always allow"ed, and a standing terminal rule does not cover it.
 *  - `other`:  everything else (building, testing, editing the working copy, git commit). The bot's
 *              ordinary rules apply: a card unless the owner has an "Always allow" for that tool.
 *
 * Writes inside the maintainer's working copies (~/cleft-work, ~/work) run without a card: changes reach
 * the live server only through a pull request and `cleft-ops deploy`, which is `danger`.
 *
 * This is a rule plus an audit trail, not a sandbox: the account still has sudo (Alex's decision), so
 * a script written into the working copy and then run is `other`. The patterns err towards asking.
 */

export type CommandKind = 'read' | 'danger' | 'other';
export interface Verdict { kind: CommandKind; reasons: string[] }

const botRow = (id: string) => db.prepare('SELECT id, name, engine FROM bots WHERE id=?').get(id) as { id: string; name: string; engine: string | null } | undefined;

/** Whether this bot gets the maintainer guard: the bots named in MAINTAINER_BOTS, else the primary bot. */
export function isMaintainer(botId: string | null | undefined): boolean {
  if (!botId) return false;
  const b = botRow(botId);
  if (!b) return false;
  const named = (process.env.MAINTAINER_BOTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (named.length) return named.includes(b.id.toLowerCase()) || named.includes(b.name.toLowerCase());
  return b.engine === 'primary';
}

const home = () => process.env.MAINTAINER_HOME || process.env.HERMES_HOME_PRIMARY?.replace(/\/\.hermes\/?$/, '') || os.homedir();

// ---------------------------------------------------------------------------
// Danger: checked on the whole command text, quotes and here-documents included, so a risky command
// hidden in `bash -c '...'` or `ssh host '...'` is still seen. A false match only means a card.

const DANGER: [RegExp, string][] = [
  [/(^|[^\w-])(sudo|doas|pkexec)(\s|$)|(^|[;&|]\s*)su(\s|$)/, 'runs as root'],
  [/(^|[^\w-])(reboot|shutdown|poweroff|halt)(\s|$)|systemctl\s+(reboot|poweroff|halt|kexec)/, 'restarts or powers off a machine'],
  [/systemctl\s+(--\S+\s+)*(start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|mask|unmask|kill|daemon-reload|daemon-reexec|isolate|edit|set-property|reset-failed|revert|link|preset)\b|(^|[^\w-])service\s+\S+\s+(start|stop|restart|reload)\b|loginctl\s+(terminate|kill|enable-linger|disable-linger)/, 'starts, stops or changes a service'],
  [/(^|[^\w-])(cleft-ops)\s+(deploy|rollback)\b/, 'deploys or rolls back the live Cleft server'],
  [/(^|[^\w-])hermes\s+(gateway\s+(stop|restart|install|uninstall)|update|uninstall|config\s+set|plugins?\s+(install|remove|enable|disable))\b/, 'changes the Hermes install or restarts its gateway'],
  [/git\s+(\S+\s+)*push\b[^\n;&|]*(\s--force\b|\s-f\b|\s--delete\b|\s-d\b|\s--mirror\b|\s\+|:\S*\b(main|master)\b|\s(origin\s+)?(main|master)\b)|git\s+(\S+\s+)*(reset\s+--hard|clean\s+-\w*f|filter-branch|filter-repo|update-ref\s+-d)\b/, 'force-pushes, pushes to main or rewrites git history'],
  [/(^|[^\w-])gh\s+(repo\s+(delete|archive|rename|edit)|release\s+delete|secret\b|variable\b|auth\b|ssh-key\b|gpg-key\b|ruleset\b)|gh\s+api\b[^\n;&|]*(-X|--method)\s*(DELETE|PUT|PATCH)/i, 'changes GitHub settings, secrets or deletes'],
  [/(^|[^\w-])(docker|podman)\s+(compose\s+)?(rm|rmi|stop|kill|restart|down|prune|system\s+prune|volume\s+rm|network\s+rm|image\s+rm|container\s+rm|update)\b/, 'stops or removes containers'],
  [/(^|[^\w-])(apt|apt-get|aptitude|dpkg|snap|flatpak|dnf|yum|pacman)\s+(\S+\s+)*(install|remove|purge|upgrade|dist-upgrade|full-upgrade|autoremove|-i|-r|-P|refresh)\b|npm\s+(\S+\s+)*(-g|--global)\b[^\n;&|]*\b(install|i|uninstall|rm)\b|pip3?\s+install\b[^\n;&|]*--break-system-packages/, 'installs or removes system software'],
  [/(^|[^\w-])(ufw|iptables|ip6tables|nft|firewall-cmd)\s|tailscale\s+(up|down|logout|set|serve|funnel|cert)\b|(^|[^\w-])ip\s+(link|addr|address|route|rule)\s+(add|del|delete|set|flush|change|replace)\b/, 'changes the firewall or network'],
  [/(^|[^\w-])(useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|visudo|chage|setfacl)\s|chown\s+(-\w*R|--recursive)|(^|[^\w-])ch(mod|own|grp)\s+[^\n;&|]*\s(\/etc|\/usr|\/boot|\/var|\/opt|\/root|~?\/\.ssh|\$HOME\/\.ssh)/, 'changes users or permissions'],
  [/(^|[^\w-])(dd|mkfs(\.\w+)?|fdisk|sfdisk|parted|wipefs|mount|umount|cryptsetup|shred|swapoff|lvremove|vgremove|zpool|zfs\s+destroy)\s/, 'touches disks or filesystems'],
  [/(^|[^\w-])(kill|pkill|killall)\s/, 'stops running programs'],
  [/crontab\s+(-\w*[re]\b|[^-\s|;&])/, 'changes scheduled jobs'],
  [/(^|[^\w-])rm\s+(-\S+\s+)*\S|(^|[^\w-])(rmdir|unlink|truncate)\s/, 'deletes files'],
  [/(curl|wget)\b[^\n;]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'runs a downloaded script'],
  [/(^|[^\w-])printenv\b|(^|[;&|]\s*)env\s*($|[|;&])|gh\s+auth\s+token|git\s+config\s+[^\n;&|]*credential/, 'prints secrets from the environment'],
  [/\bsheldon\b|\/silo\/|slack[-_]?(user|app)?[-_]?token|cleft-sheldon/i, "crosses Sheldon's firm-data boundary"],
];

/** Files that hold secrets: reading, copying or writing them always asks. */
const SECRET = /(^|[\/\s'"=<])(\.env(\.\w+)?|auth\.json|apps\.json|gate\.json|credentials(\.json)?|client_secret[\w.-]*|google_token[\w.-]*|hosts\.yml|\.netrc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)\b[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|kdbx)|shadow|gshadow|sudoers(\.d)?|hermes-relay-[\w-]*(secret|credentials)[\w.-]*|[\w.-]*authorization[\w.-]*|[\w.-]*_token)(?=$|[\s'"\/;|&)<>])|\/\.ssh(\/|\b)|\/\.gnupg\b|\/etc\/(cleft-bot|yancey-[\w-]+)\b/i;

/** Whether a command, path or pattern names a secret file (shared with hermes-mcp-tools.ts). */
export const touchesSecret = (text: string) => SECRET.test(text);

/** Paths a write (a redirection, write_file or patch) may not touch without a card. */
const PROTECTED = /^(\/etc|\/usr|\/boot|\/bin|\/sbin|\/lib|\/lib64|\/root|\/srv|\/opt|\/var(?!\/tmp)|\/sys|\/proc|\/dev(?!\/null))(\/|$)|\/\.hermes\/(config\.yaml|\.env|auth\.json|plugins|hermes-agent|SOUL\.md|memories)(\/|$)|\/\.(ssh|gnupg|config\/(gh|systemd|autostart))(\/|$)|\/\.(bashrc|profile|bash_profile|zshrc|bash_login)$/;

/** Hermes' own findings that only say a command is wrapped (its payload is checked separately). */
const CARRIER_ONLY = /via (-e\/-c|-c\/-lc) flag|via heredoc|^execute_code$/i;

// ---------------------------------------------------------------------------
// Read-only commands: every piece of a pipeline or && chain must be one of these.

const READ_ANY = new Set([
  'cd', 'ls', 'll', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'file', 'du', 'df',
  'free', 'uptime', 'hostname', 'hostnamectl', 'whoami', 'id', 'groups', 'date', 'uname', 'which', 'type', 'pwd', 'echo',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'column', 'nl', 'tree', 'realpath', 'readlink', 'basename', 'dirname', 'lsblk',
  'lscpu', 'lsusb', 'lspci', 'nproc', 'sensors', 'vmstat', 'iostat', 'mpstat', 'last', 'w', 'who', 'getent', 'dig',
  'nslookup', 'host', 'ping', 'ps', 'pgrep', 'pstree', 'ss', 'netstat', 'lsof', 'diff', 'cmp', 'md5sum', 'sha256sum',
  'timedatectl', 'nvidia-smi', 'findmnt', 'blkid', 'true', 'test', 'sleep', 'zcat', 'zgrep', 'xxd', 'od', 'strings',
]);
const READ_SUB: Record<string, RegExp> = {
  systemctl: /^((--user|--system|--no-pager|--all|-a|--full|-l|--plain|--failed|--type=\S+|--state=\S+|-n\s*\d+|--lines=\d+|--output=\S+|-o\s*\S+|--property=\S+|-p\s*\S+|--value)\s+)*(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|show|cat)\b/,
  journalctl: /^(?!.*--(vacuum|rotate|flush|sync|relinquish|setup-keys))/,
  git: /^(-C\s+\S+\s+)?(status|log|diff|show|rev-parse|describe|ls-files|ls-remote|blame|shortlog|fetch|remote(\s+(-v|show\b.*))?$|branch(\s+(-a|-r|-v|-vv|--list|--show-current|--contains\s+\S+|--merged|--no-merged))*\s*$|tag(\s+(-l|--list|--contains\s+\S+)\b.*)?\s*$|config\s+(--get|--list|-l)\b)/,
  docker: /^(compose\s+(ps|logs|config|ls|images)\b|ps|logs|inspect|images|image\s+ls|stats\s+--no-stream|version|info|network\s+(ls|inspect)|volume\s+(ls|inspect))\b/,
  podman: /^(ps|logs|inspect|images|stats\s+--no-stream|version|info)\b/,
  gh: /^(pr\s+(view|list|checks|diff|status)|run\s+(list|view|watch)|release\s+(list|view)|repo\s+view|issue\s+(list|view)|workflow\s+(list|view)|search\s+\S+|auth\s+status(?!.*(-t|--show-token)))\b/,
  tailscale: /^(status|ip|ping|netcheck|version|whois)\b/,
  ip: /^(-\w+\s+)*(a|addr|address|r|route|link|neigh|rule)(\s+(show|list|ls)\b.*)?\s*$/,
  'cleft-ops': /^(health|status)\b/,
  'cleft-release': /^status\b/,
  find: /^(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b)/,
  sed: /^(-n\s+|--quiet\s+|-E\s+|-r\s+)*(?!.*(-i\b|--in-place|\bw\s))/,
  hermes: /^(status|version|doctor|sessions\s+(list|show|search)|cron\s+(list|status)|skills\s+(list|view)|config\s+(get|show)|plugins\s+list|gateway\s+status)\b/,
  npm: /^(ls|list|view|outdated|audit(?!\s+fix)|config\s+get|run\s+(typecheck|lint|test)\b)/,
  node: /^(-v|--version)\s*$/,
  python3: /^(-V|--version)\s*$/,
  curl: /^(-[sSfLkI]+\s+|--silent\s+|--show-error\s+|--fail\s+|--max-time\s+\d+\s+|-m\s+\d+\s+)*https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w\/.?=&-]*\s*$/,
};
const SSH_OPT_WITH_VALUE = new Set(['-o', '-i', '-p', '-l', '-F', '-J', '-b', '-c', '-E', '-m', '-O', '-Q', '-S', '-W', '-w', '-L', '-R', '-D']);

/** Split on top-level |, ||, &&, ; and newlines, keeping quotes together. Null when it uses things we don't read through. */
function pieces(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '', q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { cur += ch; if (ch === q) q = null; else if (ch === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (cmd[++i] ?? ''); continue; }
    if (ch === '`' || (ch === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) || (ch === '<' && cmd[i + 1] === '(')) return null;
    if (ch === '<' && cmd[i + 1] === '<') return null; // here-documents
    if (ch === '>' || (ch === '&' && cmd[i + 1] === '>')) {
      // Only harmless redirections: 2>&1, >/dev/null, 2>/dev/null, &>/dev/null.
      const rest = cmd.slice(i);
      const m = /^(&>|>>?|>&)\s*(\/dev\/null|[12])(?=$|[\s;|&])/.exec(rest);
      if (!m) return null;
      cur += m[0]; i += m[0].length - 1; continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n' || ch === '&') {
      if (ch === '&' && cmd[i + 1] !== '&' && cmd[i - 1] !== '&' && !/[0-9>]$/.test(cur)) return null; // background job
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (q) return null;
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Words of one piece, quotes removed. */
function words(piece: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(piece))) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]));
  return out;
}

function pieceIsRead(piece: string, depth: number): boolean {
  const w = words(piece);
  if (!w.length) return true;
  const [cmd0, ...rest] = w;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd0)) return false; // VAR=x prefixes: not worth reading through
  const cmd = cmd0.replace(/^.*\//, '');
  const argText = rest.join(' ');
  if (cmd === 'ssh') {
    if (depth > 0) return false;
    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) i += SSH_OPT_WITH_VALUE.has(rest[i]) ? 2 : 1;
    const remote = rest.slice(i + 1).join(' ');
    if (!rest[i] || !remote.trim()) return false; // an interactive login
    const p = pieces(remote);
    return !!p && p.every((x) => pieceIsRead(x, depth + 1));
  }
  if (cmd === 'timeout') return rest.length > 1 && /^\d+[smh]?$/.test(rest[0]) && pieceIsRead(rest.slice(1).join(' '), depth);
  if (READ_ANY.has(cmd)) return true;
  const sub = READ_SUB[cmd];
  return !!sub && sub.test(argText);
}

/** Sort one terminal command. `hermesFindings` are Hermes' own dangerous-command findings, when the gate plugin sent them. */
export function classifyCommand(command: string, hermesFindings: string[] = []): Verdict {
  const cmd = String(command ?? '');
  const reasons = new Set<string>();
  for (const f of hermesFindings) if (typeof f === 'string' && f.trim() && !CARRIER_ONLY.test(f)) reasons.add(`Hermes flags it: ${f.trim().slice(0, 120)}`);
  for (const [re, why] of DANGER) if (re.test(cmd)) reasons.add(why);
  if (SECRET.test(cmd)) reasons.add('touches a secret file');
  // Redirections into protected places.
  for (const m of cmd.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)([~$\w\/.-]+)\1/g)) {
    const p = expand(m[2]);
    if (p !== '/dev/null' && PROTECTED.test(p)) reasons.add('writes to a system or Hermes config path');
  }
  if (reasons.size) return { kind: 'danger', reasons: [...reasons] };
  const p = pieces(cmd);
  if (p && p.length && p.every((x) => pieceIsRead(x, 0))) return { kind: 'read', reasons: [] };
  return { kind: 'other', reasons: [] };
}

function expand(p: string): string {
  const h = home();
  let s = p.replace(/^~(?=\/|$)/, h).replace(/^\$HOME(?=\/|$)/, h).replace(/^\$\{HOME\}(?=\/|$)/, h);
  if (!s.startsWith('/')) s = path.join(h, s); // relative paths are taken from the home folder (Hermes' cwd)
  return path.normalize(s);
}

/** The maintainer's working copies, where file edits run without a card. */
export function devRoots(): string[] {
  const h = home();
  const extra = (process.env.MAINTAINER_DEV_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(expand);
  return [path.join(h, 'cleft-work'), path.join(h, 'work'), ...extra];
}

/** Sort one write_file / patch target. */
export function classifyWrite(target: string): Verdict {
  if (typeof target !== 'string' || !target.trim()) return { kind: 'other', reasons: [] };
  const p = expand(target.trim());
  const reasons: string[] = [];
  if (SECRET.test(p)) reasons.push('touches a secret file');
  if (PROTECTED.test(p)) reasons.push('writes to a system or Hermes config path');
  if (/sheldon|\/silo\//i.test(p)) reasons.push("crosses Sheldon's firm-data boundary");
  if (reasons.length) return { kind: 'danger', reasons };
  if (devRoots().some((r) => p === r || p.startsWith(r + path.sep))) return { kind: 'read', reasons: [] };
  return { kind: 'other', reasons: [] };
}

/** Every path a patch call touches (Hermes' flat `path` shape and its V4A `patch` text). */
export function patchTargets(args: any): string[] {
  const out: string[] = [];
  if (typeof args?.path === 'string') out.push(args.path);
  if (typeof args?.file_path === 'string') out.push(args.file_path);
  const text = typeof args?.patch === 'string' ? args.patch : '';
  for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push(m[1].trim());
  for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.push(m[1].trim());
  if (/^\*\*\* Delete File:/m.test(text)) out.push('\u0000delete');
  return out;
}

/**
 * The maintainer guard's verdict for one Hermes tool call, or null when it has no opinion (other tools,
 * or a bot that is not a maintainer).
 */
export function maintainerVerdict(botId: string, tool: string, args: any, hermesFindings: string[] = []): Verdict | null {
  if (!isMaintainer(botId)) return null;
  if (tool === 'terminal') return classifyCommand(String(args?.command ?? ''), hermesFindings);
  if (tool === 'write_file') return classifyWrite(String(args?.path ?? args?.file_path ?? ''));
  if (tool === 'patch') {
    const targets = patchTargets(args);
    if (!targets.length) return { kind: 'other', reasons: [] };
    if (targets.includes('\u0000delete')) return { kind: 'danger', reasons: ['deletes files'] };
    const vs = targets.map(classifyWrite);
    const danger = vs.filter((v) => v.kind === 'danger');
    if (danger.length) return { kind: 'danger', reasons: [...new Set(danger.flatMap((v) => v.reasons))] };
    return vs.every((v) => v.kind === 'read') ? { kind: 'read', reasons: [] } : { kind: 'other', reasons: [] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Free-run (Alex, 2026-11-24: "Howard should be able to run terminal commands without asking.")
//
// While it is on, every terminal command of the maintainer bot runs without a card, sudo and deploys
// included. What stays: commands across Sheldon's firm-data boundary still ask; a stored "Don't allow"
// still wins; every command is written to Settings > Permissions (recently allowed) and to the maintainer
// audit log; output of commands that touch secret files is redacted before the model or the chat sees it
// (the gate plugin's transform_tool_result hook). The owner turns it off with one switch in the apps.

/** Whether this bot runs its terminal commands without a card: a maintainer bot with free-run on. */
export function freeTerminal(botId: string | null | undefined): boolean {
  if (!botId || !isMaintainer(botId)) return false;
  const r = db.prepare('SELECT free_terminal FROM bots WHERE id=?').get(botId) as { free_terminal?: number } | undefined;
  return (r?.free_terminal ?? 1) === 1;
}

export function setFreeTerminal(botId: string, on: boolean): void {
  db.prepare('UPDATE bots SET free_terminal=? WHERE id=?').run(on ? 1 : 0, botId);
}

/** The free-run verdict for a terminal command, or null when free-run does not apply. */
export function freeRunVerdict(botId: string, tool: string, args: any): { command: string; secret: boolean; reasons: string[] } | { firm: true; reasons: string[] } | null {
  if (tool !== 'terminal' || !freeTerminal(botId)) return null;
  const command = String(args?.command ?? '');
  if (FIRM.test(command)) return { firm: true, reasons: ["crosses Sheldon's firm-data boundary"] };
  const v = classifyCommand(command);
  return { command, secret: SECRET.test(command) || v.reasons.includes('prints secrets from the environment'), reasons: v.reasons };
}

const FIRM = /\bsheldon\b|\/silo\/|slack[-_]?(user|app)?[-_]?token|cleft-sheldon/i;

/**
 * A command as it is written to logs: values that look like credentials are masked, so a command such as
 * `export TOKEN=abc123...` or `curl -H "Authorization: Bearer ..."` does not put the secret in a log.
 */
export function redactCommand(cmd: string): string {
  return String(cmd ?? '')
    .replace(/((?:authorization|x-api-key|api[-_]?key)\s*[:=]\s*(?:bearer\s+|basic\s+|token\s+)?)("?)[^\s"']{6,}/gi, '$1$2***')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***')
    .replace(/(--?(?:token|password|passwd|secret|api-key|key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, '***')
    .replace(/(\/\/[^\s:@\/]+:)[^\s@\/]+@/g, '$1***@');
}

const auditPath = () => process.env.MAINTAINER_LOG || '/var/log/cleft-maintainer.log';

/** One line in the maintainer audit log (the file cleft-ops writes). Best effort: a log that cannot be written never blocks. */
export function maintainerAudit(actor: string, action: string, result: string, detail: string): void {
  const clean = (s: string) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '¦').slice(0, 1500);
  const line = `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} | ${clean(actor)} | ${clean(action)} | ${clean(result)} | ${clean(detail)}\n`;
  try { fs.appendFileSync(auditPath(), line, { mode: 0o644 }); } catch { /* not writable here (tests, a non-root server) */ }
}
