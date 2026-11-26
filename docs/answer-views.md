# Answer views

Bots can put interactive pieces straight under a reply, like ChatGPT's answers that mix text and visuals:
tables, charts, key stats, progress, checklists, pick-one or pick-several choices, short forms, next-step
buttons, https links and code. The web app, the Windows app (which loads the web UI) and the Android app
draw the same card.

- **Bot side:** the `show_view` tool (`server/src/agent/tools.ts`, offered to Hermes bots over `/mcp`).
  It takes `title`, `blocks` and an optional `group_name`. Blocks use the Page vocabulary
  (`server/src/pages.ts`) plus `stats`, `progress` and `link`. Checking and the markdown copy are in
  `server/src/views.ts`. Bad blocks are dropped and reported back to the bot.
- **Card:** a `view` card row (`server/src/types.ts`) with the checked blocks and a markdown `text` copy for
  previews, copying, voice and older apps.
- **People's changes:** `POST /api/bots/:id/cards/:seq/view` with `op` = `check`, `pick`, `field` or `send`.
  Ticks and typing only save on the card. A single pick, or Send on a multi-choice, form or button, posts
  an ordinary chat message as the person, which the bot gets like anything typed.
- **Apps:** `web/src/components/cards/ViewCard.tsx` and `mobile/src/components/ViewCard.tsx`.

Safety: a view is data only. No HTML, scripts or iframes, and only https links. It never carries an approval
id or digest, so it can't approve anything, and anything the bot does after a press still meets approval
cards. Bots can't reach the route, so a bot can't press a view.

Test: `npm run build -w server && node tests/views-e2e.mjs`. Android preview: `?screen=views`.

Later steps (see the plan): a per-person "Simple" setting that shows the text copy instead, "Open as Page",
bots updating their own last view, calculator and slider blocks with a safe formula language, and sandboxed
mini-apps for plugins after a security review.

## Calculators (`calc` blocks)

A calc block has inputs (number, slider, choice, toggle) and outputs worked out from formulas. The formula
language lives in `server/src/calc.ts`: numbers, input and earlier-output names, `+ - * / % ^ ( )`,
comparisons, `&& || !`, `cond ? a : b`, and `min max round floor ceil abs sqrt pow log exp if sum avg clamp`.
It is a small parser and evaluator for numbers only, with no lookups on objects and no loops, and the same file
runs on the server, the web app (`@shared/calc`) and Android (`mobile/src/calc.ts`, a verbatim copy that
`tests/calc.mjs` checks). Formulas are checked when the bot shows the view, so a name that isn't an input or an
earlier output is reported back to the bot. Moving a slider saves the values on the card (clamped to the
range and options) without a message. **Send these numbers** posts the inputs and answers as the person, and
can be pressed again after more changes.

## Updating a view

`show_view` returns a view id. `update_view` (only for the bot that showed it) changes the title, some blocks
by id (`changes`) or all blocks (`blocks`). What the person already did stays: checklist ticks by item text,
picks while the options are unchanged, typed form values and calculator values. The card shows "Updated" with
the time.

## Open as Page, and Simple

**Open as Page** (`POST /bots/:id/cards/:seq/page`) turns a view into a Page in the bot's files, once. Pressing
it again opens the same Page. It is not offered in groups. The **Answer visuals** setting (web: Settings,
General; Android: Appearance) is Rich or Simple. Simple shows each view's text copy, and every card can still
be switched either way with Show visuals / Show as text.

## Groups

Group members reply with `post_to_group`, which takes an optional `view` (same title and blocks as
`show_view`). The view is checked first, so a bad one posts nothing, and then it goes right under the text with
the bot's name on it. The group prompt tells members to put tables, charts, numbers, steps, picks and
calculators there instead of long Markdown lists. Chat list previews show bot replies as plain words.

## Choice buttons

For a question with a few set answers (yes or no, this or that, up to 4 options), bots put tap buttons right
under their reply, like ChatGPT's and Duet's quick replies. Code: `server/src/choices.ts` and
`server/src/choice-detect.ts`.

- **Bot side:** the `offer_choices` tool (question, 2 to 4 short options, optional `other` for an "Other" box;
  with `other` one option is enough, e.g. "Approve all").
  It doesn't end the turn; in the bot's own chat or a side chat the buttons wait until the turn ends so they
  sit under the reply. In a group, `post_to_group` takes `choices` with the same fields.
