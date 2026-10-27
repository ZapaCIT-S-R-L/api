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

## Retention

The call log keeps who started a call in which conversation, when, and how it ended. Never audio, never keys.
