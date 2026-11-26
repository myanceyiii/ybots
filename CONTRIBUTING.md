# Contributing to YBots

Thanks for helping. Bug reports, fixes, docs and features are all welcome.

## Before you start

- **Security problems** go through GitHub's private vulnerability report, never an issue: see
  [SECURITY.md](SECURITY.md).
- For anything bigger than a fix, open an issue first and say what you want to change and why, so nobody
  builds the same thing twice.
- Look for an existing open-source project that already does it (and check its license) before building
  something from scratch.

## Set up

```bash
git clone https://github.com/myanceyiii/ybots.git && cd ybots
npm ci
cp .env.example .env        # SESSION_SECRET=$(openssl rand -hex 32), DEV_LOGIN=1
npm run dev                  # server :8787 and web :5173; DEV_LOGIN works only on localhost
```

`http://localhost:5173/?fixtures` shows the web app with sample data and no server. The Android app is in
`mobile/` ([docs/android.md](docs/android.md)); the Windows app is in `desktop/`
([docs/windows-app.md](docs/windows-app.md)). Each has its own `package.json`.

## Checks

```bash
npm run typecheck                         # server and web
npm run build && npm test                 # every hermetic suite: throwaway database, fake Hermes, nothing beyond 127.0.0.1
npm test -- scope notify                  # just the suites you touched
(cd mobile && npm run typecheck)
(cd desktop && npm ci && npm test)
```

Suites that need a desktop, a real Hermes or a real service are listed in `scripts/run-tests.mjs` under
`OPT_IN` and run only when named. Put a new suite on a line of its own in `HERMETIC`. The shared helper
`tests/lib/server.mjs` starts a throwaway server with a fake Hermes.

## How changes should look

- **Parity.** A feature for one app is built for all three: web, Android and Windows. If a platform
  can't do it the same way, say so in the pull request and offer options.
- **Approvals stay strict.** A bot's message, a plugin or a tool result is never an approval. Cards are
  bound to the exact action, expire, and are answered only by a person (scripts get 403). Don't add a way
  around that.
- **No personal data in the repository.** No real names, email addresses, hostnames, IP addresses, tokens,
  household or client details, in code, comments, tests, fixtures or screenshots. Use `example.com`,
  `Alex` and `Sam` for people, and read names from settings (`DISPLAY_NAMES`, `OWNER_EMAIL`,
  `SCOPED_PEOPLE`, see `server/src/people.ts`). Never commit `.env`, `apps.json` or a database.
- **Plain words in the UI.** Short sentences, no jargon, say what happened and what to do next.
- **Old names keep working.** Settings, folders and ids from earlier names (`CLEFTBOT_*`, `BOTHQ_*`,
  `/root/bothq`, `com.yancey.*`) are read on purpose; don't rename them without a migration.

## Pull requests

One topic per pull request, with what changed, why, and how you tested it (which suites, which apps).
Include screenshots for UI changes, made with sample data. By contributing you agree your work is
released under the [MIT License](LICENSE).
