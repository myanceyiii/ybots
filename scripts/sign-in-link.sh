#!/usr/bin/env bash
# Print a link that signs one browser or phone in to the app, once, within 15 minutes, plus a QR code of it. Run ON the computer, as root.
#   bash sign-in-link.sh you@example.com
#   BASE_URL=https://<machine>.<tailnet>.ts.net bash sign-in-link.sh you@example.com
# BASE_URL swaps the link's address, for example to the Tailscale Serve address when APP_URL is a public
# hostname behind Cloudflare Access (the phone app can't pass Access, so it signs in over the tailnet).
#   CFA_ID=<client id> CFA_SECRET=<client secret> bash sign-in-link.sh you@example.com
# CFA_ID/CFA_SECRET put one phone's Cloudflare Access service token in the link's #fragment, so that phone
# can reach the public hostname through Access with no VPN. Browsers never send a #fragment to a server,
# and the phone app keeps it in its secure storage. Make one token per phone, so each can be revoked alone.
#   CFA_FILE=/etc/cleftbot/phone-access/<phone>.env bash sign-in-link.sh you@example.com
# reads CFA_ID and CFA_SECRET (and optionally BASE_URL) from a root-only file instead, so the secret stays
# off the command line.
# Day to day nobody needs this: behind Cloudflare Access the app signs people in by itself, and a signed-in
# device can sign in another from the account menu (README "Signing in"). This script is for the first sign-in.
# It works for any address, including one that is
# not in ALLOWED_EMAILS, so only run it for people you mean to let in. The key it uses never leaves this machine.
set -euo pipefail
email="${1:?usage: sign-in-link.sh <email>}"
# The app's .env: /opt/hq/app/.env on a standard install, else the .env beside this script's checkout.
if [ -z "${ENV_FILE:-}" ]; then
  ENV_FILE=/opt/hq/app/.env
  [ -f "$ENV_FILE" ] || ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
fi
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
key="$(printf 'owner-login' | openssl dgst -sha256 -hmac "$(val SESSION_SECRET)" -r | cut -d' ' -f1)"
url="$(curl -fsS -X POST "http://127.0.0.1:$(val PORT)/api/auth/owner" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"link\":true}" | sed -E 's/.*"url":"([^"]+)".*/\1/')"
if [ -n "${CFA_FILE:-}" ]; then
  CFA_ID="$(grep -E '^CFA_ID=' "$CFA_FILE" | cut -d= -f2-)"; CFA_SECRET="$(grep -E '^CFA_SECRET=' "$CFA_FILE" | cut -d= -f2-)"
  # The file can also name the public address the phone should use (the one behind Cloudflare Access).
  [ -n "${BASE_URL:-}" ] || BASE_URL="$(grep -E '^BASE_URL=' "$CFA_FILE" | cut -d= -f2- || true)"
  [ -n "${APP_SCHEME:-}" ] || APP_SCHEME="$(grep -E '^APP_SCHEME=' "$CFA_FILE" | cut -d= -f2- || true)"
fi
if [ -n "${BASE_URL:-}" ]; then url="${BASE_URL%/}/${url#*://*/}"; fi
if [ -n "${CFA_ID:-}" ] && [ -n "${CFA_SECRET:-}" ]; then url="$url#cfa=$CFA_ID:$CFA_SECRET"; fi
echo "$url"
# The same link as an app link: tapped on the phone, it opens the app (cleftbot://) and signs in.
app_link="${APP_SCHEME:-cleftbot}://sign-in?link=$(printf '%s' "$url" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
echo "Open on the phone: $app_link"
# The phone app signs in by scanning the same link as a QR code (it fetches it as JSON and keeps the token).
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$url"
else
  echo "(Install qrencode to print this link as a QR code for the phone app: apt install qrencode)" >&2
fi
