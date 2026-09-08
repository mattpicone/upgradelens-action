const EXACT = /^(?:v)?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/;

function exact(value) {
  const normalized = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  const match = normalized.match(EXACT) || normalized.match(/^==\s*(.+)$/);
  return match ? String(match[1] ?? match[0]).replace(/^v/, "") : null;
}

function packageNameFromLockSelector(selector) {
  const clean = selector.replace(/^['"]|['"]$/g, "");
  if (clean.startsWith("@")) {
    const secondAt = clean.indexOf("@", 1);
    return secondAt > 0 ? clean.slice(0, secondAt) : clean;
  }
  return clean.split("@")[0];
}

function add(map, ecosystem, name, version, direct = false) {
  const normalized = exact(version);
  if (!name || !normalized) return;
  map.set(`${ecosystem}:${name.toLowerCase()}`, { ecosystem, package: name, version: normalized, direct });
}

function markDirect(map, ecosystem, name) {
  if (!name) return;
  const key = `${ecosystem}:${name.toLowerCase()}`;
  const current = map.get(key);
  map.set(key, current ? { ...current, direct: true } : { ecosystem, package: name, version: null, direct: true });
}

function parsePackageJson(text, map) {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(json?.[section] || {})) {
      markDirect(map, "npm", name);
      add(map, "npm", name, version, true);
    }
  }
}

function parsePackageLock(text, map) {
  let json;
  try { json = JSON.parse(text); } catch { return; }
  const root = json?.packages?.[""];
  const direct = new Set(root
    ? ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((section) => Object.keys(root[section] || {}))
    : Object.keys(json?.dependencies || {}));
  for (const name of direct) {
    const row = json?.packages?.[`node_modules/${name}`] || json?.dependencies?.[name];
    add(map, "npm", name, row?.version, true);
  }
}

function parsePnpmLock(text, map) {
  const lines = text.split(/\r?\n/);
  let inImporters = false;
  let inImporter = false;
  let inDirectSection = false;
  let current = null;
  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (/^importers:\s*$/.test(line)) { inImporters = true; inImporter = false; continue; }
    if (inImporters && indent === 0 && line.trim()) { inImporters = false; inImporter = false; }
    if (inImporters && indent === 2 && /^\s{2}.+:\s*$/.test(line)) { inImporter = true; inDirectSection = false; continue; }
    if (!inImporter) continue;
    if (/^\s{4}(dependencies|optionalDependencies|devDependencies):\s*$/.test(line)) { inDirectSection = true; current = null; continue; }
    if (indent <= 4 && !/^\s*$/.test(line) && !/^\s{4}(dependencies|optionalDependencies|devDependencies):/.test(line)) inDirectSection = false;
    if (!inDirectSection) continue;
    const name = indent === 6 ? line.match(/^\s{6}([^:#][^:]*):\s*(.*)$/) : null;
    if (name) {
      current = name[1].replace(/^['"]|['"]$/g, "");
      if (name[2]) add(map, "npm", current, name[2], true);
      continue;
    }
    const version = indent === 8 ? line.match(/^\s{8}version:\s*(.+)$/) : null;
    if (version && current) add(map, "npm", current, version[1].split("(")[0], true);
  }
}

function parseYarnLock(text, map, directNames) {
  let selectors = [];
  for (const line of text.split(/\r?\n/)) {
    if (line && !/^\s/.test(line) && line.endsWith(":")) {
      selectors = line.slice(0, -1).split(",").map((value) => value.trim());
      continue;
    }
    const version = line.match(/^\s{2}version(?::|\s+)\s*["']?([^"'\s]+)["']?/);
    if (!version) continue;
    for (const selector of selectors) {
      const name = packageNameFromLockSelector(selector);
      if (directNames.has(name.toLowerCase())) add(map, "npm", name, version[1], true);
    }
  }
}

function parseRequirements(text, map) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9_.-]+)\s*==\s*([^\s;#]+)/);
    if (match) add(map, "pypi", match[1], match[2], true);
  }
}

function parsePyproject(text, map) {
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.trim().match(/^\[([^\]]+)]$/);
    if (heading) { section = heading[1]; continue; }
    if (section === "project") {
      for (const dependency of line.matchAll(/["']([A-Za-z0-9_.-]+)\s*([^"']*)["']/g)) {
        markDirect(map, "pypi", dependency[1]);
        const pinned = dependency[2].match(/^\s*==\s*([^;\s]+)/);
        if (pinned) add(map, "pypi", dependency[1], pinned[1], true);
      }
    }
    if (/^tool\.poetry\.(dependencies|group\.[^.]+\.dependencies)$/.test(section)) {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/);
      if (match && match[1].toLowerCase() !== "python") {
        markDirect(map, "pypi", match[1]);
        add(map, "pypi", match[1], match[2], true);
      }
    }
  }
}

function parsePythonLock(text, map, directNames) {
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[\[package]]\s*$/.test(line)) { name = null; continue; }
    const nameMatch = line.match(/^name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) { name = nameMatch[1]; continue; }
    const version = line.match(/^version\s*=\s*["']([^"']+)["']/);
    if (name && version && directNames.has(name.toLowerCase())) add(map, "pypi", name, version[1], true);
  }
}

function directNames(map, ecosystem) {
  return new Set([...map.values()].filter((entry) => entry.ecosystem === ecosystem && entry.direct).map((entry) => entry.package.toLowerCase()));
}

export function dependencySnapshot(files, side) {
  const map = new Map();
  const available = files.filter((file) => typeof file[side] === "string");
  for (const file of available) {
    const text = file[side];
    const name = file.path.split("/").pop();
    if (name === "package.json") parsePackageJson(text, map);
    else if (name === "package-lock.json") parsePackageLock(text, map);
    else if (/^requirements.*\.txt$/i.test(name)) parseRequirements(text, map);
    else if (name === "pyproject.toml") parsePyproject(text, map);
    else if (name === "pnpm-lock.yaml") parsePnpmLock(text, map);
  }
  const npmDirect = directNames(map, "npm");
  const pypiDirect = directNames(map, "pypi");
  for (const file of available) {
    const text = file[side];
    const name = file.path.split("/").pop();
    if (/^yarn\.lock$/i.test(name)) parseYarnLock(text, map, npmDirect);
    if (name === "poetry.lock" || name === "uv.lock") parsePythonLock(text, map, pypiDirect);
  }
  return map;
}

export function detectDependencyChanges(files) {
  const before = dependencySnapshot(files, "before");
  const after = dependencySnapshot(files, "after");
  const changes = [];
  for (const [key, target] of after) {
    const current = before.get(key);
    if (!current || !target.direct || !current.version || !target.version || current.version === target.version) continue;
    changes.push({
      ecosystem: target.ecosystem,
      package: target.package,
      current_version: current.version,
      target_version: target.version,
    });
  }
  return changes.sort((left, right) => `${left.ecosystem}:${left.package}`.localeCompare(`${right.ecosystem}:${right.package}`));
}

function major(version) {
  return Number(String(version).split(".")[0]);
}

export function prioritizeChanges(changes, security, maximum = 3) {
  return [...changes]
    .map((change) => ({ ...change, security: Boolean(security), major: major(change.target_version) > major(change.current_version) }))
    .sort((left, right) => Number(right.security) - Number(left.security) || Number(right.major) - Number(left.major) || left.package.localeCompare(right.package))
    .slice(0, Math.max(0, Math.min(3, maximum)))
    .map(({ security: _security, major: _major, ...change }) => change);
}
