#!/usr/bin/env bash
# Set up YBots on a Linux machine of your own (Ubuntu or Debian), with everything on that
# machine: the bots' screens, the live view, voice, and the app itself. Run it from the repo, as root:
#
#   ALLOWED_EMAILS=you@firm.com OWNER_EMAIL=you@firm.com bash scripts/setup-local.sh
#
# Optional:
#   PUBLIC_URL   how people reach the app, e.g. https://agents.your-tailnet.ts.net (default http://localhost:8787).
#                A phone needs HTTPS for its microphone; `tailscale serve` gives the machine an HTTPS name.
#   PORT         8787
#   SPEECH=0     skip the local speech server (Speaches in Docker) that voice calls use
#   SPEACHES_IMAGE  ghcr.io/speaches-ai/speaches:latest-cpu
#   SKIP_CHROME=1   keep whatever browser is installed
#   SETUP_HERMES=1  also install Hermes Agent (if missing), turn on its API server on 127.0.0.1:8642, run its
#                   gateway as the systemd service ybots-hermes, and give it the app's tools. You still sign
#                   it in to a model yourself afterwards: `hermes model` (INSTALL.md, step 4).
#
# Without SETUP_HERMES=1, Hermes must already be installed with its API server on; this script then points
# the app at it. Re-running the script upgrades the app and keeps .env, the database and the bots' files.
# INSTALL.md walks through every step; llms-install.md is the same for a coding agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:$PORT}"
HERMES_HOME_DIR="${HERMES_HOME_PRIMARY:-$HOME/.hermes}"
SPEACHES_IMAGE="${SPEACHES_IMAGE:-ghcr.io/speaches-ai/speaches:latest-cpu}"
STT_MODEL="${VOICE_STT_MODEL:-Systran/faster-distil-whisper-small.en}"
TTS_MODEL="${VOICE_TTS_MODEL:-speaches-ai/Kokoro-82M-v1.0-ONNX}"
[ "$(id -u)" = 0 ] || { echo "Run as root (the bots' screens and files live under /root and /opt/hq)."; exit 1; }
command -v apt-get >/dev/null || { echo "This script is for Ubuntu or Debian (apt-get)."; exit 1; }
log() { printf '\n== %s\n' "$*"; }

log "1/7 Desktop pieces: virtual displays, window manager, live view, screenshots"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb x11vnc openbox x11-utils x11-xserver-utils xdotool xclip wmctrl imagemagick dbus-x11 \
  python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 papirus-icon-theme thunar \
  fonts-noto-core fonts-liberation curl ca-certificates openssl build-essential sqlite3 qrencode >/dev/null
# build-essential: native modules (the SQLite driver) build from source when no prebuilt binary downloads.
# The file pane's previews and create_document (server/src/files.ts) convert on this machine.
apt-get install -y -qq --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils >/dev/null || echo "note: install libreoffice-writer, -calc, -impress and poppler-utils for file previews"
# LibreOffice's -nogui build has no screen plugin, so it opens no window on a bot's desktop.
if dpkg -s libreoffice-core-nogui >/dev/null 2>&1; then
  apt-get install -y -qq --no-install-recommends libreoffice-gtk3 >/dev/null || echo "note: LibreOffice here is the -nogui build; install libreoffice-gtk3 so it can show a window"
fi
if [ "${SKIP_CHROME:-0}" != 1 ] && ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then
  arch="$(dpkg --print-architecture)"
  if [ "$arch" = amd64 ]; then
    if curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
      apt-get install -y -qq /tmp/chrome.deb >/dev/null && rm -f /tmp/chrome.deb
    else
      echo "note: could not download Google Chrome; the bots need a Chrome or Chromium to browse. Install one and run this again."
    fi
  else
    apt-get install -y -qq chromium >/dev/null || echo "note: install a Chromium build for $arch yourself"
  fi
fi

log "2/7 Node 22"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -v | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  NODE_DIR=/opt/hq/node; NODE_V=v22.21.1
  mkdir -p "$NODE_DIR"
  case "$(uname -m)" in x86_64) na=x64 ;; aarch64) na=arm64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$na.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
  NODE_BIN="$NODE_DIR/bin/node"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
node -v

