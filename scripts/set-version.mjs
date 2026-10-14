// Sets one version on every published package: herceg, the three adapters
// (and their exact dependency on herceg), the lockfile's entries for them,
// and the Python package. Releases move all of them together.
//
//   npm run version:set -- 0.1.0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editableHercegEntry, isStableVersion, packageFolders } from "./release-version.mjs";
import { root } from "./temp-project.mjs";

const version = process.argv[2];
if (process.argv.length !== 3 || !isStableVersion(version)) {
  console.error(
    "version:set: expected stable X.Y.Z without leading zeros (for example 0.1.0); prereleases are not supported",
  );
  process.exit(1);
}

const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const updates = new Map();
const setJSON = (path, value) => updates.set(path, `${JSON.stringify(value, null, 2)}\n`);

for (const folder of packageFolders) {
  const path = `packages/${folder}/package.json`;
  const manifest = readJSON(path);
  manifest.version = version;
  if (manifest.dependencies?.herceg) manifest.dependencies.herceg = version;
  setJSON(path, manifest);
}

const lock = readJSON("package-lock.json");
for (const folder of packageFolders) {
  const entry = lock.packages[`packages/${folder}`];
  if (!entry) throw new Error(`package-lock.json has no entry for packages/${folder}`);
  entry.version = version;
  if (entry.dependencies?.herceg) entry.dependencies.herceg = version;
}
setJSON("package-lock.json", lock);

// The Python package says its version in its metadata and as herceg.__version__.
for (const [path, line] of [
  ["python/pyproject.toml", /^version = ".*"$/m],
  ["python/src/herceg/__init__.py", /^__version__ = ".*"$/m],
]) {
  const text = readFileSync(join(root, path), "utf8");
  if (!line.test(text)) throw new Error(`${path} has no version line`);
  const prefix = path.endsWith(".toml") ? "version" : "__version__";
  updates.set(path, text.replace(line, `${prefix} = "${version}"`));
}

const uvLock = readFileSync(join(root, "python/uv.lock"), "utf8");
const editable = editableHercegEntry(uvLock);
updates.set(
  "python/uv.lock",
  uvLock.replace(editable, editable.replace(/^version = ".*"$/m, `version = "${version}"`)),
);

// Validate every location before changing any files.
for (const [path, text] of updates) writeFileSync(join(root, path), text);

console.log(
  `version:set: ${version} for herceg, @herceg/react, @herceg/vue, @herceg/svelte, and the Python package`,
);
