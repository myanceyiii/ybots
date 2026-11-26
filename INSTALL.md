# Installing YBots

This guide installs YBots on one Linux machine of your own, from this repository alone. It takes
about 20 minutes on a fresh machine, most of it downloads. A coding agent can follow
[llms-install.md](llms-install.md) instead: the same steps with checks and expected output.

You end up with:

- the YBots server (web app, API and the bots' tools) as the systemd service `cleft-bot` on port 8787;
- the first bot's engine, [Hermes Agent](https://github.com/NousResearch/hermes-agent), as the service
  `ybots-hermes` with its API server on `127.0.0.1:8642`;
- a virtual screen per bot (Xvfb, Openbox, x11vnc) with Chrome, made on demand;
- optionally a local speech server for voice calls and dictation (Speaches in Docker);
- the web app at your address, and the Android and Windows apps signed in to it.

> The service is still called `cleft-bot` and some settings start with `CLEFTBOT_`: those are the
> project's earlier internal names, kept so existing installs keep working.

## 1. What you need

| | Minimum | Comfortable |
|---|---|---|
| OS | Ubuntu 24.04 or Debian 12, x86_64 or arm64, with systemd | Ubuntu 24.04 LTS |
| CPU / RAM | 4 cores / 8 GB (two bots) | 8 cores / 32 GB (four or more bots) |
| Disk | 30 GB free | 100 GB (browser profiles, files, backups) |
| Access | root (sudo) on the machine | |
| A model | a sign-in or API key for at least one model provider that Hermes supports (ChatGPT/Codex, Claude, OpenRouter, Nous Portal, a local model, and others) | |
| Optional | Docker, for the local speech server | a domain or a Tailscale tailnet, for HTTPS on phones |

Each bot's Chrome uses about 1.5 GB of memory while it browses. Bots run as root on this machine and
can read each other's files: give YBots a machine (or VM) of its own. Read [SECURITY.md](SECURITY.md)
before you put it on a network others can reach.

## 2. Get the code

```bash
sudo -i                                   # the rest runs as root
apt-get update && apt-get install -y git curl ca-certificates
git clone https://github.com/myanceyiii/ybots.git /opt/ybots
cd /opt/ybots
```

Any folder works; this guide uses `/opt/ybots`.

## 3. Install everything with one script

```bash
ALLOWED_EMAILS=you@example.com SETUP_HERMES=1 bash scripts/setup-local.sh
```

`ALLOWED_EMAILS` lists who may sign in (comma-separated). The first address is the owner
(`OWNER_EMAIL`), whose first bot is the Hermes agent this script sets up. The script:

1. installs the desktop pieces (Xvfb, Openbox, x11vnc, xdotool, ImageMagick, LibreOffice for file
   previews) and Google Chrome (on arm64, Chromium);
2. installs Node.js 22 under `/opt/hq/node` unless Node 22.12 or newer is already there;
3. with `SETUP_HERMES=1`: installs Hermes Agent with its official installer (unless `hermes` is
   already installed), turns on its API server on `127.0.0.1:8642` with a new key in `~/.hermes/.env`,
   and runs its gateway as the service `ybots-hermes`;
4. runs `npm ci` and `npm run build`, and copies `apps.example.json` to `apps.json`;
5. writes `.env` once (mode 600) with a new `SESSION_SECRET`; later runs keep it;
6. starts the speech server in Docker if Docker is installed (`SPEECH=0` skips it);
7. installs and starts the service `cleft-bot`, waits for `/api/health`, writes
   `data/hermes-mcp-hq.yaml` and adds it to Hermes' `config.yaml`, so the first bot gets the app's tools.

Other settings for the script:

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8787` | How people reach the app. Set it now if you know it (step 6), e.g. `https://bots.example.com` |
| `PORT` | `8787` | The app's port |
| `SPEECH` | `1` | `0` skips the speech server |
| `SKIP_CHROME` | `0` | `1` keeps whatever browser is installed |
| `SETUP_HERMES` | `0` | `1` installs and runs Hermes as above. Leave it out if you run Hermes yourself |
| `HERMES_HOME_PRIMARY` | `~/.hermes` | The first bot's Hermes home |

Running the script again is safe: it upgrades the app and keeps `.env`, the database and the bots' files.

**Check it:**

```bash
systemctl is-active cleft-bot ybots-hermes      # active, active
curl -s http://127.0.0.1:8787/api/health         # {"ok":true,...}
curl -s http://127.0.0.1:8642/health             # Hermes answers
```

### If you run Hermes yourself

Leave out `SETUP_HERMES=1`. Before running the script, install Hermes
(`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`, see the
[Hermes docs](https://hermes-agent.nousresearch.com/docs/getting-started/installation)), and turn on
its API server in `~/.hermes/.env`:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random value: openssl rand -hex 32>
API_SERVER_PORT=8642
API_SERVER_HOST=127.0.0.1
```

Keep its gateway running (`hermes gateway run`). The script reads the key from `~/.hermes/.env`. After
the script, give that agent the app's tools:

```bash
python3 scripts/add-hq-to-hermes.py --config ~/.hermes/config.yaml --entry data/hermes-mcp-hq.yaml
```

It adds one `mcp_servers.hq` entry, keeps a dated copy of the file, and Hermes picks it up without a
restart. `--remove` takes it out again.

## 4. Sign the first bot in to a model

Hermes needs a model before the first bot can answer:

```bash
HERMES_HOME=~/.hermes hermes model
```

Pick a provider and follow its sign-in: a subscription (for example ChatGPT/Codex) or an API key. Check
your provider's terms before you run agents on a consumer subscription. Every other bot you make later
gets a Hermes home and gateway of its own (under `data/engines/`), and you pick its provider and model in
the app: open the bot, **Engine**.

## 5. Sign in to the app

On the machine:

```bash
bash scripts/sign-in-link.sh you@example.com
```

It prints a one-time link (valid 15 minutes) and a QR code of it. Open the link in a browser that can
reach the app (on the machine itself, `http://localhost:8787` works). From then on, any signed-in device
can sign in another one: account menu, **Sign in another device** shows a QR code for the phone or a link
for a browser. The script works for any address, so only run it for people you mean to let in.

## 6. Reach it from your other devices

The app listens on `127.0.0.1` while `APP_URL` is a `localhost` address. To use it from a phone or another
computer, give it an HTTPS address (phones need HTTPS for the microphone) and update `.env`:

```bash
# in /opt/ybots/.env
APP_URL=https://bots.example.com
SERVER_URL=https://bots.example.com
ALLOWED_EMAILS=you@example.com,partner@example.com
```

then `systemctl restart cleft-bot`. Pick one way in:

**A. Tailscale (private, simplest).** Install [Tailscale](https://tailscale.com/download/linux), then
`tailscale serve --bg 8787`. The app is then at `https://<machine>.<tailnet>.ts.net` for devices on your
tailnet only. Use that address as `APP_URL`.

**B. Cloudflare Tunnel with Cloudflare Access (reachable anywhere, behind a sign-in).** Make a tunnel to
`http://127.0.0.1:8787` and an Access application for the hostname that lets in your addresses. Then in
`.env`: `CF_ACCESS_TEAM_DOMAIN=<your team>` and `CF_ACCESS_AUD=<the application's AUD tag>`. The app checks
Access' signed token on every request and signs people in by the address Access let through, if it is on
`ALLOWED_EMAILS`. Phones without a VPN use an Access service token: see "Signing in" in the
[README](README.md#signing-in) for `CF_ACCESS_PHONE_TOKENS`.

**C. Your own reverse proxy (Caddy, nginx).** Terminate HTTPS there and forward to `127.0.0.1:8787`,
including WebSockets (the live screen and voice use them) and long-lived responses (`/api/events` is a
stream; turn off proxy buffering for it). Keep the app's own sign-in: do not put Basic auth in front of
it, because the phone and Windows apps cannot pass it. Example for Caddy:

```
bots.example.com {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
```

Whatever you choose, never expose port 8787 itself to the internet, and keep `DEV_LOGIN=0`.

## 7. Voice calls and dictation (optional)

With Docker installed, the script runs [Speaches](https://speaches.ai) (Whisper for speech to text,
Kokoro for the voice) on `127.0.0.1:8000` and downloads both models. Without Docker, install it
(`apt-get install -y docker.io`) and run the script again, or point `VOICE_URL` at any server with the
OpenAI audio API. Details, other voices and the Phonon call voice: [docs/voice.md](docs/voice.md).

## 8. Connect apps, plugins and connectors

- **Apps** are MCP servers on the machine, listed in `apps.json`, behind approval cards:
  [docs/local-apps.md](docs/local-apps.md). The example file has entries to copy and turn on.
- **Plugins** add tools that run in a container, installed from the app (**Settings > Connections**):
  [docs/plugins.md](docs/plugins.md).
- **Connectors** (also under **Settings > Connections**) add remote MCP servers and sign-ins such as Google:
  [docs/connector-admin.md](docs/connector-admin.md).
- **Research on X** needs `XAI_API_KEY` in `.env` (optional; nothing is sent to xAI without it).

Every action a bot takes in a connected app waits for your OK on a card in the chat until you choose
**Always allow** for it. See [SECURITY.md](SECURITY.md).

## 9. Phones and PCs

- **Android:** [docs/android.md](docs/android.md) (build the APK, or install a released one; sign in by
  scanning the QR code from step 5).
- **Windows:** [docs/windows-app.md](docs/windows-app.md) (download the zip from Releases or build it;
  enter your address and scan the QR code).
- **Any browser:** open your address. The web app installs as a PWA on phones and desktops.

All three apps have the same features (chat, approval cards, screens, voice, files, pages, settings).

## 10. Make your bots

Open the app and make a bot with **+**: a name, a look, instructions. The first bot of the owner is the
Hermes agent from step 3 (it keeps its own memory, skills and messaging channels). Each new bot gets its
own Hermes home under `data/engines/<bot>/`, its own gateway on ports from 8650, its own screen and
browser profile. `MAX_BOTS` in `.env` caps how many you can make (default 4).

A person listed in `SCOPED_PEOPLE` (in `.env`) sees only the bots named for them, in a simpler view: useful for
a family member who should have one bot of their own.

## 11. Back up

What to keep, all on the machine:

| What | Where |
|---|---|
| The database (chats, bots, cards, settings) | `data/*.db` (path in the start line of `journalctl -u cleft-bot`) |
| Daily verified copies of it | `data/snapshots/` (14 kept, `DB_SNAPSHOTS_KEEP`) |
| Settings and secrets | `.env`, `apps.json` |
| Each extra bot's Hermes home | `data/engines/` |
| The first bot's Hermes home | `~/.hermes` |
| Library files and browser profiles | `/root/bothq/` |

A simple nightly backup (encrypt it before it leaves the machine; it holds sign-ins):

```bash
sqlite3 /opt/ybots/data/cleftbot.db ".backup /var/backups/ybots-$(date +%F).db"   # the database named in the start line
tar -czf /var/backups/ybots-files-$(date +%F).tgz -C / opt/ybots/.env opt/ybots/apps.json opt/ybots/data/engines root/.hermes root/bothq
```

To restore: stop `cleft-bot` and `ybots-hermes`, put the files back, start them again.

## 12. Upgrade

```bash
cd /opt/ybots
git pull
bash scripts/setup-local.sh          # rebuilds and restarts; keeps .env, data and bots
```

Or by hand: `npm ci && npm run build && systemctl restart cleft-bot`. Read the release notes first: they
say when a new setting is needed. The server makes a database copy every day; take one by hand before a
big upgrade with **Settings > System**, **Copy now**. Hermes upgrades itself with `hermes update`.

## 13. Uninstall

```bash
systemctl disable --now cleft-bot ybots-hermes
rm -f /etc/systemd/system/cleft-bot.service /etc/systemd/system/ybots-hermes.service
systemctl daemon-reload
docker rm -f speaches 2>/dev/null; docker volume rm speaches-hf-cache 2>/dev/null
python3 /opt/ybots/scripts/add-hq-to-hermes.py --config ~/.hermes/config.yaml --remove   # if you keep Hermes
rm -rf /opt/ybots /root/bothq /opt/hq/node        # the app, its data, browser profiles and files, its Node
# rm -rf ~/.hermes                                # only if you also want Hermes and its memory gone
```

Bots' screens are processes started by the app; a reboot (or `pkill Xvfb`) ends any that are left.

## 14. Troubleshooting

| Symptom | Look at | Usual fix |
|---|---|---|
| `cleft-bot` will not start | `journalctl -u cleft-bot -n 50` | The server refuses the placeholder `SESSION_SECRET`, or a database with no accounts next to one with accounts (set `DB_PATH`, or `ALLOW_EMPTY_DB=1` for a deliberate fresh start) |
| "engine didn't start" / the first bot never answers | `journalctl -u ybots-hermes -n 50`; `curl 127.0.0.1:8642/health` | Sign Hermes in to a model (step 4); check `HERMES_KEY` in `.env` matches `API_SERVER_KEY` in `~/.hermes/.env` |
| The bot answers but has no app tools | `grep -A4 'hq:' ~/.hermes/config.yaml` | Run `add-hq-to-hermes.py` (step 3) |
| Sign-in link says the address is not allowed | `ALLOWED_EMAILS` in `.env` | Add the address and restart |
| A phone can't connect | the address in the app | It must be `https://`; on a tailnet the phone needs Tailscale on |
| Voice does nothing | `curl 127.0.0.1:8000/health`; `docker logs speaches` | Install Docker and rerun the script, or set `VOICE_URL` |
| A bot's screen stays black | `pgrep -a Xvfb`; the bot's Computer panel | Install Chrome (`SKIP_CHROME=0`) and rerun; check `LOCAL_RESOLUTION` |
| A new bot "stopped while starting" | `tail data/engines/<bot id>/logs/gateway.out.log` | Its first start installs Python packages. Behind a proxy or TLS-inspecting firewall, add `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE` and `UV_NATIVE_TLS=true` to the `cleft-bot` service (`systemctl edit cleft-bot`); each bot's agent gets them |
| Anything else | **Settings > System** in the app | Each check says what is wrong; **Copy report** copies it all |

More for whoever runs the server: [docs/operations.md](docs/operations.md). Architecture:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development install

To work on the code without the desktop pieces:

```bash
npm ci
cp .env.example .env            # set SESSION_SECRET, DEV_LOGIN=1, HERMES_URL/HERMES_KEY
npm run dev                      # server on :8787 and web on :5173 (DEV_LOGIN works only on localhost)
npm test                         # every hermetic suite: throwaway database, fake Hermes, nothing beyond 127.0.0.1
```

`?fixtures` on the dev web app shows sample data with no server behind it. See
[CONTRIBUTING.md](CONTRIBUTING.md).
