# Sheldon's silo

Sheldon, the legal and firm-work bot, runs on the same machine as the other bots but inside its own container (decision D17 in the team plan, which is kept outside the repo). This page is what was built, what it protects, and how to bring it up. Files: `silo/sheldon/`, `server/src/silo.ts`, tests `tests/silo.mjs` and `tests/silo-e2e.mjs`.

## What runs where

```text
 host (Host2)                                   ┌──────── internal network "inside" (no route out) ───────┐
                                                 │                                                         │
 app (127.0.0.1:8787) ◄── relay ◄── gate ◄───────┤  sheldon container (uid 10101, no capabilities)         │
   │   only /mcp/<Sheldon>      (socat 8787)      │    Hermes agent  :8642   (its home in /data/hermes)     │
   │   from the gate's address                    │    Xvfb + openbox + x11vnc :5900                         │
   │                                              │    Edge, profile in /data/edge, DevTools on its          │
   ├──► 127.0.0.1:8653 ──► gate ──► sheldon:8642  │      own loopback only                                   │
   └──► 127.0.0.1:5953 ──► gate ──► sheldon:5900  │    files and downloads in /data/files, /data/downloads   │
                                                 │                                                         │
            internet ◄── gate (tinyproxy, allow-list, HTTPS only) ◄── every request Sheldon makes            │
                                                 └─────────────────────────────────────────────────────────┘
 /data = the encrypted volume (LUKS file, opened with Alex's passphrase), mounted only into this container
```

- **The app never starts, configures or deletes Sheldon's agent.** `SILO_BOTS` in the app's `.env` names the bot; the app then only calls the agent's API on 127.0.0.1:8653 with the agent's key and relays its screen from 127.0.0.1:5953. Nothing of the primary agent (its sign-ins, API keys, model settings or fallback providers) is copied in, which a normal managed bot would get. Model sign-in and restart from the app are refused with a pointer to the container.
- **Sheldon's own files never touch the host's filesystem** outside the encrypted volume. Its Hermes home, browser profile, downloads and working files are all under `/data`.
- **Only the gate can reach Sheldon, and the gate is Sheldon's only way out.** The `inside` network is `internal`, so the container has no route to the internet, the host or the other bots. The gate forwards three things: the agent API and the screen (published on the host's loopback only), and MCP calls to the host relay.
- **Outbound traffic goes only to the allow-list** (`/etc/cleft-bot/silo/sheldon/allowlist`, one regular expression per host name). Anything else gets `403 Filtered`. CONNECT is allowed to port 443 only. The starting list covers the firm's ChatGPT and Microsoft 365; Alex edits it.
- **The relay passes only Sheldon's own MCP path** (`/mcp/<id>` and `/mcp/<id>/gate`), only from the gate's fixed address, and strips forwarding headers. The app still checks Sheldon's bearer token on every call. The app's other routes, other bots' MCP paths and everything else are refused.
- **The app's approval gate for Hermes' own tools** (terminal, files, browser, computer use) is installed inside the container too, so Sheldon's built-in tools ask the app the same way the other bots' do.
- **The container runs as an unprivileged user** with every Linux capability dropped, `no-new-privileges`, no sudo, no Docker socket, process, memory and CPU limits.

## Disclosure rules, enforced by the server

Sheldon's existing rules (team plan, section 8) are enforced twice: in its persona, and by the app's server, which does not depend on the model following instructions.

| To | Allowed | Shape |
| --- | --- | --- |
| Leonard | CAL, ITINERARY, RECEIPT, Q, A | as below |
| Anyone else, any group chat | nothing | |

- `send_to_bot` from Sheldon must carry a `type`. CAL, ITINERARY and RECEIPT take only named fields (`data`), each checked, and the message the recipient gets is **rebuilt by the server from those fields**, so a reason, a title, a client name or anything else cannot ride along. CAL is `{start, end, status: busy|away}`; ITINERARY is `{kind, start, end?, from?, to?, carrier?, number?}` with short plain labels; RECEIPT is `{date, amount, currency, category, vendor?}`.
- Q and A carry free text (500 characters at most) and go to Leonard only. The server cannot judge whether a sentence is confidential, so this is where Sheldon's own judgment is the only guard; keeping it to the work calendar limits it.
- A second check sits in the delivery path itself: a message from Sheldon is delivered only if it passed the check above, once, to that recipient.
- Sheldon cannot create a group chat, post in one, or be added to one (from the app or by another bot), and a group that lists it skips it.
- Recipients are named by bot name in `SILO_BOTS`; the allow-list above is the one `provision.sh` prints.

## Bringing it up on Host2

Each step that is privileged or touches the firewall waits for Alex's yes.

