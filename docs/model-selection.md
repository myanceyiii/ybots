# Model selection: Manual and Auto

Each bot picks its model in **Settings → Engine**.

- **Manual** (the default): every turn uses the provider and model you set. This is how the app always worked.
- **Auto**: the provider stays fixed and each turn picks one of three tiers from how hard it looks:
  - **Light** for small talk, quick asks, system notices and short teammate replies.
  - **Standard** for most requests.
  - **Heavy** for planning, analysis, code, legal or financial work, and long requests, or when you ask it to think hard.
- **Only ever use this provider**: a lock. The server refuses any setting or turn on another provider.

The panel shows which model the last turn used and why. It also shows turns and tokens per tier for the last 7 days, so you can see whether Auto is saving anything.

## What Hermes already does (checked in Hermes v0.22.7 source)

| Feature | In v0.22.7? | Where |
|---|---|---|
| Per-request `provider` + `model` on `/v1/responses` | Yes. An explicit provider is always honoured. A bare model without a provider is honoured only when the API server sets `direct_model_requests`. That is why Auto requires a provider. | `gateway/platforms/api_server.py`, `_request_agent_overrides` |
| Precedence | Browser model lock, then a session `/model` override, then the session-persisted model, then `model_routes` alias, then per-request provider/model, then global default. If someone types `/model` inside a bot's chat, that wins over the app's choice for that conversation. | `_select_agent_runtime` |
| `model_routes` aliases (alias → provider/model) | Yes, in the API server's config | `_parse_model_routes` |
| Cheaper models for side jobs (compression, approval classifier, vision, curator and others) | Yes, under `auxiliary.<task>` in `config.yaml`. Default is the main model. | `hermes_cli/config_defaults.py`, docs `configuring-models.md` |
| A separate model for subagents | Yes, `delegation.model` / `delegation.provider` | same |
| Fallback chain when a provider fails | Yes, `fallback_providers` / `fallback_model` | docs `features/fallback-providers.md` |
| Routing by task difficulty | **No.** `smart_model_routing` is only a key the setup wizard writes as `enabled: false`. Nothing in v0.22.7 reads it at run time. | `hermes_cli/setup_quick.py`, `hermes_cli/config.py` |
| `provider_routing` | OpenRouter only (which upstream host serves a model). This is not difficulty routing. | docs `features/provider-routing.md` |

**Checked again on Hermes v0.23.3 (what runs on Host2), 2026-11-22.** Each turn first resolves the default route in the bot's own `config.yaml` (`_resolve_session_agent_runtime`). Only after that does it apply the provider and model sent with the turn (`prepare_api_runtime`, in `gateway/run_turn_runner.py`). So if the config's default provider has no sign-in, the turn fails before the request's provider counts. Leonard hit this ("No Codex credentials stored") when they were moved from ChatGPT to Claude. The app now writes a managed bot's chosen provider and model into its `config.yaml` (with a `.bak` copy) whenever they change and on every engine start. On a provider change it restarts that bot's agent once any running turn has finished. The primary agent (Howard's own Hermes) and a siloed bot (Sheldon's container) are left alone, so their configured provider must stay signed in.

Per-turn tier changes do take effect once the default route resolves. On Host2, a heavy turn for Leonard ran on `claude-opus-5-5` while their config's default was `claude-sonnet-5` (Hermes `state.db`, `sessions.model_config.gateway_runtime`).

Auto steps up a tier after a failed turn only when the failure looks like the model's fault. Sign-in, credential, quota, rate-limit, timeout and network errors don't escalate, because a bigger model wouldn't fix them.

So the difficulty router lives in this app (`server/src/model-router.ts`), and Hermes just receives the provider, model and reasoning effort for each turn.

## How Auto decides

- The check runs locally and costs no tokens. It looks at the turn's text: kinds of hard work, length, code or error output, how many parts it has, small talk, simple asks, and whether you asked for something brief. It also looks at where the turn came from (you, a routine, a teammate bot, a system notice).
- When unsure it picks Standard.
- After a failed turn it goes one tier up.
- It is sticky because Hermes' prompt cache is keyed to the model. Hermes' docs say any mid-conversation model change makes the next request re-read the whole conversation at full input price. So Auto goes up at once, but goes down only after two lighter turns in a row, or three once the conversation passes 20 turns. "New chat" starts fresh.
- A tier with no model uses the next tier up, then the manual (fallback) model.

## Suggested setup for the four bots

The "Use suggested tiers" button only offers models that the bot's own Hermes reports for its signed-in account (`GET /api/model/options`, the provider's `models` list). `server/src/model-router.ts` keeps a short, ordered list of candidates per tier (`TIER_CANDIDATES`), and `suggestTiers()` picks the first candidate per tier that is in Hermes' list. A tier with no match is left empty. If Hermes reports no list (not answering, not signed in), the button does not appear. The app never suggests a model it has not seen in that list.

