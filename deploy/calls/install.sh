#!/usr/bin/env bash
# Install or update the phone call service on this machine (run as root, from a Cleft checkout):
#   sudo bash deploy/calls/install.sh            install/update and start
#   sudo bash deploy/calls/install.sh --remove   stop and remove it (keeps recordings in /var/lib/cleft-calls)
# Needs /etc/cleft-bot/calls/telnyx.env (TELNYX_API_KEY=...). Writes /etc/cleft-bot/calls/calls.env once:
# the call service key (derived from the server's SESSION_SECRET), the Telnyx app id and number, and the
# allowed numbers (CALLS_ALLOWED_TO; set by hand while testing). Publishing /telnyx/* is a separate step
# (Tailscale Serve on :8443 + the Cloudflare tunnel's calls.example.com), see docs/calls.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest=/opt/cleft-calls
envfile="${CLEFT_ENV:-/opt/hq/bot-hq-local/.env}"
conf=/etc/cleft-bot/calls
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now cleft-calls cleft-call-llm 2>/dev/null || true
  rm -f /etc/systemd/system/cleft-calls.service /etc/systemd/system/cleft-call-llm.service
  systemctl daemon-reload
  echo "removed (kept $dest and /var/lib/cleft-calls)"
  exit 0
fi
[ -f "$conf/telnyx.env" ] || { echo "missing $conf/telnyx.env" >&2; exit 1; }
if [ ! -f "$conf/calls.env" ]; then
  secret="$(grep -E '^SESSION_SECRET=' "$envfile" | head -1 | cut -d= -f2- | tr -d '\"'"'")"
  [ -n "$secret" ] || { echo "no SESSION_SECRET in $envfile" >&2; exit 1; }
  key="$(printf 'cleft-calls' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
  umask 077
  cat > "$conf/calls.env" <<EOT
CLEFT_CALLS_KEY=$key
TELNYX_CONNECTION_ID=${TELNYX_CONNECTION_ID:-}
CALLS_FROM=${CALLS_FROM:-}
CALLS_ALLOWED_TO=${CALLS_ALLOWED_TO:-}
CALLS_PUBLIC_WSS=${CALLS_PUBLIC_WSS:-wss://calls.example.com}
EOT
  chmod 600 "$conf/calls.env"
  echo "wrote $conf/calls.env"
fi
mkdir -p "$dest"
[ -x "$dest/venv/bin/python" ] || python3 -m venv "$dest/venv"
"$dest/venv/bin/pip" install -q -r "$here/requirements.txt"
install -m 0644 "$here/cleft_calls.py" "$dest/cleft_calls.py"
install -m 0644 "$here/cleft-calls.service" /etc/systemd/system/cleft-calls.service
systemctl daemon-reload
systemctl enable cleft-calls >/dev/null
systemctl restart cleft-calls
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8791/telnyx/events -H 'content-type: application/json' -d '{}' || true)"
  [ "$code" = 200 ] && break
  sleep 2
done
echo "cleft-calls answered $code"
# The small local call model (the server uses it when its .env has CALLS_LOCAL_MODEL=...).
if [ -x /usr/local/bin/ollama ]; then
  model="${CALLS_LOCAL_MODEL:-$(grep -E '^CALLS_LOCAL_MODEL=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"'"'")}"
  install -m 0644 "$here/cleft-call-llm.service" /etc/systemd/system/cleft-call-llm.service
  systemctl daemon-reload
  systemctl enable cleft-call-llm >/dev/null
  systemctl restart cleft-call-llm
  sleep 3
  if [ -n "$model" ]; then
    curl -sf --max-time 900 http://127.0.0.1:11434/api/pull -d "{\"model\":\"$model\",\"stream\":false}" >/dev/null && echo "call model $model ready"
  fi
fi
