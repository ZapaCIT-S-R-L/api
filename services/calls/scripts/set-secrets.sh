#!/usr/bin/env bash
# Stefan runs this (never an agent, never CI): stores the Cloudflare Realtime and TURN credentials as Worker secrets
# of the calls Worker for one environment. wrangler prompts for each value without echoing it; nothing is printed,
# logged or written to disk. Get the values in the Cloudflare dashboard → Realtime:
#   REALTIME_APP_ID, REALTIME_APP_SECRET   Realtime → SFU → your app ("zapakid-calls-<env>"): App ID and App Secret
#   TURN_KEY_ID, TURN_KEY_API_TOKEN        Realtime → TURN Server → your key: Turn Token ID and API Token
# Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN) with Workers Scripts: Edit on the ZapaCIT account.
# Usage: services/calls/scripts/set-secrets.sh staging|production [NAME ...]   (default: all four)
set -euo pipefail
cd "$(dirname "$0")/.."

env=${1:-}
case "$env" in
  staging|production) ;;
  *) echo "Usage: $0 staging|production [NAME ...]" >&2; exit 2 ;;
esac
shift
names=("$@")
[ ${#names[@]} -gt 0 ] || names=(REALTIME_APP_ID REALTIME_APP_SECRET TURN_KEY_ID TURN_KEY_API_TOKEN)

for name in "${names[@]}"; do
  case "$name" in
    REALTIME_APP_ID|REALTIME_APP_SECRET|TURN_KEY_ID|TURN_KEY_API_TOKEN) ;;
    *) echo "Unknown secret $name" >&2; exit 2 ;;
  esac
  echo "Paste $name for $env (input hidden):"
  npx wrangler secret put "$name" --env "$env"
done
echo "Done. Check: curl https://calls$([ "$env" = staging ] && echo -staging).zapakid.ro/health"
