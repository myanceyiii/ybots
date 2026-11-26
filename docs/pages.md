# Pages

A Page is a living document a bot writes while it works and its person edits alongside it. It opens in
the file pane (web and Windows) and on the Files screen (Android).

## Where it lives

`<name>.page.json` in the bot's workspace (`<library>/<botId>/`), next to its other files, so file chips,
the file list and backups pick it up like any other file. History lives in the app database
(`page_versions`), up to 300 versions per Page; typing in one block for under 45 seconds is one entry.

## Blocks

text, heading, checklist, table (optional total row), form, choice, chart (bar, line, pie; from its own
numbers or a table in the Page), callout, button, file, code, toggle, divider. Shapes are in
`server/src/pages.ts` (`content`). Unknown types are refused, and a file edited by hand is re-typed when
it is next read, so nothing else gets in.

## Editing together

The server is the only writer. Every change is a small operation (`applyOps`): insert, update, delete,
move, title, and per-item changes that never clash (check, add_item, remove_item, cell, add_row,
remove_row, field, submitted, pick). Each block records the page version of its last change and who
made it.

- An `update` whose `base` is older than the block's last change by someone of the other kind is a clash.
- A bot's clashing update is refused with the current block; the bot reads the Page and redoes it.
- A person's clashing update is kept beside the block (`alt`) until they pick "keep mine" or "keep theirs".
- `page_read` tells the bot what people changed since it last read the Page.

Every change is announced on the live event stream (`{ type: 'page' }`), so open Pages reload; blocks the
bot just changed get a short highlight.

## Safety

Nothing in a Page runs. The apps draw blocks with their own components; the chart is an SVG drawn from
escaped text (`server/src/page-chart.ts`, copied to `mobile/src/pageChart.ts`). Buttons and forms send a
chat message as the person who pressed them, so anything the bot does next goes through the normal
approval cards. Page text reaches the bot marked as content. Pictures only come from the workspace.

## Bot tools

`page_create`, `page_read`, `page_update`, `page_export` (built-in tools, workspace only).

## Export

md, txt and html are written directly; docx, odt and pdf are the HTML converted by LibreOffice on the
server (charts embedded as SVG pictures); csv and xlsx export one table. Exports land beside the Page.

| Block | md / txt | html | docx, odt, pdf |
|---|---|---|---|
| checklist, choice | `- [x]` / `- [ ]` | ☑ / ☐ list | ☑ / ☐ list |
| table | table (+ total row) | table | table |
| form | fields with answers | same | same |
| chart | its data table | picture + table | picture + table |
| button | left out | left out | left out |
| toggle | opened out | opened out | opened out |

Tests: `npm run build -w server && node tests/pages.mjs`.

## The Pages tab

Every Page a bot has is listed in its **Pages** tab (web and Windows: the bot's side panel, next to Library;
Android: the chat's ⋯ menu, "<bot>'s pages"). `server/src/page-shelf.ts` builds the list from the
`.page.json` files in the bot's workspace plus a small `page_shelf` table: pinned or not, the chat a Page came
from (main chat or a side chat, and the answer it was saved from), and deleted Pages waiting for Undo.

- **Library vs Pages.** The Library lists the bot's other files; `.page.json` files are left out of it.
- **Saving.** "Save to Pages" (or "Open as Page") under an answer view makes a Page from it once. A side chat's
  Pages go in the bot's own workspace.
- **Still interactive.** Calculators (`calc` blocks, shared checks in `server/src/calc-block.ts`) keep working on
  a Page; a person's numbers are a `calc` change that never clashes. Buttons and "Send these numbers" post into
  the chat the Page came from while that chat exists, else the main chat.
- **Delete.** A deleted Page moves into the hidden `.cleft-trash` folder (no file walk looks in dot folders) and
  Undo puts it back; it is removed for good after 7 days.
- Routes: `GET /api/bots/:id/pages/list`, `POST .../pages/pin`, `.../pages/delete`, `.../pages/undelete`; rename is
  the existing `title` page change. Live event `pages` tells the apps to reload the list.
