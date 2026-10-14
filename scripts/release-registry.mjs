import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const npmRegistry = "https://registry.npmjs.org";

async function metadata(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  assert(
    response.ok,
    `${url}: registry returned HTTP ${response.status}; retry after resolving the registry error`,
  );
  return response.json();
}

export async function verifyNpmPackage(manifest, integrity, fetcher = fetch) {
  const label = `${manifest.name}@${manifest.version}`;
  const published = await metadata(
    `${npmRegistry}/${encodeURIComponent(manifest.name)}/${manifest.version}`,
    fetcher,
  );
  if (published === null) return false;
  assert.equal(published.name, manifest.name, `${label}: unexpected registry package name`);
  assert.equal(published.version, manifest.version, `${label}: unexpected registry version`);
  assert.equal(
    published.dist?.integrity,
    integrity,
    `${label}: published integrity differs from the local tarball; choose a new version`,
  );
  const url = published.dist?.tarball;
  assert(
    typeof url === "string" && new URL(url).origin === npmRegistry,
    `${label}: unexpected tarball URL`,
  );
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  assert(
    response.ok,
    `${label}: tarball returned HTTP ${response.status}; retry after resolving the registry error`,
  );
  const actual = `sha512-${createHash("sha512")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("base64")}`;
  assert.equal(
    actual,
    integrity,
    `${label}: published tarball differs from the local tarball; choose a new version`,
  );
  return true;
}

export async function verifyPyPIArtifacts(version, artifacts, requireAll = false, fetcher = fetch) {
  const published = await metadata(`https://pypi.org/pypi/herceg/${version}/json`, fetcher);
  if (published === null) {
    assert(!requireAll, `PyPI herceg ${version}: release is missing; rerun the upload`);
    return;
  }
  assert(Array.isArray(published.urls), `PyPI herceg ${version}: missing files metadata`);
  for (const { filename, sha256 } of artifacts) {
    const files = published.urls.filter((file) => file.filename === filename);
    assert(files.length <= 1, `PyPI ${filename}: duplicate file metadata`);
    if (files.length === 0) {
      assert(!requireAll, `PyPI ${filename}: file is missing; rerun the upload`);
      continue;
    }
    assert.equal(
      files[0].digests?.sha256,
      sha256,
      `PyPI ${filename}: published SHA256 differs from the local artifact; choose a new version`,
    );
  }
}
