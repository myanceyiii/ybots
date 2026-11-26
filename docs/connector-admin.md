# Connected-app admin (Howard)

Asked for by Alex on 2026-11-23: the admin bot (Howard) can look after connected apps (the MCP
servers bots use), with Alex's approval on each change. Code: `server/src/connector-admin.ts`.
Tests: `tests/connector-admin.mjs`.

## Tools (admin bot only)

| Tool | Card | What it does |
| --- | --- | --- |
| `connected_apps_overview` | no | Each app's server, tools (runs / asks / blocked), OAuth scopes (Google: asked, granted, missing), bots, firm flag. No keys. |
| `connected_app_logs` | no | Recent log lines of one app, keys removed. |
| `connected_app_history` | no | Changes made, who allowed each, which can be undone. |
| `change_connected_app` | one per call | `set_bot`, `restart`, `edit_app`, `add_app`, `remove_app`, `rollback`. |

The admin bots are the primary bot, or the names/ids in `CONNECTOR_ADMIN_BOTS` (comma-separated).
Other bots don't see the tools and are refused if they call them.

## What the server enforces

- The change card has no Always allow; script sign-ins and bot messages can't answer it (existing
  card rules in `agent/loop.ts` and `routes.ts`).
- Fields that hold or lead to keys (`env`, `headers`, `headersFile`, `oauth`, `remote`) can't be set,
  edited or removed, and `${VAR}` is refused anywhere in a change. The overview shows them as hidden.
- Sign-ins and new scopes stay with the person (Connect Google).
- Firm apps (`m365`, `files`, `cms`, and any catalog connector with `firm`) get a warning line on the card.
- Each change is stored in `connector_admin_changes` (before, after, who allowed it, via what), in
  `plugin_audit`, and as a line in `/var/log/cleft-maintainer.log`. apps.json is copied to
  `data/apps-json-backups/` before every write.

## Undo

- Howard: `change_connected_app {action: "rollback", change: "<id>"}` (its own card).
- Alex: Settings > Connections > Changes by Bots > Undo (web, Windows, Android).
- A rollback of an apps.json change is refused if the entry changed again since (it would undo more).

## Limit

Howard's Linux account on Host2 has passwordless sudo (given for "full control", 2026-11-23), so
the rules above bind the tools, not a shell. The skill tells him not to read keys another way.
