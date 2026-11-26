# Shared provider catalog

Every bot the app runs ("managed" bots, and every new bot such as Raj) gets the same list of model
providers, kept in one place: `server/src/provider-catalog.ts`. Each bot picks its own default provider
and model, and its own fallbacks, in its settings (web, Windows and Android: Model tab, Providers).

## Three facts, kept apart

| Fact | Meaning | Where it comes from |
|---|---|---|
| Listed | The app offers this provider. Says nothing about keys or logins. | `CATALOG` |
| Access | The bot's agent has a key or login for it. Still not proof it works. | The shared key on the server, and what the bot's Hermes reports |
| Verified | One real request from **this bot's own agent** got an answer from that exact model. | **Check** button (`POST /api/bots/:id/engine/check`), stored in `provider_checks` |

A Check answered by a different model (a fallback) is recorded as failed, not verified. Error text is
scrubbed of anything that looks like a key or token. The Check request uses `store: false`, has every tool
refused, and writes nothing into the bot's conversations.

## Anthropic API and Claude subscription side by side

* **Claude API (Anthropic)**: the shared `ANTHROPIC_API_KEY` from the owner's Hermes `.env` is no longer
  put in a managed bot's environment. It goes into the bot's Hermes credential pool (`auth.json`, row
  labelled `cleft-shared-anthropic-api-key`, file mode 600). Hermes uses it from there.
* **Claude subscription (Claude Code, experimental)**: the `claude-subscription-directsdk-experimental`
  plugin (NousResearch/hermes-official-plugins). Its own safeguard refuses to run if any Anthropic key or
  token is in its environment. Because the key now lives in the pool, the safeguard stays on, unchanged.
  * Off for every bot by default. Only the owner can switch it on, per bot, after accepting the warning
    (terms appear to forbid this use; plan limits are shared; extra usage can be billed).
  * Never a silent fallback. It is only used where a bot's default or explicit fallback names it.
  * It signs in with a **separate bot-only Claude Code login** in `CLAUDE_LOGIN_DIR` (never the owner's
    own `~/.claude`). Bots that are not opted in point at an empty `no-claude-login` folder.
  * Its cost figures are the plugin's estimate at API list prices, not a bill.
* `auth.adopt_external_logins: false` is set for managed bots, so the API route can never borrow a
  Claude Code login.
* OAuth tokens (`ANTHROPIC_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) and the owner's `auth.json` sign-ins are no
  longer copied into bot homes. A new bot that wants ChatGPT or Nous signs in on its own.

## Fallbacks

Explicit, per bot, at most 3, stored in `bots.fallbacks` and written to the bot's `fallback_providers`.
An existing chain in a bot's config is adopted once so it stays visible. New bots start with none. With
none, a failed turn fails; nothing else is tried or billed. Changing them needs no restart.

## Picking the Claude subscription

The subscription is always in the Provider dropdown (web, Windows) and list (Android) of every bot the
app can set up, labelled "Off for this bot, choose to switch on" until the owner switches it on. Picking
it while off shows the warning with an "I understand" box; Save then switches it on and makes it the
default in one request (`allowSubscription` + `acknowledgeSubscriptionTerms`). It is never "Connected"
while off, and it has no Sign in button: it uses the bot-only login on the server.

## The owner's own agent (Howard)

Howard has the same settings as every bot: default provider and model, fallbacks, and the subscription
opt-in (`server/src/primary-providers.ts`). His Hermes home is the owner's hand-kept setup, so:

* Only what a setting names is written, and only when it changes. His default model is written only
  when it is changed in the app; until then his own (ChatGPT) stays. Comments and layout in his
  `config.yaml` are kept, and each file keeps its owner and mode.
* `config.yaml`, `.env` and `auth.json` are backed up first to `PRIMARY_BACKUP_DIR`
  (default `data/primary-backups/<time>/`, newest 30 kept), and one audit line (no secrets) goes to
  `/var/log/cleft-maintainer.log`.
* The subscription plugin's login points at an empty folder in his home unless it is switched on for
  him, so it never uses the owner's personal `~/.claude` login.
* Switching it on moves `ANTHROPIC_API_KEY` from his `.env` into his credential pool (same row label as
  the bots); the plugin refuses to run while it is in the environment. Nothing else in his `.env` is
  removed; other settings the plugin refuses are reported. The bots keep getting the shared key, now read
  from his pool. Switching it off does not move the key back (Hermes uses the pool either way).
* A change he only picks up on start (subscription on/off, key moved, new default provider) is not
  applied by restarting him at once. It is marked pending (settings say so), and the app runs
  `PRIMARY_RESTART_COMMAND` once no app turn runs, no approval card waits, and his session store has been
  quiet for 3 minutes. Without that setting the app never restarts him and settings say a restart is needed.
  Fallback changes need no restart.

## What is not changed

* Outside bots (Sheldon): no catalog, no credentials.
* Each bot's existing default provider and model, conversations, permissions and approval gates.

## Server settings (`.env`)

| Setting | Use |
|---|---|
| `PROVIDER_PLUGINS_DIR` | Model-provider plugins copied into every managed bot's home (default `data/provider-plugins`). |
| `CLAUDE_LOGIN_DIR` | The bot-only Claude Code login folder. Empty: the subscription shows "Not signed in". |
| `CLAUDE_CODE_BIN` | Path to the `claude` binary for the subscription plugin. |
| `PRIMARY_RESTART_COMMAND` | How the app restarts the owner's own agent when idle, e.g. `systemctl --user --machine=<user>@ restart hermes-gateway.service`. Empty: never restarted by the app. |
| `PRIMARY_BACKUP_DIR` | Where Howard's files are backed up before each write (default `data/primary-backups`). |
| `NEW_BOT_PROVIDER`, `NEW_BOT_MODEL` | Where a new bot starts when the owner's own default is a sign-in route bots do not share (default `anthropic` / `claude-sonnet-5`). Saved as the bot's own choice, changeable in its settings. |

Sign the bot-only login in once, on the server:

```
sudo CLAUDE_CONFIG_DIR=/opt/hq/claude-login /opt/build-host/claude-code/node_modules/.bin/claude auth login
```

## Upgrade

After deploy, each managed bot's agent is restarted once, when idle, so the key moves from its `.env`
into its pool (`.hq-provider-fp` records the setup an agent started with; `provider-runtime.ts` checks
every minute, 10-minute cooldown per bot).

## Rollback

1. `cleft-ops rollback` (or `cleft-ops deploy <previous sha>`): the previous build ignores the new
   columns and table.
2. Restore each managed bot's `.env`, `auth.json` and `config.yaml` from the deploy backup
   (`/opt/hq/deploy-<date>-providers/engines/<botId>/`), then restart those bots' agents from settings.
3. Optional: remove `CLAUDE_LOGIN_DIR`, `CLAUDE_CODE_BIN` from the app `.env`.
4. Howard: copy `config.yaml`, `.env` and `auth.json` back from the newest folder in
   `data/primary-backups/` from before the change (owned by the gateway's user, mode 600), then restart his gateway.

## Tests

`tests/provider-catalog.mjs` (helpers, migration of an existing bot, a new bot, isolation, persistence,
key rotation, primary untouched) and `tests/provider-catalog-e2e.mjs` (routes, opt-in rules, fallbacks,
Check). Both are hermetic and in `scripts/run-tests.mjs`.
