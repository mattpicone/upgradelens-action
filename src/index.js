import { appendFile, readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { detectDependencyChanges, prioritizeChanges } from "./extract.js";

const dependencyFile = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt)$/i;
const service = (process.env["INPUT_SERVICE-URL"] || "https://upgradelens.mattpicone.workers.dev").replace(/\/$/, "");
const requestedChanges = Number(process.env["INPUT_MAX-CHANGES"] || 3);
const requestedSpend = Number(process.env["INPUT_MAX-SPEND-USD"] || 0.03);
const maxChanges = Number.isFinite(requestedChanges) ? Math.min(3, Math.max(1, Math.floor(requestedChanges))) : 3;
const maxSpendAtomic = Number.isFinite(requestedSpend) ? Math.round(Math.min(0.03, Math.max(0, requestedSpend)) * 1_000_000) : 30_000;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${name} ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function annotation(level, message) {
  process.stdout.write(`::${level}::${String(message).replace(/[\r\n]+/g, " ")}\n`);
}

async function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
}

async function oidcEntitlement() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  const url = new URL(requestUrl);
  url.searchParams.set("audience", service);
  const oidc = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!oidc.ok) throw new Error(`GitHub OIDC token request returned ${oidc.status}`);
  const assertion = (await oidc.json()).value;
  const exchange = await fetch(`${service}/v1/trials/github/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${assertion}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!exchange.ok) throw new Error(`UpgradeLens OIDC exchange returned ${exchange.status}`);
  return (await exchange.json()).token;
}

function contentResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type !== "text") continue;
    try { return JSON.parse(item.text); } catch { /* continue */ }
  }
  return null;
}

let paidClientPromise = null;
let spentAtomic = 0;
async function paidReview(change) {
  if (!process.env.UPGRADELENS_BUYER_PRIVATE_KEY) return null;
  if (!paidClientPromise) paidClientPromise = (async () => {
    const [{ Client }, { StreamableHTTPClientTransport }, { x402MCPClient }, { x402Client }, { ExactEvmScheme }, { appendPaymentIdentifierToExtensions }, { privateKeyToAccount }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@x402/mcp"),
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("@x402/extensions/payment-identifier"),
      import("viem/accounts"),
    ]);
    const account = privateKeyToAccount(process.env.UPGRADELENS_BUYER_PRIVATE_KEY);
    const payment = new x402Client()
      .register("eip155:8453", new ExactEvmScheme(account))
      .registerExtension({
        key: "payment-identifier",
        enrichPaymentPayload: async (created) => ({
          ...created,
          extensions: appendPaymentIdentifierToExtensions(structuredClone(created.extensions || {})),
        }),
      });
    const raw = new Client({ name: "upgradelens-action", version: "0.1.0" }, { capabilities: {} });
    const buyer = new x402MCPClient(raw, payment, {
      autoPayment: true,
      onPaymentRequested: ({ toolName, paymentRequired }) => {
        const accepts = paymentRequired?.accepts || [];
        const requirement = accepts.length === 1 ? accepts[0] : null;
        const amount = Number(requirement?.amount);
        const allowed = toolName === "review_dependency_upgrade" && requirement?.scheme === "exact" &&
          paymentRequired?.resource?.url === `${service}/mcp#review_dependency_upgrade` &&
          requirement?.network === "eip155:8453" && String(requirement?.asset || "").toLowerCase() === BASE_USDC &&
          /^0x[0-9a-fA-F]{40}$/.test(requirement?.payTo || "") && Number.isSafeInteger(amount) && amount === 10_000 &&
          spentAtomic + amount <= maxSpendAtomic;
        if (allowed) spentAtomic += amount;
        return allowed;
      },
    });
    await buyer.connect(new StreamableHTTPClientTransport(new URL(`${service}/mcp`)));
    return buyer;
  })();
  const buyer = await paidClientPromise;
  return contentResult(await buyer.callTool("review_dependency_upgrade", { ...change, detail: "compact" }));
}

