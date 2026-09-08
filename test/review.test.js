import { describe, expect, it } from "vitest";
import { paymentAllowed, reviewRequest, reviewSummary, spendLimit } from "../src/review.js";
import { prioritizeChanges } from "../src/extract.js";

const change = { ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0" };
const service = "https://example.com";
const challenge = () => ({
  x402Version: 2,
  resource: { url: `${service}/mcp#review_dependency_upgrade` },
  extensions: { "payment-identifier": { info: { required: true } } },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: `0x${"a".repeat(40)}` }],
});

describe("conversion and buyer spending", () => {
  it("sends only contract fields after security/major prioritization", () => {
    const [selected] = prioritizeChanges([change], true);
    expect(selected).toEqual(change);
    expect(reviewRequest({ ...selected, security: true, major: true, path: "private/file" }, { node: "22" }))
      .toEqual({ ...change, runtime: { node: "22" }, detail: "compact" });
  });

  it.each([[undefined, 30000], ["", 30000], ["0", 0], ["0.03", 30000], ["0.01", 10000], ["0.009999", 9999], ["0.010001", 10001], ["1", 30000], ["invalid", 0], ["NaN", 0], ["-1", 0], ["0.0099999", 0]])("respects the spend limit %s", (input, expected) => {
    expect(spendLimit(input)).toBe(expected);
  });

  it("caps authorizations at the configured budget", () => {
    const allowed = (spentAtomic) => paymentAllowed({ toolName: "review_dependency_upgrade", paymentRequired: challenge(), service, spentAtomic, maxSpendAtomic: 20000 });
    expect([0, 10000, 20000].map(allowed)).toEqual([true, true, false]);
  });

  it.each(["network", "asset", "amount", "payTo", "scheme", "resource", "version", "identifier", "multiple", "http"])('rejects mismatched %s', (field) => {
    const required = challenge();
    if (field === "resource") required.resource.url = `${service}/mcp#other`;
    else if (field === "version") required.x402Version = 1;
    else if (field === "identifier") required.extensions = {};
    else if (field === "multiple") required.accepts.push({ ...required.accepts[0] });
    else if (field !== "http") required.accepts[0][field] = "wrong";
    expect(paymentAllowed({ toolName: "review_dependency_upgrade", paymentRequired: required, service: field === "http" ? "http://example.com" : service, spentAtomic: 0, maxSpendAtomic: 30000 })).toBe(false);
  });

  it("shows actionable evidence and distinguishes unavailable reviews", () => {
    const summary = reviewSummary([
      { change, decision: "review_required", headline: "Review route syntax", migration_actions: [{ action: "Replace wildcard routes" }], citations: [{ source_type: "release notes", source_url: "https://example.com/release" }, { source_url: "javascript:alert(1)" }] },
      { change: { ...change, package: "a|<script>" }, decision: "unknown", note: "Payment unavailable" },
    ], 30000, 10000);
    expect(summary).toContain("Replace wildcard routes");
    expect(summary).toContain("https://example.com/release");
    expect(summary).toContain("Completed 1 of 2");
    expect(summary).toContain("$0.01");
    expect(summary).not.toContain("javascript:");
    expect(summary).not.toContain("<script>");
  });
});
