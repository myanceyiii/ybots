#!/usr/bin/env bash
# Turn on the Sheldon link on a running install (docs/sheldon-link.md). Run as root on the server,
# after the Slack tokens are in /etc/cleft-bot/slack/. It backs up first and restarts the app once.
#   sudo scripts/deploy-sheldon-link.sh <repo dir> <commit> <Sheldon's Slack member id> <channel id> [service] [call link]
#   call link: Sheldon's chatgpt.com/dots/… address; the app's "Open in ChatGPT" button opens it.
# Undo: the script prints the backup folder; restore .env from it and restart the service.
set -euo pipefail
REPO=${1:?repo dir}; COMMIT=${2:?commit}; SHELDON=${3:?Slack member id}; CHANNEL=${4:?channel id}; SVC=${5:-bot-hq-local}; CALL_URL=${6:-}
OWNER_NAME=${OWNER_NAME:?set OWNER_NAME to the first name Sheldon uses for the owner}
# These go into one line of .env as JSON: Slack ids are letters and digits, the name is plain words.
[[ "$SHELDON" =~ ^[UW][A-Z0-9]{4,20}$ ]] || { echo "Slack member id looks wrong (U… or W…)"; exit 1; }
[[ "$CHANNEL" =~ ^[CDG][A-Z0-9]{4,20}$ ]] || { echo "channel id looks wrong (C…, D… or G…)"; exit 1; }
[[ "$OWNER_NAME" =~ ^[A-Za-z][A-Za-z\ .\'-]{0,40}$ ]] || { echo "OWNER_NAME must be a plain first name"; exit 1; }
[[ -z "$CALL_URL" || "$CALL_URL" =~ ^https://chatgpt\.com/[A-Za-z0-9/._~-]*$ ]] || { echo "call link must be a plain https://chatgpt.com/ address"; exit 1; }
CALL_JSON=${CALL_URL:+,\"callUrl\":\"$CALL_URL\"}
TOK=/etc/cleft-bot/slack
BACKUP=/opt/hq/deploy-$(date -u +%Y%m%d-%H%M%S)-sheldon-link
for f in user_token app_token; do [ -s "$TOK/$f" ] || { echo "missing $TOK/$f (see docs/sheldon-link.md step 5)"; exit 1; }; done
grep -q '^xoxp-' "$TOK/user_token" && grep -q '^xapp-' "$TOK/app_token" || { echo "a token file holds the wrong kind of token"; exit 1; }

cd "$REPO"
git cat-file -e "$COMMIT^{commit}" || { echo "commit $COMMIT is not in $REPO; fetch it first"; exit 1; }
mkdir -p "$BACKUP"; chmod 700 "$BACKUP"
cp -a .env "$BACKUP/env"; git rev-parse HEAD > "$BACKUP/prev-commit"; git status --porcelain > "$BACKUP/status"
git diff > "$BACKUP/uncommitted.diff"; cp -a web/dist "$BACKUP/web-dist" 2>/dev/null || true
echo "backup: $BACKUP"
# Leftover edits under silo/ belong to the removed container work and are kept in the backup.
if grep -v ' silo/' "$BACKUP/status" | grep -q .; then echo "uncommitted changes outside silo/, see $BACKUP/status; stopping"; exit 1; fi
git checkout -- silo/ 2>/dev/null || true
git clean -fdq silo/ 2>/dev/null || true
git checkout -q --detach "$COMMIT"

# Config: Sheldon stops being a silo bot and becomes an outside member.
RUNAS=$(systemctl show -p User --value "$SVC"); RUNAS=${RUNAS:-root}
chown -R "$RUNAS" "$TOK"; chmod 700 "$TOK"; chmod 600 "$TOK"/*
sed -i -e '/^SILO_BOTS=/d' -e '/^OUTSIDE_BOTS=/d' -e '/^SLACK_\(USER\|BOT\|APP\)_TOKEN_FILE=/d' .env
cat >> .env <<CONF
OUTSIDE_BOTS={"name:Sheldon":{"via":"slack","slackUserId":"$SHELDON","channel":"$CHANNEL","channelName":"assistants","replyMinutes":75,"ownerName":"$OWNER_NAME","aliases":{"Claude":"Leonard"}$CALL_JSON}}
SLACK_USER_TOKEN_FILE=$TOK/user_token
SLACK_APP_TOKEN_FILE=$TOK/app_token
CONF

export PATH="$PATH:/usr/local/bin:/usr/bin"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
systemctl restart "$SVC"
for i in $(seq 1 30); do sleep 2; journalctl -u "$SVC" --since "-2min" | grep -q '\[slack-link\]' && break; done
journalctl -u "$SVC" --since "-2min" | grep '\[slack-link\]' || echo "no [slack-link] line yet; check: journalctl -u $SVC"
echo "done. Undo: cp $BACKUP/env $REPO/.env && git -C $REPO checkout \$(cat $BACKUP/prev-commit) && npm run build && systemctl restart $SVC"
