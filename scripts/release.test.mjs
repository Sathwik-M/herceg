import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifyNpmPackage, verifyPyPIArtifacts } from "./release-registry.mjs";
import { isStableVersion, packageFolders } from "./release-version.mjs";
import { root } from "./temp-project.mjs";

const manifest = { name: "@herceg/react", version: "1.2.3" };
const tarball = Buffer.from("packed package");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const dist = { integrity, tarball: "https://registry.npmjs.org/@herceg/react/-/react-1.2.3.tgz" };
const json = (value) => Response.json(value);
const artifacts = [
  { filename: "herceg-1.2.3-py3-none-any.whl", sha256: "wheel-hash" },
  { filename: "herceg-1.2.3.tar.gz", sha256: "sdist-hash" },
];
const urls = artifacts.map(({ filename, sha256 }) => ({ filename, digests: { sha256 } }));

test("npm skips only an exact version with identical registry integrity and tarball bytes", async () => {
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    return requested.length === 1 ? json({ ...manifest, dist }) : new Response(tarball);
  };
  assert.equal(await verifyNpmPackage(manifest, integrity, fetcher), true);
  assert.deepEqual(requested, ["https://registry.npmjs.org/%40herceg%2Freact/1.2.3", dist.tarball]);
  await assert.rejects(
    verifyNpmPackage(manifest, integrity, async () =>
      json({ ...manifest, dist: { ...dist, integrity: "different" } }),
    ),
    /published integrity differs/,
  );
  let calls = 0;
  await assert.rejects(
    verifyNpmPackage(manifest, integrity, async () =>
      ++calls === 1 ? json({ ...manifest, dist }) : new Response("different bytes"),
    ),
    /published tarball differs/,
  );
  await assert.rejects(
    verifyNpmPackage(manifest, integrity, async () =>
      json({ ...manifest, version: "1.2.4", dist }),
    ),
    /unexpected registry version/,
  );
});

test("only a confirmed version metadata 404 permits a new publication", async () => {
  assert.equal(
    await verifyNpmPackage(manifest, integrity, async () => new Response(null, { status: 404 })),
    false,
  );
  for (const status of [401, 403, 429, 500, 503]) {
    const fetcher = async () => new Response(null, { status });
    await assert.rejects(verifyNpmPackage(manifest, integrity, fetcher), /registry returned HTTP/);
    await assert.rejects(
      verifyPyPIArtifacts("1.2.3", artifacts, false, fetcher),
      /registry returned HTTP/,
    );
  }
  const unavailable = async () => {
    throw new Error("connection refused");
  };
  await assert.rejects(verifyNpmPackage(manifest, integrity, unavailable), /connection refused/);
  await assert.rejects(
    verifyPyPIArtifacts("1.2.3", artifacts, false, unavailable),
    /connection refused/,
  );
  await assert.rejects(
    verifyNpmPackage(manifest, integrity, async () => new Response("invalid json")),
    SyntaxError,
  );
  let calls = 0;
  await assert.rejects(
    verifyNpmPackage(manifest, integrity, async () =>
      ++calls === 1 ? json({ ...manifest, dist }) : new Response(null, { status: 404 }),
    ),
    /tarball returned HTTP 404/,
  );
});

