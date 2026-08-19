#!/usr/bin/env bash
# Check that every relative link in the markdown resolves to a file that
# exists. Moving a document is the ordinary way a link rots, and a broken
# link in the README is read by more people than most bugs.
#
# Run from anywhere: bash scripts/check-links.sh
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
checked=0

while IFS= read -r file; do
  dir="$(dirname "$file")"
  # Markdown inline links, minus the two kinds that name no file: absolute
  # URLs, and fragments pointing within the page itself.
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    case "$target" in
      http://*|https://*|mailto:*|'#'*) continue ;;
    esac
    path="${target%%#*}"          # drop any #anchor
    [ -n "$path" ] || continue
    checked=$((checked+1))
    if [ ! -e "$dir/$path" ]; then
      echo "BROKEN $file -> $target"
      fail=1
    fi
  done < <(
    # Code is not prose: drop fenced blocks and inline code spans first, so a
    # regex or a shell snippet that happens to contain ](...) is not read as a
    # link.
    awk '/^[[:space:]]*```/ { fenced = !fenced; next } !fenced' "$file" \
      | sed -e 's/`[^`]*`//g' \
      | grep -oE '\]\([^)]+\)' \
      | sed -e 's/^](//' -e 's/)$//'
  )
done < <(git ls-files '*.md')

if [ "$fail" = 0 ]; then
  echo "All $checked relative markdown links resolve."
else
  echo ""
  echo "Fix the links above, or the files they should point at."
  exit 1
fi
