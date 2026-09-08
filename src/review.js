// Keep local selection metadata out of the strict public review contract.
export function reviewRequest(change, runtime = {}) {
  return {
    ecosystem: change.ecosystem,
    package: change.package,
    current_version: change.current_version,
    target_version: change.target_version,
    ...(Object.keys(runtime).length ? { runtime } : {}),
    detail: "compact",
  };
}

export function spendLimit(value) {
  if (value === undefined || value === "") return 30_000;
  // Invalid limits authorize no spending. Never round up a buyer's limit.
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return 0;
  const [whole, fraction = ""] = value.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return Number(atomic > 30_000n ? 30_000n : atomic);
}

export function paymentAllowed({ toolName, paymentRequired, service, spentAtomic, maxSpendAtomic }) {
  const accepts = paymentRequired?.accepts;
  const requirement = Array.isArray(accepts) && accepts.length === 1 ? accepts[0] : null;
  return service.startsWith("https://") && toolName === "review_dependency_upgrade" &&
    paymentRequired?.x402Version === 2 &&
    paymentRequired?.extensions?.["payment-identifier"]?.info?.required === true &&
    paymentRequired?.resource?.url === `${service}/mcp#review_dependency_upgrade` &&
    requirement?.scheme === "exact" && requirement?.network === "eip155:8453" &&
    String(requirement?.asset || "").toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" &&
    /^0x[0-9a-fA-F]{40}$/.test(requirement?.payTo || "") &&
    requirement?.amount === "10000" && spentAtomic + 10_000 <= maxSpendAtomic;
}

export function normalizeReview(result) {
  if (!result || !["proceed", "review_required", "block", "unknown"].includes(result.decision)) {
    return { decision: "unknown", note: result?.error?.message || "The service did not return a valid review decision." };
  }
  return result;
}

function escape(value) {
  return String(value ?? "").slice(0, 2000).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_\[\]])/g, "\\$1");
}

function sourceLink(citation) {
  try {
    const url = new URL(citation.source_url);
    if (url.protocol !== "https:") return null;
    return `[${escape(citation.source_type || "Source")}](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  } catch { return null; }
}

export function reviewSummary(results, maxSpendAtomic, authorizedAtomic) {
  const rows = results.map(({ change, ...result }) =>
    `| ${escape(change.package)} | ${escape(change.current_version)} → ${escape(change.target_version)} | ${escape(result.decision)} | ${escape(result.risk_score ?? "—")} |`).join("\n");
  const completed = results.filter((row) => !row.note).length;
  const detail = results.map((row) => {
    const actions = (row.migration_actions || []).slice(0, 6).map((action, i) => `${i + 1}. ${escape(action.action)}`).join("\n");
    const sources = (row.citations || []).slice(0, 6).map(sourceLink).filter(Boolean).join(" · ");
    return `### ${escape(row.change.package)}\n\n${escape(row.note || row.headline || row.decision)}\n\n${actions ? `${actions}\n\n` : ""}${sources ? `Evidence: ${sources}\n\n` : ""}`;
  }).join("");
  return `## UpgradeLens dependency review\n\n| Package | Upgrade | Decision | Risk |\n|---|---|---|---:|\n${rows}\n\n${detail}Completed ${completed} of ${results.length} selected review(s). Payment authorizations reserved: $${(authorizedAtomic / 1_000_000).toFixed(2)}; run limit: $${(maxSpendAtomic / 1_000_000).toFixed(2)}. Authorizations are a spending ceiling, not proof of settlement.\n\nOnly package names, exact versions, and configured runtimes are sent for analysis.\n`;
}
