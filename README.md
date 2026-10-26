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
3. The merge to `main` deploys to staging.

## Versions

Every deploy tags the merged commit `vMAJOR.MINOR.PATCH` before it goes live (`scripts/next-version.js`):

- no label: patch (`v1.0.4` → `v1.0.5`)
- label `minor`: a large feature (`v1.0.4` → `v1.1.0`)
- label `major`: a change that breaks compatibility with the previous version (`v1.3.7` → `v2.0.0`)

Add the label to the PR before merging it. Never deploy from a laptop.

## License

[AGPL-3.0](LICENSE). Contributions need the CLA, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).
