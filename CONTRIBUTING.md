# Contributing

Thanks for helping. Issues and pull requests are welcome.

- **Small pull requests**, one change each, with a clear description.
- **Tests first:** add or change the test in `test/` that shows the change, then the code. `npm test` and
  `npm run test:e2e` must pass.
- **API changes** start in [`openapi.yaml`](openapi.yaml): the apps build against it.
- **Database changes** are new files in `migrations/`, never edits to applied ones. A migration must keep working with
  the previous Worker version, because a failed deploy rolls back the Worker but not the database.
- **Before you push**, run `scripts/check.sh`: the same checks as CI (lint, unit and Worker tests, dry-run build,
  e2e against `wrangler dev`, npm audit, OSV-Scanner, SBOM, gitleaks). Push only when it is green, and paste its
  table into the pull request. Needs `gitleaks`, `actionlint` and `osv-scanner` installed.
- **No credentials** in code, commits or issues. CI scans every pull request.
- **No plaintext.** The server stores only public keys and ciphertext. Never add an endpoint that accepts message
  content, private keys or anything that would let the server decrypt a chat.

## Contributor License Agreement

This project is licensed under the [AGPL-3.0](LICENSE). Before we can merge your first pull request, you sign the
[ZapaKid Contributor License Agreement](CLA.md): add a row with your GitHub username to
[CLA-SIGNATURES.md](CLA-SIGNATURES.md) in that pull request. The `cla` check confirms it. You keep the copyright in
your contribution, and ZapaCIT SRL can distribute it, including through the app stores.
