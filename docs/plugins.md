# Plugins

YBots borrows the "everything is a plugin" idea from the DeepSeek harness, but keeps two hard
rules from this project:

- **Only the owner approves.** A plugin can make an approval rule stricter, never looser, and can
  never answer an approval card. A message from a bot, or anything a plugin or bot produces, is never
  an approval.
- **Plugin code runs on the server side, out of process.** The apps (web, Windows, Android) only show
  what plugins add, from data. No plugin code runs on a phone or PC.

## What a plugin is

Every entry in `apps.json` is a plugin of kind `mcp-app`: a local MCP server whose tools the bots
call through this server's `/mcp` endpoint, where every call passes the approval check. Plugins also
come from `EXTRA_MCP_SERVERS` (served as `extra-<name>`) and from installs through the app.

| Field | Meaning |
|---|---|
| `kind` | `"mcp-app"`, the only kind that runs code. Anything else is skipped. |
| `version` | The exact version or full git commit it is pinned to. |
| `bots` | Bot ids or names that get it by default, or `["*"]`. |
| `exclusive` | `true`: at most one bot may have it on. |
| `network` | Sites it says it talks to, shown to the owner. |

## Which bot gets which plugin

1. The owner's switch for that plugin and bot, if there is one.
2. Otherwise the plugin's `bots` field.
3. Otherwise: hand-written entries (`apps.json`, `EXTRA_MCP_SERVERS`) go to every bot, as they
   always did. Plugins installed through the app go to **no** bot until the owner turns them on.

A bot never sees the tools of a plugin it does not have on, `list_apps` shows it only its own, and a
call to such a tool is refused even if "Always allow" was stored for it. An `exclusive` plugin can be
on for one bot only; turning it on for a second bot is refused until it is turned off for the first.
Use it for anything firm-only, so it stays with Sheldon. Every switch is recorded in `plugin_audit`.

## The approval check

For a call to a plugin's tool (`agent/tools.ts`, `policyFor`):

1. The plugin is off for the calling bot: **refused**.
2. `apps.json` rules and the MCP server's read-only hints: `block` refuses, `ask` always asks, `allow`
   and read-only tools run, anything else asks.
3. What the user stored on a card ("Always allow" or "Don't allow") applies to the non-fixed cases.
4. **Approval stages** (`plugins/policy.ts`) registered by code in this repository may then say `ask`
   or `block`. The strictest answer wins. A stage that says `allow` is ignored, and a stage that
   throws counts as `block`. When a stage asks, the card offers no "Always allow".

A plugin installed through the app cannot loosen its own rules either: its `allow` patterns and its
server's read-only hints are ignored, so each of its tools asks until the owner chooses "Always allow"
on a card. Its `ask` and `block` patterns still apply.

Cards are answered only by the signed-in user, in the app or by voice on their own call
(`agent/loop.ts`, `resolveApproval`). No plugin, stage or bot can answer one.

## Installing, removing and switching plugins

Only the owner does this, from the signed-in app, in two steps (`plugins/changes.ts`, routes under
`/api/plugins`):

1. **Propose** (`POST /api/plugins/changes`, `{action, ...}` with action `enable`, `disable`,
   `install`, `remove` or `restore`). The server works everything out first and returns a pending
   change: a plain summary, details, and a digest. Nothing changes yet.
2. **Confirm** (`POST /api/plugins/changes/:id/confirm`, `{digest}`). The same owner, within 10
   minutes, with the digest they were shown. The server applies it and returns what the database now
   says. Confirming twice returns the first result. `.../cancel` drops it.

The owner is the account whose email is `OWNER_EMAIL`, or, when that is not set, anyone signed in to
a server that only listens on this machine. No bot tool proposes or confirms a change.

### What an install checks

- From npm the package must be given as `name@exact-version`; `npm pack --ignore-scripts` fetches it
  and nothing in it runs. A local `file:/abs/path.tgz` works only with `PLUGINS_ALLOW_LOCAL_TARBALLS=1`.
- Refused: links, install scripts (`preinstall`, `install`, `postinstall`, `prepare`), `binding.gyp`,
  dependencies without an `npm-shrinkwrap.json`, a version that is not exact, more than 5000 files or
  50 MB. Pinned dependencies are fetched with `npm ci --ignore-scripts`.
