# ZapaKid chat service

Sealed mailboxes for ZapaKid's end-to-end encrypted family chat: conversations, libsignal ciphertext envelopes per
recipient device, a live stream per conversation and encrypted attachments. It never sees a key or a plaintext,
only routing metadata (who is in which conversation, which device sent to which device, sizes, times).

- Its own Cloudflare Worker: `chat-staging.zapakid.ro` (staging), `chat.zapakid.ro` (production). D1, R2 and
  Durable Objects in the EU jurisdiction.
- The contract: [`openapi.yaml`](openapi.yaml), including the `MembershipEvent` and `ConversationEvent` queue
  messages.
- **Auth:** no login of its own. Requests carry a short-lived ES256 chat token from the account service (the repo
  root), checked against its JWKS (`ACCOUNT_JWKS_URL`, cached; served from cache through an outage of up to a day).
- **Family graph:** membership events from the account service on the Cloudflare Queue
  `zapakid-membership-<env>` (dead letters in `…-dlq`). The chat service keeps its own copy and enforces the family
  rules: parents and kids start conversations, other families' kids only when shared, and a kid's parents read the
  kid's chats as **observers** (api #73): their devices get every sealed envelope, but they can't send
  (`403 observer_read_only`), they aren't in calls and they get no push. Oversight is on by default and can be
  turned off per kid (`kid.oversight_changed`); the server keeps that in `kid_oversight`. Kids aren't told who
  observes. A conversation has at most 64 observers besides its 64 writers; if a family change would push it over
  (`reconcile()`), nobody is added and the conversation is closed instead.
  Produced by the account API (`PUT /v1/families/{familyId}/kids/{kidId}/oversight`, api #94); changes are ordered by `occurredAt`, so a late older one is ignored. `GET /v1/contacts` lists who an account may chat with (ids only).

- **Messages:** one Durable Object per conversation (SQLite, EU) holds a delivery copy per recipient device until
  that device acknowledges it, and serves the WebSocket stream (hibernation). Devices without a stream get a
  content-free push through the `PushProvider` interface (`src/push.ts`); it is switched off until the APNs/FCM
  credentials exist (ios #27, android #25).

- **Calls:** the calls service asks `ChatMembership.member(conversationId, accountId)` (`src/rpc.ts`) whether the
  caller is a current member of an open conversation, and which members and devices to ring, and
  `ChatMembership.tokenRevoked(accountId, deviceId, sep, iat)` whether a chat token was revoked: by a logout-all
  (its session epoch) or because its device was removed after it was issued (api #92). `revoked(accountId, sep)`
  stays for calls Workers from before that.
  Observers are not members for calls (never rung, never given the call key); the answer flags them
  (`observer: true`) so the calls service can show them the call log. Workers RPC through its `CHAT` service
  binding only; there is no HTTP route for it. The other way round, when chat removes members from a conversation
  or closes it, it tells the calls service with a `ConversationEvent` on the Cloudflare Queue
  `zapakid-conversation-events-<env>` (`src/conversation-events.ts`, transactional outbox in D1, flushed right
  after the change and hourly), so a live call drops those members' devices at once.

- **Sign out everywhere:** `account.sessions_revoked` (from `POST /v1/auth/logout-all` on the account service)
  stores the account's new session epoch (`session_epochs`). Chat tokens with a lower `sep` claim are refused and
  their open streams closed with `4401`, so a lost phone loses chat within seconds, not when its token expires.

- **Removed devices:** `device.removed` (a parent revokes a kid's phone or unpairs the kid, the kid signs out, or a
  logout-all with `removeDevices`) tombstones the device (`device_tombstones`). Chat tokens for that device issued
  before the removal (up to a second after, for the race with the token endpoint) are refused on every route, and
  its open streams are closed with `4403` (api #92). A device registered again gets newer tokens, which work.

- **Attachments:** ciphertext only, in R2 (EU) under a random id, ≤ 25 MiB, through one-time upload/download URLs
  (15 minutes, usable once; only the token's hash is stored). Kept until the conversation is purged; abandoned
  reservations and expired download URLs are purged hourly.

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
rollback on failure; then the same for production once @stefan-zpc approves the `production` environment.

## Deploying: Cloudflare settings

The deploys use the `staging` and `production` GitHub environments' `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, shared with the account API. On top of the permissions in the root README, the token needs:

| Scope   | Permission               | Why                                                 |
| ------- | ------------------------ | --------------------------------------------------- |
| Account | Queues: Edit             | create the queues, attach the consumer and producer |
| Account | Workers R2 Storage: Edit | create the EU attachments bucket, bind it           |

Durable Objects need no extra permission. Zone `zapakid.ro`: the existing DNS / Workers Routes permissions cover
the `chat-staging` and `chat` custom domains. No secrets: the service has none.

Cloudflare Queues have no EU jurisdiction setting; the events carry only ids (accounts, families, devices, push
tokens), which goes in the DPIA.

The account events stream (`GET /v1/events`, `src/account-hub.ts`, api #100) holds one Durable Object per account (EU
jurisdiction when deployed, migration `v2`). It carries conversation ids only, to the account's own devices, and stores
nothing. Logout-all (`account.sessions_revoked`) closes the account's events sockets opened with older tokens (4401).

"Typing..." signals (api #98) are metadata too, for the DPIA and privacy notice: while a member types, the service relays
"account X is typing" to the other members' open streams. It is held in memory only for the moment of delivery, never
stored or logged, has no content and doesn't survive the connection. Observing parents (read-only) can't send it, but
they see the kids' and the other writers' typing, like everything else in the chat (an oversight decision: if
oversight is off for a kid, the parents are not in the chat and see nothing).