1. **Build the images** (needs Docker, which is installed): `docker compose -f silo/sheldon/compose.yaml build`. Optionally pin Hermes to the team's version with `HERMES_COMMIT`.
2. **Encrypted volume** (root, Alex types the passphrase): `sudo silo/sheldon/host/make-volume.sh create 40G`. After a reboot, `make-volume.sh open` before the silo starts; Sheldon is down until then. Needs `cryptsetup-bin`.
3. **Create the bot in the app first, siloed from birth.** Add `SILO_BOTS={"name:Sheldon": {...}}` (the line from step 4 with `name:Sheldon` as the key) to the app's `.env` and restart the app, then create the bot named Sheldon. It never gets a Hermes home on the host.
4. **Host side** (root): `sudo silo/sheldon/host/provision.sh <sheldon bot id>`. Writes the secrets and settings under `/etc/cleft-bot/silo/sheldon/`, installs the relay unit (not started) and prints the `SILO_BOTS` line; switch the key from `name:Sheldon` to the id.
5. **Firewall** (needs Alex's yes): with UFW on, the relay needs one rule: `ufw allow in on br-sheldon-out from 172.30.53.2 to 172.30.53.1 port 8789 proto tcp`. Docker itself adds the NAT and isolation rules for the two networks when they are created.
6. **Start**: `systemctl enable --now sheldon-mcp-relay` and `docker compose -f silo/sheldon/compose.yaml --env-file /etc/cleft-bot/silo/sheldon/silo.env up -d`.
7. **Model**: Alex signs Sheldon's Hermes in to the firm's ChatGPT himself, from the live view (Take control, right-click the desktop, Terminal, `hermes auth add openai-codex`). Then set its model choice in the app (provider locked to `openai-codex`, see `docs/model-selection.md`).
8. **Import** of Sheldon's export happens only after the checks below pass and Alex confirms. Alex places the package inside the volume himself.

## Checks

- `node tests/silo.mjs`: the allow-list rules (8 checks).
- `sudo node tests/silo-e2e.mjs`: the real app with the real container (9 checks): siloed from creation, app reaches the agent, MCP through gate and relay, refusals and a rebuilt CAL at Leonard, no group chats, sign-in and restart refused, approval gate reachable from inside, live view answers.
- Checked by hand in the container: no capabilities (`CapEff 0`), no sudo, no Docker socket; no direct internet; a host not on the allow-list is refused; the relay refuses other paths and other bots; the host relay and the inside bridge address are unreachable from the container.

## Not done yet, and known limits

- **The browser is Microsoft Edge** (since 2026-11-22, Alex's choice; `SILO_BROWSER=google-chrome` in silo.env builds Chrome instead, with its profile in /data/chrome). Both are Chromium, so the flags, DevTools port and sandbox note below apply to either.
- **The browser runs without its own inner sandbox.** On Host2 (2026-11-22) Chrome's setuid sandbox failed to start ("failed to move to new namespaces") because the container sets no-new-privileges and drops every capability. `provision.sh` therefore writes `CHROME_NO_SANDBOX=1`, and the container (non-root user, no capabilities, internal network, allow-list proxy) is the only wall around the browser. Turning Chrome's sandbox back on would need a seccomp profile that allows user namespaces and a host AppArmor change, which is Alex's call.
- **The ChatGPT desktop app for Linux** (preview) is not in the image yet. Install it in the container once its package source is checked, and add its hosts to the allow-list.
- **Memory panel**: the app reads a bot's memory from its Hermes home on the host; Sheldon's is inside the volume, so the panel is empty for Sheldon.
- **Backups**: `host/backup.sh` stops the container for a moment, archives `/data`, encrypts it with `age` to a public key whose private half Alex keeps off the machine, cuts it into 95 MB pieces and pushes to a private GitHub repository. It needs `age`, the repo clone and a deploy key. `host/sheldon-backup.service` and `host/sheldon-backup.timer` run it weekly (Sunday 3:30 a.m. Central); copy both to `/etc/systemd/system/` and enable the timer once the recipient file and clone exist. Git history keeps every backup, so the repository grows over time.
- **What a silo does not change** (team plan, section 4): the app's database holds Sheldon's conversations with the app, and whoever administers the machine can read it. The silo keeps Sheldon apart from the other bots, not from the machine's administrator.
- **User namespaces**: Docker's `userns-remap` would map the container's users to an unused range on the host. It is a daemon-wide change and would affect the speech container, so it is left for Alex to decide.

## Open internet (SILO_EGRESS=open)

Alex asked on 2026-11-22 for Sheldon to reach the whole web, as he did in his old ChatGPT home. With `SILO_EGRESS=open` in `silo.env` the gate's proxy allows any public host on ports 443 and 80. It still refuses `gate/denylist`: localhost, `.local`/`.lan`/`.internal`, `*.ts.net`, and private, tailnet, link-local and multicast IP literals. `sheldon-egress-guard.service` adds a firewall backstop: the `SHELDON-EGRESS` chain in `DOCKER-USER` drops anything from the gate to 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8 and multicast, so a public name that resolves to a private address still can't reach this machine's neighbours or the tailnet. The host relay is unaffected, because it is host-bound traffic that UFW already limits to port 8789.

Still in place: no direct route out (everything goes through the gate), no access to the other bots except the typed allow-list, the encrypted volume, and no capabilities. What changes is that Sheldon can now send data to any public website, so a malicious page could try to talk him into leaking something. His standing instructions keep confidential work in the container, and the gate's log records every host he reaches. To go back: set `SILO_EGRESS=allowlist`, recreate the gate, and `systemctl disable --now sheldon-egress-guard`.