- The tree digest (sha256 over every file's sha256 and path) is shown on the card, checked again on
  confirm, and again after the files move to `PLUGINS_DIR/installed/<id>@<version>-<digest>`.
- An optional `cleftbot-plugin.json` in the package gives `name`, `entry`, `network`, `ask`, `block`
  and `exclusive`. An `allow` there is ignored.
- The plugin lands **switched off** for every bot (unless the owner picked bots on the same card).
  Older versions stay on disk, so Remove and Restore are one confirm each.

### How an installed plugin runs

In a container: `docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges
--user 65534:65534 --memory 512m --pids-limit 128 --network none` with the package mounted read-only
(`PLUGIN_RUNTIME`, default `docker`; `PLUGIN_RUNTIME_IMAGE`, default `node:22-slim`). A plugin whose
manifest lists sites gets the default bridge network; the list is shown to the owner but not enforced
host by host. None of the server's environment is passed in, and its command is not `${VAR}`-expanded.
`PLUGINS_UNSANDBOXED=1` runs it as a plain node process; that is for tests only.

## Hermes' own tools

Hermes' built-in tools (terminal, write_file, patch, the browser, computer_use, delegate_task, ...)
never pass through `/mcp`, so they are gated by a Hermes plugin of ours,
`server/hermes-plugins/cleft-bot-gate`: a `pre_tool_call` hook that asks `POST /mcp/<bot>/gate`
(loopback only, the bot's `/mcp` token) before each call. The server (`plugins/hermes-gate.ts`):

1. lets read-only tools run (`read_file`, `search_files`, `web_search`, `web_extract`, `skill_view`, ...);
2. applies what the owner stored on a card for `hermes__<tool>` ("Always allow" / "Don't allow");
3. otherwise shows an approval card and waits (25 minutes, like every card);
4. runs the approval stages, which can only make it stricter.

A tool the list does not know asks. Tools served by this server (`mcp__hq__*`) are checked at `/mcp`
and pass the hook. The hook fails closed: no answer, a bad answer or a missing `gate.json` blocks.

Managed bots get the plugin in their Hermes home automatically (`plugins.enabled`, and
`approvals.timeout: 1560` so Hermes waits as long as a card does). `HERMES_GATE=0` turns that off.
The hook runs inside the Hermes process (Hermes' default `plugins.isolation: in_process`), which
lets it tell Hermes that it is waiting on a person. The primary Hermes agent is not managed by this
server: run `bash scripts/install-hermes-gate.sh` on its machine and add the two lines it prints.
Because that Hermes also serves Telegram, the dashboard, cron and so on, its gate only checks turns
that arrive through the API server (`platforms` in `gate.json`), and the server only gates them while
the app has a turn running for that bot. Everything else keeps Hermes' own approval rules.

## What a plugin can show in the apps

Plugins add UI as **data**, never code (`server/src/plugins/ui-schema.ts`, shared by the server and
every app; web imports it as `@shared/plugins/ui-schema`):

- **Cards in a conversation.** A tool returns `structuredContent: { cleftbot_card: { title, subtitle?,
  blocks } }`. Blocks: `heading`, `text`, `fields`, `table`, `link` (https only), `image` (https or a
  small png/jpeg/gif/webp data URL), `progress`, `badge`. The server validates the card, drops unknown
  keys and refuses anything else; a refused card is simply not shown. A plugin card has no buttons
  that act. Approval cards are never plugin-defined.
- **A settings form.** `settings` in `cleftbot-plugin.json`: fields of type `text`, `secret`,
  `boolean`, `number` or `select`. The owner fills it in on the Plugins page
  (`PUT /api/plugins/:id/settings`). The plugin gets the values as `CLEFTBOT_SETTING_<KEY>`
  environment variables (passed to docker by name, never on its command line) and restarts. The apps
  are never sent a stored secret back, only whether it is set.

## Making a plugin with a Bot

A Bot can help write a plugin, but it can never install one (`server/src/plugins/builder.ts`):

1. **Plan.** The Bot calls `propose_plugin` (title, purpose, tools and whether each changes things,
   the sites it needs). A plan card appears in the conversation. Nothing is built.
2. **Build.** Only the owner's Build button (`POST /api/plugins/drafts/:id/build`) starts it. That
   authorizes building this plan, nothing else; the Bot gets a notice with the rules.
3. **Files.** The Bot sends the files with `submit_plugin_draft`, refused before Build, from another
   Bot, or after install. Rules: an ES module package, exact version, no dependencies or scripts,
   `index.mjs` built on the plugin kit (`server/plugin-kit/cleftbot-mcp.mjs`, which the server adds
   itself), at most 40 text files and 512 KB.
4. **Checks**, run by the server in the sandbox (no network, read-only, none of the server's
   environment): the package rules, network names only from the plan, a secret scan, a dry run whose
   tools must match the plan exactly, and its `test.mjs` if it has one. Every submission is committed
   to a git repository in `PLUGINS_DIR/drafts/<id>`. Failures go back to the Bot (8 tries).
5. **Review.** A review card shows the checks, notes (for example "it uses the network"), the tools,
   the files and the fingerprint. Only the owner's Install, sent with that fingerprint
   (`POST /api/plugins/drafts/:id/install`), installs it, through the same install path as npm
   packages: switched off, or on for the Bots ticked on the card. Undo removes it; Restore on the
   Plugins page brings it back.

### Where to find it in the apps

The same screens in all three apps (the Windows app shows this server's web app, so it gets them
with every server update; Android has its own screens in `mobile/src/screens/Plugins.tsx` and
`PluginCode.tsx`):

- **Plugins in the side menu.** Web and Windows: a Plugins entry under Tasks in the sidebar (with a
  count of plans and built plugins waiting on the owner), and in the account menu. Android: Plugins
  in the profile sheet, and Create plugin in the + menu.
- **The Plugins page**: every plugin with a switch per Bot, Details (status, which tools only read
  and which ask first, network, where it runs, fingerprint, history), its settings form, Remove and
  Restore, install from npm, and the plugins made with a Bot with their status.
- **Create plugin.** Pick a Bot and say what the plugin should do (`POST /api/plugins/create`). The
  request goes into that Bot's chat as the owner's own message, word for word, and the app opens the
  chat; the Bot answers with a plan card. Nothing else happens until Build.
- **View code.** On the review card and the Plugins page (`GET /api/plugins/drafts/:id/files`, owner
  only): every file the Bot wrote as the server checked it, with a note when the files on disk no
  longer match the card's fingerprint. The server's own kit file is listed but not shown.

Plan and review cards are not approval cards: voice cannot answer them, and a Bot's message is never
taken as an answer. Only the server owner can build or install, and only for their own Bots' plans.
Without Docker (and without `PLUGINS_UNSANDBOXED=1`) the checks cannot run, so nothing passes.
