#!/usr/bin/env bash
# Stefan runs this (never an agent, never CI): makes a new chat token signing key and stores it as the Worker secret
# CHAT_TOKEN_SIGNING_KEY of one environment. The private key goes from node straight into wrangler through a pipe:
# it is never printed, written to a file or kept in a shell variable. Needs `npx wrangler login` (or
# CLOUDFLARE_API_TOKEN) with Workers Scripts: Edit on the ZapaCIT account.
# Usage: scripts/set-chat-token-key.sh staging|production
# Running it again rotates the key: tokens signed with the old one stop verifying and the apps fetch new ones.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

env=${1:-}
case "$env" in
  staging|production) ;;
  *) echo "Usage: $0 staging|production" >&2; exit 2 ;;
esac

node scripts/chat-token-key.js | npx wrangler secret put CHAT_TOKEN_SIGNING_KEY --env "$env"
echo "CHAT_TOKEN_SIGNING_KEY set for $env. Check: curl https://api$([ "$env" = staging ] && echo -staging).zapakid.ro/.well-known/jwks.json"
