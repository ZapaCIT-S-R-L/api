# ZapaKid calls service

Voice calls for ZapaKid (1:1 and group) on Cloudflare Realtime (SFU + TURN), as its own Worker:
`calls-staging.zapakid.ro` (staging) and `calls.zapakid.ro` (production). Every audio frame is encrypted on the
phone with a per-call key that is sealed per device with libsignal; this service and Cloudflare only see ciphertext.
Audio is never stored; the call log in D1 (EU) is metadata only.

- Contract: [`openapi.yaml`](openapi.yaml) (`npm run lint:api` validates it).
- Auth: the chat token from the account API (root of this repo, `POST /v1/chat/token`), verified against its JWKS
  (`ACCOUNT_JWKS_URL`). No login of its own. The token's `conv` claim holds membership scopes, not conversation
  ids, so it is not used to authorize: on every start, join and view the Worker asks the chat service
  (`ChatMembership.member`, `services/chat/src/rpc.ts`) over the `CHAT` service binding (Workers RPC, never public
  HTTP) whether the caller is a current member, and which members' devices to ring (`src/chat.ts`). On every request
  it also asks `ChatMembership.tokenRevoked(accountId, deviceId, sep, iat)` whether the token was revoked: its
  session epoch (`sep`) by a logout-all at the account API, or its device removed after `iat` (a kid's phone
  revoked by a parent or signed out, api #92); a live call re-asks for each participant every minute and before every relayed
  key, and drops the ones revoked (`left` with reason `revoked`, socket closed with `4401`). Tests and the local
  e2e run play the chat service with `test/chat-stub`.
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
own workflows ignore `services/`. The token needs `Queues: Edit` (root README) for the conversation events queues.

The `CHAT` binding needs the chat Worker of the same environment (`zapakid-chat-staging`, `zapakid-chat-production`)
deployed with its `ChatMembership` entrypoint first; otherwise the calls deploy fails. Deploy order: chat before
calls, enforced. Each calls stage first waits (up to 30 minutes, before migrations or the deploy) until the chat
Worker of that environment lists every method calls uses (`CHAT_RPC` in the workflow: `member`, `tokenRevoked`) in the
`rpc` field of its `/health` (`scripts/wait-for-rpc.js`); if it doesn't, the stage fails without changing anything:
deploy chat, then re-run. Should calls still meet a chat Worker without `tokenRevoked` (a chat rollback), every request
gets a retryable 503 `chat_unavailable` with `Retry-After: 30`, logged as `chat outdated`; a token is never let
through unchecked. The conversation events
queues (`zapakid-conversation-events-<env>` and `…-dlq`) are created by `scripts/resources.js` if missing, as the
chat deploy does, so the queue never blocks either deploy.

The GitHub environments and Cloudflare API token are the API's (root README, "Deploying"): the same token scopes
cover this Worker (Workers Scripts, D1, Workers Routes and DNS on `zapakid.ro`). The custom domains create their own
DNS records on the first deploy.

## How a call works

- `src/calls.ts`: the HTTP API (start, join, leave, decline, call log, events, Realtime proxy).
- `src/call-room.ts`: one Durable Object per call. It holds the roster and the key epoch, which goes up on every
  join and leave. It runs the hibernating events WebSocket and relays the libsignal-sealed key envelopes to the one
  device each is for, queuing them for a device that isn't connected yet. It also runs the timers: 30 s ring
  timeout, 2 h maximum, 30 s reconnect grace, and cleanup an hour after the end.
- `src/conversation-events.ts`: the consumer of the chat service's `ConversationEvent` queue
  (`zapakid-conversation-events-<env>`, dead letters in `…-dlq`). When chat removes members from a conversation
  (unpair, family left, connection removed, kid unshared, account deleted, conversation deleted by that member) or
  closes it, the live call drops those members' devices at once: `left` with reason `removed`, their events
  sockets closed, the epoch bumped so the key leader rotates the call key without them, and their SFU tracks closed
  (the call room keeps the sessions and retries from its alarm with backoff, honouring Retry-After, up to 10
  attempts, until Realtime confirms or answers 404/410 for the session; a session whose retries run out stays on
  the list, logged as `sfu session close retries exhausted`, and the ended call's state is kept for it). Replayed
  events are deduped by id (`processed_events` in D1, 14 days), and events older than the call or than a device's
  join are ignored, so a readmitted member is not dropped. A closed conversation ends its call. Without the event
  they would only lose access on their next request (every request re-asks the chat service), not mid-call.
- `src/realtime.ts`: Cloudflare Realtime SFU calls with the app secret, plus TURN credentials (TTL 1 h). If TURN is
  down, it falls back to STUN only.
- `src/push.ts`: ringing phones that aren't open. iOS: one APNs VoIP push per iPhone (`apns-push-type: voip`, topic
  `<APNS_TOPIC>.voip`, priority 10, no expiry), whose payload is only `{"callId": ...}`; PushKit hands it to CallKit.
  It authorizes with an ES256 provider token signed with the `APNS_AUTH_KEY` secret (`kid` = `APNS_KEY_ID`, `iss` =
  `APNS_TEAM_ID`), renewed every 40 minutes, and goes to `api.push.apple.com` (`api.sandbox.push.apple.com` only
  when `APNS_ENVIRONMENT` is `sandbox`). A failed push is logged with its status and APNs reason, never the device
  token or the key, and never fails the call. Ending a ring sends nothing: a VoIP push must always show a call, and
  the ringing phone learns the end from the events WebSocket. Without `APNS_AUTH_KEY` (tests, local dev) nothing is
  sent. Not live yet: the device push tokens don't reach this service (`ChatMembership.member` lists device ids
  only), so only targets that carry a token are rung. Android (FCM) comes separately.
- Limits: 8 participants, and 10 calls started and 30 joins a minute per account (rate limiting binding).

## Secrets

The Worker needs four secrets per environment: `REALTIME_APP_ID`, `REALTIME_APP_SECRET`, `TURN_KEY_ID` and
`TURN_KEY_API_TOKEN`. `/health` answers 503 and names any that are missing. The `bootstrap-secrets` workflow
(Actions → Run workflow, `env` = `staging` or `production`) creates a Realtime SFU app and a TURN key named
`zapakid-<env>` and stores them, masked, never by hand. The order for a new environment:

1. Merge; the first deploy creates the Worker. Its e2e check fails until the secrets are set, and there is nothing
   to roll back to yet.
2. Run `bootstrap-secrets` for that environment. It skips a Worker that isn't deployed yet, so run it after step 1.
3. Re-run the `deploy-calls` workflow; it goes green.

The chat tokens need the account API's signing key; the same workflow makes it.

iPhone ringing also needs the `APNS_AUTH_KEY` secret, the APNs `.p8` key (PEM), with `APNS_KEY_ID` set to its key id
in `wrangler.jsonc`. `bootstrap-secrets` doesn't import it yet (api #102); until it does, the secret is unset and
iPhones in the background don't ring. Calls work either way.

## Retention

The call log keeps who started a call in which conversation, when, how it ended and the peak number of
participants. It never keeps audio or keys. Rows are purged daily after `CALL_LOG_RETENTION_DAYS` (365). Deleting a
conversation's call log together with the chat comes with the chat service.
