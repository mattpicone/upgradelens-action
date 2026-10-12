# UpgradeLens client examples

The service is a public remote MCP endpoint:
`https://upgradelens.mattpicone.workers.dev/mcp`.

- [GitHub dependency pull requests](../README.md#first-review-no-wallet-required): one free repository trial, no wallet, zero spending limit.
- [Cursor MCP configuration](cursor/.cursor/mcp.json): copy into your project or global Cursor MCP config.
- [TypeScript and Python buyer examples](agent-buyers/README.md): free evaluation first, with an optional authorized one-cent Base USDC payment.

Use `review_dependency_upgrade` for a known current and target version. Pass the
application's actual runtime as `runtime.node` or `runtime.python` when known.
A response of `unknown` means evidence is insufficient; it is not permission
to merge. Automatic paid retries require a funded, authorized buyer wallet.
The service is read-only and accepts npm and PyPI only.
