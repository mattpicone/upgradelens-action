# Autonomous agent buyer examples

Both examples default to the live direct MCP endpoint and can use the free evaluation without a wallet. Bazaar indexing is still pending, so a Bazaar-first integration may never reach the service. Set `DIRECT_MCP=false` only to test Bazaar discovery.

For paid use, set `EVM_PRIVATE_KEY` to an authorized buyer wallet. The examples enforce one exact $0.01 payment on Base USDC, automatically retry through x402, and reject results that lack HTTPS citations. Standard MCP installation alone does not configure payment.

Wallet credentials are read only from `EVM_PRIVATE_KEY`; the examples never print or persist them. For paid calls, the wallet must already be funded and authorized for the advertised asset. Search itself is free.

- TypeScript: install dependencies listed in the source, then `npx tsx examples/agent-buyers/typescript.ts`
- Python: `python examples/agent-buyers/python.py`

These are bounded buyer integrations, not traffic generators. Do not use the merchant wallet, synthetic payers, or owner-funded calls to influence discovery rankings.
