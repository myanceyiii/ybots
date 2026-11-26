import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** A secret from NAME, or from the file named by NAME_FILE (so keys need not sit in .env). */
function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  throw new Error(`Missing env ${name} (or ${name}_FILE)`);
}

/** NAME or NAME_FILE when set, else empty. */
function optionalSecret(name: string): string {
  return process.env[name] || process.env[`${name}_FILE`] ? secret(name) : '';
}

/**
 * Where the bots' screens live: `local` (Xvfb displays on this machine, see local-computer.ts) or
 * `orgo` (a computer at orgo.ai). COMPUTER picks one; unset = orgo when an Orgo key is set, else local.
 */
const computer: 'local' | 'orgo' = process.env.COMPUTER === 'local' || process.env.COMPUTER === 'orgo'
  ? process.env.COMPUTER
  : process.env.ORGO_API_KEY || process.env.ORGO_API_KEY_FILE ? 'orgo' : 'local';

/**
 * SESSION_SECRET signs sessions, the agents' /mcp tokens and the owner sign-in key, so a guessable
 * one (the placeholder from .env.example, or anything short) would let anyone in.
 */
function sessionSecret(): string {
  const v = req('SESSION_SECRET');
  if (/^change-me/i.test(v) || v.length < 16) {
    throw new Error('SESSION_SECRET is the example placeholder or too short. Set it to a long random value, e.g. `openssl rand -hex 32`.');
  }
  return v;
}

/** True for http(s)://localhost, 127.x.x.x and [::1] URLs. */
export function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/** CLEFTBOT_<name>, or BOTHQ_<name> / GROKBOT_<name> as set up before the project was renamed. */
export function compatEnv(name: string): string | undefined {
  return process.env[`CLEFTBOT_${name}`] ?? process.env[`BOTHQ_${name}`] ?? process.env[`GROKBOT_${name}`];
}

/**
 * Default database file. One made under an earlier name (data/bothq.db, data/grokbot.db) keeps being used,
 * and a larger earlier one wins over a new-name file: on 2026-11-23 an empty data/cleftbot.db appeared beside
 * the real bothq.db and the next restart opened the empty one, so every bot but the default one vanished.
 */
function defaultDbPath(): string {
  const current = new URL('../../data/cleftbot.db', import.meta.url).pathname;
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return -1; } };
  for (const old of ['bothq.db', 'grokbot.db']) {
    const legacy = new URL(`../../data/${old}`, import.meta.url).pathname;
    if (size(legacy) > 0 && size(legacy) > size(current)) return legacy;
  }
  return current;
}

/** https://<team>.cloudflareaccess.com from a team name, host or URL; empty stays empty. */
function teamDomain(v: string): string {
  const t = v.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!t) return '';
  return `https://${t.includes('.') ? t : `${t}.cloudflareaccess.com`}`;
}

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');
const appUrl = process.env.APP_URL ?? 'http://localhost:5173';

