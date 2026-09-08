import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let folder;
const entryPoints = ["src/index.js", "dist/index.js"];
const git = (...args) => execFileSync("git", args, { cwd: folder, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "upgradelens-action-test-"));
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const commit = () => { git("add", "package.json"); git("-c", "commit.gpgsign=false", "commit", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  await writeFile(join(folder, "package.json"), JSON.stringify({ devDependencies: { vite: "6.1.0" } }));
  const base = commit();
  await writeFile(join(folder, "package.json"), JSON.stringify({ devDependencies: { vite: "7.0.0" } }));
  const head = commit();
  // Checkout/working-copy contents must never substitute for the requested PR head.
  await writeFile(join(folder, "package.json"), JSON.stringify({ devDependencies: { vite: "99.0.0" } }));
  await writeFile(join(folder, "event.json"), JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, title: "Security update", labels: [] } }));
  await writeFile(join(folder, "fetch.mjs"), `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://service.example/v1/upgrade/review') throw new Error('Unexpected network call');
      const body = JSON.parse(init.body);
      appendFileSync(process.env.REQUESTS_FILE, JSON.stringify(body) + '\\n');
      const allowed = ['ecosystem', 'package', 'current_version', 'target_version', 'detail', 'runtime'];
      if (Object.keys(body).some(k => !allowed.includes(k))) return Response.json({ error: { message: 'Unknown review field' } }, { status: 400 });
      if (process.env.SCENARIO === 'payment') return Response.json({}, { status: 402 });
      if (process.env.SCENARIO === 'outage') return Response.json({error:{message:'Unavailable'}}, {status:503});
      return Response.json({ decision: process.env.SCENARIO === 'block' ? 'block' : 'review_required', headline: 'Runtime upgrade required', migration_actions: [{ order:1, action:'Use Node 22.12 or newer' }], citations: [{ source_type:'registry', source_url:'https://registry.npmjs.org/vite/7.0.0' }] });
    };
  `);
});

afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

describe("real action entry point", () => {
  it.each(entryPoints.flatMap((entry) => ["success", "block", "payment", "outage"].map((scenario) => [entry, scenario])))("%s handles %s without disclosing repo contents or signing a payment", async (entry, scenario) => {
    const source = fileURLToPath(new URL(`../${entry}`, import.meta.url));
    const key = `${entry.replaceAll("/", "-")}-${scenario}`;
    const summary = join(folder, `${key}.md`);
    const output = join(folder, `${key}.outputs`);
    const requests = join(folder, `${key}.requests`);
    const run = spawnSync(process.execPath, ["--import", join(folder, "fetch.mjs"), source], {
      cwd: folder, encoding: "utf8", timeout: 15000,
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_PATH: join(folder, "event.json"), GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output,
        "INPUT_SERVICE-URL": "https://service.example", "INPUT_NODE-VERSION": "22.12.0", "INPUT_MAX-SPEND-USD": "0",
        SCENARIO: scenario, REQUESTS_FILE: requests,
      },
    });
    expect(run.status, run.stderr).toBe(scenario === "block" ? 1 : 0);
    const request = JSON.parse((await readFile(requests, "utf8")).trim());
    expect(request).toEqual({ ecosystem: "npm", package: "vite", current_version: "6.1.0", target_version: "7.0.0", runtime: { node: "22.12.0" }, detail: "compact" });
    const report = await readFile(summary, "utf8");
    const counts = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map((line) => line.split("=")));
    expect(counts.reviewed).toBe(["success", "block"].includes(scenario) ? "1" : "0");
    if (scenario === "success") {
      expect(report).toContain("Use Node 22.12 or newer");
      expect(report).toContain("https://registry.npmjs.org/vite/7.0.0");
    }
    if (scenario === "payment") expect(report).toContain("free unit is exhausted");
    expect(report).not.toContain("99.0.0");
  });
});
