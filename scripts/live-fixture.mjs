// Owner-controlled verification, never merchant revenue or organic demand.
// No wallet is passed to the child process; the spending ceiling is zero.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "upgradelens-live-review-"));
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  git("init"); git("config", "user.name", "UpgradeLens verification"); git("config", "user.email", "verification@example.invalid");
  function commit(version) {
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ dependencies: { express: version } }));
    git("add", "package.json"); git("-c", "commit.gpgsign=false", "commit", "-m", "Owned dependency fixture");
    return git("rev-parse", "HEAD");
  }
  const base = commit("4.19.2"), head = commit("5.1.0");
  const event = join(fixture, "event.json"), summary = join(fixture, "summary.md"), output = join(fixture, "outputs");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, title: "Owned verification", labels: [] } }));
  const { UPGRADELENS_BUYER_PRIVATE_KEY: _ignoredWallet, ...environment } = process.env;
  const result = spawnSync(process.execPath, [entry], { cwd: fixture, encoding: "utf8", timeout: 90000,
    env: { ...environment, UPGRADELENS_VERIFICATION: "true", GITHUB_EVENT_PATH: event,
      GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, "INPUT_MAX-SPEND-USD": "0", "INPUT_MAX-CHANGES": "1" } });
  const counts = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")));
  const report = { generated_at: new Date().toISOString(), verification: true, organic_demand: false,
    max_spend_usd: 0, wallet_passed: false, exit_status: result.status, counts, summary: readFileSync(summary, "utf8") };
  writeFileSync("live-review-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ verification: true, max_spend_usd: 0, counts }));
  if (result.status !== 0 || counts.reviewed !== "1" || counts.unavailable !== "0") {
    throw new Error("Live free review did not complete; inspect live-review-report.json. No paid call was authorized.");
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }
