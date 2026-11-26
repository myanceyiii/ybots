// Web search by API (server/src/web-search.ts): the primary agent's search service, key and settings reach
// the bots the app runs, the owner's switch turns the web toolset off, the status never carries the key,
// and each bot's searches this month are counted from its Hermes history.
// Needs a built server: `npm run build -w server`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-'));
const primary = path.join(dir, 'h');
const engines = path.join(dir, 'engines');
fs.mkdirSync(primary, { recursive: true });
fs.writeFileSync(path.join(primary, 'config.yaml'), 'web:\n  backend: brave-free\n  search_backend: ""\n  extract_backend: ""\n  use_gateway: false\nmodel:\n  default: x\n');
fs.writeFileSync(path.join(primary, '.env'), 'BRAVE_SEARCH_API_KEY=secret-brave-key\nTELNYX_API_KEY=not-shared\n');
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: engines, SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', HERMES_HOME_PRIMARY: primary });
const { db } = await import('../server/dist/db.js');
const ws = await import('../server/dist/web-search.js');
// Groups add bots.kind (agent/rooms.ts); this test does not load the agent loop.
try { db.exec("ALTER TABLE bots ADD COLUMN kind TEXT DEFAULT 'agent'"); } catch { /* exists */ }

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };

const t = Date.now();
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u1','m@example.test','Alex',?)").run(t);
db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u2','k@example.test','Sam',?)").run(t);
const bot = (id, name, user, engine) => db.prepare("INSERT INTO bots (id, user_id, name, engine, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, user, name, engine, t, t);
bot('b_howard', 'Howard', 'u1', 'primary');
bot('b_leonard', 'Leonard', 'u1', 'managed');
bot('b_robin', 'Robin', 'u2', 'managed');
bot('b_sheldon', 'Sheldon', 'u1', null);

// Leonard's Hermes history: two searches and a page read this month, one search last year.
fs.mkdirSync(path.join(engines, 'b_leonard'), { recursive: true });
const h = new Database(path.join(engines, 'b_leonard', 'state.db'));
h.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, timestamp REAL)');
const now = Date.now() / 1000;
for (const [tool, ts] of [['web_search', now], ['web_search', now - 1], ['web_extract', now], ['web_search', now - 400 * 86400], ['terminal', now]]) {
  h.prepare("INSERT INTO messages (session_id, role, tool_name, timestamp) VALUES ('s','tool',?,?)").run(tool, ts);
}
h.close();

test('a bot gets the primary agent\'s search service and an hour of cache', () => {
  const cfg = { web: { extract_char_limit: 9000 }, agent: { disabled_toolsets: ['delegation'] } };
  ws.applyWebConfig(cfg, 'b_leonard');
  assert.equal(cfg.web.backend, 'brave-free');
  assert.equal(cfg.web.cache_ttl_minutes, 60);
  assert.equal(cfg.web.cache_enabled, true);
  assert.equal(cfg.web.extract_char_limit, 9000, 'keys we do not share are kept');
  assert.equal('use_gateway' in cfg.web, false, 'only the listed keys are copied');
  assert.deepEqual(cfg.agent.disabled_toolsets, ['delegation']);
});

test('switching it off disables the web toolset, and back on enables it', () => {
  db.prepare("UPDATE bots SET web_search=0 WHERE id='b_leonard'").run();
  const cfg = { agent: { disabled_toolsets: ['delegation'] } };
  ws.applyWebConfig(cfg, 'b_leonard');
  assert.deepEqual(cfg.agent.disabled_toolsets.sort(), ['delegation', 'web']);
  db.prepare("UPDATE bots SET web_search=1 WHERE id='b_leonard'").run();
  ws.applyWebConfig(cfg, 'b_leonard');
  assert.deepEqual(cfg.agent.disabled_toolsets, ['delegation']);
});

test('only search keys are shared, nothing else from the primary .env', () => {
  assert.deepEqual(ws.primarySearchEnv(), { BRAVE_SEARCH_API_KEY: 'secret-brave-key' });
});

test('the owner sees every bot with an engine here, use this month, and never the key', () => {
  const s = ws.webSearchStatus('u1', true);
  assert.equal(s.service, 'Brave Search API');
  assert.equal(s.keySet, true);
  assert.match(s.extract, /no key/);
  assert.deepEqual(s.bots.map((b) => b.name), ['Howard', 'Leonard', 'Robin'], 'Sheldon has no engine here');
  const leonard = s.bots.find((b) => b.name === 'Leonard');
  assert.equal(leonard.searches, 2);
  assert.equal(leonard.reads, 1);
  assert.equal(s.bots.find((b) => b.name === 'Howard').ownSetup, true);
  assert.equal(s.bots.find((b) => b.name === 'Robin').searches, null, 'no history yet');
  assert.equal(JSON.stringify(s).includes('secret-brave-key'), false);
});

test('anyone else sees only their own bots', () => {
  assert.deepEqual(ws.webSearchStatus('u2', false).bots.map((b) => b.name), ['Robin']);
});

test('no key: the keyless free tier is named', () => {
  fs.writeFileSync(path.join(primary, '.env'), '');
  fs.writeFileSync(path.join(primary, 'config.yaml'), 'model:\n  default: x\n');
  const s = ws.webSearchStatus('u1', true);
  assert.equal(s.keySet, false);
  assert.match(s.service, /no key/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
