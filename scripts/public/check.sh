#!/usr/bin/env bash
# Look for anything private in a folder before it is shared: secrets (gitleaks, when installed) and
# the words in a deny list you keep OUTSIDE the repository (names, hostnames, addresses, one
# Perl-style regex per line, # for comments). Exits 1 and prints each hit when it finds one.
#
#   scripts/public/check.sh <folder> <deny-list file>
set -euo pipefail
DIR=${1:?folder to check}; DENY=${2:?deny list file (kept outside the repo)}
[ -d "$DIR" ] || { echo "no folder $DIR"; exit 2; }
[ -f "$DENY" ] || { echo "no deny list at $DENY"; exit 2; }
bad=0
pat=$(grep -vE '^\s*(#|$)' "$DENY" | paste -sd'|' -)
if [ -n "$pat" ]; then
  if grep -rInP --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json "$pat" "$DIR" | cut -c1-200; then
    echo "FAIL: deny-listed words above"; bad=1
  fi
  # File and folder names too.
  if (cd "$DIR" && find . -path ./node_modules -prune -o -print | grep -iP "$pat"); then echo "FAIL: deny-listed file names above"; bad=1; fi
fi
if command -v gitleaks >/dev/null; then
  gitleaks dir "$DIR" --no-banner --redact -l warn || { echo "FAIL: gitleaks found possible secrets"; bad=1; }
else
  echo "note: gitleaks is not installed, so only the deny list was checked"
fi
for f in .env apps.json; do [ -e "$DIR/$f" ] && { echo "FAIL: $f must never be shared"; bad=1; }; done
find "$DIR" -name '*.db' -not -path '*/node_modules/*' | grep . && { echo "FAIL: database files"; bad=1; }
[ $bad = 0 ] && echo "clean: nothing from the deny list, no secrets found"
exit $bad