async function review(change, entitlement) {
  const response = await fetch(`${service}/v1/upgrade/review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(entitlement ? { "x-upgradelens-trial-token": entitlement } : {}),
    },
    body: JSON.stringify({ ...change, detail: "compact" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 402) return paidReview(change);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`review returned ${response.status}: ${body?.error?.message || "unknown error"}`);
  return body;
}

async function fileAtRevision(revision, path) {
  try { return command("git", ["show", `${revision}:${path}`]); } catch { return null; }
}

async function currentFile(path) {
  try {
    const value = await readFile(path, "utf8");
    return value.length <= 2 * 1024 * 1024 ? value : null;
  } catch { return null; }
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha || process.env.GITHUB_SHA;
  if (!base || !head) {
    await summary("## UpgradeLens\n\nSkipped: this action runs only for pull requests.\n");
    return;
  }
  const changed = command("git", ["diff", "--name-only", base, head, "--"]).split(/\r?\n/).filter(dependencyFile.test.bind(dependencyFile));
  const candidates = new Set(changed);
  for (const path of changed) {
    const folder = dirname(path);
    const name = basename(path);
    if (["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(name)) candidates.add(folder === "." ? "package.json" : `${folder}/package.json`);
    if (["poetry.lock", "uv.lock"].includes(name)) candidates.add(folder === "." ? "pyproject.toml" : `${folder}/pyproject.toml`);
  }
  const files = await Promise.all([...candidates].map(async (path) => ({ path, before: await fileAtRevision(base, path), after: await currentFile(path) })));
  const security = /security|vulnerab|\bCVE-/i.test(`${event.pull_request.title || ""} ${event.pull_request.body || ""} ${(event.pull_request.labels || []).map((label) => label.name).join(" ")}`);
  const changes = prioritizeChanges(detectDependencyChanges(files), security, maxChanges);
  if (!changes.length) {
    await summary("## UpgradeLens\n\nNo exact direct npm or PyPI version change was found. Repository source was not uploaded.\n");
    return;
  }
  let entitlement = null;
  try { entitlement = await oidcEntitlement(); } catch (error) { annotation("warning", error.message); }
  const results = [];
  for (const change of changes) {
    try {
      const result = await review(change, entitlement);
      if (!result) {
        results.push({ change, decision: "unknown", note: "Free repository unit unavailable and no compatible wallet was configured." });
        annotation("warning", `${change.package}: analysis requires payment; configure UPGRADELENS_BUYER_PRIVATE_KEY as an Actions/Dependabot secret.`);
      } else {
        results.push({ change, ...result });
        annotation(result.decision === "block" ? "error" : result.decision === "proceed" ? "notice" : "warning", `${change.package} ${change.current_version} → ${change.target_version}: ${result.decision}`);
      }
    } catch (error) {
      results.push({ change, decision: "unknown", note: error.message });
      annotation("warning", `${change.package}: ${error.message}`);
    }
  }
  const rows = results.map((row) => `| ${row.change.package} | ${row.change.current_version} → ${row.change.target_version} | ${row.decision} | ${row.risk_score ?? "—"} |`).join("\n");
  await summary(`## UpgradeLens dependency review\n\n| Package | Upgrade | Decision | Risk |\n|---|---|---:|---:|\n${rows}\n\nAnalyzed ${results.length} direct change(s); maximum paid spend was $${(maxSpendAtomic / 1_000_000).toFixed(2)}. Repository contents, tokens, OIDC assertions, and wallet material were not sent as telemetry.\n`);
  if (results.some((row) => row.decision === "block")) process.exitCode = 1;
}

main().catch(async (error) => {
  annotation("warning", error instanceof Error ? error.message : String(error));
  await summary("## UpgradeLens\n\nAnalysis was unavailable; the workflow remains non-blocking because no explicit `block` decision was returned.\n");
});
