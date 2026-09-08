import { appendFile, readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { detectDependencyChanges, prioritizeChanges } from "./extract.js";
import { reviewRequest, spendLimit, paymentAllowed, normalizeReview, reviewSummary } from "./review.js";

const dependencyFile = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt)$/i;
const service = (process.env["INPUT_SERVICE-URL"] || "https://upgradelens.mattpicone.workers.dev").replace(/\/$/, "");
const requestedChanges = Number(process.env["INPUT_MAX-CHANGES"] || 3);
const maxChanges = Number.isFinite(requestedChanges) ? Math.min(3, Math.max(1, Math.floor(requestedChanges))) : 3;
const maxSpendAtomic = spendLimit(process.env["INPUT_MAX-SPEND-USD"]);
const runtime = Object.fromEntries(["node", "python"].flatMap((key) => {
  const value = process.env[`INPUT_${key.toUpperCase()}-VERSION`]?.trim();
  return value ? [[key, value]] : [];
}));

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${name} ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function annotation(level, message) {
  process.stdout.write(`::${level}::${String(message).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
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
  if (!process.env.UPGRADELENS_BUYER_PRIVATE_KEY || maxSpendAtomic - spentAtomic < 10_000) return null;
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
    const raw = new Client({ name: "upgradelens-action", version: "0.1.1" }, { capabilities: {} });
    const buyer = new x402MCPClient(raw, payment, {
      autoPayment: true,
      onPaymentRequested: ({ toolName, paymentRequired }) => {
        const allowed = paymentAllowed({ toolName, paymentRequired, service, spentAtomic, maxSpendAtomic });
        if (allowed) spentAtomic += 10_000;
        return allowed;
      },
    });
    try { await buyer.connect(new StreamableHTTPClientTransport(new URL(`${service}/mcp`))); }
    catch (error) { await buyer.close().catch(() => {}); throw error; }
    return buyer;
  })();
  const buyer = await paidClientPromise;
  return normalizeReview(contentResult(await buyer.callTool("review_dependency_upgrade", reviewRequest(change, runtime))));
}

async function review(change, entitlement) {
  const response = await fetch(`${service}/v1/upgrade/review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(entitlement ? { "x-upgradelens-trial-token": entitlement } : {}),
    },
    body: JSON.stringify(reviewRequest(change, runtime)),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 402) {
    try { return await paidReview(change); }
    catch { throw new Error("Paid review unavailable. Check wallet configuration, remaining budget, and service payment readiness."); }
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`review returned ${response.status}: ${body?.error?.message || "unknown error"}`);
  return normalizeReview(body);
}

async function fileAtRevision(revision, path) {
  try { return command("git", ["show", `${revision}:${path}`]); } catch { return null; }
}

async function main() {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "reviewed=0\nblocked=0\nunavailable=0\n");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha || process.env.GITHUB_SHA;
  if (!base || !head) {
    await summary("## UpgradeLens\n\nSkipped: this action runs only for pull requests.\n");
    return;
  }
  if (!/^[a-f0-9]{40,64}$/i.test(base) || !/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Pull request revisions must be full commit hashes.");
  const changed = command("git", ["diff", "--name-only", "-z", base, head, "--"]).split("\0").filter(dependencyFile.test.bind(dependencyFile));
  const candidates = new Set(changed);
  for (const path of changed) {
    const folder = dirname(path);
    const name = basename(path);
    if (["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(name)) candidates.add(folder === "." ? "package.json" : `${folder}/package.json`);
    if (["poetry.lock", "uv.lock"].includes(name)) candidates.add(folder === "." ? "pyproject.toml" : `${folder}/pyproject.toml`);
  }
  const files = await Promise.all([...candidates].map(async (path) => ({ path, before: await fileAtRevision(base, path), after: await fileAtRevision(head, path) })));
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
        const note = "Review unavailable: the free unit is exhausted, and a funded wallet plus at least $0.01 remaining run budget is required for payment.";
        results.push({ change, decision: "unknown", note });
        annotation("warning", `${change.package}: ${note}`);
      } else {
        results.push({ ...result, change });
        annotation(result.decision === "block" ? "error" : result.decision === "proceed" ? "notice" : "warning", `${change.package} ${change.current_version} → ${change.target_version}: ${result.decision}`);
      }
    } catch (error) {
      results.push({ change, decision: "unknown", note: error.message });
      annotation("warning", `${change.package}: ${error.message}`);
    }
  }
  // Preserve an explicit block even if writing the report fails.
  if (results.some((row) => row.decision === "block")) process.exitCode = 1;
  await summary(reviewSummary(results, maxSpendAtomic, spentAtomic));
  if (process.env.GITHUB_OUTPUT) {
    const counts = { reviewed: results.filter((row) => !row.note).length, blocked: results.filter((row) => row.decision === "block").length, unavailable: results.filter((row) => row.note).length };
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(counts).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}

main().catch(async (error) => {
  annotation("warning", error instanceof Error ? error.message : String(error));
  await summary("## UpgradeLens\n\nAnalysis was unavailable; the workflow remains non-blocking because no explicit `block` decision was returned.\n");
}).finally(async () => {
  if (paidClientPromise) await (await paidClientPromise.catch(() => null))?.close().catch(() => {});
});
