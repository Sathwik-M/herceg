import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
  const wheel = join(consumer, wheels[0]);
  const venv = join(consumer, "venv");
  await step("Create a fresh virtual environment without downloading Python", () => {
    uv(["venv", "--no-project", "--python", env.UV_PYTHON ?? ">=3.10", venv]);
  });
  const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await step("Check that the wheel contains all four bundled JavaScript artifacts", () => {
    run(
      python,
      [
        "-I",
        "-c",
        `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as wheel:
    for name in ("herceg.js", "herceg-static.js", "herceg-widget.js", "herceg-streamlit.js"):
        path = "herceg/static/" + name
        assert wheel.getinfo(path).file_size > 0, "Empty bundle: " + path
`,
        wheel,
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
