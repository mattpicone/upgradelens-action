import { describe, expect, it } from "vitest";
import { detectDependencyChanges, prioritizeChanges } from "../src/extract.js";

describe("direct dependency extraction", () => {
  it("resolves direct npm changes from package-lock and ignores transitive packages", () => {
    const files = [{
      path: "package-lock.json",
      before: JSON.stringify({ packages: { "": { dependencies: { express: "^4.19.0" } }, "node_modules/express": { version: "4.19.2" }, "node_modules/transitive": { version: "1.0.0" } } }),
      after: JSON.stringify({ packages: { "": { dependencies: { express: "^5.1.0" } }, "node_modules/express": { version: "5.1.0" }, "node_modules/transitive": { version: "2.0.0" } } }),
    }];
    expect(detectDependencyChanges(files)).toEqual([{ ecosystem: "npm", package: "express", current_version: "4.19.2", target_version: "5.1.0" }]);
  });

  it("supports pnpm importer resolution", () => {
    const before = `lockfileVersion: '9.0'\nimporters:\n  packages/app:\n    dependencies:\n      zod:\n        specifier: ^3.25.0\n        version: 3.25.0\n`;
    const after = before.replaceAll("3.25.0", "4.0.0");
    expect(detectDependencyChanges([{ path: "pnpm-lock.yaml", before, after }])).toMatchObject([{ package: "zod", current_version: "3.25.0", target_version: "4.0.0" }]);
  });

  it("supports yarn direct entries when paired with package.json", () => {
    for (const [beforeLock, afterLock] of [
      ['vite@^6.1.0:\n  version "6.1.0"\ntransitive@1:\n  version "1.0.0"', 'vite@^7.0.0:\n  version "7.0.0"\ntransitive@2:\n  version "2.0.0"'],
      ['"vite@npm:^6.1.0":\n  version: 6.1.0\n"transitive@npm:1":\n  version: 1.0.0', '"vite@npm:^7.0.0":\n  version: 7.0.0\n"transitive@npm:2":\n  version: 2.0.0'],
    ]) {
      const files = [
        { path: "package.json", before: '{"dependencies":{"vite":"^6.1.0"}}', after: '{"dependencies":{"vite":"^7.0.0"}}' },
        { path: "yarn.lock", before: beforeLock, after: afterLock },
      ];
      expect(detectDependencyChanges(files)).toEqual([{ ecosystem: "npm", package: "vite", current_version: "6.1.0", target_version: "7.0.0" }]);
    }
  });

  it("uses PEP 621 direct names to resolve uv lockfile versions", () => {
    const files = [
      { path: "pyproject.toml", before: '[project]\ndependencies = ["django>=4.2", "requests>=2"]', after: '[project]\ndependencies = ["django>=5.1", "requests>=2"]' },
      { path: "uv.lock", before: '[[package]]\nname = "django"\nversion = "4.2.11"\n[[package]]\nname = "asgiref"\nversion = "3.7.0"', after: '[[package]]\nname = "django"\nversion = "5.1.1"\n[[package]]\nname = "asgiref"\nversion = "3.8.0"' },
    ];
    expect(detectDependencyChanges(files)).toEqual([{ ecosystem: "pypi", package: "django", current_version: "4.2.11", target_version: "5.1.1" }]);
  });

  it("supports Poetry and uv lockfiles using pyproject direct names", () => {
    for (const lock of ["poetry.lock", "uv.lock"]) {
      const files = [
        { path: "pyproject.toml", before: '[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^4.2"', after: '[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5.1"' },
        { path: lock, before: '[[package]]\nname = "django"\nversion = "4.2.11"\n[[package]]\nname = "asgiref"\nversion = "3.7.0"', after: '[[package]]\nname = "django"\nversion = "5.1.1"\n[[package]]\nname = "asgiref"\nversion = "3.8.0"' },
      ];
      expect(detectDependencyChanges(files)).toEqual([{ ecosystem: "pypi", package: "django", current_version: "4.2.11", target_version: "5.1.1" }]);
    }
  });

  it("supports exact requirements files and ignores ranges and malformed entries", () => {
    const before = "requests==2.31.0\nflask>=2\nnot valid ???\n";
    const after = "requests==2.32.4\nflask>=3\nnot valid ???\n";
    expect(detectDependencyChanges([{ path: "requirements-dev.txt", before, after }])).toEqual([
      { ecosystem: "pypi", package: "requests", current_version: "2.31.0", target_version: "2.32.4" },
    ]);
  });

  it("prioritizes security, then majors, caps grouped updates at three, and tolerates malformed files", () => {
    const changes = detectDependencyChanges([
      { path: "package.json", before: "{broken", after: "still broken" },
      { path: "requirements.txt", before: "a==1.0.0\nb==1.0.0\nc==1.0.0\nd==1.0.0", after: "a==2.0.0\nb==1.1.0\nc==3.0.0\nd==1.0.1" },
    ]);
    expect(prioritizeChanges(changes, false, 3).map((change) => change.package)).toEqual(["a", "c", "b"]);
    expect(prioritizeChanges(changes, true, 99)).toHaveLength(3);
  });
});
