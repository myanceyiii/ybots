# Helpers (sub-agents)

A bot's Hermes can hand parts of a big job to **helpers**: short-lived child agents started with
Hermes' own `delegate_task`. Each helper starts with a clean context, works on its own and reports a
summary back, so the bot's own conversation stays small. Hermes runs them; the app only reads and
writes the owner's settings in the bot's Hermes `config.yaml` and lists recent runs.

Code: `server/src/helpers.ts`, routes in `server/src/routes-config.ts`, screens in
`web/src/components/config/HelpersTab.tsx` (web and the Windows app) and the Helpers tab of
`mobile/src/screens/BotSettings.tsx` (Android). Test: `node tests/helpers.mjs` after `npm run build -w server`.

## What the owner sets (bot settings → Helpers)

| Setting | Hermes key |
|---|---|
| Use helpers on/off | `agent.disabled_toolsets` without/with `delegation` |
| Helpers at once (1-10) | `delegation.max_concurrent_children` |
| Steps per helper (10-250) | `delegation.max_iterations` |
| Models helpers may run on: Fast, Standard, Deep (the app's light, standard and heavy tiers) | `delegation.backends.model_map.options` (routes `fast`, `standard`, `deep`), all on the bot's own provider |
| Strongest model a helper may use | routes above it are not written at all, so the bot cannot pick them |
| Model when the bot doesn't pick | `delegation.backends.model_map.default`, and `delegation.model` / `provider` / `reasoning_effort` |

Picking a route per job needs the official `advanced-delegation` Hermes plugin in that Hermes home
(`hermes plugins install advanced-delegation --enable`). Without it every helper runs on the default
route and the backend is set to `default`, so the cap still holds.

Only the bot's own models are offered and accepted: its manual model, its Auto tiers (Model tab) and
the main model in its Hermes config, narrowed to what its Hermes lists for the signed-in account
(`helperModels`). A helper can never run on a model its bot isn't allowed to use. When Hermes reports
no list, only the bot's own models are kept.

## Who has helpers (Host2, 2026-11-23)

| Bot | At once | Steps | Routes (default first) |
|---|---|---|---|
| Howard | 4 | 60 | standard gpt-6.1-terra, fast gpt-6-luna |
| Leonard | 2 | 60 | fast claude-sonnet-5, standard claude-opus-5-5 (max) |
| Doug | 2 | 60 | his main model (no tiers set) |

Leonard runs on Host2, whose CPU is the known bottleneck, so it gets 2 at once.

## Tested: the approval gate covers helpers

A helper is a Hermes child agent in the same process; its tool calls go through the same
`pre_tool_call` hook, so `cleft-bot-gate` asks before each one exactly as for the bot. Tested live on
2026-11-23 by asking Leonard to start a helper that tried gated actions: every
`write_file`, `terminal` and Actual write by the helper raised its own approval card, and was
refused when the card was refused. A helper of a bot with read-only Actual saw only the 36 read-only Actual tools, because
`mcp__hq__*` tools are served by this server with the bot's own token and its own policy.

Howard's gate has a `platforms` filter (his Hermes also serves Telegram and others). A helper
started during an app turn keeps the parent's session platform, so it is gated too: tested the same
day, Howard's helper's `write_file` and `terminal` each raised a card and were stopped.
