# UpgradeLens data handling

Updated October 12, 2026. Maintainer: Matt Picone. For support or data-handling
questions, [open an issue](https://github.com/mattpicone/upgradelens-action/issues).
Do not post wallet keys, authentication assertions or private repository data.

The Action reads manifests and lockfiles locally in your GitHub Actions job.
It sends the package ecosystem, package name, exact versions and any runtime
you configure to the UpgradeLens service. It does not upload repository source,
complete manifests or lockfiles. Package names may reveal private dependencies;
review your inputs before enabling the Action on a private project.

For the free repository trial, the Action requests a short-lived GitHub OIDC
assertion and sends it to UpgradeLens to verify repository identity. The
assertion can include repository and workflow identity. The service stores
hashes of repository and assertion identifiers for quota and replay protection,
rather than storing the original assertion. The resulting entitlement expires
in 15 minutes. GitHub controls the runner and workflow logs.

The remote service runs on Cloudflare Workers and D1. It uses public registry,
deps.dev, OSV and lifecycle data sources to look up package and version facts;
these requests disclose the requested public package identifiers to those
providers. No caller repository is cloned or executed. Infrastructure providers
may process connection metadata according to their own policies.

Diagnostic records contain pseudonymous client identifiers, package ecosystem
and name, tool names, result status, latency, client software and bounded
user-agent/referrer metadata. Generic usage records are cleaned up after 45
days on a best-effort schedule. MCP event and payment records are retained for
usage history, duplicate-payment protection and accounting; they currently have
no automatic retention cutoff. Hashing is pseudonymization, not a guarantee of
anonymity. These records are used to operate the service, enforce limits and
measure genuine usage; the product does not sell telemetry or use it to send
marketing messages.

Payment is optional and requires an explicitly configured, funded Base wallet.
The wallet key stays in the Action process and is used to sign payment
authorizations. Payment authorizations and public wallet addresses are shared
with the service and its Coinbase x402 facilitator. Settled transfers are public
on Base. The Action does not print or persist wallet keys or OIDC assertions.
The first-review workflow sets the spending ceiling to zero.

Upgrade reviews are deterministic source-based analysis, not generated legal
or security guarantees. Missing evidence returns `unknown`; findings still
require application-specific testing and review. The Action software is
provided under the [MIT license](LICENSE).
