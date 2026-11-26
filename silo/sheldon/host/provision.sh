#!/usr/bin/env bash
# Prepare the host side of Sheldon's silo. Run as root on the bots' machine, once, after the bot
# exists in the app (or with SHELDON_BOT_ID set to "name:Sheldon" style config; see docs/sheldon-silo.md).
#
#   sudo silo/sheldon/host/provision.sh <sheldon-bot-id> [app .env path]
#
# Writes (nothing outside these):
#   /etc/cleft-bot/silo/sheldon/            root-only settings: silo.env, relay.env, allowlist
#   /etc/cleft-bot/silo/sheldon/secrets/    api_key, vnc_password, mcp_token (read by the container's user)
#   /usr/local/lib/cleft-bot/sheldon-mcp-relay.py and /etc/systemd/system/sheldon-mcp-relay.service
# It starts nothing and changes no firewall rule. It prints the SILO_BOTS line for the app's .env.
set -euo pipefail
BOT=${1:?usage: provision.sh <sheldon-bot-id> [app .env]}
APP_ENV=${2:-/opt/hq/bot-hq-local/.env}
HERE=$(cd "$(dirname "$0")" && pwd)
ETC=/etc/cleft-bot/silo/sheldon
SILO_UID=10101
DATA=${SILO_DATA:-/srv/cleft-silo/sheldon/data}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[[ "$BOT" =~ ^[A-Za-z0-9_-]{3,64}$ ]] || { echo "bad bot id" >&2; exit 1; }
SECRET=$(grep -E '^SESSION_SECRET=' "$APP_ENV" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
[ -n "$SECRET" ] || { echo "SESSION_SECRET not found in $APP_ENV" >&2; exit 1; }

install -d -m 0700 -o root -g root "$ETC"
install -d -m 0750 -o root -g "$SILO_UID" "$ETC/secrets"
umask 077
new() { [ -s "$1" ] || { printf '%s' "$2" > "$1"; }; }
new "$ETC/secrets/api_key" "$(openssl rand -hex 24)"
new "$ETC/secrets/vnc_password" "$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | cut -c1-8)"
# The token the app expects from this bot on /mcp: HMAC-SHA256(SESSION_SECRET, "mcp:<bot id>").
printf 'mcp:%s' "$BOT" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1 | tr -d '\n' > "$ETC/secrets/mcp_token"
chown root:"$SILO_UID" "$ETC"/secrets/*
chmod 0440 "$ETC"/secrets/*

[ -s "$ETC/allowlist" ] || install -m 0644 "$HERE/../gate/allowlist.example" "$ETC/allowlist"

cat > "$ETC/silo.env" <<ENV
SHELDON_BOT_ID=$BOT
SILO_DATA=$DATA
SILO_ALLOWLIST=$ETC/allowlist
SECRETS_DIR=$ETC/secrets
AGENT_PORT=8653
VNC_PORT=5953
# Chrome's setuid sandbox cannot start under no-new-privileges with every capability dropped
# (tested on Host2, Ubuntu 24.04). The container stays the wall around the browser.
CHROME_NO_SANDBOX=${CHROME_NO_SANDBOX:-1}
# allowlist or open (the whole internet except private addresses; also enable sheldon-egress-guard).
SILO_EGRESS=${SILO_EGRESS:-allowlist}
ENV
cat > "$ETC/relay.env" <<ENV
SHELDON_BOT_ID=$BOT
RELAY_LISTEN=172.30.53.1:8789
GATE_IP=172.30.53.2
APP=127.0.0.1:${APP_PORT:-8787}
ENV
chmod 0600 "$ETC/silo.env" "$ETC/relay.env"

# The relay runs as a systemd DynamicUser, so the folder must be readable by others (root's umask may be 077).
install -d -m 0755 /usr/local/lib/cleft-bot
install -m 0755 "$HERE/sheldon-egress-guard.sh" /usr/local/lib/cleft-bot/sheldon-egress-guard.sh
install -m 0644 "$HERE/sheldon-egress-guard.service" /etc/systemd/system/sheldon-egress-guard.service
install -D -m 0755 "$HERE/sheldon-mcp-relay.py" /usr/local/lib/cleft-bot/sheldon-mcp-relay.py
install -m 0644 "$HERE/sheldon-mcp-relay.service" /etc/systemd/system/sheldon-mcp-relay.service
systemctl daemon-reload

echo
echo "Add to the app's .env (then restart the app):"
printf 'SILO_BOTS={"%s":{"url":"http://127.0.0.1:8653","keyFile":"%s","vnc":"127.0.0.1:5953","vncPasswordFile":"%s","allow":{"Leonard":["CAL","ITINERARY","RECEIPT","Q","A"]}}}\n' \
  "$BOT" "$ETC/secrets/api_key" "$ETC/secrets/vnc_password"
