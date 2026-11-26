#!/usr/bin/env bash
# Create, open or close Sheldon's encrypted volume (LUKS2 in a file). Run as root.
#
#   make-volume.sh create [size, default 40G]   new volume; asks Alex for a passphrase twice
#   make-volume.sh open                          after a reboot; asks for the passphrase
#   make-volume.sh close                         stop the silo first
#
# The passphrase is typed by Alex and is never stored on the machine, so after a reboot Sheldon
# stays down until it is opened again. The mount point is what compose.yaml mounts as /data.
set -euo pipefail
IMG=${SILO_IMG:-/srv/cleft-silo/sheldon.luks}
NAME=cleft-sheldon
MNT=${SILO_DATA:-/srv/cleft-silo/sheldon/data}
SILO_UID=10101
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v cryptsetup >/dev/null || { echo "cryptsetup is not installed (apt install cryptsetup-bin)" >&2; exit 1; }

case "${1:-}" in
  create)
    if [ -e "$IMG" ]; then
      if cryptsetup isLuks "$IMG" 2>/dev/null; then echo "$IMG already exists and is an encrypted volume; use open" >&2; exit 1; fi
      echo "$IMG is left over from an unfinished create (not encrypted yet); removing it"
      rm -f "$IMG"
    fi
    install -d -m 0700 "$(dirname "$IMG")"
    fallocate -l "${2:-40G}" "$IMG"
    chmod 0600 "$IMG"
    # Remove the empty file again if the format is cancelled or fails, so a rerun starts clean.
    trap 'cryptsetup isLuks "$IMG" 2>/dev/null || rm -f "$IMG"' EXIT
    echo "cryptsetup asks you to type YES in capital letters, then the passphrase twice."
    cryptsetup luksFormat --type luks2 --verify-passphrase "$IMG"
    trap - EXIT
    cryptsetup open "$IMG" "$NAME"
    mkfs.ext4 -q -L sheldon "/dev/mapper/$NAME"
    install -d -m 0700 "$MNT"
    mount -o nodev,nosuid,noexec "/dev/mapper/$NAME" "$MNT"
    chown "$SILO_UID:$SILO_UID" "$MNT"; chmod 0700 "$MNT"
    echo "created and mounted at $MNT" ;;
  open)
    cryptsetup open "$IMG" "$NAME"
    install -d -m 0700 "$MNT"
    mount -o nodev,nosuid,noexec "/dev/mapper/$NAME" "$MNT"
    echo "mounted at $MNT" ;;
  close)
    umount "$MNT"
    cryptsetup close "$NAME"
    echo "closed" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
