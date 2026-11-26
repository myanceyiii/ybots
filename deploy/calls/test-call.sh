#!/usr/bin/env bash
# Place one test call (run as root on the call machine). Only numbers in CALLS_ALLOWED_TO can be called.
#   sudo bash deploy/calls/test-call.sh <number> [bot] [brief]
# Prints the call id; follow it with: sudo bash deploy/calls/test-call.sh --show <id>
set -euo pipefail
. /etc/cleft-bot/calls/calls.env
if [ "${1:-}" = "--show" ]; then
  curl -s -H "Authorization: Bearer $CLEFT_CALLS_KEY" "http://127.0.0.1:8791/calls/$2"; echo; exit 0
fi
to="$1"; bot="${2:-Leonard}"
brief="${3:-This is a test call to the owner on his own phone. Introduce yourself, ask how their morning is going, chat for a few turns, then ask whether your voice sounds natural and how long your pauses feel. Thank them and end the call when they are done.}"
opening="Hi, this is an AI assistant calling for ${CALL_FOR:-the owner}. This call is recorded. This is a test call."
python3 - "$to" "$bot" "$brief" "$opening" <<'PY' | curl -s -X POST http://127.0.0.1:8791/calls -H "Authorization: Bearer $CLEFT_CALLS_KEY" -H 'content-type: application/json' --data-binary @-
import json, sys
print(json.dumps({"to": sys.argv[1], "bot": sys.argv[2], "brief": sys.argv[3], "opening": sys.argv[4], "max_seconds": 180}))
PY
echo
