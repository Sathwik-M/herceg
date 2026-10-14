import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { editableHercegEntry, isStableVersion, packageFolders } from "./release-version.mjs";
import { root } from "./temp-project.mjs";

const tag = process.argv[2];
const version = tag?.startsWith("v") ? tag.slice(1) : undefined;
assert(
  process.argv.length === 3 && isStableVersion(version),
  "release tag: expected vX.Y.Z with a stable version and no leading zeros; use a tag such as v0.1.0",
);
const read = (path) => readFileSync(join(root, path), "utf8");
const equal = (actual, location) =>
  assert.equal(
    actual,
    version,
    `${location}: must match ${tag}; run npm run version:set -- ${version}`,
  );
const lock = JSON.parse(read("package-lock.json"));
for (const folder of packageFolders) {
  const path = `packages/${folder}`;
  const manifest = JSON.parse(read(`${path}/package.json`));
  equal(manifest.version, `${path}/package.json version`);
  equal(lock.packages[path]?.version, `package-lock.json ${path} version`);
  if (folder !== "herceg") {
    equal(manifest.dependencies?.herceg, `${path}/package.json dependencies.herceg`);
    equal(
      lock.packages[path]?.dependencies?.herceg,
      `package-lock.json ${path} dependencies.herceg`,
    );
  }
}
const project = read("python/pyproject.toml")
  .split(/^\[project\]\s*$/m)[1]
  ?.split(/^\[/m)[0];
equal(project?.match(/^version = "([^"]+)"$/m)?.[1], "python/pyproject.toml version");
equal(
  read("python/src/herceg/__init__.py").match(/^__version__ = "([^"]+)"$/m)?.[1],
  "herceg.__version__",
);
equal(
  editableHercegEntry(read("python/uv.lock")).match(/^version = "([^"]+)"$/m)?.[1],
  "python/uv.lock editable herceg version",
);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`release: all package and lockfile versions match ${tag}`);
