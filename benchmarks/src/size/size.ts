// Bundle size benchmark: each entry renders an equivalent time-series line
// chart with a tooltip, bundled for production with tree shaking.
//
//   npm run size -- [--out results/size.json]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { compile } from "svelte/compiler";
import { HERCEG_ALIAS, ROOT } from "../runner/build.ts";
import { commit, machine, packageVersion } from "../runner/environment.ts";

const { values: args } = parseArgs({
  options: { out: { type: "string" }, filter: { type: "string" } },
});

const ENTRIES = join(ROOT, "src", "size", "entries");

/** The npm package each entry measures, for version reporting. */
const ENTRY_PACKAGES: Record<string, string> = {
  "herceg-line": "herceg",
  "herceg-grid": "herceg",
  "herceg-bar": "herceg",
  "herceg-area": "herceg",
  "herceg-scatter": "herceg",
  "herceg-react-line": "@herceg/react",
  "herceg-vue-line": "@herceg/vue",
  "herceg-svelte-line": "@herceg/svelte",
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
  /**
   * What a page loads before the chart can render: the entry chunk and the
   * chunks it imports statically, fetched (and compressed) one by one.
   */
  initial: Uint8Array[];
  css: Uint8Array | undefined;
  /** Chunks the page can reach only through dynamic imports, loaded when needed. */
  lazy: Uint8Array[];
}

/** Frameworks are shared by the whole application, so adapter entries leave them out. */
const FRAMEWORKS: Record<string, string[]> = {
  "herceg-react-line": ["react", "react-dom", "react/jsx-runtime"],
  "herceg-vue-line": ["vue"],
  "herceg-svelte-line": ["svelte", "svelte/*"],
};

/** Compiles Svelte components for production, as an application's build would. */
const svelte: esbuild.Plugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
      contents: compile(readFileSync(path, "utf8"), { filename: path }).js.code,
      loader: "js",
      resolveDir: dirname(path),
    }));
  },
};

async function bundle(entry: string, minify: boolean, external: string[]): Promise<Bundle> {
  const result = await esbuild.build({
    external,
    jsx: "automatic",
    entryPoints: [entry],
    bundle: true,
    minify,
    write: false,
    outdir: "out",
    format: "esm",
    // Dynamic imports become separate chunks, as with application bundlers.
    splitting: true,
    target: "es2022",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: HERCEG_ALIAS,
    plugins: [svelte],
    metafile: true,
    logLevel: "error",
  });
  const name = basename(entry).replace(/\.tsx?$/, "");
  const outputs = result.metafile.outputs;
  // Metafile paths are relative and use forward slashes, on Windows too.
  const contents = new Map(
    result.outputFiles.map((file) => [
      relative(process.cwd(), file.path).split(sep).join("/"),
      file.contents,
    ]),
  );
  // The entry and what it imports statically, transitively.
  const initial = new Set<string>();
  const visit = (path: string) => {
    if (initial.has(path)) return;
    initial.add(path);
    for (const { path: imported, kind } of outputs[path]!.imports)
      if (kind === "import-statement" && outputs[imported]) visit(imported);
  };
  visit(Object.keys(outputs).find((path) => basename(path) === `${name}.js`)!);
  // Chunks the initial ones can import later, transitively: code split off
  // for modules a page leaves out is never loaded.
  const lazy = new Set<string>();
  const reach = (path: string) => {
    for (const { path: imported, kind } of outputs[path]!.imports) {
      if (!outputs[imported] || initial.has(imported) || lazy.has(imported)) continue;
      if (kind !== "dynamic-import" && !lazy.has(path)) continue;
      lazy.add(imported);
      reach(imported);
    }
  };
  for (const path of initial) reach(path);
  const css = Object.keys(outputs).find((path) => path.endsWith(".css"));
  return {
    initial: [...initial].map((path) => contents.get(path)!),
    css: css === undefined ? undefined : contents.get(css),
    lazy: [...lazy].map((path) => contents.get(path)!),
  };
}

const gzip = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).byteLength;
const brotli = (bytes: Uint8Array) =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength;
/** Bytes of chunks fetched one by one: each compressed on its own. */
const total = (chunks: Uint8Array[], size: (bytes: Uint8Array) => number) =>
  chunks.reduce((sum, chunk) => sum + size(chunk), 0);

const rows = [];
// Entries are scripts; components they render sit next to them.
for (const file of readdirSync(ENTRIES)
  .filter((name) => /\.tsx?$/.test(name))
  .sort()) {
  const name = basename(file).replace(/\.tsx?$/, "");
  if (args.filter && !name.includes(args.filter)) continue;
  const entry = join(ENTRIES, file);
  const external = FRAMEWORKS[name] ?? [];
  const raw = await bundle(entry, false, external);
  const minified = await bundle(entry, true, external);
  const css = minified.css;
  const pkg = ENTRY_PACKAGES[name] ?? name;
  rows.push({
    entry: name,
    package: pkg,
    version: packageVersion(pkg),
    raw: total(raw.initial, (bytes) => bytes.byteLength),
    minified: total(minified.initial, (bytes) => bytes.byteLength),
    gzip: total(minified.initial, gzip),
    brotli: total(minified.initial, brotli),
    // Herceg loads a few small chunks with the entry; competitors load one.
    chunks: minified.initial.length,
    // Stylesheets the library requires, reported separately from JavaScript.
    css: css ? { minified: css.byteLength, gzip: gzip(css), brotli: brotli(css) } : null,
    // Code split off for on-demand loading, such as Herceg's GPU painter.
    lazy: minified.lazy.length
      ? {
          minified: total(minified.lazy, (bytes) => bytes.byteLength),
          gzip: total(minified.lazy, gzip),
        }
      : null,
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
      "esbuild bundle, ESM, es2022, minified, NODE_ENV=production, code splitting; measured is what loads before the chart renders, the entry chunk and the chunks it imports statically, each compressed on its own as browsers fetch them; chunks reached only by dynamic imports and required CSS are reported separately; gzip level 9; brotli quality 11",
    environment: { ...machine(), esbuild: esbuild.version },
    results: rows,
  };
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\nWrote ${out}`);
}
