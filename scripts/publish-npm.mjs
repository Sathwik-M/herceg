// Pack and verify every package before publishing any; the engine always goes first.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmRegistry, verifyNpmPackage } from "./release-registry.mjs";
import { packageFolders } from "./release-version.mjs";
import { npm, root, run } from "./temp-project.mjs";

const mode = process.argv[2];
assert(
  process.argv.length === 3 && ["--check", "--publish"].includes(mode),
  "Usage: node scripts/publish-npm.mjs --check|--publish",
);
const directory = mkdtempSync(join(tmpdir(), "herceg-release-"));
try {
  const manifest = JSON.parse(readFileSync(join(root, "packages/herceg/package.json"), "utf8"));
  run(process.execPath, [join(root, "scripts/check-release.mjs"), `v${manifest.version}`], {
    cwd: root,
  });
  const packed = [];
  for (const folder of packageFolders) {
    const cwd = join(root, "packages", folder);
    run(process.execPath, [join(root, "scripts/check-publish.mjs")], { cwd });
    const [pack] = JSON.parse(
      run(
        npm,
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--workspaces=false",
          "--pack-destination",
          directory,
        ],
        { cwd },
      ),
    );
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const tarball = join(directory, pack.filename);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    assert.equal(pack.integrity, integrity, `${manifest.name}: npm pack integrity differs`);
    const exists = await verifyNpmPackage(manifest, integrity);
    console.log(
      `${manifest.name}@${manifest.version}: ${exists ? "published tarball matches; skip" : "not published"}`,
    );
    packed.push({ manifest, tarball, integrity, exists });
  }
  if (mode === "--publish") {
    for (const { manifest, tarball, integrity, exists } of packed) {
      if (exists) continue;
      run(
        npm,
        [
          "publish",
          tarball,
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "latest",
          "--registry",
          npmRegistry,
        ],
        { cwd: root },
      );
      assert(
        await verifyNpmPackage(manifest, integrity),
        `${manifest.name}: published version is missing; rerun after registry propagation`,
      );
      console.log(`${manifest.name}@${manifest.version}: published and verified`);
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
