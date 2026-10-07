// Bundle size benchmark: each entry renders an equivalent time-series line
// chart with a tooltip, bundled for production with tree shaking.
//
//   npm run size -- [--out results/size.json]

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { HERCEG_ALIAS, ROOT } from "../runner/build.ts";
import { commit, machine, packageVersion } from "../runner/environment.ts";

const { values: args } = parseArgs({
  options: { out: { type: "string" }, filter: { type: "string" } },
});

const ENTRIES = join(ROOT, "src", "size", "entries");

/** The npm package each entry measures, for version reporting. */
const ENTRY_PACKAGES: Record<string, string> = {
  "herceg-line": "herceg",
  "echarts-line": "echarts",
  "echarts-full": "echarts",
  "chartjs-line": "chart.js",
  "chartjs-auto": "chart.js",
  "plotly-basic": "plotly.js-basic-dist-min",
  "plotly-full": "plotly.js-dist-min",
  "tanstack-line": "@tanstack/charts",
  uplot: "uplot",
};

interface Bundle {
  js: Uint8Array;
  css: Uint8Array | undefined;
}

async function bundle(entry: string, minify: boolean): Promise<Bundle> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify,
    write: false,
    outdir: "out",
    format: "esm",
    target: "es2022",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: HERCEG_ALIAS,
    logLevel: "error",
  });
  const file = (extension: string) =>
    result.outputFiles.find((output) => output.path.endsWith(extension));
  return { js: file(".js")!.contents, css: file(".css")?.contents };
}

const gzip = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).byteLength;
const brotli = (bytes: Uint8Array) =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength;

const rows = [];
for (const file of readdirSync(ENTRIES).sort()) {
  const name = basename(file, ".ts");
  if (args.filter && !name.includes(args.filter)) continue;
  const entry = join(ENTRIES, file);
  const raw = await bundle(entry, false);
  const minified = await bundle(entry, true);
  const css = minified.css;
  const pkg = ENTRY_PACKAGES[name] ?? name;
  rows.push({
    entry: name,
    package: pkg,
    version: packageVersion(pkg),
    raw: raw.js.byteLength,
    minified: minified.js.byteLength,
    gzip: gzip(minified.js),
    brotli: brotli(minified.js),
    // Stylesheets the library requires, reported separately from JavaScript.
    css: css ? { minified: css.byteLength, gzip: gzip(css), brotli: brotli(css) } : null,
  });
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(
  `${"entry".padEnd(16)} ${"min".padStart(11)} ${"gzip".padStart(11)} ${"brotli".padStart(11)} ${"css gzip".padStart(11)}`,
);
for (const row of rows) {
  console.log(
    `${row.entry.padEnd(16)} ${kb(row.minified).padStart(11)} ${kb(row.gzip).padStart(11)} ${kb(row.brotli).padStart(11)} ${(row.css ? kb(row.css.gzip) : "-").padStart(11)}`,
  );
}

if (args.out) {
  const out = resolve(ROOT, args.out);
  mkdirSync(dirname(out), { recursive: true });
  const output = {
    schema: 1,
    date: new Date().toISOString(),
    commit: commit(),
    method:
      "esbuild bundle, ESM, es2022, minified, NODE_ENV=production; gzip level 9; brotli quality 11; required CSS reported separately",
    environment: { ...machine(), esbuild: esbuild.version },
    results: rows,
  };
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\nWrote ${out}`);
}
