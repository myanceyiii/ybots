# Sheldon link (outside members over Slack)

Sheldon is a ChatGPT agent that lives in the household Slack, not in this app. The app treats him as an
**outside member**: he shows in the sidebar under "Outside the app", can be in any group chat, and the
bots reach him with the normal `send_to_bot` tool. The app never starts an agent for him.

- **Out.** A message to Sheldon is posted in `#assistants` under the owner's Slack account (a user token
  with only `chat:write`), in the channel's format `[Leonard]>@Sheldon Q … <@Sheldon>`. Slack marks it
  "Sent using Cleft". Owner posts wake Sheldon in about 20 to 30 seconds (timed 2026-11-22).
- **In.** One outbound Socket Mode connection (no public URL) reads the channel. Sheldon's thread reply
  goes back to whoever asked (a bot or a group). His top-level `[Sheldon]>@Leonard …` post goes to that
  bot. Each arrives as an `external` message: information only, it never answers an approval.
- **Rules.** Bots must start with a channel type (Q, A, FYI, CAL, BUDGET, LIST), at most 1,000
  characters; card or account numbers, SSNs, keys, passwords and balances are refused. At most 20 posts
  per 5 minutes and one per 1.1 s. 3-hop limit. No answer after 75 minutes: the asker is told.
  "Assistants, stop" from a person in the channel pauses the link until it is turned back on in the app.
- **Where to see it.** Sheldon's page in the app lists every exchange with filters by bot and "Waiting".

## Set up (owner, about 10 minutes)

1. Open https://api.slack.com/apps, choose **Create New App**, then **From a manifest**, pick the
   household workspace. Slack opens on the **JSON** tab: replace everything there with
   `deploy/slack/cleft-app-manifest.json` (the YAML file is the same app, for the YAML tab). Create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes.** Name it `socket`, add the
   scope `connections:write`, Generate. Copy the token that starts with `xapp-`.
2b. **Agents & AI Apps → Slack MCP server access → On**, Save. Posts sent through Slack's MCP server
   carry no `bot_id`, and those are the only Cleft posts Sheldon's ChatGPT agent wakes for (seen live
   2026-11-22: even an app with no bot user gets a `bot_id` on a plain `chat.postMessage`).
3. **Install App → Install to Workspace → Allow**, signed in to Slack as yourself (the owner). This asks
   for your permission to post and read `#assistants` as you. Copy the **User OAuth Token** (`xoxp-…`).
4. Put the two tokens on the server, one per file, readable only by root:
   ```
   sudo install -d -m 700 /etc/cleft-bot/slack
   sudo sh -c 'umask 077; cat > /etc/cleft-bot/slack/user_token'   # paste xoxp-…, Enter, Ctrl-D
   sudo sh -c 'umask 077; cat > /etc/cleft-bot/slack/app_token'    # paste xapp-…, Enter, Ctrl-D
   ```
5. Tell Sheldon once in `#assistants` that posts signed `[Howard]` or `[Leonard]` come from the
   Cleft bots and follow the channel rules.

The app deliberately has **no bot user**, so there is nothing to `/invite`. Posts from an app that has a
bot user carry a `bot_id`, and Sheldon's ChatGPT agent did not start a turn for those (2026-11-22: two
such posts got no turn, while the same mention from an app without a bot user woke him in 14 to 18 s).

Then run `scripts/deploy-sheldon-link.sh` (it backs up, updates, sets the config below and restarts).

## Config (.env)

```
OUTSIDE_BOTS={"name:Sheldon":{"via":"slack","slackUserId":"U…","channel":"C…","channelName":"assistants","replyMinutes":75,"ownerName":"Alex","aliases":{"Claude":"Leonard"}}}
SLACK_USER_TOKEN_FILE=/etc/cleft-bot/slack/user_token
SLACK_APP_TOKEN_FILE=/etc/cleft-bot/slack/app_token
SLACK_POST_VIA=mcp   # post through Slack's MCP server; falls back to chat.postMessage on failure
# SLACK_BOT_TOKEN_FILE=…   optional, only for an app that has a bot user (not recommended, see above)
```

`aliases` maps names Sheldon may use for our bots (he still calls Leonard "Claude") to the bot.

### Open in ChatGPT button

Sheldon's chat (web, Windows and phone) has an **Open in ChatGPT** button. It does not start a call;
it opens a ChatGPT link, by default `https://chatgpt.com/voice`. On Android, chatgpt.com's
`/.well-known/assetlinks.json` lets the ChatGPT app (`com.openai.chatgpt`) open every chatgpt.com link,
so the installed app takes it; on a computer it opens ChatGPT's voice page in the browser.

Sheldon is a ChatGPT dot, and a dot's call can only be started from the call button in its conversation.
To land on that conversation instead of a plain ChatGPT voice chat, add `"callUrl"` to his entry with his
`https://chatgpt.com/dots/…` address from the browser's address bar (or pass it as the deploy script's
sixth argument), then tap his call button there if you want to talk. Only `https://chatgpt.com/…` (or `chat.openai.com`) links are accepted; anything else falls back
to the voice page. OpenAI does not document a link that opens one GPT straight into voice mode.

## Undo

Remove `OUTSIDE_BOTS` from `.env` and restart: Sheldon's page stays, nothing goes out. To remove the
Slack side, delete the Cleft app at https://api.slack.com/apps.

## Tests

`node tests/outside.mjs` (rules and routing) and `node tests/outside-e2e.mjs` (the real server against a
fake Slack, including the socket; `SHOTS=/dir` saves screenshots). Neither touches the real Slack.
