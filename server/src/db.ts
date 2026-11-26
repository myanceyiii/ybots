import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { emptyDbRefusal } from './db-guard.js';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
// Never come up on an empty database while one with the accounts sits beside it (db-guard.ts).
const refusal = emptyDbRefusal(env.dbPath);
if (refusal) {
  console.error(`[db] ${refusal}`);
  throw new Error(refusal);
}
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// A second reader or writer (a backup, a snapshot, a deploy's copy) waits its turn instead of failing at once.
db.pragma('busy_timeout = 5000');
// With the write-ahead log, NORMAL keeps the database consistent through a crash and writes far less often.
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  provisional_user_id TEXT NOT NULL,
  connected_account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orgo_id TEXT,
  status TEXT NOT NULL DEFAULT 'absent',
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Idempotent column migrations for tables that predate a column.
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'luna'");
// 1 = the owner hid this bot from their own view (Alex hid a bot): not in their list, no notifications to their
// main profile. Not the `hidden` column, which marks helpers (sub-bots) and takes them off the team. Scoped sign-ins ignore it.
addColumn('bots', 'owner_hidden', 'INTEGER NOT NULL DEFAULT 0');
// 1 = the routine posts only when it found something; a run with nothing to report leaves no message (routines.ts).
addColumn('routines', 'quiet', 'INTEGER NOT NULL DEFAULT 1');
addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
addColumn('bots', 'voice_language', "TEXT NOT NULL DEFAULT 'auto'");
// Hermes engine: per-bot model choice, which engine runs the bot ('primary' = the existing agent,
// 'managed' = a gateway we start), and the managed gateway's port.
addColumn('bots', 'model', 'TEXT');
addColumn('bots', 'provider', 'TEXT');
addColumn('bots', 'engine', 'TEXT');
addColumn('bots', 'engine_port', 'INTEGER');
addColumn('bots', 'handback_at', 'INTEGER');
// Model choice (model-router.ts): 'manual' uses model/provider as set; 'auto' picks one of the tiers
// in model_tiers (JSON) per turn. provider_lock, when set, is the only provider a turn may use.
// auto_state is the router's memory for the current conversation.
addColumn('bots', 'model_mode', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('bots', 'model_tiers', 'TEXT');
addColumn('bots', 'provider_lock', 'TEXT');
addColumn('bots', 'auto_state', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS model_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  tier TEXT,
  provider TEXT,
  model TEXT,
  reason TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS model_turns_bot_at ON model_turns(bot_id, at);
`);
// Shared provider catalog (provider-catalog.ts). claude_subscription = 1 once the owner switched the
// experimental Claude Code subscription route on for this bot (off for every bot until then).
// fallbacks = the bot's explicit fallback chain, JSON [{provider, model}] in order; NULL = never set
// (the chain in its Hermes config is adopted once, so an existing one stays visible and unchanged).
addColumn('bots', 'claude_subscription', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'fallbacks', 'TEXT');
// Real requests made from a bot's own agent to check that a provider and model answer (Check in settings).
db.exec(`
CREATE TABLE IF NOT EXISTS provider_checks (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  PRIMARY KEY (bot_id, provider, model)
);
`);
addColumn('screens', 'width', 'INTEGER');
addColumn('screens', 'height', 'INTEGER');
// JSON list of the tools an approval card asked about: "Always allow" stores a policy for each of
// them and for nothing else (older rows have none and only `tool`).
addColumn('approvals', 'tools', 'TEXT');
// Hash of exactly what an approval card showed (tool, listed tools, arguments). An answer that names a
// different hash is refused, so a phone can only approve the action it displayed (see approvalDigest).
addColumn('approvals', 'digest', 'TEXT');
// A picture that replaces the bot's shape (generated or uploaded), as a data URL. Served to the owner only.
addColumn('bots', 'avatar_image', 'TEXT');
// Looks (avatars.ts): pictures a bot offered on a look card (kept=1 once chosen, so its reveal card
// keeps working; the others are dropped after two weeks), the poses made from its picture, and the
// state of making them (JSON, AvatarPoseJob).
db.exec(`
CREATE TABLE IF NOT EXISTS avatar_candidates (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  image TEXT NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS avatar_candidates_bot ON avatar_candidates(bot_id, created_at);
CREATE TABLE IF NOT EXISTS avatar_poses (
  bot_id TEXT NOT NULL,
  pose TEXT NOT NULL,
  image TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, pose)
);
`);
addColumn('bots', 'avatar_pose_job', 'TEXT');
// Picture runs started from a bot's Look settings (avatars.ts). Kept in the database so a run survives a
// server restart (it is started again) and so an app that was closed or in the background finds its
// pictures when it comes back. `ask` is the LookRequest (JSON); `candidates` the avatar_candidates ids
// (JSON). `seen_at` is set once an app has shown the result; runs are dropped after a day.
db.exec(`
CREATE TABLE IF NOT EXISTS picture_runs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  ask TEXT NOT NULL,
  state TEXT NOT NULL,
  candidates TEXT,
  error TEXT,
  resumes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS picture_runs_bot ON picture_runs(bot_id, created_at);
`);
// 1 = the session was made with the owner key (POST /api/auth/owner or its sign-in link). Such a
// session is not held to ALLOWED_EMAILS; sessions from before this column count as ordinary ones.
addColumn('auth_sessions', 'owner', 'INTEGER NOT NULL DEFAULT 0');
// The Access address of the person who started the session (or the session that made its sign-in link),
// when known. Only used to show their name (DISPLAY_NAMES); who may do what is still decided by user_id.
addColumn('auth_sessions', 'person', 'TEXT');
// Set when the session belongs to a script or another program (a Claude thread, a test), not a person: the
// name it is shown under. Such a session can never answer an approval card, and what it writes into a chat
// is labelled with this name instead of looking like the person typed it. Sessions made straight from the
// owner key (POST /api/auth/owner without `link`) are scripts on the server by definition.
// Sessions from before this column are all counted as people's: phones signed in with a sign-in link
// (owner, no person) look exactly like scripts' sessions, and marking them scripts locked people out.
addColumn('auth_sessions', 'agent', 'TEXT');
// Groups (agent/rooms.ts) keep their kind and members on the bot row. The columns are made here as well as in
// initRooms, because store.ts reads `kind` for every bot: a module that loads the store without the rooms
// module (a script, a test) would otherwise fail on a fresh database.
addColumn('bots', 'kind', "TEXT NOT NULL DEFAULT 'agent'");
addColumn('bots', 'members', 'TEXT');
// Signed-in devices (sessions.ts): when the session was last used (kept to the day), and what it said it
// was when it signed in ("Chrome on Windows", "YBots for Android"), so a person can tell their devices apart.
addColumn('auth_sessions', 'last_seen_at', 'INTEGER');
addColumn('auth_sessions', 'device', 'TEXT');
// Who answered an approval card: their name, where from (web, Windows app, phone app, notification, voice
// call) and what they are ('person' only; scripts are refused). Empty for cards answered before this.
addColumn('approvals', 'answered_by', 'TEXT');
addColumn('approvals', 'answered_via', 'TEXT');
// Emoji reactions to the bot's messages since its last turn (JSON list), told to it at the start of its next
// turn as feedback (routes.ts /reactions, agent/loop.ts). Never an approval.
addColumn('bots', 'pending_feedback', 'TEXT');
// Side chats (side-chats.ts): extra conversations with one bot that run alongside its main chat. A side
// chat is a hidden bots row whose `side_of` is the bot it belongs to; it has its own rows, history, live
// state, queue and approval cards, and borrows everything else (name, look, model, engine, computer,
// files, memory) from that bot (store.ts getBotRow). `chat_titled` = 1 once the title is set (by hand
// or from the first message); `chat_deleted_at` marks a deleted one that Undo can still bring back.
addColumn('bots', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'side_of', 'TEXT');
addColumn('bots', 'chat_title', 'TEXT');
addColumn('bots', 'chat_titled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'chat_deleted_at', 'INTEGER');
// A bot's colour in chats (chat-colors.ts), set in its settings; NULL = picked for it (assignChatColors).
addColumn('bots', 'chat_color', 'TEXT');
// How often the bot uses answer views, calculators, tap choices and Pages (visuals-level.ts); NULL = the default (rich).
addColumn('bots', 'visuals', 'TEXT');
// What a message sent while the bot works does (steer-mode.ts): steer | queue | interrupt; NULL = steer.
addColumn('bots', 'busy_send', 'TEXT');
// Web search by API (web-search.ts): NULL or 1 = on, 0 = the owner switched the bot's web_search/web_extract off.
addColumn('bots', 'web_search', 'INTEGER');
// Phone timers and alarms (phone.ts): 1 = on, 0 = off, NULL = on for Leonard only.
addColumn('bots', 'phone_actions', 'INTEGER');

// PCs paired through the Windows app (machines.ts). `public_key` is the PC's Ed25519 key (SPKI, base64);
// `person` is who paired it, and when set only their sessions see the PC. `bots` is the JSON list of
// bot ids that may use it. A removed PC keeps its row with `revoked_at` so its key never works again.
db.exec(`
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person TEXT,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  bots TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS machine_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  bot_id TEXT,
  tool TEXT NOT NULL,
  approval_id TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
`);

// Lookups that ran without an index: a bot's waiting cards (asked on every turn step), a bot's routines and
// tasks, a bot's memories, and the side chats of a bot (asked for every row of the chat list).
db.exec(`
CREATE INDEX IF NOT EXISTS approvals_bot_status ON approvals(bot_id, status);
CREATE INDEX IF NOT EXISTS routines_bot ON routines(bot_id);
CREATE INDEX IF NOT EXISTS tasks_bot ON tasks(bot_id, updated_at);
CREATE INDEX IF NOT EXISTS memories_bot ON memories(bot_id);
CREATE INDEX IF NOT EXISTS bots_user ON bots(user_id);
CREATE INDEX IF NOT EXISTS bots_side_of ON bots(side_of);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS rows_kind ON rows(bot_id, generation, kind, seq);
`);

// 1 = the bot has not had its Auto tiers chosen yet: the first time its agent reports a model list, the
// suggested tiers for its provider are saved and Auto is switched on (engine.ts seedTiers). Any change
// to the bot's model settings in the app clears it, so a choice made by a person is never overwritten.
{
  const had = (db.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).some((c) => c.name === 'tiers_seed');
  addColumn('bots', 'tiers_seed', 'INTEGER NOT NULL DEFAULT 0');
  // Bots made before this existed on manual with no tiers at all (Raj, 2026-11-24) get the same once.
  // The owner's own agent (is_primary) and helpers keep what they have.
  // Helpers and side chats have no agent port of their own, so engine_port leaves them out.
  if (!had) db.exec("UPDATE bots SET tiers_seed=1 WHERE model_mode='manual' AND model_tiers IS NULL AND COALESCE(is_primary,0)=0 AND engine_port IS NOT NULL AND side_of IS NULL AND COALESCE(kind,'agent')='agent'");
}

export const now = () => Date.now();
