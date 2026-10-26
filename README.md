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

| Scope             | Permission             | Why                                                                     |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| Account           | Workers Scripts: Edit  | upload the Worker and its versions, roll back, attach the custom domain |
| Account           | D1: Edit               | find or create the EU database, apply migrations                        |
| Account           | Account Settings: Read | Wrangler reads the account                                              |
| Zone `zapakid.ro` | Workers Routes: Edit   | routes on the zone                                                      |
| Zone `zapakid.ro` | DNS: Edit              | the custom domain's DNS record (`api-staging`)                          |
| Zone `zapakid.ro` | Zone: Read             | Wrangler looks up the zone                                              |

Account resources: only the ZapaCIT account; zone resources: only `zapakid.ro`. Add Account → Workers R2 Storage: Edit
when R2 (attachments) arrives; Durable Objects need no extra permission (they deploy with the Worker script).

Play Integrity (Android app attestation on sign-in, `ATTESTATION_POLICY` in `wrangler.jsonc`):

1. Google Cloud (the project linked to the app in Play Console → Test and release → App integrity): enable the
   Play Integrity API, create a service account with no project roles, and create a JSON key for it.
2. Play Console → App integrity → Play Integrity API: link that Cloud project, and grant the service account
   access (Users and permissions, app `ro.zapakid.app`, "View app information").
3. Store the key as a Worker secret, never in git: `npx wrangler secret put PLAY_INTEGRITY_CREDENTIALS --env staging`
   (paste the JSON), then delete the downloaded file.
4. Set `PLAY_CERT_SHA256` per environment to the app signing key's SHA-256 as Play Integrity reports it
   (base64url, no padding; Play Console → App integrity → App signing), and switch staging's `ATTESTATION_POLICY`
   to `required`, in a PR.

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
