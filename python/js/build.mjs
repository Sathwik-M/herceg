// Bundles the JavaScript the Python package ships: `npm run build:python`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "herceg", "static");
mkdirSync(out, { recursive: true });
const common = {
  bundle: true,
  minify: true,
  target: "es2022",
  alias: { "herceg/spec": join(here, "..", "..", "packages", "herceg", "src", "from-spec.ts") },
  logLevel: "warning",
};
// Browsers: a classic script defining `hercegPython.render`, so each chart's
// HTML can inline it. The WebGL painter is inlined rather than split.
await esbuild.build({
  ...common,
  entryPoints: [join(here, "browser.ts")],
  format: "iife",
  globalName: "hercegPython",
  outfile: join(out, "herceg.js"),
});
// Embedded engines: a classic script defining `hercegStatic`.
await esbuild.build({
  ...common,
  entryPoints: [join(here, "static.ts")],
  format: "iife",
  platform: "neutral",
  outfile: join(out, "herceg-static.js"),
});
