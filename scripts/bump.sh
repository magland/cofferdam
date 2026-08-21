#!/usr/bin/env bash
set -euo pipefail

# Bumps the version in package.json and package-lock.json and commits the two
# of them. No tag: .github/workflows/publish.yml tags the release itself, from
# the version it reads back out of package.json after a successful publish, so
# a tag made here would only collide with that one.

LEVEL="${1:-patch}"

case "$LEVEL" in
  major|minor|patch|[0-9]*) ;;
  *)
    echo "usage: bump.sh [major|minor|patch|<version>]" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "error: working tree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

npm version "$LEVEL" --no-git-tag-version >/dev/null
version="$(node -p "require('./package.json').version")"
git commit --quiet -m "v$version" package.json package-lock.json

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "Committed v$version on $branch."
echo "Push it to publish: git push origin $branch"
