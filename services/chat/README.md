# ZapaKid chat service

Sealed mailboxes for ZapaKid's end-to-end encrypted family chat: conversations, libsignal ciphertext envelopes per
recipient device, a live stream per conversation and encrypted attachments. It never sees a key or a plaintext,
only routing metadata (who is in which conversation, which device sent to which device, sizes, times).

- Its own Cloudflare Worker: `chat-staging.zapakid.ro` (staging), `chat.zapakid.ro` (production). D1, R2 and
  Durable Objects in the EU jurisdiction.
- The contract: [`openapi.yaml`](openapi.yaml), including the `MembershipEvent` queue messages.
- **Auth:** no login of its own. Requests carry a short-lived ES256 chat token from the account service (the repo
  root), checked against its JWKS (`ACCOUNT_JWKS_URL`, cached; served from cache through an outage of up to a day).
- **Family graph:** membership events from the account service on the Cloudflare Queue
  `zapakid-membership-<env>` (dead letters in `…-dlq`). The chat service keeps its own copy and enforces the family
  rules: parents start conversations, kids' parents are always members, other families' kids only when shared.

## Develop

Node 24 (`../../.nvmrc`). In this folder: `npm ci --ignore-scripts`, then

- `npm test`: config/script tests (node:test) and Worker tests in the Workers runtime (Vitest).
- `npm run lint`: Prettier, ESLint, TypeScript, Redocly.
- End to end: `npx wrangler d1 migrations apply DB --local`, `npx wrangler dev --port 8790`, then
  `CHAT_URL=http://127.0.0.1:8790 npm run test:e2e`. The tests play the account service: they serve an ES256 key
  set on 127.0.0.1:8789 and feed membership events through `POST /__e2e/membership`, which exists only with the
  local `E2E_HOOKS` variable and only for loopback requests.
- `scripts/check.sh` runs all of the above like CI and prints the table for the PR.

## How changes ship

`ci-chat.yml` checks PRs that touch `services/chat/**`. A merge to `main` runs `deploy-chat.yml`: tests, release tag
`chat-vX.Y.Z` with an SBOM, resources (created if missing), D1 migrations, deploy to staging, e2e against staging,
rollback on failure. Production: Actions → `deploy-chat-production` → a `chat-v…` tag, approved by @stefan-zpc.

## Deploying: Cloudflare settings

The deploys use the `staging` and `production` GitHub environments' `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, shared with the account API. On top of the permissions in the root README, the token needs:

| Scope   | Permission               | Why                                               |
| ------- | ------------------------ | ------------------------------------------------- |
| Account | Queues: Edit             | create the membership queues, attach the consumer |
| Account | Workers R2 Storage: Edit | create the EU attachments bucket, bind it         |

Durable Objects need no extra permission. Zone `zapakid.ro`: the existing DNS / Workers Routes permissions cover
the `chat-staging` and `chat` custom domains. No secrets: the service has none.

Cloudflare Queues have no EU jurisdiction setting; the events carry only ids (accounts, families, devices, push
tokens), which goes in the DPIA.
