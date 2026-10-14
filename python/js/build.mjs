// Bundles the JavaScript the Python package ships: `npm run build:python`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "herceg", "static");
mkdirSync(out, { recursive: true });
const engine = join(here, "..", "..", "packages", "herceg", "src");
const common = {
  bundle: true,
  minify: true,
  target: "es2022",
  alias: {
    herceg: join(engine, "index.ts"),
    "herceg/pdf": join(engine, "pdf.ts"),
    "herceg/fonts": join(engine, "fonts.ts"),
    "herceg/spec": join(engine, "from-spec.ts"),
  },
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
// Notebook widgets and Streamlit components: ES modules, as anywidget and
// Streamlit load them.
for (const name of ["widget", "streamlit"]) {
  await esbuild.build({
    ...common,
    entryPoints: [join(here, `${name}.ts`)],
    format: "esm",
    outfile: join(out, `herceg-${name}.js`),
  });
}
