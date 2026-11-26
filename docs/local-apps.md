# Local apps (in place of Composio)

This fork removes Composio. The bots reach your apps through **MCP servers you run on the same
machine**, listed in `apps.json`. Nothing about your apps (sign-ins, tokens, email, documents)
goes through a hosted integration service.

## What Composio did, and what replaces it

| Composio did | This fork does it with |
|---|---|
| Catalog of app actions the model can call | Each MCP server's own tool list |
| OAuth sign-in and token storage on its servers | Each MCP server signs in itself and keeps its tokens on this machine |
| Running the actions | The MCP server calls the app's API directly from this machine |
| Event triggers ("new email") | Scheduled routines that check for new items (e.g. every 15 minutes) |
| Read/write labels for approval cards | `apps.json` rules plus the server's `readOnlyHint` annotations |
| Google sign-in to the web app | Sign-in links from `scripts/sign-in-link.sh` on the server |

## How it works

```
Hermes agent ──MCP──> cleft-bot /mcp/<bot> ──approval check──> local MCP server ──> app API
                         (this server)     (cards in chat)    (apps.json)
```

Every bot's Hermes engine already talks to this server's `/mcp` endpoint (loopback only). Tools from
the apps in `apps.json` are added to that endpoint as `<app id>__<tool name>`, for example
`m365__send-mail`. Because they go through `/mcp`, every call passes the approval check first.

Servers are started on first use and restarted at most every 30 seconds after a failure. Edit
`apps.json` and the change is picked up on the next call; apps whose entry changed are restarted.
Each server's log lines appear in the server log as `[app:<id>]`.

## apps.json

Copy `apps.example.json` to `apps.json` in the repo root (or point `APPS_CONFIG` at another path).
It is in `.gitignore`. `${NAME}` anywhere in `command`, `args`, `env`, `url`, `cwd` and `headers` is
replaced with that environment variable, so secrets can stay in `.env`.

| Field | Meaning |
|---|---|
| `id` | Lower-case letters, digits and dashes. The tool-name prefix. |
| `name`, `description`, `logo` | What the app list and approval cards show. |
| `command`, `args`, `env`, `cwd` | A stdio server this machine starts. |
| `url`, `headers` | A streamable-HTTP server. Must be on this machine unless `"remote": true`. |
| `allow` | Tool-name patterns that run without asking. `*` matches anything. |
| `ask` | Patterns that ask every time; "Always allow" on the card cannot switch them off. |
| `block` | Patterns that never run. |
| `trustReadOnlyHints` | Tools the server marks read-only run without asking. Default `true`. |
| `enabled` | `false` keeps the entry but does not start the server. |
| `timeoutMs` | How long one call may take. Default 120000. |

### The approval check, in order

1. `block` match: refused. `ask` match: asks, every time.
2. What you chose on an earlier approval card: "Always allow" runs it; a block refuses it.
3. `allow` match, or the server marks the tool read-only: runs.
4. Anything else: asks.

A tool name that is not a tool of a running app is refused. The card lists the call's arguments,
nested fields included (`message.subject: ...`), so you see what is about to be sent.

Stored choices are listed, and can be removed, under Settings → Permissions in the web app.

## Microsoft 365 (Outlook, calendar, OneDrive, Teams)

The example uses [Softeria's ms-365-mcp-server](https://github.com/softeria/ms-365-mcp-server).

1. In Microsoft Entra, register an app for your tenant (public client, device-code flow allowed)
   and give it the delegated Graph permissions the bots need. Put its IDs in `.env`:
   `MS365_CLIENT_ID=...` and `MS365_TENANT_ID=...`.
2. Sign in once, on the server, as the account the bots will act for, with the same token paths as
   `apps.json`:
   ```bash
   mkdir -p ~/.cleft-bot
   MS365_MCP_CLIENT_ID=... MS365_MCP_TENANT_ID=... \
   MS365_MCP_TOKEN_CACHE_PATH=~/.cleft-bot/m365-token-cache.json \
   MS365_MCP_SELECTED_ACCOUNT_PATH=~/.cleft-bot/m365-account.json \
   npx -y @softeria/ms-365-mcp-server --org-mode --login
   ```
3. The example allows `list-*`, `get-*` and `search-*` and blocks `delete-*`; sending mail,
   creating events and everything else asks. Add `--read-only` to `args` to remove write tools
   entirely, or `--enabled-tools <regex>` to expose fewer.

Check that server's README for its current flags; they change between versions.

## Your own systems (case management, document management)

Write a small MCP server over the system's API (any language with an MCP SDK), run it on this
machine and add it to `apps.json`. Start with `"ask": ["*"]` and loosen it once you trust it.

## Reacting to new items without triggers

Ask a bot for something like "every 15 minutes on weekdays, check the intake mailbox for new
messages and summarize anything new for me". It makes a routine (visible and pausable in the app)
that checks through its apps and stays silent when nothing is new. Routines made with Composio
triggers by the original Bot HQ are kept but no longer fire; the startup log says how many.

## EXTRA_MCP_SERVERS

Upstream's `EXTRA_MCP_SERVERS` handed MCP servers straight to each extra bot's Hermes engine, where
their calls skipped the approval check. YBots now serves them like `apps.json` entries, named
`extra-<name>` (for example `extra-my-tools__search`), so every call passes the approval check and
the per-bot switches. Old copies are taken out of each managed bot's Hermes config the next time it
is written. Prefer `apps.json` for new servers: it can set `allow`, `ask` and `block` rules.

## Plugin fields

Every entry in `apps.json` is a plugin of kind `mcp-app`. These optional fields describe it further
(see `docs/plugins.md`):

| Field | Meaning |
|---|---|
| `kind` | `"mcp-app"`, the only kind that runs code. Anything else is skipped. |
| `version` | The exact version or full git commit it is pinned to. |
| `bots` | Bot ids or names that get it by default, or `["*"]`. Without it a hand-written entry goes to every bot. |
| `exclusive` | `true`: at most one bot may have it on (for a firm-only app, say). |
| `network` | Sites it says it talks to, shown to the owner. |

## What still leaves this machine

- **Model calls.** Whatever Hermes is set to use. With the ChatGPT sign-in (`hermes model` →
  ChatGPT/Codex subscription), prompts, tool results and screenshots go to OpenAI under that
  account. A local model server keeps them here.
- **Nothing for the bots' screens.** They are virtual displays on this machine (`COMPUTER=local`,
  the default). Only `COMPUTER=orgo` uses Orgo's cloud computers.
- **Nothing for voice.** Speech goes to the local speech server (docs/voice.md).
- **xAI.** Only when `XAI_API_KEY` is set (the `x_search` tool). Leave it empty and it is off.
- **Whatever each MCP server talks to.** The Microsoft 365 server talks to Microsoft Graph, as any
  Outlook client would.
