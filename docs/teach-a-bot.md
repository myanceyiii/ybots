# Teach a bot by showing it

Thread: "Teach a bot by recording" (Alex, 2026-11-28). Idea borrowed from OpenBot's Teach a Bot
(CopilotKit/OpenBot at `f681239`, `docs/personal-edition.md#teach-a-bot`, MIT).

Take control of a bot's screen, press **Record**, do the task once in the bot's Chrome, press **Stop**. The bot's
own Hermes writes the steps up as a skill. You check it beside the steps it came from, edit it, and **Save skill**
puts it in the bot's real Hermes skills (the same as Skills › New skill), or **Discard** throws it away.

## Where it is

| | Web and Windows | Android |
|---|---|---|
| Record / Stop | Beside Hand back while you drive the screen (large view, chin or touch bar) | Header of the computer screen while you drive, and its ⋯ menu |
| Review | Opens after Stop; also Skills › "A recording is waiting for review" | Opens after Stop; also Settings › Skills, and the ⋯ menu |
| Start from Skills | Skills › Teach by showing › Show it (opens the screen in control mode) | Settings › Skills › Show it |

The steps are captured on the server, not in the app, so every app records the same way. On a phone the small
screen is the only limit.

## How it works

- `server/src/teach.ts`: recordings (`teach_recordings` table), masking, the draft, save and discard; routes in
  `routes-config.ts` under `/api/bots/:id/teach`.
- `server/src/teach-page.ts`: the script put into every page and frame of the bot's Chrome while recording, in its
  own isolated world (`cleft_teach`), through the browser guard's DevTools connection (`browser-guard.ts`
  `onGuardAttach` / `onGuardBinding` / `forEachSession`). It reports the page, clicks, typed text (once, when the
  field is left or Enter is pressed), choices, ticks and Enter. Only trusted (real) input counts.
- On Stop the script is removed from new documents and the binding is dropped; the server ignores anything late.
- The draft: one call to the bot's own Hermes (`/v1/responses`) with every tool refused meanwhile (`withToolsOff`).
  The steps and the person's note go in as quoted data. If the model can't be reached or answers badly, the steps
  are written up as they are (`plainDraft`) and the review says why.
- Hand back stops a running recording and writes it up. A recording stops itself after 200 steps or 30 minutes.

## Privacy and safety

- A field that holds a secret (password, card number, security or one-time code, by type, autocomplete, label,
  name or shape) is recorded as "[sensitive field]" and its value is never read in the page.
- The server checks every step again with OpenBot's masking (`server/src/vendor/openbot/recorder-masking.ts`,
  copied unchanged): emails, card-like numbers, long tokens and sign-in codes in text and addresses become
  `[redacted]`. A value typed through a secure-input card in the last hour is dropped too.
- Nothing typed into a sensitive field reaches the database, the model, the review or logs.
- While a recording runs, the bot's own browser tools are refused, so only the person's steps are recorded.
- Only a signed-in person can start, stop, save or discard. Script sessions (Claude threads, tests) get 403.
- Walled-off bots (silo, outside members) and bots with no reachable Hermes skills can't be taught here.
- Drafted skills always tell the bot to call `ask_secure_input` for secrets and `request_purchase_approval` before
  paying; the person sees and can edit the whole skill before it is saved.

## Tests

- `tests/teach.mjs` (hermetic): masking, folding, plain-words steps, reading the draft.
- `tests/teach-e2e.mjs` (opt-in, needs Chromium): a real Chromium as the bot's Chrome and a local test site.
  With the built web app it also checks the review in the web app; `SHOT_DIR=<folder>` keeps pictures.
