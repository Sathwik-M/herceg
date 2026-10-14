// Sets one version on every published package: herceg, the three adapters
// (and their exact dependency on herceg), the lockfile's entries for them,
// and the Python package. Releases move all of them together.
//
//   npm run version:set -- 0.1.0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./temp-project.mjs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("version:set: give a version such as 0.1.0 or 0.2.0-rc.1");
  process.exit(1);
}

const packages = ["herceg", "react", "vue", "svelte"];
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const writeJSON = (path, value) =>
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);

for (const folder of packages) {
  const path = `packages/${folder}/package.json`;
  const manifest = readJSON(path);
  manifest.version = version;
  if (manifest.dependencies?.herceg) manifest.dependencies.herceg = version;
  writeJSON(path, manifest);
}

const lock = readJSON("package-lock.json");
for (const folder of packages) {
  const entry = lock.packages[`packages/${folder}`];
  if (!entry) throw new Error(`package-lock.json has no entry for packages/${folder}`);
  entry.version = version;
  if (entry.dependencies?.herceg) entry.dependencies.herceg = version;
}
writeJSON("package-lock.json", lock);

// The Python package says its version in its metadata and as herceg.__version__.
for (const [path, line] of [
  ["python/pyproject.toml", /^version = ".*"$/m],
  ["python/src/herceg/__init__.py", /^__version__ = ".*"$/m],
]) {
  const text = readFileSync(join(root, path), "utf8");
  if (!line.test(text)) throw new Error(`${path} has no version line`);
  const prefix = path.endsWith(".toml") ? "version" : "__version__";
  writeFileSync(join(root, path), text.replace(line, `${prefix} = "${version}"`));
}

console.log(
  `version:set: ${version} for herceg, @herceg/react, @herceg/vue, @herceg/svelte, and the Python package`,
);
