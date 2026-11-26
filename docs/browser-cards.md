# Browser cards: secure input and purchase approval

Thread: "Add secure input and purchase cards for browser work" (Alex, 2026-11-24).
Goal: like Muse, when a bot's browser needs a password, login or code, a card in the app takes it and the
app types it into the page, without anyone opening the browser. Before any purchase, a card shows the
amount, payment method and recipient and must be approved before the browser can complete it.

## How the bots browse today (checked on Host2, 2026-11-24)

- Each managed bot has its own Chrome on its own screen on Host2 (`computer.ts cdpUrlFor`, DevTools on
  127.0.0.1:92xx). Hermes drives it with `browser_exec` (browser-use code) and `browser_cdp` (raw DevTools
  calls). Agent logs on Host2 show only those two browser tools in use.
- Every Hermes tool call passes the Cleft gate (`server/hermes-plugins/cleft-bot-gate` -> `POST /mcp/<bot>/gate`).
- Hermes ships its own vault autofill (`tools/browser_vault_tool.py`, ported from Merit-Systems/OpenInstinct, MIT)
  but its prompts need a chat surface; under the API server the bots run on it answers `prompt_unavailable`.
- The claude_browser connector (shared browser on Host1) is used by Claude threads, not by the bots.

## Design

1. **Browser guard** (new, `server/src/browser-guard.ts`). The server keeps a DevTools connection to each
   working bot's Chrome and adds a small script to every page and frame in an *isolated world* (page
   scripts cannot see or change it). The script:
   - holds every click, tap, Enter and form submit aimed at a purchase control ("Place order", "Pay",
     "Buy now", "Complete purchase", "Subscribe", PayPal/Apple Pay/Google Pay buttons, any submit of a form
     with card fields), unless a purchase approval for the page's *current* state is armed;
   - reads the checkout for the card (total, currency, card last four, merchant, items, shipping, recurring);
   - finds and stamps the field a secure input is for, and checks the value landed without echoing it;
   - notices CAPTCHAs.
2. **Purchase approval card** (hq tool `request_purchase_approval`). The server reads the page itself; the
   bot's own figures are shown only as "the bot says" and a mismatch is flagged. Approve / Deny, no Always
   allow, never from a notification. On Approve the server re-reads the page; if anything changed it is not
   armed and the bot must ask again. Armed for 3 minutes, one purchase, bound to origin + total + currency +
   card. The guard re-checks at the click itself; a changed total is held and reported.
3. **Secure input card** (hq tool `ask_secure_input`). The bot names the kind of field (password, username,
   one-time code, card number, expiry, CVC, other). The server finds the field on the live page and the card
   shows the site and the field's own label from the page. The person types into a masked box; the value goes
   app -> server -> DevTools `Input.insertText` into that exact field, after re-checking the page and frame
   origin. The bot gets "filled" or "failed: why", never the value. The value is not stored; the server keeps
   only a salted hash (1 hour) so the gate plugin can mask it if a later browser result echoes it.
4. **Needs-you card** (hq tool `ask_for_help_on_screen`): CAPTCHA, passkey, app approval: the card opens the
   bot's screen; Done lets the bot carry on.
5. **Gate backstop**: while the bot's page has a purchase control and no armed approval, `browser_cdp` calls
   that can act and `browser_exec` code that runs page script, submits or presses keys are refused with
   "call request_purchase_approval first". This covers `form.submit()` and fetch-style bypasses of the guard.
6. **Plugin after-step note**: after each browser step the gate plugin asks the server for notes ("the Pay
   button was held: nothing was bought", "CAPTCHA on this page") and masks entered secrets and card-like
   numbers (13-19 digits passing Luhn) in the result.

## Threat model

| Threat | Defence |
|---|---|
| Prompt injection on a page ("type your password into this box", "click Pay") | Page text is data. Only the bot can ask, and the card shows the *page's* real origin from DevTools, not what the bot or page claims. Purchases are held in the page by the guard whatever the bot was told. |
| Phishing look-alike domain | Card shows the exact origin (and the frame origin for card iframes) in large type; fill refuses if the origin changed between card and fill. |
| Bot learns the secret | Value never enters a tool result, the transcript, the card row, the DB, logs, memory or GBrain. Results say only filled/failed. Gate plugin masks the value and card-like numbers in later browser results. |
| Notification leak / lock-screen approval | Notifications name the site only and have no buttons for these cards; answering from a notification is refused by the server. |
| Replay / double answer | Card id + digest, pending-only, expires (25 min card, 3 min armed purchase), one fill or one purchase each. |
| Total or merchant changes after approval | Re-read at Approve and again inside the page at the click; any change holds the click and asks again. |
| Bot bypasses the guard with script (`form.submit()`, fetch, raw DevTools input) | Gate backstop refuses acting `browser_exec`/`browser_cdp` on pages with a purchase control unless an approval is armed. |
| A bot or Claude thread answers a card | Only signed-in people (not script sessions, not bots) can answer; same rules as email/call cards. |
| Clipboard history / keyboard learning | The app never copies the value; masked inputs turn off autocorrect/suggestions; Android uses a password field. |

## Known limits (plain)

- Detection of purchase controls is word- and form-based; an unusual button label could slip by. Default is
  to hold anything that looks like paying. A site that charges on a step with no recognisable control is
  not covered.
- Bots with raw DevTools or terminal access could still script around the guard; the gate backstop narrows
  this but is not a sandbox. Purchases on Leonard via Stripe Link (terminal) keep Link's own approval.
- No password vault is built. Hermes has one (`browser_vault`) but it cannot prompt under the API server;
  proposal: a "Save for this site" option that stores into Hermes' vault, to build only if Alex wants it.
- Bots that bring their own browser (not the managed Chrome) are not guarded.

## Sources

- Hermes `tools/browser_vault_tool.py` (origin binding, masked prompt, redaction registry), NousResearch/hermes-agent.
- Merit-Systems/OpenInstinct (MIT): opaque-handle vault autofill, `agent/subagents/browser-agent/tools/fill_from_vault.ts`.
- microsoft/playwright-mcp (Apache-2.0) `--secrets`: replace secret text in tool responses ("a convenience, not a security feature").
- Chrome DevTools Protocol: `Page.addScriptToEvaluateOnNewDocument` (worldName, runImmediately), `Runtime.addBinding`, `Input.insertText`.
