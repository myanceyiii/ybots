# Approvals that know the kind of action

Some actions matter more than others: deleting, sending to other people, sharing, posting, paying and
changing a password or other credential. YBots recognises them and treats them with care, whatever else a
bot is allowed to do. The design follows OpenBot's `docs/approvals.md` (MIT, CopilotKit, commit f681239);
OpenBot's server is not published, so the logic here is our own and no code was copied.

## How a kind is recognised

By what the action is called, never by what it carries (`server/src/action-kinds.ts`):

| Where | How |
| --- | --- |
| An app or MCP tool | Its first verb: `delete_message`, `send_gmail_message`, `share_file`, `publish_post`, `place_order`, `reset_password`. `mark_as_spam`, `list_archived`, `cancel_scheduled_send` and `create_draft` are not kinds, because their first verb is something else. A tool its server marks `destructiveHint` asks as deleting. |
| A Hermes tool | `send_message` is a send. |
| A button in a bot's browser | Its label starts with the action: Send, Delete, Yes delete, Move to trash, Empty trash, Discard, exactly Remove; Share, Invite, Add people; Post, Publish, Tweet, Go live; Change / Update / Reset password, two-factor switches. Comment and Reply count only when text is written in their box. |
| A key in a bot's browser | Ctrl/Cmd+Enter in a text box; Enter in a box for writing a message, reply or comment; Enter in a form whose button is one of the above. Search boxes never count. |

Paying in the browser keeps the purchase hold and its card (`docs/browser-cards.md`). Post / Share on a
social site, for a bot with the publish guard on, keeps the posting plan hold (`docs/posting.md`).

## What changes

- **The card says what it does.** A kind's card shows a chip (Delete, Send, Share, Post, Pay, Password or
  security change) and one line ("This sends something to other people."). It is never answered from a
  notification.
- **Allow for this conversation.** Every card that offers Always allow also offers Allow for this
  conversation: the bot does it now, and the same action again in this chat's current conversation without
  asking (same bot, same tool; for a browser kind, the same kind on the same site). It ends with New
  conversation, when the chat is deleted, or with **Turn off** on the line above the message box, on web,
  Windows and Android. Uses are logged in Settings > Permissions as "allowed for this conversation".
- **Browser presses of a kind are held**, whatever the bot's tool rules say. "Always allow" on a bot's
  browser clicks no longer lets it press a site's Send or Delete. The guard holds the press and tells the bot,
  which calls `request_action_approval`; the card shows the button and site as the guard read them. Allow once
  lets the next press of that kind on that site through within two minutes; Allow for this conversation and
  Always allow let that kind through on that site from then on (rule key `browser_kind__<kind>__<site>`).
  Script and raw DevTools steps that could press such a button are refused on that page until it is allowed.
- **A password or security change on a website is handed to you**: the card says it is yours to do, with
  **I did it myself** and **Don't do it**. The bot never presses it. A credential an app's own tool changes
  asks like anything else.
- **A server's read-only hint** never lets a kind through without a card.
- **When you take control of a bot's screen**, your own presses are never held.

## What does not change

Cards bound to a digest and answered once by a person; scripts and bots can never answer; the full-email send
card (no standing answer); purchase cards; posting plans; your own apps.json `allow` lists (Leonard's Actual
transaction tools still run without a card, as decided on 2026-11-24).

## What isn't recognised

A button with no label; other keyboard shortcuts (Alt+S); a label with another word (Confirm, Done); an app
tool whose name names none of the words and that its server does not mark destructive. A shell command that
deletes files on the bot's own computer is not an account action and follows the terminal's rules.