export const env = {
  port: Number(process.env.PORT ?? 8787),
  /**
   * Interface to listen on. Unset = this machine only (127.0.0.1) while APP_URL is a local address,
   * so a development server is not offered to the whole network; otherwise every interface (what an
   * Orgo public URL needs). HOST, when set, always wins.
   */
  host: process.env.HOST || (isLoopbackUrl(appUrl) ? '127.0.0.1' : undefined),
  appUrl,
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Other addresses the web app is opened from (comma-separated), such as a public hostname in front of APP_URL. */
  extraOrigins: (process.env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** The app is only reachable at a local address (development). Some conveniences are limited to this. */
  localOnly: isLoopbackUrl(appUrl),
  /** Optional. Empty = no voice modes and no x_search tool, and nothing is sent to xAI. */
  xaiKey: process.env.XAI_API_KEY ?? '',
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  computer,
  /** Only for COMPUTER=orgo. */
  orgoKey: computer === 'orgo' ? secret('ORGO_API_KEY') : optionalSecret('ORGO_API_KEY'),
  sessionSecret: sessionSecret(),
  /** Email-only sign-in for testing. Honoured only when APP_URL is a local address (see routes.ts). */
  devLogin: process.env.DEV_LOGIN === '1' && isLoopbackUrl(appUrl),
  dbPath: process.env.DB_PATH ?? defaultDbPath(),

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../data/engines', import.meta.url).pathname,
  // Skills every bot the app runs should have (household memory and coordination rules): each
  // <category>/<name>/SKILL.md folder here is copied once into every managed bot's home (engine.ts).
  // Kept outside Git because the household skills hold private routines.
  sharedSkillsDir: process.env.SHARED_SKILLS_DIR ?? new URL('../../data/shared-skills', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /**
   * Shared provider catalog (provider-catalog.ts). Model-provider plugins every managed bot gets a copy
   * of, one folder each (data/provider-plugins/<plugin name>). Code only, never credentials.
   */
  providerPluginsDir: process.env.PROVIDER_PLUGINS_DIR ?? new URL('../../data/provider-plugins', import.meta.url).pathname,
  /**
   * The Claude Code login the experimental subscription route uses (a CLAUDE_CONFIG_DIR made with
   * `claude auth login`). Only bots the owner switched the route on for are pointed at it; the app
   * never reads, copies or refreshes what is inside. Empty = the route is not signed in anywhere.
   */
  claudeLoginDir: (process.env.CLAUDE_LOGIN_DIR ?? '').trim(),
  /**
   * How the app restarts the owner's own agent (Howard) after a provider change that needs it, e.g.
   * `systemctl --user --machine=me@ restart hermes-gateway.service`. Run only when that agent is idle.
   * Empty = the app never restarts it and settings say a restart is needed.
   */
  primaryRestartCommand: (process.env.PRIMARY_RESTART_COMMAND ?? '').trim(),
  /** The Claude Code executable for that route, when it is not on the agents' PATH. */
  claudeCodeBin: (process.env.CLAUDE_CODE_BIN ?? '').trim(),
  // Where a new bot starts when the owner's own default is a sign-in the bots don't share (ChatGPT, Nous).
  newBotProvider: (process.env.NEW_BOT_PROVIDER ?? 'anthropic').trim(),
  newBotModel: (process.env.NEW_BOT_MODEL ?? 'claude-sonnet-5').trim(),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  // ---- the one shared computer ----
  /** The Orgo computer every bot works on (one screen each). Empty = legacy one-box-per-user mode is not supported. */
  // With local screens the computer is this machine; its id is just 'local'.
  orgoComputerId: computer === 'local' ? 'local' : process.env.ORGO_COMPUTER_ID ?? '',
  /** This server runs on that computer, so shell commands run locally instead of through Orgo's API. */
  localBox: computer === 'local' || process.env.HQ_LOCAL === '1',
  /** Local screens: size of each display, and where their state (pids, VNC password) is kept. */
  localResolution: /^\d{3,5}x\d{3,5}$/.test(process.env.LOCAL_RESOLUTION ?? '') ? process.env.LOCAL_RESOLUTION! : '1280x800',
  localStateDir: process.env.LOCAL_STATE_DIR ?? new URL('../../data/computer', import.meta.url).pathname,
  /**
   * DevTools URL of a Chrome that already runs on the default screen and belongs to the primary bot
   * (e.g. http://127.0.0.1:9333). When set, we never start or stop that screen's Chrome ourselves.
   */
  primaryCdpUrl: process.env.PRIMARY_CDP_URL ?? '',
  /** Bots that can each have a screen (Orgo allows four screens on one Linux computer). */
  maxBots: Number(process.env.MAX_BOTS ?? 4),
  /**
   * Bot names that may never use a paired PC (docs/remote-pc.md), from PC_BLOCKED_BOTS.
   */
  pcBlockedBots: [...new Set([...(process.env.PC_BLOCKED_BOTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)])],
  /**
   * Comma-separated emails allowed to sign in. Empty = anyone, but only while APP_URL is a local
   * address; on a public URL an empty list lets nobody in, and a session whose address is not on
   * the list stops working (see routes.ts maySignIn, lib/auth.ts userFromToken).
   */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * The account of whoever runs the computer. Only its bots may be bound to the agent that already
   * lives there (the primary engine: that agent's memory, its messaging, the main screen). Unset =
   * any account while APP_URL is a local address (development), no account on a public URL (see
   * engine.ts mayUsePrimary).
   */
  ownerEmail: (process.env.OWNER_EMAIL ?? '').trim().toLowerCase(),
  /**
   * Optional. An OpenAI-compatible images endpoint (`.../v1/images/generations`) for generating bot
   * avatars, such as a local image server or a proxy in front of one. Empty = "Generate" is off and
   * avatars can only be uploaded. AVATAR_IMAGE_KEY is sent as a bearer token when set.
   */
  avatarImageUrl: process.env.AVATAR_IMAGE_URL ?? '',
  avatarImageModel: process.env.AVATAR_IMAGE_MODEL ?? '',
  avatarImageKey: process.env.AVATAR_IMAGE_KEY ?? '',
  // ---- sign-in through Cloudflare Access (see lib/cf-access.ts) ----
  /** The Access team, as https://<team>.cloudflareaccess.com (a bare team name or host is accepted). Empty = off. */
  cfAccessTeamDomain: teamDomain(process.env.CF_ACCESS_TEAM_DOMAIN ?? ''),
  /** The Access application's AUD tag (comma-separated when one app is reached through more than one Access app). */
  cfAccessAud: (process.env.CF_ACCESS_AUD ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Where the team's signing keys are read from; default <team domain>/cdn-cgi/access/certs. */
  cfAccessCertsUrl: process.env.CF_ACCESS_CERTS_URL ?? '',
  /**
   * Which app account an Access address signs in to, when they differ: `access@x=account@y,...`. For an
   * install whose account was made under another address. Unlisted addresses sign in as themselves.
   */
  cfAccessAccounts: new Map((process.env.CF_ACCESS_ACCOUNTS ?? '').split(',').map((p) => p.split('=').map((s) => s.trim().toLowerCase())).filter((p) => p.length === 2 && p[0].includes('@') && p[1].includes('@')) as [string, string][]),
  /**
   * Names to show for addresses: `address=Name,...`. An address can be a person's Access address (shown
   * as "signed in as Alex" on that person's devices) or an account's own address (shown when the
   * device's session does not know who signed it in, e.g. `owner@example.com=Alex & Sam`). Display
   * only: it changes no account, permission or what the bots are told. Unlisted: the account's name.
   */
  displayNames: new Map((process.env.DISPLAY_NAMES ?? '').split(',').map((p) => { const i = p.indexOf('='); return i < 0 ? [] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }).filter((p) => p.length === 2 && p[0].includes('@') && p[1]) as [string, string][]),
  /**
   * People who see only some bots: `address=Bot|Other Bot,...` (bot names, any case). Every session that
   * person starts (Access sign-in, a sign-in link or QR they make, a device they pair) lists, opens and
   * hears about only those bots and their side chats; the rest of the account answers 403 or is left out
   * (lib/scope.ts). Unlisted people see the whole account. The bots themselves are unchanged: a scoped
   * person's bot still talks to the others through the team's own channels.
   */
  scopedPeople: new Map((process.env.SCOPED_PEOPLE ?? '').split(',').map((p) => { const i = p.indexOf('='); return i < 0 ? [] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).split('|').map((n) => n.trim().toLowerCase()).filter(Boolean)]; }).filter((p) => p.length === 2 && (p[0] as string).includes('@') && (p[1] as string[]).length) as [string, string[]][]),
  /** The address behind Access, shown on the sign-in page of other addresses ("open <this> to sign in"). */
  cfAccessAppUrl: (process.env.CF_ACCESS_APP_URL ?? '').replace(/\/+$/, ''),
  /**
   * Phones' Cloudflare Access service tokens, by the person's address: `address=/path/to/file.env,...`.
   * Each file is the one scripts/sign-in-link.sh reads (CFA_ID, CFA_SECRET, optional APP_SCHEME), kept
   * root-only on the server. With CF_ACCESS_APP_URL set, a "Sign in another device" link made by that
   * person's own (non-script) session points at the public address and carries their phone's token in
   * the #fragment, so the phone app reaches the server through Access with no VPN. Read at link time,
   * so a renewed token needs no restart. Unlisted people get the plain link (APP_URL).
   */
  phoneAccess: new Map((process.env.CF_ACCESS_PHONE_TOKENS ?? '').split(',').map((p) => { const i = p.indexOf('='); return i < 0 ? [] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }).filter((p) => p.length === 2 && p[0].includes('@') && p[1].startsWith('/')) as [string, string][]),
  /** Put the approval gate plugin into every managed bot's Hermes home (default on; HERMES_GATE=0 turns it off). */
  hermesGate: (process.env.HERMES_GATE ?? '1') !== '0',
};

if (process.env.DEV_LOGIN === '1' && !env.devLogin) {
  console.warn('[env] DEV_LOGIN=1 is ignored because APP_URL is not a local address. Use scripts/sign-in-link.sh instead.');
}
if (!env.localOnly && !env.allowedEmails.length) {
  console.warn('[env] ALLOWED_EMAILS is empty and APP_URL is public: nobody can sign in with Google, and only sign-ins made with scripts/sign-in-link.sh keep working. Set ALLOWED_EMAILS to let people in.');
}
if (!env.localOnly && !env.ownerEmail) {
  console.warn("[env] OWNER_EMAIL is not set and APP_URL is public: no new bot is bound to the computer's own agent, each gets an agent of its own. Set OWNER_EMAIL to the account that should have it.");
}