log "3/7 Hermes Agent (the bots' engine)"
HERMES_BIN_PATH="$(command -v hermes || true)"
[ -z "$HERMES_BIN_PATH" ] && [ -x "$HOME/.local/bin/hermes" ] && HERMES_BIN_PATH="$HOME/.local/bin/hermes"
if [ "${SETUP_HERMES:-0}" = 1 ]; then
  if [ -z "$HERMES_BIN_PATH" ]; then
    HERMES_INSTALL_URL="${HERMES_INSTALL_URL:-https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh}"
    echo "installing Hermes Agent from $HERMES_INSTALL_URL (log: /tmp/ybots-hermes-install.log)"
    curl -fsSL "$HERMES_INSTALL_URL" | HERMES_HOME="$HERMES_HOME_DIR" bash -s -- --non-interactive >/tmp/ybots-hermes-install.log 2>&1 \
      || { tail -20 /tmp/ybots-hermes-install.log; echo "Hermes did not install; see the log above"; exit 1; }
    HERMES_BIN_PATH="$(command -v hermes || true)"
    [ -z "$HERMES_BIN_PATH" ] && [ -x "$HOME/.local/bin/hermes" ] && HERMES_BIN_PATH="$HOME/.local/bin/hermes"
    [ -n "$HERMES_BIN_PATH" ] || { echo "Hermes installed but no hermes command was found; see /tmp/ybots-hermes-install.log"; exit 1; }
  fi
  "$HERMES_BIN_PATH" --version 2>/dev/null | head -1 || true
  # The API server the app talks to: loopback only, with a key of its own. Other lines are kept.
  mkdir -p "$HERMES_HOME_DIR"; touch "$HERMES_HOME_DIR/.env"; chmod 600 "$HERMES_HOME_DIR/.env"
  if ! grep -qE '^API_SERVER_KEY=.+' "$HERMES_HOME_DIR/.env"; then
    sed -i -E '/^API_SERVER_(ENABLED|KEY|PORT|HOST)=/d' "$HERMES_HOME_DIR/.env"
    { echo "API_SERVER_ENABLED=true"; echo "API_SERVER_KEY=$(openssl rand -hex 32)"; echo "API_SERVER_PORT=8642"; echo "API_SERVER_HOST=127.0.0.1"; } >> "$HERMES_HOME_DIR/.env"
  fi
  cat > /etc/systemd/system/ybots-hermes.service <<UNIT
[Unit]
Description=Hermes Agent gateway for YBots (the first bot)
After=network-online.target

