# Activity trail

Settings > Activity (web and Windows) and the profile sheet's **Activity** (Android) show one list of every
action a Bot was allowed, refused or failed to do. Each row says which Bot, who it was for, what started it,
how it was decided (an approval card and who answered it, an Always-allow rule, a Don't-allow setting, the
browser guard, the Slack link) and a short reason. Code: `server/src/activity.ts`.

## What started it

| Kind | Meaning | Nobody watching |
|---|---|---|
| person | Somebody sent the message or pressed the button | no |
| script | A script signed in as the owner sent the message | yes |
| routine | One of the Bot's routines fired | yes |
| goal | A scheduled check-in fired | yes |
| memory | A memory import read an app (reserved; nothing does this through a turn yet) | yes |
| handoff | Another Bot, or an outside member through Slack, asked for it | yes |
| self | The Bot's engine ran a tool while the app had no turn for it | yes |
| system | The app itself, after a person's action | no |
| earlier | Copied from an older log, where the cause was not recorded | no |

The idea comes from OpenBot's "What started a run" (CopilotKit/OpenBot, `docs/architecture.md`, MIT). Its
server is not published, so this is written from the description.

## Writers

- The Hermes gate (`mcp.ts` `/mcp/:bot/gate`): every allow, refusal and card answer for Hermes' own tools.
  The result of an allowed tool arrives later in the turn's stream; a failure turns that same row to failed.
- The app's own tools and connected-app tools over `/mcp` (`mcp.ts` `callTool`), paired PCs included.
- The browser guard's refusals.
- `send_to_bot`: refused hand-offs (too many hops, a walled Bot, the Slack link refusing a send to an
  outside member such as Sheldon) are refused rows. Messages themselves are never kept.
- A person's plugin and connection changes (`plugins/registry.ts` `audit`).
- On first start, the last 30 days of the older logs (approval cards, Always-allow uses, PC calls, plugin and
  connection changes) are copied in once, marked "Not recorded".

Look-only steps (reading, listing, searching) are kept but hidden unless **Show look-only steps** is on;
refusals and failures always show. Rows are kept 180 days, at most 100,000.

## Export

**Download as a spreadsheet** (`POST /api/activity/export`) gives the current filter as CSV, newest 5,000
rows, and writes a row of its own saying who took it, how many rows and under which filter. A cell that
starts with `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet never runs it as a formula.

A scoped sign-in (a scoped person) cannot read the trail; it covers every Bot.
