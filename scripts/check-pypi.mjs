import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPyPIArtifacts } from "./release-registry.mjs";
import { isStableVersion } from "./release-version.mjs";
import { root } from "./temp-project.mjs";

const [version, flag] = process.argv.slice(2);
assert(
  isStableVersion(version) && (!flag || flag === "--require-all") && process.argv.length <= 4,
  "Usage: node scripts/check-pypi.mjs X.Y.Z [--require-all]",
);
const directory = join(root, "python/dist");
// uv creates a .gitignore alongside its distribution files.
const files = readdirSync(directory)
  .filter((name) => name !== ".gitignore")
  .sort();
assert.deepEqual(
  files,
  [`herceg-${version}-py3-none-any.whl`, `herceg-${version}.tar.gz`],
  "python/dist: expected exactly this version's wheel and sdist; rebuild the release artifacts",
);
const artifacts = files.map((filename) => ({
  filename,
  sha256: createHash("sha256")
    .update(readFileSync(join(directory, filename)))
    .digest("hex"),
}));
await verifyPyPIArtifacts(version, artifacts, flag === "--require-all");
console.log(
  `PyPI herceg ${version}: ${flag ? "all files are published and match" : "existing files match; missing files may be uploaded"}`,
);
