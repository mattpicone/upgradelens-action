# UpgradeLens Action

A read-only JavaScript Action that reviews exact direct npm and PyPI dependency changes in pull requests. It supports Dependabot, Renovate, and ordinary contributors.

The Action examines dependency manifests and lockfiles locally, selects at most three direct changes (security updates first, then major updates), and sends only the ecosystem, package name, current version, target version, and optional runtime to UpgradeLens. It never uploads repository source.

## Install

```yaml
name: UpgradeLens dependency review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  id-token: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: mattpicone/upgradelens-action@v0
        with:
          max-spend-usd: "0.03"
        env:
          # Optional: needed only for paid reviews after the free unit.
          UPGRADELENS_BUYER_PRIVATE_KEY: ${{ secrets.UPGRADELENS_BUYER_PRIVATE_KEY }}
```

No account or API key is needed. With `id-token: write`, each immutable GitHub repository ID receives one free analysis unit per rolling 30 days. The OIDC assertion is exchanged for a 15-minute repository-bound entitlement and is never added to telemetry.

For automatic x402 payment after the free unit, configure `UPGRADELENS_BUYER_PRIVATE_KEY` as an Actions secret holding a compatible Base wallet private key with sufficient USDC. For Dependabot-triggered runs it must be a [Dependabot secret](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions#accessing-secrets). The default and documented maximum is $0.03 per run; the Action accepts only the exact UpgradeLens `review_dependency_upgrade` resource at $0.01 on Base.

## Behavior

- Reads `package.json`, npm/pnpm/yarn lockfiles, `pyproject.toml`, Poetry/uv lockfiles, and exact `requirements*.txt` entries.
- Ignores transitive and unrelated source changes.
- Reviews direct development dependencies as well as production dependencies.
- Compares the exact PR commits, so checkout or merge changes cannot substitute different versions.
- Writes a job summary with migration actions, evidence links, and annotations.
- Accepts optional `node-version` and `python-version` inputs for runtime compatibility checks.
- Exposes `reviewed`, `blocked`, and `unavailable` outputs for downstream workflow steps.
- Treats invalid spend limits as zero; payments require at least $0.01 remaining and can never exceed $0.03 per run.
- Fails only for an explicit `block` result. `review_required`, `unknown`, payment unavailable, and service errors remain non-failing.
- Does not print, persist, or send wallet keys, GitHub OIDC assertions, repository contents, or complete manifests.

Marketplace publication is intentionally not required. Pin the Action to a release commit SHA for the strongest supply-chain control; the moving `v0` tag tracks compatible v0 releases.

## Development

```sh
npm ci
npm test
npm run build
git diff --exit-code -- dist/index.js
```
