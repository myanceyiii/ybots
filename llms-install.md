# YBots install guide for AI coding agents

You are installing YBots for a person on a Linux machine you can run commands on. Follow these steps in
order. Each step has the command, a check, and what the check prints when it worked. Stop and tell the
person when a check fails twice; the "If it fails" lines name the usual cause. The human-oriented guide
with the same steps is [INSTALL.md](INSTALL.md).

## Rules while you install

- Ask the person before you start for: (1) the email address(es) allowed to sign in, (2) how they will
  reach the app (only this machine, Tailscale, Cloudflare, or their own domain), (3) whether to set up voice
  (needs Docker). Do not guess an email address.
- Never print, log or paste the values of `SESSION_SECRET`, `API_SERVER_KEY`, `HERMES_KEY` or any token.
  Read them only with the scripts below.
- Never open port 8787, 8642, 8000 or 59xx to the internet, never set `DEV_LOGIN=1` on a public address,
  and never put the app on a public address without `ALLOWED_EMAILS`.
- The model sign-in (`hermes model`) is interactive and is the person's account: hand that step to the
  person. Do not create accounts or accept provider terms for them.
- Run as root (`sudo -i`). Do not install on a machine that already runs other important services
  without asking: bots run as root and can read the machine's files.

## Step 0: check the machine

```bash
. /etc/os-release && echo "$ID $VERSION_ID $(uname -m)"; nproc; free -g | awk '/Mem:/{print $2" GB"}'; df -h / | tail -1; ps -p 1 -o comm=
```

Expected: `ubuntu 24.04` or `debian 12`, `x86_64` or `aarch64`, 4 or more CPUs, 8 or more GB, 30 GB or
more free, and `systemd`. If PID 1 is not `systemd` (a plain container), the services in step 2 cannot
start: tell the person and stop.

## Step 1: get the code

```bash
apt-get update -qq && apt-get install -y -qq git curl ca-certificates openssl
git clone https://github.com/myanceyiii/ybots.git /opt/ybots && cd /opt/ybots && git log --oneline -1
```

Expected: one line with a commit id and message.

## Step 2: run the setup script

```bash
cd /opt/ybots
ALLOWED_EMAILS='<email from the person>' SETUP_HERMES=1 SPEECH=<1 with voice, 0 without> \
  bash scripts/setup-local.sh 2>&1 | tee /root/ybots-setup.log | grep -E '^== |^note:|Done\.|error' 
```

Takes 5 to 20 minutes. Expected: the lines `== 1/7` to `== 7/7`, a line `{"ok":true,...}` from the health
check, and `Done.` The script ends with exit code 0 (`echo $?`).

Check:

```bash
systemctl is-active cleft-bot ybots-hermes
curl -fsS http://127.0.0.1:8787/api/health; echo
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8642/health
grep -c '^  hq:' ~/.hermes/config.yaml
```

Expected: `active` twice, a JSON line with `"ok":true`, `200`, and `1`.

If it fails:
- `note: could not download Google Chrome`: install Chrome or Chromium another way, then rerun the
  script (the bots browse with it; everything else works without it).
- `Hermes did not install`: read `/tmp/ybots-hermes-install.log`. Behind a TLS-inspecting proxy, export
  `SSL_CERT_FILE` and `UV_NATIVE_TLS=true` and rerun.
- `cleft-bot` not active: `journalctl -u cleft-bot -n 50 --no-pager` and match the message in INSTALL.md,
  "Troubleshooting".
- The script is safe to run again after a fix; it keeps `.env` and data.

## Step 3: the person signs Hermes in to a model

Tell the person to run this in a terminal on the machine and pick their provider:

```bash
HERMES_HOME=/root/.hermes hermes model
```

Then check that the first bot's engine has a model:

```bash
curl -fsS http://127.0.0.1:8787/api/health; echo
journalctl -u ybots-hermes -n 20 --no-pager | tail -5
```

Expected: the health line still says `"ok":true`, and no repeating errors in the Hermes log.

## Step 4: make the sign-in link

```bash
cd /opt/ybots && bash scripts/sign-in-link.sh '<owner email>'
```

Expected: a `http(s)://.../api/auth/link/...` line and a QR code. Give the person the link: it signs in
one browser once, within 15 minutes. It is a credential: do not paste it anywhere else.

## Step 5: reach it from other devices (if the person asked)

Do one of these, then set the address in `.env` and restart:

```bash
# A. Tailscale (the person must sign the machine in to their tailnet: `tailscale up` prints a link)
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up && tailscale serve --bg 8787
ADDR="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

# B. Cloudflare Tunnel + Access, or C. the person's own reverse proxy: follow INSTALL.md step 6 and set ADDR to the https address.

cd /opt/ybots
sed -i -E "s#^APP_URL=.*#APP_URL=$ADDR#; s#^SERVER_URL=.*#SERVER_URL=$ADDR#" .env
systemctl restart cleft-bot && sleep 3 && curl -fsS http://127.0.0.1:8787/api/health; echo
curl -fsS -o /dev/null -w '%{http_code}\n' "$ADDR/api/health"
```

Expected: `"ok":true` and `200`. For Cloudflare Access also add `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` (the person reads them from their Zero Trust dashboard). Then make a new sign-in link
(step 4): links carry `APP_URL`.

## Step 6: report to the person

Tell them, in this order: the address to open, that the sign-in link expires in 15 minutes, that the
first bot is ready once they have signed Hermes in to a model (step 3), and where the apps are:
`docs/android.md` and `docs/windows-app.md`. Mention that every app action a bot takes waits for their OK
on a card until they choose "Always allow".

## Rollback

Everything the install added, newest first. Ask the person before removing `~/.hermes` (their agent's
memory and sign-ins) or `/root/bothq` (files the bots made).

```bash
systemctl disable --now cleft-bot ybots-hermes
rm -f /etc/systemd/system/cleft-bot.service /etc/systemd/system/ybots-hermes.service && systemctl daemon-reload
docker rm -f speaches 2>/dev/null; docker volume rm speaches-hf-cache 2>/dev/null
rm -rf /opt/ybots /opt/hq/node
# tailscale serve reset          # if you did step 5A
```

Packages from step 2 (Xvfb, x11vnc, Openbox, LibreOffice, Chrome, Docker) stay installed; remove them
with `apt-get remove` only if the person asks.

## Upgrade later

```bash
cd /opt/ybots && git pull && bash scripts/setup-local.sh && curl -fsS http://127.0.0.1:8787/api/health
```

Expected: `"ok":true`. The script keeps `.env`, the database and the bots.
