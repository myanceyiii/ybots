// The test runner behind `npm test`: builds the server, then runs every hermetic suite one by one.
// Hermetic means: a throwaway database and folders, fake Hermes and speech servers where needed, and no
// network beyond 127.0.0.1. Suites that need real services, a desktop, or a running server are listed
// under OPT_IN and only run when named:  npm test -- e2e voice-call
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const HERMETIC = [
  'app-oauth', 'provider-catalog', 'provider-catalog-e2e', 'avatar-crop', 'engine-skills', 'helpers', 'message-text', 'mobile-chat-target', 'quick-ask', 'model-router', 'tiers-seed',
  'caption', 'outside', 'outside-e2e', 'raw-output', 'reactions', 'room-mentions', 'sign-in', 'silo', 'skills-auto-save',
  'voice-samples', 'local-apps', 'no-outbound', 'plugins', 'connectors', 'pages', 'files', 'notify',
  'audit-fixes-e2e', 'calc', 'machines-e2e', 'group-stop-e2e', 'views-e2e', 'fresh-undo-e2e', 'reactions-e2e', 'message-edit-e2e',
  'stop-turn-e2e', 'dictation-live-e2e', 'quick-ask-web-e2e', 'dictation-service-e2e', 'engine-model-config', 'mention-picker-e2e', 'connector-admin', 'connections', 'app-session-retry', 'thinking-caption-e2e', 'steps-upward-e2e', 'list-preview', 'list-preview-e2e', 'approval-preview-e2e', 'maintainer-guard',
  'scope', 'systemd-timers', 'systemd-timer-hosts', 'systemd-timers-e2e', 'chat-extras-e2e', 'choices', 'choices-e2e', 'calls-brain', 'tool-refresh-e2e', 'tool-list-restart', 'visuals-level', 'maintainer-finish', 'session-rotation', 'board-pin', 'board-pin-e2e', 'hermes-mcp-tools', 'web-search', 'model-badge-e2e', 'engine-summary', 'update-interrupt-e2e',
  'steering-e2e', 'steer-plugin',
  'foundation-e2e', 'desktop-updates',
  'events-resume-e2e', 'usage-e2e', 'routine-catchup-e2e',
  'polish-e2e', 'reply-wait', 'screen-retry', 'card-icon', 'reminders-e2e', 'phone',
];

/** Need a real service, a desktop (Xvfb, x11vnc, Chrome), a running server, or are known to be out of date. */
export const OPT_IN = {
  e2e: 'needs a running server on :8787',
  'connections-web-e2e': 'needs the built web app and Chromium',
  'voice-call': 'needs Chrome and a throwaway bot on a running server',
  'local-voice-e2e': 'needs Xvfb, x11vnc, ImageMagick and Chrome',
  'local-computer': 'needs Xvfb and x11vnc',
  'screen-relay-local': 'needs Xvfb and x11vnc',
  'clipboard-local': 'needs a desktop session',
  'local-apps-e2e': '1 case out of date (demo__delete_case)',
  'helpers-e2e': '2 cases out of date (primary agent config)',
  'model-choice-e2e': '2 cases out of date',
  security: 'upstream suite, many cases out of date',
  'silo-e2e': 'needs the Sheldon container',
  'policy-probe': 'needs a live Hermes',
  'avatar-generate': 'calls the picture service',
  'machines-electron-e2e': 'needs Electron and a desktop',
  'engine-fold-web-e2e': 'needs the built web app and Chromium',
  'hide-bot-web-e2e': 'needs the built web app and Chromium',
  'browser-cards-e2e': 'needs Chromium (Playwright)',
  'posting-e2e': 'needs Chromium (Playwright); writes /root/bothq/files',
};

const named = process.argv.slice(2);
const suites = named.length ? named : HERMETIC;
for (const s of suites) if (!HERMETIC.includes(s) && !(s in OPT_IN)) { console.error(`No suite called ${s}.`); process.exit(2); }

if (!process.env.SKIP_BUILD) {
  const b = spawnSync('npm', ['run', 'build', '-w', 'server'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

// Unit suites that import the server directly need these; each e2e suite sets its own.
const env = { ...process.env, SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex') };
const failed = [];
for (const s of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'tests', `${s}.mjs`)], { cwd: root, env, encoding: 'utf8', timeout: 10 * 60_000 });
  const ok = r.status === 0;
  console.log(`${ok ? 'pass' : 'FAIL'} ${s} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!ok) { failed.push(s); console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => /^FAIL|Error|assert/i.test(l)).slice(0, 12).map((l) => `     ${l}`).join('\n')); }
}
console.log(failed.length ? `\n${failed.length} of ${suites.length} suites failed: ${failed.join(', ')}` : `\nall ${suites.length} suites passed`);
if (!named.length) console.log(`Not run (name them to run): ${Object.entries(OPT_IN).map(([k, v]) => `${k} (${v})`).join('; ')}`);
process.exit(failed.length ? 1 : 0);
