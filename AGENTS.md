# Notes for coding agents

This file is for AI coding agents working **on** this repository. To **install** YBots for someone, follow
[llms-install.md](llms-install.md) instead.

## Layout

| Path | What |
|---|---|
| `server/src/` | Node 22 + Hono + SQLite (better-sqlite3). API, Hermes adapter (`agent/loop.ts`), engines (`engine.ts`), MCP endpoint (`mcp.ts`), screens (`computer.ts`, `local-computer.ts`), approval cards, routines, voice |
| `web/src/` | React + zustand web app (also what the Windows app shows) |
| `mobile/` | Expo SDK 58 Android app; read `mobile/AGENTS.md` before changing it |
| `desktop/` | Electron Windows app: a window around the web app plus tray, updates, PC pairing |
| `scripts/` | `setup-local.sh` (install), `sign-in-link.sh`, `add-hq-to-hermes.py`, `run-tests.mjs`, `public/` (public export) |
| `tests/` | Hermetic suites (`npm test`); `tests/lib/server.mjs` starts a throwaway server with a fake Hermes |
| `docs/` | One file per feature; `.env.example` documents every setting |

## Commands

```bash
npm ci
npm run typecheck          # server + web
npm run build              # web then server
npm test                   # all hermetic suites; `npm test -- <suite> ...` for some
(cd mobile && npm run typecheck)
(cd desktop && npm test)
```

Run the typecheck and the suites you touched before you call a change done. A test that needs a desktop,
real Hermes or a real service is opt-in (`OPT_IN` in `scripts/run-tests.mjs`).

## Rules

- Build every user-facing feature for web, Android and Windows (Windows shows the web app, so usually web
  and Android). Keep shared helpers identical where a file says so (e.g. `server/src/message-text.ts` and
  `mobile/src/messageText.ts`).
- Never weaken approvals: a bot message, plugin, tool result or script session is never an approval;
  cards are answered by a person, bound to the exact action and expire. `/mcp` answers only on loopback.
- No personal data anywhere in the repo (code, comments, tests, fixtures, docs): no real names, emails,
  hostnames, IPs, tokens or household/client details. People in examples are `Alex` (owner) and `Sam`
  (family member) at `example.com`. Names shown to users come from settings (`server/src/people.ts`).
- Never commit `.env`, `apps.json`, `data/` or databases.
- Keep old names working (`CLEFTBOT_*`/`BOTHQ_*`/`GROKBOT_*` settings, `/root/bothq`, `cleft-bot`
  service, `com.yancey.*` ids): installed copies depend on them.
- Write UI text in plain, short sentences.
