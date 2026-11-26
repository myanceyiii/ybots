#!/usr/bin/env bash
# Encrypted backup of Sheldon's volume to Alex's private GitHub repository. Run as root.
#
#   backup.sh                 stop the silo for a moment, archive /data, encrypt, start it, push
#
# Encryption uses age to a public key (BACKUP_RECIPIENT, an age1... line in
# /etc/cleft-bot/silo/sheldon/backup.recipient). The matching private key is kept by Alex off
# this machine, so neither this machine nor GitHub can read the backup. Pieces are cut to 95 MB
# because GitHub refuses files over 100 MB. Only the newest KEEP backups stay in the tree.
#
# Needs: age, git, a clone of the private backup repo at BACKUP_REPO with a push credential that
# can write only that repository (a deploy key).
set -euo pipefail
ETC=/etc/cleft-bot/silo/sheldon
DATA=${SILO_DATA:-/srv/cleft-silo/sheldon/data}
REPO=${BACKUP_REPO:-/var/lib/cleft-bot/sheldon-backup}
KEEP=${KEEP:-7}
COMPOSE=(docker compose -f "$(cd "$(dirname "$0")/.." && pwd)/compose.yaml" --env-file "$ETC/silo.env")
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
RECIPIENT=$(grep -E '^age1[0-9a-z]+$' "$ETC/backup.recipient" | head -1)
[ -n "$RECIPIENT" ] || { echo "no age recipient in $ETC/backup.recipient" >&2; exit 1; }
[ -d "$REPO/.git" ] || { echo "no backup clone at $REPO" >&2; exit 1; }
mountpoint -q "$DATA" || { echo "$DATA is not mounted (encrypted volume closed?)" >&2; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPO/sheldon/$STAMP"
mkdir -p "$OUT"
# A consistent copy: the agent's databases are closed while the archive is made.
"${COMPOSE[@]}" stop sheldon
trap '"${COMPOSE[@]}" start sheldon' EXIT
tar -C "$DATA" --numeric-owner -cf - . | age -r "$RECIPIENT" | split -b 95m -d -a 3 - "$OUT/data.tar.age."
"${COMPOSE[@]}" start sheldon
trap - EXIT
( cd "$OUT" && sha256sum data.tar.age.* > SHA256SUMS )

cd "$REPO"
ls -1d sheldon/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r git rm -rq --
git add -A sheldon
git -c user.name=cleft-bot-backup -c user.email=backup@localhost commit -qm "Sheldon backup $STAMP"
git push -q origin HEAD
echo "pushed $STAMP"