- **Fallback:** when a reply ends with an obvious yes/no ("Should I...?", "Want me to...?") or "A or B (or C)?"
  question, or ends telling the person to reply with set words (`Reply "approve all" or tell me which to
  change` gives "Approve all" plus an Other box), and the bot offered no buttons, asking view (choice, form,
  button or calc block) or ask_user that turn, the server adds them (`auto: true`). A view that only shows
  stats, tables or charts doesn't count as asking. Open questions ("What...?", "Why...?") and questions about facts ("Is it A or B?") get none.
- **Card:** a `view` card with `quick: true` and one `choice` block (so every app reuses the view code). Apps
  draw it as a row of pill buttons with no card around it; chat list previews skip it.
- **A tap** goes through the same `POST /bots/:id/cards/:seq/view` (`op: pick`, or `text` for Other). The person's
  message is just the answer ("Yes"); the bot is told `[Answer to "<question>"] Yes`. The row then shows the
  pick (and, in a group, who pressed it) and a second tap gets 409. In a group the message @mentions the bot
  that asked, so it reaches that bot.
- **Phone notices:** when there are 3 or fewer answers, the Android notification carries them as buttons that
  send the same pick (NotifyActionReceiver). Web and Windows notifications open the chat.
- **Safety:** a tap is a chat reply only. It carries no approval id or digest, bots can't reach the route, and
  anything privileged the bot does next still meets its approval card.

Test: `node tests/choices.mjs` (detector) and `node tests/choices-e2e.mjs`. Android preview: `?screen=choices`.

## How often a bot uses them (per bot)

Each bot's settings have **Visuals in replies: Minimal / Balanced / Rich** (default Rich), on web/Windows
(Bot settings › General) and Android (bot settings). It only changes the bot's prompt guidance
(`server/src/visuals-level.ts`, used by `agent/prompt.ts` and the group brief in `agent/rooms.ts`); every
tool stays available at every level.

- **Rich**: look for every chance to show rather than tell, with concrete triggers (comparisons → table or
  chart, money and what-ifs → calc block, key numbers → stats, steps → checklist or Page, long work →
  progress bar via update_view, 2-4 set answers → offer_choices, things to keep → Page, next action → button).
- **Balanced**: views only when clearly easier than text.
- **Minimal**: plain text; views, calculators and Pages only when asked. Tap choices are still offered.

This is separate from **Answer visuals: Rich / Simple** in the app's own settings, which is per device and
only changes how views that arrive are drawn. A tap on a view or choice is a chat reply, never an approval.

## Pinned boards

A view that tracks work stays in reach just above the message box, however far the chat moves on, until it is
no longer useful. Rules: `server/src/board-pin.ts` (Android has a verbatim copy, `mobile/src/boardPin.ts`).
Apps: `web/src/components/BoardDock.tsx` (web and Windows) and `mobile/src/components/BoardDock.tsx` (Android).

- **Pins itself** when shown with a live or step-counting progress bar, or when the bot moves a progress bar or
  an unticked checklist with `update_view`. A gauge ("$600 of $1,000 spent") or a to-do list shown once does not.
  Bots can pass `pin: true` / `pin: false` on `show_view` and `update_view`. People pin or unpin any view from
  its card (Pin / Unpin) or the dock (×, with Undo): `POST /bots/:id/cards/:seq/pin` with `{ on }`. A person's
  unpin sticks until the person or the bot pins it again.
- **Lets go** 10 minutes after every bar is full and every item is ticked (`pin.doneAt`), after a day with no
  update ("Paused" after an hour), or when unpinned. Quick choice buttons never pin.
- **Stopped:** a bar left short when its turn ended (`stopped` on the block, view-stall.ts) shows "Stopped after:
  <last step>" with a Dismiss button, and lets go an hour after it stopped. Moving the bar again clears it.
- **Never cut mid-word:** the strip shows `boardLine` summaries (`shortText`: drop parentheses, then first clause,
  then first phrases; "…" only as a last resort). Title and step each wrap to two lines; a narrow pane (container
  query on web, phones on Android) moves the bar under the words. Full text is in the tooltip and the open board.
- The pin is saved on the card row (`pin`), so every device shows the same and it survives restarts. The
  original card stays in the chat with a "Pinned" tag; Jump to message scrolls to it.
- **Dock:** one line (bot face, title, step, bar, %). Open, it is the live card itself, so ticks work there too.
  Several boards show as tabs with each bot's face (groups). Android opens it in a bottom sheet. Sam's view (a scoped
  sign-in) on the web keeps it to one bigger board with only Hide.

Test: `node tests/board-pin.mjs` and `node tests/board-pin-e2e.mjs`. Web dev: `?fixtures=boards` and
`?fixtures=boardsgroup`. Android preview: `?screen=boards`, `?screen=boardsgroup`.
