#!/usr/bin/env bash
# Make the public copy of this repository: the files of one commit (default HEAD) without the paths
# in scripts/public/exclude.txt, checked by scripts/public/check.sh, committed as ONE fresh commit with
# no history. It never pushes; you look at it, then push it yourself to the public repository.
#
#   scripts/public/export.sh --deny <deny-list file> --out <empty folder> [--ref <commit>] [--test]
#
#   --deny   deny list kept outside the repo (names, hostnames, addresses), see check.sh
#   --out    where the public copy goes (must not exist yet)
#   --ref    commit to export (default HEAD; uncommitted changes are never included)
#   --test   also run `npm ci`, `npm run build` and `npm test` in the copy, as a new user would
#
# Then:  cd <out> && git remote add origin git@github.com:<you>/<public repo>.git && git push -u origin main
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF=HEAD; DENY=; OUT=; TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deny) DENY=$2; shift 2 ;; --out) OUT=$2; shift 2 ;; --ref) REF=$2; shift 2 ;; --test) TEST=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[ -n "$DENY" ] && [ -n "$OUT" ] || { sed -n '2,14p' "$0"; exit 2; }
[ -e "$OUT" ] && { echo "$OUT already exists; give a new folder"; exit 2; }
DENY=$(cd "$(dirname "$DENY")" && pwd)/$(basename "$DENY")
case "$DENY" in "$ROOT"/*) echo "keep the deny list outside the repository"; exit 2 ;; esac

mkdir -p "$OUT"
git -C "$ROOT" archive --format=tar "$REF" | tar -x -C "$OUT"
while IFS= read -r p; do
  case "$p" in ''|'#'*) continue ;; esac
  rm -rf "${OUT:?}/${p%/}"
done < "$ROOT/scripts/public/exclude.txt"
# The household-skills folder is gitignored except its README, which points at private files.
rm -rf "$OUT/deploy/household-skills"
echo "== exported $(git -C "$ROOT" rev-parse --short "$REF") to $OUT"

bash "$ROOT/scripts/public/check.sh" "$OUT" "$DENY"

# Links inside the docs that would point at a file left out.
missing=0
while IFS= read -r line; do
  file=${line%%:*}; link=${line#*:}
  target=$(cd "$(dirname "$OUT/$file")" && realpath -m "$link")
  [ -e "$target" ] || { echo "broken link in $file -> $link"; missing=1; }
done < <(cd "$OUT" && grep -oE '\]\(([^)#: ]+\.(md|sh|json|ya?ml|txt))' -r --include='*.md' . | sed -E 's/\]\(//' | sed 's#^\./##')
[ $missing = 0 ] || { echo "FAIL: fix the links above (or stop excluding their targets)"; exit 1; }

if [ $TEST = 1 ]; then
  echo "== npm ci, build and the hermetic tests in the copy"
  (cd "$OUT" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && npm test)
  rm -rf "$OUT/node_modules" "$OUT"/*/node_modules "$OUT"/*/dist
fi

git -C "$OUT" init -q -b main
git -C "$OUT" add -A
git -C "$OUT" -c user.name="${PUBLIC_AUTHOR_NAME:-YBots}" -c user.email="${PUBLIC_AUTHOR_EMAIL:-ybots@users.noreply.github.com}" \
  commit -q -m "YBots $(date -u +%Y-%m-%d) (public snapshot)"
echo "== one commit, no history: $(git -C "$OUT" log --oneline)"
echo "Nothing was pushed. Look it over, then push it to the public repository yourself."