[Service]
Environment=HOME=$HOME
Environment=HERMES_HOME=$HERMES_HOME_DIR
Environment=PATH=$(dirname "$HERMES_BIN_PATH"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$HERMES_BIN_PATH gateway run --no-supervise
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable ybots-hermes >/dev/null 2>&1 || true
  systemctl restart ybots-hermes
  for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8642/health >/dev/null 2>&1 && break; sleep 2; done
  if curl -fsS http://127.0.0.1:8642/health >/dev/null 2>&1; then echo "Hermes API server is up on 127.0.0.1:8642"
  else echo "note: Hermes' API server is not answering yet (journalctl -u ybots-hermes); the app keeps retrying"; fi
elif [ -z "$HERMES_BIN_PATH" ]; then
  echo "note: no hermes command found. Install Hermes first, or run this again with SETUP_HERMES=1 (INSTALL.md, step 3)."
fi

log "4/7 Build the app"
cd "$ROOT"
# Node's own headers let the SQLite module build without downloading them.
npm_config_nodedir="$(dirname "$(dirname "$NODE_BIN")")" npm ci --no-audit --no-fund >/tmp/cleft-bot-npm.log 2>&1 || { tail -20 /tmp/cleft-bot-npm.log; exit 1; }
npm run build >/tmp/cleft-bot-build.log 2>&1 || { tail -20 /tmp/cleft-bot-build.log; exit 1; }
[ -f apps.json ] || { cp apps.example.json apps.json; echo "made apps.json from apps.example.json: edit it for your apps (docs/local-apps.md)"; }

log "5/7 Settings (.env is written once and kept on later runs)"
if [ ! -f .env ]; then
  : "${ALLOWED_EMAILS:?ALLOWED_EMAILS (comma-separated emails that may sign in) is required on first run}"
  key() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
  umask 077
  {
    echo "PORT=$PORT"
    echo "APP_URL=$PUBLIC_URL"
    echo "SERVER_URL=$PUBLIC_URL"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "DEV_LOGIN=0"
    echo "ALLOWED_EMAILS=$ALLOWED_EMAILS"
    echo "OWNER_EMAIL=${OWNER_EMAIL:-${ALLOWED_EMAILS%%,*}}"
    echo "COMPUTER=local"
    echo "HERMES_BIN=${HERMES_BIN_PATH:-/usr/local/bin/hermes}"
    echo "HERMES_URL=http://127.0.0.1:8642"
    echo "HERMES_HOME_PRIMARY=$HERMES_HOME_DIR"
    echo "HERMES_KEY=$(key API_SERVER_KEY "$HERMES_HOME_DIR/.env")"
    echo "VOICE_URL=http://127.0.0.1:8000/v1"
    echo "VOICE_STT_MODEL=$STT_MODEL"
    echo "VOICE_TTS_MODEL=$TTS_MODEL"
    echo "# VOICE_APPROVALS=1   # answer approval cards by saying yes or no on a call"
    echo "# XAI_API_KEY=        # optional: only for the x_search tool"
  } > .env
  chmod 600 .env
fi

log "6/7 Local speech server for voice calls (Speaches: Whisper + Kokoro), on 127.0.0.1:8000 only"
if [ "${SPEECH:-1}" = 1 ]; then
  if ! command -v docker >/dev/null; then
    echo "Docker is not installed, so voice is set up without a speech server. Install Docker and run this again,"
    echo "or run any server with the OpenAI audio API and point VOICE_URL at it."
  else
    if ! docker ps --format '{{.Names}}' | grep -qx speaches; then
      docker rm -f speaches >/dev/null 2>&1 || true
      docker run --detach --restart unless-stopped --name speaches \
        --publish 127.0.0.1:8000:8000 \
        --volume speaches-hf-cache:/home/ubuntu/.cache/huggingface/hub \
        "$SPEACHES_IMAGE" >/dev/null
    fi
    for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 2; done
    for m in "$STT_MODEL" "$TTS_MODEL"; do
      if curl -fsS -X POST "http://127.0.0.1:8000/v1/models/$m" >/dev/null 2>&1; then echo "model ready: $m"
      else echo "note: could not download $m; check the model name in .env (VOICE_STT_MODEL / VOICE_TTS_MODEL) against the Speaches docs"; fi
    done
  fi
fi

log "7/7 Keep it running (systemd service cleft-bot)"
# Installs from before the rename have a unit called bot-hq-local; replace it so only one copy runs.
if [ -f /etc/systemd/system/bot-hq-local.service ]; then
  systemctl disable --now bot-hq-local >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/bot-hq-local.service
fi
cat > /etc/systemd/system/cleft-bot.service <<EOF
[Unit]
Description=YBots (self-hosted AI agent team)
After=network-online.target docker.service

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN --env-file=$ROOT/.env $ROOT/server/dist/index.js
Restart=always
RestartSec=3
Environment=HOME=$HOME
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The bots' displays and browsers are started detached and must outlive a restart of the app.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cleft-bot >/dev/null 2>&1 || true
systemctl restart cleft-bot
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo

secret="$(grep -E '^SESSION_SECRET=' .env | cut -d= -f2-)"
tok="$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
umask 077
mkdir -p data
cat > data/hermes-mcp-hq.yaml <<EOF
# Add under mcp_servers: in $HERMES_HOME_DIR/config.yaml (Hermes picks it up without a restart).
  hq:
    url: http://127.0.0.1:$PORT/mcp/primary
    headers:
      Authorization: Bearer $tok
    timeout: 1800
    connect_timeout: 30
EOF
OWNER="$(grep -E '^OWNER_EMAIL=' .env | tail -1 | cut -d= -f2-)"
if [ "${SETUP_HERMES:-0}" = 1 ] && [ -f "$HERMES_HOME_DIR/config.yaml" ]; then
  if python3 -c 'import yaml' 2>/dev/null || { apt-get install -y -qq python3-yaml >/dev/null 2>&1 && python3 -c 'import yaml'; }; then
    python3 "$ROOT/scripts/add-hq-to-hermes.py" --config "$HERMES_HOME_DIR/config.yaml" --entry "$ROOT/data/hermes-mcp-hq.yaml" \
      && echo "gave the first bot's Hermes the app's tools (mcp_servers.hq in $HERMES_HOME_DIR/config.yaml)"
  fi
fi
cat <<EOF

Done.
- Sign in to a model for the first bot, if you have not: HERMES_HOME=$HERMES_HOME_DIR hermes model
- Give that Hermes the app's tools, if this script did not: python3 scripts/add-hq-to-hermes.py --config $HERMES_HOME_DIR/config.yaml --entry $ROOT/data/hermes-mcp-hq.yaml
- Sign in to the app: ENV_FILE=$ROOT/.env bash scripts/sign-in-link.sh ${OWNER:-you@example.com}
- Apps: edit $ROOT/apps.json (docs/local-apps.md). Voice and calls: docs/voice.md. Phones and PCs: docs/android.md, docs/windows-app.md.
EOF
