import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npm, root, run, withTempProject } from "./temp-project.mjs";

await withTempProject("test:python-package", async (consumer, step) => {
  // Keep cache and interpreter settings; discard registry and source overrides.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^UV_(?:INDEX(?:_.*)?|DEFAULT_INDEX|EXTRA_INDEX_URL|FIND_LINKS|NO_INDEX|CONFIG_FILE|PROJECT|WORKING_DIR)$/.test(
          name,
        ) && !/^PIP_(?:INDEX_URL|EXTRA_INDEX_URL|FIND_LINKS|NO_INDEX|CONFIG_FILE)$/.test(name),
    ),
  );
  const uv = (args, cwd = consumer) =>
    run("uv", [...args, "--no-config", "--no-python-downloads"], { cwd, env });
  const offlineFirst = (args, cwd) => {
    args = [...args, "--no-sources"];
    try {
      return uv([...args, "--offline"], cwd);
    } catch (error) {
      console.log(`  Offline attempt failed; retrying with PyPI only\n${error.message}`);
      return uv([...args, "--default-index", "https://pypi.org/simple"], cwd);
    }
  };

  await step("Build the bundled Python JavaScript", () => {
    run(npm, ["run", "build:python"], { cwd: root });
  });
  await step("Build the sdist and wheel (offline first, PyPI fallback)", () => {
    offlineFirst(
      ["build", "--python", env.UV_PYTHON ?? ">=3.10", "--out-dir", consumer],
      join(root, "python"),
    );
  });
  const wheels = readdirSync(consumer).filter((name) => name.endsWith(".whl"));
  assert.equal(wheels.length, 1, "Expected one wheel");
  const sdists = readdirSync(consumer).filter((name) => name.endsWith(".tar.gz"));
  assert.equal(sdists.length, 1, "Expected one sdist");
  assert(
    readFileSync(join(root, "python/LICENSE")).equals(readFileSync(join(root, "LICENSE"))),
    "python/LICENSE differs from root LICENSE",
  );
  const wheel = join(consumer, wheels[0]);
  const venv = join(consumer, "venv");
  await step("Create a fresh virtual environment without downloading Python", () => {
    uv(["venv", "--no-project", "--python", env.UV_PYTHON ?? ">=3.10", venv]);
  });
  const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await step("Check bundled JavaScript and the license in both distributions", () => {
    run(
      python,
      [
        "-I",
        "-c",
        `
import sys, tarfile, zipfile
from email.parser import BytesParser
from pathlib import Path
license_text = Path(sys.argv[3]).read_bytes()
with zipfile.ZipFile(sys.argv[1]) as wheel:
    for name in ("herceg.js", "herceg-static.js", "herceg-widget.js", "herceg-streamlit.js"):
        path = "herceg/static/" + name
        assert wheel.getinfo(path).file_size > 0, "Empty bundle: " + path
    licenses = [name for name in wheel.namelist() if name.endswith(".dist-info/licenses/LICENSE")]
    assert len(licenses) == 1, "Wheel must contain one LICENSE"
    assert wheel.read(licenses[0]) == license_text, "Wheel LICENSE differs from root LICENSE"
    metadata = wheel.read(licenses[0].replace("licenses/LICENSE", "METADATA"))
    assert BytesParser().parsebytes(metadata).get_all("License-File") == ["LICENSE"]
with tarfile.open(sys.argv[2], "r:gz") as sdist:
    prefix = Path(sys.argv[2]).name.removesuffix(".tar.gz") + "/"
    assert sdist.extractfile(prefix + "LICENSE").read() == license_text, "Sdist LICENSE differs from root LICENSE"
    metadata = sdist.extractfile(prefix + "PKG-INFO").read()
    assert BytesParser().parsebytes(metadata).get_all("License-File") == ["LICENSE"]
`,
        wheel,
        join(consumer, sdists[0]),
        join(root, "LICENSE"),
      ],
      { cwd: consumer, env },
    );
  });
  await step("Install the wheel and its dependencies (offline first, PyPI fallback)", () => {
    offlineFirst(["pip", "install", "--python", python, wheel]);
  });
  await step("Import the installed wheel, build a chart, and render HTML", () => {
    run(
      python,
      [
        "-I",
        "-c",
        `
import sys
from pathlib import Path
import herceg as hg
assert Path(hg.__file__).is_relative_to(Path(sys.prefix)), "Imported the checkout"
chart = hg.line({"x": [1, 2, 3], "y": [3, 1, 2]}, x="x", y="y", title="Package smoke test")
html = chart.to_html()
assert html.startswith("<!doctype html>"), "Missing HTML document"
assert "hercegPython.render" in html, "Missing bundled runtime"
assert "Package smoke test" in html, "Missing chart title"
print("Installed wheel rendered", len(html), "HTML characters")
`,
      ],
      { cwd: consumer, env },
    );
  });
});
