#!/usr/bin/env bash
# Put the YBots approval gate into the PRIMARY Hermes agent's home (the one YBots does not
# manage itself). Managed bots get it automatically. Run it yourself on the machine Hermes runs on:
#
#   bash scripts/install-hermes-gate.sh [HERMES_HOME]     (default: $HERMES_HOME_PRIMARY or ~/.hermes)
#
# It copies server/hermes-plugins/cleft-bot-gate into <home>/plugins/, writes gate.json (mode 600)
# pointing at this server's /mcp/primary/gate, and prints the two config.yaml lines to add. It does
# not edit config.yaml or restart anything. Once enabled, every Hermes tool that is not read-only asks
# for approval in the app, but only in turns that come in through Hermes' API server (the app's way
# in). Telegram, the dashboard, cron and other platforms keep Hermes' own approval rules. If the app
# is down, API-server turns cannot use those tools (fail closed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
HOME_DIR="${1:-$(getenv HERMES_HOME_PRIMARY)}"
HOME_DIR="${HOME_DIR:-$HOME/.hermes}"
PORT="$(getenv PORT)"; PORT="${PORT:-8787}"
secret="$(getenv SESSION_SECRET)"
[ -n "$secret" ] || { echo "SESSION_SECRET is not set in $ENV_FILE" >&2; exit 1; }
[ -d "$HOME_DIR" ] || { echo "No Hermes home at $HOME_DIR" >&2; exit 1; }
tok="$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
dest="$HOME_DIR/plugins/cleft-bot-gate"
umask 077
mkdir -p "$dest"
cp server/hermes-plugins/cleft-bot-gate/plugin.yaml server/hermes-plugins/cleft-bot-gate/__init__.py "$dest/"
# Only turns that arrive through the API server (how the app talks to Hermes) are checked here;
# Telegram, the dashboard, cron and other platforms keep Hermes' own approval rules.
printf '{"url":"http://127.0.0.1:%s/mcp/primary/gate","token":"%s","timeout":1560,"platforms":["api_server"]}\n' "$PORT" "$tok" > "$dest/gate.json"
chmod 600 "$dest/gate.json"
cat <<EOF
Installed the gate plugin in $dest.
To turn it on, add to $HOME_DIR/config.yaml and restart that Hermes:

plugins:
  enabled: [cleft-bot-gate]      # keep any plugins already listed
approvals:
  timeout: 1560                  # so Hermes waits as long as an approval card does

To turn it off again: remove cleft-bot-gate from plugins.enabled.
EOF
