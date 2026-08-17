#!/usr/bin/env bash
# Create a remote repos vault on Fly.io, from nothing to a working server.
#
#   ./scripts/deploy-fly.sh my-vault-name [region] [size-gb]
#
# Safe to re-run: existing apps and volumes are reused, so this doubles as the
# way to deploy an update.
set -euo pipefail

APP="${1:-}"
REGION="${2:-ewr}"
SIZE="${3:-10}"

if [ -z "$APP" ]; then
  echo "usage: $0 <app-name> [region] [size-gb]" >&2
  echo "" >&2
  echo "  <app-name>  globally unique on Fly, e.g. 'jeremys-vault'" >&2
  echo "  [region]    Fly region code (default ewr; see 'fly platform regions')" >&2
  echo "  [size-gb]   volume size in GB (default 10)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if ! command -v fly >/dev/null 2>&1; then
  echo "flyctl is not installed. See https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi
if ! fly auth whoami >/dev/null 2>&1; then
  echo "Not logged in to Fly. Run: fly auth login" >&2
  exit 1
fi

if fly status -a "$APP" >/dev/null 2>&1; then
  echo "==> App '$APP' already exists, reusing it"
else
  echo "==> Creating app '$APP'"
  fly apps create "$APP"
fi

if fly volumes list -a "$APP" 2>/dev/null | grep -q '[[:space:]]vault[[:space:]]'; then
  echo "==> Volume 'vault' already exists, reusing it"
else
  echo "==> Creating ${SIZE}GB volume 'vault' in $REGION"
  fly volumes create vault --app "$APP" --region "$REGION" --size "$SIZE" --yes
fi

# --ha=false is required, not a preference: a vault is a directory on one
# volume, so a second machine would be a second, silently diverging vault.
echo "==> Deploying (single machine)"
fly deploy --app "$APP" --ha=false

URL="https://${APP}.fly.dev"
echo ""
echo "==> Deployed: $URL"

echo "==> Looking for the one-time owner token in the logs"
TOKEN=""
for _ in 1 2 3 4 5 6; do
  TOKEN="$(fly logs -a "$APP" --no-tail 2>/dev/null | grep -o 'repos_[0-9a-f]\{64\}' | head -1 || true)"
  [ -n "$TOKEN" ] && break
  sleep 5
done

echo ""
if [ -n "$TOKEN" ]; then
  echo "Owner token (shown once by the server on first start):"
  echo ""
  echo "  export REPOS_HOST=$URL"
  echo "  export REPOS_TOKEN=$TOKEN"
  echo ""
  echo "Then: repos whoami"
else
  echo "No owner token found in the recent logs."
  echo "If this vault was already initialized, that is expected: the token is"
  echo "printed only on the very first start. Otherwise check: fly logs -a $APP"
fi
