# Security

## Reporting a vulnerability

Please report vulnerabilities privately with GitHub's **Report a vulnerability** button on this repository's **Security** tab. Do not post them in YouTube comments, public issues, pull requests or discussions, where anyone could use them before there is a fix.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer as soon as possible, but responses are best effort: this is a hobby-scale open-source project with no service-level commitment.

Only the `main` branch is supported. Fixes land there; there are no backported releases.

## What you are running

Every bot is an AI agent with a shell, a browser and your connected apps on a shared computer, running as root. Anyone who can sign in to the app, or who can get text in front of a bot (an email it reads, a web page it opens, a message in a connected app), may be able to make it run commands. Treat every key on that computer as readable by the bots.

## The security model

What YBots enforces, so you know what you can rely on:

- **Approval cards.** Every action a bot takes in a connected app, plugin or connector (reading included)
  waits for a person's OK on a card until that person chooses **Always allow** for that bot and tool. A card
  is bound to the exact action (a digest of the tool and its arguments), expires, can be answered once, and
  records who answered it and from where. Emails are sent only from a card showing the whole email, with
  no Always allow. Risky tools say so on the card.
- **A bot message is never an approval.** Messages between bots, plugin output, tool results, web pages
  and emails are information. Only a person's answer on a card approves anything, and plugins cannot grant
  approvals.
- **Scripts are not people.** A session made by a program can never answer a card (see below).
- **Agents reach the app only on loopback.** `/mcp` and the owner sign-in answer only calls from the same
  machine that were not passed on by a proxy.
- **No passwords.** People sign in with one-time QR codes or links from a signed-in device, through
  Cloudflare Access, or with a link made on the server. `ALLOWED_EMAILS` is enforced on every request on
  a public address.
- **Hermes' own tools.** For the extra bots, Hermes asks before it runs its own terminal, file and browser
  tools, and the question arrives as a card (`HERMES_GATE=1`, the default).
- **Walled bots are optional.** You can wall one bot off from the others (for work data), either as a bot
  reached over Slack ([docs/sheldon-link.md](docs/sheldon-link.md)) or as a bot in a sealed container
  ([docs/sheldon-silo.md](docs/sheldon-silo.md)). The app then checks every message it sends to another
  bot against an allow list. Without either setting, all bots are one team and can message each other.

What it does **not** do: it is not a sandbox. Bots run as root on the machine, can read each other's files,
and a bot that has been talked into something by a web page or an email can try to use anything it already
has. The cards limit what it can do in your apps without you; they do not make the machine safe for
secrets you would not give the bots.

## Deploying safely

- **Never expose the app on a public URL without sign-in.** Set `ALLOWED_EMAILS` to the people who should get in (the install script requires it), keep `DEV_LOGIN=0`, and use a long random `SESSION_SECRET` (`openssl rand -hex 32`). Remove the public URL when you are not using it.
- **Keep keys on the server.** API keys belong in the server's `.env` (or `*_FILE` files) on the computer, never in the web app, a repository, a chat with a bot, or a screenshot.
- **Set spend limits** with every provider whose key you use (your model providers, and xAI, Composio or Orgo if you use them), so a runaway or hijacked bot cannot run up a large bill.
- **Use computer-scoped Orgo keys**, limited to the one computer the bots use, rather than account-wide keys that can create, read or delete every computer in your account.
- **Never show keys on screen or in recordings.** Hide `.env` files, terminals and dashboards before you stream, record or share your screen; a key that has been on screen should be rotated.
- **Rotate a key as soon as it may have leaked.** Deleting it from a file or from git history is not enough once it has been public.
- **Connect only the apps a bot needs**, and think before choosing "Always allow": it lets every bot of yours repeat that action without asking, and for Composio's sandbox tools it covers any code, which can reach all your connected apps.

## Scripts signed in to an account

A session made straight from the owner key (`POST /api/auth/owner` without `link`) belongs to a script
or another program, such as a Claude thread or a test, not a person. Such a session:

- can never answer an approval card (403, code `agent_session`), by button, notification or voice, and
  can never allow a PC pairing;
- has its chat messages shown as "Sent by <name> · not you", and the bot is told they are not the
  person's words or approval;
- can only make sign-in links for more script sessions.

A script names itself with `agent` in the body (for example `{"email": "...", "agent": "Claude: helpers
thread"}`); unnamed ones show as "Script on the server". A sign-in link opened in a browser is a person's
session. Every approval card records who answered it and from where (web, Windows app, phone app, phone
notification, voice call), and an app tool's result tells the bot who allowed or declined it. Anyone who
can read the server's `.env` can still sign in as a person; this labels and stops honest automation, it is
not a wall against the server's own administrator.
