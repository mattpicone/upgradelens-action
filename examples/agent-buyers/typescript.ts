/**
 * Autonomous Bazaar/direct MCP buyer. The wallet key is read only from the
 * process environment. Search is free; code approves only one $0.01 Base-USDC
 * review and validates HTTPS citations before returning an actionable result.
 *
 * npm i @modelcontextprotocol/sdk @x402/core @x402/evm @x402/extensions @x402/mcp viem
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402MCPClient } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { privateKeyToAccount } from "viem/accounts";

const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp";
const DIRECT = "https://upgradelens.mattpicone.workers.dev/mcp";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const input = { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0", runtime: { node: "22" }, detail: "compact" };
const intent = "Review whether this exact npm major dependency upgrade is safe and return a cited migration plan";

function structured(result: any): any {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content ?? []) {
    if (item.type === "text") try { return JSON.parse(item.text); } catch { /* continue */ }
  }
  return null;
}

function entries(value: any): any[] {
  return Array.isArray(value) ? value : [...(value?.resources ?? []), ...(value?.items ?? []), ...(value?.tools ?? [])];
}

function discoveredTool(entry: any): string | null {
  const required = entry?._meta?.["x402/payment-required"] ?? entry;
  return required?.extensions?.bazaar?.info?.input?.toolName ?? entry?.toolName ?? null;
}

function validateCitations(result: any): void {
  const citations = result?.citations ?? result?.evidence ?? [];
  if (!Array.isArray(citations) || citations.length === 0) throw new Error("No citations returned; do not act on this result");
  for (const citation of citations) {
    const url = new URL(citation.source_url);
    if (url.protocol !== "https:") throw new Error(`Unsafe citation: ${url}`);
  }
}

async function main(): Promise<void> {
  const key = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  const payment = new x402Client();
  if (key) payment.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key)));
  payment.registerExtension({
      key: "payment-identifier",
      enrichPaymentPayload: async (created: any) => ({
        ...created,
        extensions: appendPaymentIdentifierToExtensions(structuredClone(created.extensions ?? {})),
      }),
    });

  let paid = false;
  const raw = new Client({ name: "dependency-review-agent", version: "1.0.0" }, { capabilities: {} });
  const client = new x402MCPClient(raw, payment, {
    autoPayment: Boolean(key),
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const requirement = paymentRequired.accepts.length === 1 ? paymentRequired.accepts[0] : null;
      const allowed = Boolean(key) && !paid && ["proxy_tool_call", "review_dependency_upgrade"].includes(toolName) &&
        requirement?.scheme === "exact" && requirement.network === "eip155:8453" &&
        requirement.amount === "10000" && requirement.asset.toLowerCase() === BASE_USDC;
      if (allowed) paid = true;
      return allowed;
    },
  });

  const callTool = (name: string, args: Record<string, unknown>) => key
    ? client.callTool(name, args)
    : raw.callTool({ name, arguments: args });
  const direct = process.env.DIRECT_MCP !== "false";
  await client.connect(new StreamableHTTPClientTransport(new URL(direct ? DIRECT : BAZAAR)));
  try {
    let result: any;
    if (direct) {
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "review_dependency_upgrade")) throw new Error("Review tool not found on the direct endpoint");
      result = structured(await callTool("review_dependency_upgrade", input));
    } else {
      const search = structured(await callTool("search_resources", { query: intent }));
      const match = entries(search).find((entry) => discoveredTool(entry) === "review_dependency_upgrade");
      if (!match) throw new Error("No exact dependency-upgrade review resource found in Bazaar");
      result = structured(await callTool("proxy_tool_call", { toolName: discoveredTool(match), parameters: input }));
    }
    if (result?.x402Version === 2 || result?.error) {
      throw new Error(result?.error?.message ?? "Free evaluation is exhausted. Configure an authorized EVM_PRIVATE_KEY to enable the capped $0.01 payment, then retry.");
    }
    validateCitations(result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

await main();
