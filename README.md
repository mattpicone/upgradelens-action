# UpgradeLens Action

A read-only JavaScript Action that reviews exact direct npm and PyPI dependency changes in pull requests. It supports Dependabot, Renovate, and ordinary contributors.

The Action examines dependency manifests and lockfiles locally, selects at most three direct changes (security updates first, then major updates), and sends only the ecosystem, package name, current version, target version, and optional runtime to UpgradeLens. It never uploads repository source.

## First review: no wallet required

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
          max-changes: "1"
          max-spend-usd: "0"
```

No account or API key is needed. With `id-token: write`, each immutable GitHub repository ID receives one free analysis unit per rolling 30 days. The OIDC assertion is exchanged for a 15-minute repository-bound entitlement and is never added to telemetry.

The default reviews the highest-priority dependency change, matching the one-unit free evaluation. No private key is needed to get a cited first result. Repeated runs after the rolling unit is consumed report an unavailable review unless payment is configured.

## Repeated and paid reviews

For automatic x402 payment after the free unit, configure `UPGRADELENS_BUYER_PRIVATE_KEY` as an Actions secret holding a compatible Base wallet private key with sufficient USDC. For Dependabot-triggered runs it must be a [Dependabot secret](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions#accessing-secrets). The default spending ceiling is $0.03 per run, while the first-review workflow sets it to zero; the Action accepts only the exact UpgradeLens `review_dependency_upgrade` resource at $0.01 on Base.

To review up to three selected changes with a strict three-cent run ceiling:

```yaml
      - uses: mattpicone/upgradelens-action@v0
        with:
          max-changes: "3"
          max-spend-usd: "0.03"
        env:
          UPGRADELENS_BUYER_PRIVATE_KEY: ${{ secrets.UPGRADELENS_BUYER_PRIVATE_KEY }}
```

The Action reads changed manifests and lockfiles locally, then returns the
upgrade decision, ordered migration actions and source links in the job
summary. It does not change your dependency files or merge your PR.

## Provide your application runtime

Set `node-version` or `python-version` to the runtime your application actually
uses. Without it, an upgrade with a declared runtime requirement returns
`unknown` because compatibility cannot be verified. The Action runner's Node
version does not establish your application's runtime.

```yaml
        with:
          max-changes: "1"
          max-spend-usd: "0"
          node-version: "22" # Use your application's actual version.
```

[Public MCP configuration and bounded buyer examples](examples/README.md)
are available for agent integrations beyond GitHub pull requests.

## Behavior

- Reads `package.json`, npm/pnpm/yarn lockfiles, `pyproject.toml`, Poetry/uv lockfiles, and exact `requirements*.txt` entries.
- Ignores transitive and unrelated source changes.
- Reviews direct development dependencies as well as production dependencies.
- Selects one highest-priority change by default; `max-changes: "3"` explicitly enables up to three reviews.
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

## Verification

`npm test` verifies extraction, spending limits and the actual bundled entry
point. The manually dispatched **Live free-review verification** workflow
uses an owned fixture, GitHub OIDC, no wallet and a zero spending ceiling.
Its requests identify themselves as verification traffic, so they cannot
increase genuine demand or revenue statistics. It is not customer activity.
