#!/usr/bin/env bash
# Runs the same checks as CI (.github/workflows/ci.yml, audit.yml), locally, and prints a Markdown summary for the
# PR description. Exit code 0 only when every check passed. Needs Node 24, gitleaks, actionlint, osv-scanner.
# Usage: scripts/check.sh            (from the repo root)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

LOG_DIR=$(mktemp -d)
PORT=${CHECK_PORT:-8787}
JWKS_PORT=8788
rows=()
failed=0

run() {
  local name=$1
  shift
  local log="$LOG_DIR/${name// /_}.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    rows+=("| $name | pass | $((SECONDS - start)) s |")
  else
    rows+=("| $name | **FAIL** | $((SECONDS - start)) s |")
    failed=1
    echo "---- $name failed, last lines of $log:" >&2
    tail -20 "$log" >&2
  fi
}

e2e() {
  rm -rf .wrangler/state
  npx wrangler d1 migrations apply DB --local || return 1
  # A throwaway chat token signing key for this run only.
  npx wrangler dev --port "$PORT" --ip 127.0.0.1 --show-interactive-dev-session=false \
    --var "APPLE_JWKS_URL:http://127.0.0.1:$JWKS_PORT/apple" --var "GOOGLE_JWKS_URL:http://127.0.0.1:$JWKS_PORT/google" \
    --var "CHAT_TOKEN_SIGNING_KEY:$(node scripts/chat-token-key.js)" \
    </dev/null >"$LOG_DIR/wrangler-dev.log" 2>&1 &
  local pid=$!
  local up=0
  for _ in $(seq 1 60); do
    if curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/health"; then up=1; break; fi
    sleep 1
  done
  local status=1
  if [ "$up" = 1 ]; then API_URL="http://127.0.0.1:$PORT" npm run test:e2e && status=0; fi
  kill "$pid" 2>/dev/null
  pkill -f "wrangler dev --port $PORT" 2>/dev/null
  return $status
}

want=$(cat .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]')
[ "$have" = "$want" ] || echo "Note: Node $have here, CI uses $want (.nvmrc)." >&2

run "npm ci" npm ci --ignore-scripts
run "lint (Prettier, ESLint, tsc, Redocly)" npm run lint
run "actionlint" actionlint
run "unit (node tests + Worker tests)" npm test
run "build (wrangler dry run, staging)" npx wrangler deploy --dry-run --env staging --outdir "$LOG_DIR/dist"
run "e2e (wrangler dev)" e2e
run "npm audit (runtime, high+)" npm audit --omit=dev --audit-level=high
run "OSV-Scanner (lockfile)" osv-scanner scan source --lockfile package-lock.json
run "npm sbom (CycloneDX)" npm sbom --sbom-format cyclonedx --omit dev --package-lock-only
run "gitleaks (history)" gitleaks git . --no-banner --redact

echo
echo "Local checks ($(git rev-parse --short HEAD), $(date -u +%Y-%m-%dT%H:%MZ), Node $(node -v)):"
echo
echo "| Check | Result | Time |"
echo "| --- | --- | --- |"
printf '%s\n' "${rows[@]}"
[ "$failed" = 0 ] || echo "Logs: $LOG_DIR" >&2
exit $failed