As of 2026-11-22 on Host2 this gives:

| Bot | Provider | Light | Standard | Heavy | Lock |
|---|---|---|---|---|---|
| Leonard | `anthropic` (Claude) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | optional |
| Howard | `openai-codex` (ChatGPT) | gpt-6-luna | gpt-6.1-terra | gpt-6.2-sol | optional |
| Sheldon | `openai-codex`, signed in to the firm's ChatGPT inside his container | whatever his account reports | | | **on** |

Before this change the button used fixed ids from Hermes' offline fallback list. For the ChatGPT sign-in, gpt-5.4-mini and gpt-5.5 were not in the list the account reports. The panel also cut every provider's list at 12 models, which hid real ones such as claude-haiku-4-5-20251001 and made them look missing.

Sheldon's lock keeps him on `openai-codex`. What keeps him on the *firm's* account is that his container's Hermes is signed in only to that account. The app cannot see which ChatGPT account a sign-in belongs to.

## Other ways to keep costs down in Hermes (optional, not done here)

- Point `auxiliary.compression`, `auxiliary.approval` and `auxiliary.curator` at the light model. They default to the main model.
- Set `delegation.model` to the standard model so subagents don't inherit a heavy one.

These change each bot's Hermes `config.yaml`, so they are left for the owner to apply on the live machine.

## API

- `PATCH /api/bots/:id/engine` takes `{ provider?, model?, modelMode?: 'manual'|'auto', modelTiers?: { light|standard|heavy: { model, effort } } | null, providerLock?: string|null }`. It returns 400 if Auto has no provider, or if the provider breaks the lock.
- `GET /api/bots/:id/engine` also returns `modelMode`, `modelTiers`, `providerLock`, `tierPresets` and `lastRoute`.
- `GET /api/bots/:id/engine/usage?days=7` returns turns and tokens per tier and model.
- Bots (`GET /api/bots`, `bot` events) carry `modelMode`, `modelTiers` and `providerLock`.

## New bots get Auto tiers (2026-11-24)

A bot made in the app starts with `bots.tiers_seed = 1`. The first time its agent reports a model list,
the suggested tiers for its saved provider (`suggestTiers`, only ids that account lists) are saved and
Auto is switched on; its own model stays as the fallback. Nothing is guessed: with no list or no
candidates for that provider it stays as it is and tries again on the next start or settings visit.
Any save of the bot's model settings in the app clears the flag, so a person's choice is never
overwritten. Bots that existed before this on Manual with no tiers got the flag once (Raj).

The Claude subscription route (`claude-subscription-directsdk-experimental`, ids with `[1m]`) and
OpenRouter now have tier candidates, so "Use suggested tiers" appears for them. Choosing Auto with
empty tiers fills in the suggested ones on web, Windows and Android.

## Shared skills for every bot

`SHARED_SKILLS_DIR` (default `data/shared-skills`, outside Git) holds `<category>/<name>/SKILL.md`
folders every managed bot should have, such as `household/gbrain-shared-memory` and
`household/household-bot-coordination`. Each is copied into a bot's home once when its agent starts
(`installSharedSkills`); an existing copy is never overwritten and a removed one is not put back
(`skills/.shared-installed`).
