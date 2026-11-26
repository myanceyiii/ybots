# Maintainer guard (Howard)

Howard, the primary bot, administers the homelab and maintains YBots from the app. In the app he is
the same Hermes and the same Linux account as from the Hermes dashboard or Relay, so his reach is the
same. What differs is approval: in an app turn every Hermes tool goes through the cleft-bot-gate plugin
(`/mcp/<bot>/gate`). Per tool, that was either a card for every `ls` or one "Always allow" that let
`sudo rm -rf` through too.

`server/src/maintainer-guard.ts` sorts each terminal command and file write for the maintainer bot:

| Kind | Examples | Decision |
| --- | --- | --- |
| read | `ls`, `systemctl status`, `journalctl`, `git log`, `ssh host 'df -h'`, edits in `~/cleft-work` | runs, no card |
| danger | `sudo`, service changes, `cleft-ops deploy`, `rm`, force push, packages, firewall, secret files, Sheldon's silo | card every time, no "Always allow", standing rules ignored |
| other | `npm test`, `git commit`, `gh pr merge` | the bot's ordinary rules (a terminal "Always allow" covers it) |

The gate plugin also sends Hermes' own dangerous-command findings (`tools/approval_detection.py`), which
only make a command stricter. A stored "Don't allow" still wins. Outside app turns (dashboard, Relay,
Telegram, cron) Hermes keeps its own rules, as before.

Settings: `MAINTAINER_BOTS` (names or ids; default the primary bot), `MAINTAINER_HOME` (default from
`HERMES_HOME_PRIMARY`), `MAINTAINER_DEV_DIRS` (extra working copies).

Limits: this is a rule plus an audit trail, not a sandbox. The account keeps passwordless sudo, so a
script written into the working copy and then run is "other". Classification errs towards asking.

Tests: `tests/maintainer-guard.mjs` (in `npm test`): sorting, the policy, and the real gate route with
cards allowed, declined, refused to a bot token and a script session, and helper-style calls.