test("PyPI resumes either partial upload only when existing hashes match", async () => {
  for (const file of urls) {
    const partial = async () => json({ urls: [file] });
    await verifyPyPIArtifacts("1.2.3", artifacts, false, partial);
    await assert.rejects(verifyPyPIArtifacts("1.2.3", artifacts, true, partial), /file is missing/);
    await assert.rejects(
      verifyPyPIArtifacts("1.2.3", artifacts, false, async () =>
        json({ urls: [{ ...file, digests: { sha256: "different" } }] }),
      ),
      /published SHA256 differs/,
    );
  }
  await verifyPyPIArtifacts("1.2.3", artifacts, true, async () => json({ urls }));
  const missing = async () => new Response(null, { status: 404 });
  await verifyPyPIArtifacts("1.2.3", artifacts, false, missing);
  await assert.rejects(
    verifyPyPIArtifacts("1.2.3", artifacts, true, missing),
    /release is missing/,
  );
  await assert.rejects(
    verifyPyPIArtifacts("1.2.3", artifacts, false, async () => json({})),
    /missing files metadata/,
  );
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "herceg-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    "scripts",
    "package-lock.json",
    "python/pyproject.toml",
    "python/uv.lock",
    "python/src/herceg/__init__.py",
    ...packageFolders.map((folder) => `packages/${folder}/package.json`),
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  return directory;
}

const invoke = (directory, script, ...args) =>
  spawnSync(process.execPath, [join(directory, "scripts", script), ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  });

test("stable versions update every release location and engine dependencies, with engine first", (t) => {
  const directory = fixture(t);
  assert.deepEqual(packageFolders, ["herceg", "react", "vue", "svelte"]);
  const set = invoke(directory, "set-version.mjs", "1.2.3");
  assert.equal(set.status, 0, set.stderr);
  const check = invoke(directory, "check-release.mjs", "v1.2.3");
  assert.equal(check.status, 0, check.stderr);
  const versionPaths = [
    "python/pyproject.toml",
    "python/src/herceg/__init__.py",
    "python/uv.lock",
    ...packageFolders.map((folder) => `packages/${folder}/package.json`),
  ];
  for (const path of versionPaths) {
    const filename = join(directory, path);
    const contents = readFileSync(filename, "utf8");
    writeFileSync(filename, contents.replace("1.2.3", "1.2.4"));
    assert.notEqual(invoke(directory, "check-release.mjs", "v1.2.3").status, 0, path);
    writeFileSync(filename, contents);
  }
  for (const folder of packageFolders.slice(1)) {
    const path = join(directory, `packages/${folder}/package.json`);
    const contents = readFileSync(path, "utf8");
    const pkg = JSON.parse(contents);
    pkg.dependencies.herceg = "^1.2.3";
    writeFileSync(path, JSON.stringify(pkg));
    assert.notEqual(invoke(directory, "check-release.mjs", "v1.2.3").status, 0);
    writeFileSync(path, contents);
  }
  const path = join(directory, "package-lock.json");
  const contents = readFileSync(path, "utf8");
  for (const folder of packageFolders) {
    for (const key of folder === "herceg" ? ["version"] : ["version", "dependencies"]) {
      const lock = JSON.parse(contents);
      const entry = lock.packages[`packages/${folder}`];
      if (key === "version") entry.version = "1.2.4";
      else entry.dependencies.herceg = "1.2.4";
      writeFileSync(path, JSON.stringify(lock));
      assert.notEqual(invoke(directory, "check-release.mjs", "v1.2.3").status, 0);
    }
  }
});

test("invalid release versions fail before writing, and the gate requires v", (t) => {
  const directory = fixture(t);
  const path = join(directory, "packages/herceg/package.json");
  const before = readFileSync(path, "utf8");
  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "1.2.3-rc.1",
    "1.2.3+build",
    "v1.2.3",
    "1.2.3\n",
  ]) {
    assert.equal(isStableVersion(version), false, version);
    assert.notEqual(invoke(directory, "set-version.mjs", version).status, 0);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.notEqual(invoke(directory, "check-release.mjs", `v${version}`).status, 0);
  }
  assert.notEqual(invoke(directory, "check-release.mjs", "0.0.0").status, 0);
});

test("publish guard checks runtime, types, and Svelte exports without building", (t) => {
  const directory = fixture(t);
  const target = join(directory, "fixture-package");
  mkdirSync(target);
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({
      name: "fixture",
      exports: { ".": { import: "./index.js", types: "./index.d.ts", svelte: "./Chart.svelte" } },
    }),
  );
  const guard = () =>
    spawnSync(process.execPath, [join(directory, "scripts/check-publish.mjs")], {
      cwd: target,
      encoding: "utf8",
    });
  for (const file of ["index.js", "index.d.ts", "Chart.svelte"]) {
    const result = guard();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing exports target/);
    writeFileSync(join(target, file), "");
  }
  assert.equal(guard().status, 0);
});

test("an invalid editable lock entry cannot leave a version update partially applied", (t) => {
  const directory = fixture(t);
  const path = join(directory, "python/uv.lock");
  const contents = readFileSync(path, "utf8");
  writeFileSync(
    path,
    contents.replace('source = { editable = "." }', 'source = { virtual = "." }'),
  );
  const before = readFileSync(join(directory, "packages/herceg/package.json"), "utf8");
  const result = invoke(directory, "set-version.mjs", "1.2.3");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected one editable herceg entry/);
  assert.equal(readFileSync(join(directory, "packages/herceg/package.json"), "utf8"), before);
});

test("PyPI file checks accept uv's .gitignore, hash both artifacts, and reject stale builds", (t) => {
  const directory = fixture(t);
  const dist = join(directory, "python/dist");
  mkdirSync(dist);
  writeFileSync(join(dist, ".gitignore"), "*");
  const files = artifacts.map(({ filename }) => {
    writeFileSync(join(dist, filename), filename);
    return { filename, digests: { sha256: createHash("sha256").update(filename).digest("hex") } };
  });
  const mock = join(directory, "mock-pypi.mjs");
  writeFileSync(
    mock,
    `globalThis.fetch = async () => Response.json(${JSON.stringify({ urls: files })});\n`,
  );
  const check = () =>
    spawnSync(
      process.execPath,
      ["--import", mock, join(directory, "scripts/check-pypi.mjs"), "1.2.3", "--require-all"],
      { cwd: directory, encoding: "utf8" },
    );
  assert.equal(check().status, 0);
  writeFileSync(join(dist, artifacts[0].filename), "different bytes");
  assert.match(check().stderr, /published SHA256 differs/);
  writeFileSync(join(dist, "herceg-1.2.2.tar.gz"), "old artifact");
  assert.match(check().stderr, /expected exactly this version's wheel and sdist/);
});
