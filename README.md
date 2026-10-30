# ZapaKid API

Backend for ZapaKid, an end-to-end encrypted chat for families. The apps encrypt with
[libsignal](https://github.com/signalapp/libsignal); this API only stores public keys and ciphertext and can never
decrypt a chat. The server has no cryptography of its own beyond verifying sign-in tokens and hashing session tokens.

- Cloudflare Workers + D1 (EU jurisdiction), TypeScript. Staging: `api-staging.zapakid.ro`.
- The contract the apps build against: [`openapi.yaml`](openapi.yaml) (stable: health, sign-in, account; the rest is
  marked draft). `npm run lint:api` validates it.
- Node 24 (`.nvmrc`). `npm ci`, then:
  - `npm test`: unit tests (`test/scripts`, node:test) and Worker tests in the Workers runtime (`test/worker`, Vitest).
  - End-to-end (`test/e2e`): `npx wrangler d1 migrations apply DB --local`, then in one terminal
    `npx wrangler dev --var APPLE_JWKS_URL:http://127.0.0.1:8788/apple --var GOOGLE_JWKS_URL:http://127.0.0.1:8788/google`
    and in another `API_URL=http://127.0.0.1:8787 npm run test:e2e`. The tests serve their own test keys on port
    8788; the Worker accepts a key URL override only on 127.0.0.1/localhost.
  - `npm run lint` (Prettier, ESLint, TypeScript); `npm run format` fixes formatting.
- Dependencies are pinned to exact versions (`.npmrc`), updated by Dependabot, and audited on every PR and daily.

## Security notes (threat model)

- **The server is untrusted by design.** It stores libsignal public keys, signatures and ciphertext; it can't
  decrypt a chat, and the apps don't rely on it for any cryptographic check.
- **Prekey signatures are verified on the phones, not here.** The server checks only key types and sizes, key id
  uniqueness and counts, and stops abuse (rate limits, attestation, body caps). libsignal verifies the signed EC and
  Kyber prekey signatures against the identity key when it builds a session from a bundle. A bad bundle only breaks
  session setup with that sender; the phone refuses it. `test/worker/devices.test.ts` pins this: an all-zero
  signature is accepted by the server, so nobody assumes the server checked it.
- **Identity keys never change silently.** The apps compare safety numbers and keep the last identity key they
  trusted (libsignal `IdentityKeyStore`); the server's key history is a convenience, not the guarantee.
- **The only crypto in the server** is sign-in token verification (jose), SHA-256 and random tokens (WebCrypto),
  and app attestation checks (pkijs, WebCrypto). No custom primitives.
- **A lost kid phone is unpaired by a parent.** Kid sessions (`zkk_`, from QR pairing, 30 days) are one per paired
  phone: a parent lists them (`GET /v1/families/{familyId}/kids/{kidId}/sessions`, ids and dates only) and revokes
  one (`DELETE .../sessions/{sessionId}`); the token answers 401 everywhere from the next request. The kid's phone
  signs itself out with `POST /v1/kid/logout`.
- **A lost phone loses everything at once.** `POST /v1/auth/logout-all` deletes the parent's sessions and bumps
  their session epoch (`parents.session_epoch`, the chat token's `sep` claim); the `account.sessions_revoked`
  event makes the chat and calls services refuse the chat tokens already issued and close the streams and calls
  opened with them, instead of waiting out the token's 10 minutes. `?removeDevices=true` also removes the parent's
  registered devices (`device.removed` events), so other phones stop sealing messages to the lost one.

## Services

The repo root is the account API (api.zapakid.ro). Other services live under `services/`, each its own Worker with
its own `package.json`, wrangler config, OpenAPI spec, CI (`ci-<service>.yml`) and deploy (`deploy-<service>.yml`):

- [`services/chat`](services/chat/README.md): conversations, encrypted envelopes, stream, attachments
  (chat.zapakid.ro).
- [`services/calls`](services/calls/README.md): voice calls (calls.zapakid.ro).

A PR that changes only `services/**` skips the account API's checks and deploy.

## How changes ship

1. Open a pull request. CI (`.github/workflows/ci.yml`) runs lint, the unit and Worker tests, builds the Worker (dry
   run), runs the end-to-end tests on a local server, audits dependencies and scans the whole history for credentials.
2. A maintainer reviews and merges it.
3. The merge to `main` deploys to staging (`.github/workflows/deploy.yml`, environment `staging`): tests, release
   tag + SBOM, D1 database (created in the EU jurisdiction if missing) and migrations, `wrangler deploy --env staging`,
   then the end-to-end tests against api-staging.zapakid.ro, rolling back the Worker if they fail.
4. Production is manual: Actions → `deploy-production` → Run workflow with a release tag; the `production`
   environment needs @stefan-zpc's approval. Until the v1 cutover the production Worker has no route.

D1 migrations are not rolled back with the Worker, so every migration must keep working with the previous version.

## Deploying: Cloudflare settings

Each GitHub environment (`staging`, `production`) has its own secret `CLOUDFLARE_API_TOKEN` and variable
`CLOUDFLARE_ACCOUNT_ID`. Create one custom API token per environment (My Profile → API Tokens → Create Custom Token):

| Scope             | Permission               | Why                                                                     |
| ----------------- | ------------------------ | ----------------------------------------------------------------------- |
| Account           | Workers Scripts: Edit    | upload the Worker and its versions, roll back, attach the custom domain |
| Account           | D1: Edit                 | find or create the EU database, apply migrations                        |
| Account           | Account Settings: Read   | Wrangler reads the account                                              |
| Account           | Calls: Write             | create the Realtime SFU app and TURN key (bootstrap-secrets.yml)        |
| Account           | Queues: Edit             | queues for the chat service                                             |
| Account           | Workers R2 Storage: Edit | encrypted attachments in R2 (EU)                                        |
| Zone `zapakid.ro` | Workers Routes: Edit     | routes on the zone                                                      |
| Zone `zapakid.ro` | DNS: Edit                | the custom domain's DNS record (`api-staging`)                          |
| Zone `zapakid.ro` | Zone: Read               | Wrangler looks up the zone                                              |

The workflows give the token only to the steps that run wrangler, never to `npm ci` (always `--ignore-scripts`) or
the tests, so a compromised dependency can't read it (`test/scripts/workflow-secrets.test.js`).

Account resources: only the ZapaCIT account; zone resources: only `zapakid.ro`. Durable Objects need no extra
permission (they deploy with the Worker script).

### Generated secrets: the bootstrap-secrets workflow

Secrets the Workers can generate for themselves are made by a workflow, never on a laptop: Actions →
`bootstrap-secrets` → Run workflow, with `env` = `staging` or `production` (the environment's approval applies).
It runs `scripts/bootstrap-secrets.js` with the environment's `CLOUDFLARE_API_TOKEN`:

| Worker (from its wrangler config) | Secrets                                  | Made by                                    |
| --------------------------------- | ---------------------------------------- | ------------------------------------------ |
| account (`zapakid-api-<env>`)     | `CHAT_TOKEN_SIGNING_KEY`                 | a new ES256 key pair, generated in the job |
| calls (`zapakid-calls-<env>`)     | `REALTIME_APP_ID`, `REALTIME_APP_SECRET` | a new Realtime SFU app `zapakid-<env>`     |
|                                   | `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`      | a new Realtime TURN key `zapakid-<env>`    |

- Idempotent: secrets already on the Worker are skipped. `rotate` = `chat-token-key`, `realtime` or `all` replaces
  them (apps fetch a new chat token on the 401; a rotated Realtime app or TURN key leaves the old one in the
  dashboard to delete once calls use the new one).
- A Worker that isn't deployed yet, or whose config isn't on `main` yet, is skipped with a notice: deploy it first,
  then run the workflow again.
- Values are masked the moment they exist and reach `wrangler secret put` on stdin only: never echoed, uploaded or
  cached (`test/scripts/workflow-hygiene.test.js`).

Play Integrity (Android app attestation on sign-in, `ATTESTATION_POLICY` in `wrangler.jsonc`):

No Google key exists anywhere (the org policy blocks service-account keys). The API signs a 5-minute assertion
(`iss` = `CHAT_TOKEN_ISSUER`, `sub` = `play-integrity`) with its chat token key `CHAT_TOKEN_SIGNING_KEY`; Google's
Workload Identity Federation trusts that issuer through `/.well-known/openid-configuration` and its JWKS, and the
federated token impersonates the service account named in `PLAY_INTEGRITY_SERVICE_ACCOUNT`. Rotating the chat key
needs nothing on Google's side.

1. Google Cloud (the project linked to the app in Play Console → Protected with Play → Play Integrity API): enable the
   Play Integrity API and create a service account with no project roles (staging: `play-integrity-staging`).
2. Workload Identity: pool `cloudflare-workers`, OIDC provider per environment (staging: `zapakid-api-staging`,
   issuer `https://api-staging.zapakid.ro`, default audience, attribute mapping `google.subject=assertion.sub`,
   condition `assertion.sub == "play-integrity"`). Grant `principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/cloudflare-workers/subject/play-integrity`
   the role `roles/iam.workloadIdentityUser` on that service account only.
3. Set `PLAY_INTEGRITY_WIF_AUDIENCE` (`//iam.googleapis.com/…/providers/<id>`) and `PLAY_INTEGRITY_SERVICE_ACCOUNT`
   per environment in `wrangler.jsonc`, in a PR.
4. Set `PLAY_CERT_SHA256` per environment to the app signing key's SHA-256 as Play Integrity reports it
   (base64url, no padding; Play Console → App integrity → App signing), in a PR.
5. Staging only, optional: test accounts that may sign in without attestation (debug builds Play doesn't
   recognise) go in the secret `ATTESTATION_ALLOWLIST`, comma separated `google:<sub>` / `apple:<sub>`:
   `npx wrangler secret put ATTESTATION_ALLOWLIST --env staging`. Production has no allowlist (`required`).

Chat tokens (`POST /v1/chat/token`, verified by the chat and calls services against `/.well-known/jwks.json`): the
signing key is the Worker secret `CHAT_TOKEN_SIGNING_KEY`, a private P-256 JWK. Stefan creates it per environment,
never an agent or CI: `scripts/set-chat-token-key.sh staging` (and `production`). The script pipes a new key from
`scripts/chat-token-key.js` straight into `wrangler secret put`; it is never printed or written to disk. Running it
again rotates the key (apps fetch a new token on the 401). Until it is set, both endpoints answer
`503 not_configured` and the staging e2e check of the JWKS fails, so set it before merging the chat token PR.

App Attest (iOS app attestation): nothing to set up on Cloudflare. The App ID `ro.zapakid.app` (team `9572LYGZ7S`)
has App Attest enabled; the API pins Apple's App Attestation Root CA (`src/app-attest-root.ts`) and accepts
development keys (Xcode builds) on staging only (`APP_ATTEST_ENVIRONMENTS`). Simulators can't attest: on staging
they sign in as allowlisted test accounts (`ATTESTATION_ALLOWLIST`).

`/health` answers 503 and names what is missing when the policy is `required` and the secret or certificate is not
set.

Zone settings (dashboard, or the infra repo), not set by this repo:

- **TLS 1.3 only** for `api-staging.zapakid.ro` and `api.zapakid.ro`. Options, cheapest first:
  1. A WAF custom rule (free plan includes some): Security → WAF → Custom rules, expression
     `(http.host in {"api-staging.zapakid.ro" "api.zapakid.ro"} and cf.tls_version ne "TLSv1.3")`, action Block.
     Recommended: free, API hosts only, the website keeps its own minimum.
  2. Zone-wide SSL/TLS → Edge Certificates → Minimum TLS Version 1.3 (also applies to www.zapakid.ro).
  3. Per-hostname minimum TLS (`PUT /zones/{zone_id}/hostnames/settings/min_tls_version/{hostname}`,
     `{"value": "1.3"}`): needs Advanced Certificate Manager (paid).

  Also keep SSL/TLS → Edge Certificates → TLS 1.3 on.

- **HSTS**: the API sends `Strict-Transport-Security` itself on every response; "Always Use HTTPS" on.
- **Non-EU traffic** is blocked by a zone rule (later, infra).

## Versions

Every deploy tags the merged commit `vMAJOR.MINOR.PATCH` before it goes live (`scripts/next-version.js`):

- no label: patch (`v1.0.4` → `v1.0.5`)
- label `minor`: a large feature (`v1.0.4` → `v1.1.0`)
- label `major`: a change that breaks compatibility with the previous version (`v1.3.7` → `v2.0.0`)

Add the label to the PR before merging it. Never deploy from a laptop.

## License

[AGPL-3.0](LICENSE). Contributions need the CLA, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).
