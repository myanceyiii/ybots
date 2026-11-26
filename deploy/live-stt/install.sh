#!/usr/bin/env bash
# Install or update the live dictation service on this machine (run as root, from a Cleft checkout):
#   sudo bash deploy/live-stt/install.sh            install/update, start, health check, set LIVE_STT_URL
#   sudo bash deploy/live-stt/install.sh --remove   stop and remove it (the apps fall back by themselves)
# Then restart Cleft (cleft-ops deploy) so the server picks up LIVE_STT_URL.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest=/opt/cleft-live-stt
envfile="${CLEFT_ENV:-/opt/hq/bot-hq-local/.env}"
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now cleft-live-stt 2>/dev/null || true
  rm -f /etc/systemd/system/cleft-live-stt.service
  systemctl daemon-reload
  [ -f "$envfile" ] && sed -i '/^LIVE_STT_URL=/d' "$envfile"
  echo "removed (kept $dest; delete it by hand if wanted)"
  exit 0
fi
mkdir -p "$dest"
[ -x "$dest/venv/bin/python" ] || python3 -m venv "$dest/venv"
"$dest/venv/bin/pip" install -q -r "$here/requirements.txt"
install -m 0644 "$here/cleft_live_stt.py" "$dest/cleft_live_stt.py"
install -m 0644 "$here/cleft-live-stt.service" /etc/systemd/system/cleft-live-stt.service
systemctl daemon-reload
systemctl enable cleft-live-stt >/dev/null
systemctl restart cleft-live-stt
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8790/health
if [ -f "$envfile" ] && ! grep -q '^LIVE_STT_URL=' "$envfile"; then
  echo 'LIVE_STT_URL=ws://127.0.0.1:8790/live' >> "$envfile"
  echo "added LIVE_STT_URL to $envfile"
fi
