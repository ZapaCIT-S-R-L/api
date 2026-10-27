# ZapaKid calls service

Voice calls for ZapaKid (1:1 and group) on Cloudflare Realtime (SFU + TURN), as its own Worker:
`calls-staging.zapakid.ro` (staging) and `calls.zapakid.ro` (production). Every audio frame is encrypted on the
phone with a per-call key that is sealed per device with libsignal; this service and Cloudflare only see ciphertext.
Audio is never stored; the call log in D1 (EU) is metadata only.

- Contract: [`openapi.yaml`](openapi.yaml) (`npm run lint:api` validates it).
- Auth: the chat token from the account API (root of this repo, `POST /v1/chat/token`), verified against its JWKS
  (`ACCOUNT_JWKS_URL`). No login of its own.
- Node 24 (`../../.nvmrc`). In this folder: `npm ci --ignore-scripts`, then
  - `npm test`: `test/scripts` (node:test) and `test/worker` (Vitest in the Workers runtime);
  - `scripts/check.sh`: everything CI runs (`.github/workflows/ci-calls.yml`), including the e2e tests against
    `wrangler dev` on port 8797 with a fake account JWKS and a fake Realtime/TURN API on 127.0.0.1:8798 (plain http
    URLs are accepted only on loopback);
  - `npm run lint`, `npm run format`.

## How changes ship

A merge to `main` that touches `services/calls/` runs `.github/workflows/deploy-calls.yml`: tests, D1 database (EU,
created if missing) and migrations, `wrangler deploy --env staging`, e2e against calls-staging.zapakid.ro (rollback
on failure), then the same for production once @stefan-zpc approves the `production` environment. The account API's
own workflows ignore `services/`.

The GitHub environments and Cloudflare API token are the API's (root README, "Deploying"): the same token scopes
cover this Worker (Workers Scripts, D1, Workers Routes and DNS on `zapakid.ro`). The custom domains create their own
DNS records on the first deploy.

## How a call works

- `src/calls.ts`: the HTTP API (start, join, leave, decline, call log, events, Realtime proxy).
- `src/call-room.ts`: one Durable Object per call. It holds the roster and the key epoch, which goes up on every
  join and leave. It runs the hibernating events WebSocket and relays the libsignal-sealed key envelopes to the one
  device each is for, queuing them for a device that isn't connected yet. It also runs the timers: 45 s ring
  timeout, 2 h maximum, 30 s reconnect grace, and cleanup an hour after the end.
- `src/realtime.ts`: Cloudflare Realtime SFU calls with the app secret, plus TURN credentials (TTL 1 h). If TURN is
  down, it falls back to STUN only.
- `src/push.ts`: the ringing interface (PushKit VoIP / FCM). It's a stub until the APNs and FCM credentials and the
  device push tokens arrive.
- Limits: 8 participants, and 10 calls started and 30 joins a minute per account (rate limiting binding).

## Secrets (Stefan)

The Worker needs four secrets per environment. `/health` answers 503 and names any that are missing, so the deploy's
e2e check fails and rolls back until they are set. Create a Realtime SFU app and a TURN key in the Cloudflare
dashboard (Realtime), one of each per environment, then from this folder:

    scripts/set-secrets.sh staging       # prompts for REALTIME_APP_ID, REALTIME_APP_SECRET, TURN_KEY_ID, TURN_KEY_API_TOKEN
    scripts/set-secrets.sh production

wrangler prompts for each value without echoing it. Nothing is printed or stored anywhere else. The chat tokens
need the account API's signing key (root README, "Chat tokens").

## Retention

The call log keeps who started a call in which conversation, when, how it ended and the peak number of
participants. It never keeps audio or keys. Rows are purged daily after `CALL_LOG_RETENTION_DAYS` (365). Deleting a
conversation's call log together with the chat comes with the chat service.
