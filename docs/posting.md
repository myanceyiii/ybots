# Posting to social media from a bot's browser

A bot with the **publish hold** on (`bots.publish_guard`, `PUT /api/bots/:id/publish-guard`) cannot press a
final Post / Publish / Schedule button on a social site (Facebook and Business Suite, Instagram, YouTube
Studio, X, TikTok, LinkedIn, Threads, Pinterest) unless the person approved that exact caption on a posting
plan card. Anyone signed in to the account can turn the hold on; only the owner, in person, can turn it off.

## Pieces

| Piece | Where |
| --- | --- |
| Page hold: final-button detection, caption hash (cyrb53 of NFKC, no zero-width, collapsed, lower-case text), dry run | `server/src/browser-guard-page.ts` (publish section) |
| Allow list pushed to every page, publish events, script/DevTools bypass refusals on social hosts | `server/src/browser-guard.ts` (`gatePublish`, `pushPublishState`, `readPost`, `cookieFacts`) |
| Plans, items, file fingerprints, tools | `server/src/posting.ts` |
| Drive video pull (service account, drive.readonly, key pasted on a secure card) | `server/src/drive-pull.ts` |
| Card UI | web `components/cards/Cards.tsx` (`PostingPlanCard`), Android `mobile/src/screens/Chat.tsx`; Windows uses the web app |
| Answer route | `POST /api/approvals/:id/plan {days, digest, decision}` (a person in an app only; never a notification, a bot or a plain allow) |

## Tools (only for bots with the hold on)

- `request_posting_approval`: one card, one switch per day. Each day lists its video (sha256 fingerprint),
  cover, and each platform's caption, title and time. Approve covers exactly the days left on, until the end
  of each day (POSTING_TZ, default America/Chicago). Changing a day's video or cover file cancels what is left
  of that day; a different caption never matches. Always allow is offered with a warning and counts only after
  the person has pressed Approve on an earlier plan and when the plan has no warnings.
- `posting_dry_run start|finish`: every final press is held and reported for 45 minutes.
- `posting_status`: what was approved, pressed (where) and cancelled.
- `check_signins`: which platforms have sign-in cookies (names and expiry only, never values). Session-only
  cookies are flagged because the profile drops them on restart.
- `ask_drive_key`, `drive_pull`, `drive_pull_status`: pull a Drive folder into the bot's workspace.

A Business Suite press on facebook.com counts for the day's Facebook post and its Instagram twin when both
have the same caption.

## Reuse check

`dreammis/social-auto-upload` (MIT) automates uploads with Playwright and saved cookies. We drive the bot's
own browser instead and only took its idea of checking sign-in by cookie. The Drive JWT uses node `crypto`,
so no new dependency.

## Tests

`node tests/posting-e2e.mjs` (opt-in: needs Chromium; a local page poses as x.com through host-resolver-rules).
