// Run from the repo root: node --experimental-strip-types benchmarks/src/layouts/run.ts --out PATH
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { chromium } from "playwright";
import { HERCEG_ALIAS } from "../runner/build.ts";
import { commit, machine, packageVersion } from "../runner/environment.ts";
import type { Sample, Shape } from "./page.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("--out: expected a result path; give --out PATH");
const output = resolve(values.out);
const directory = mkdtempSync(join(dirname(output), "layouts-"));
await build({
  entryPoints: [join(import.meta.dirname, "page.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: join(directory, "page.js"),
  alias: HERCEG_ALIAS,
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader(
    "Content-Type",
    request.url === "/page.js" ? "application/javascript" : "text/html",
  );
  response.end(
    request.url === "/page.js"
      ? readFileSync(join(directory, "page.js"))
      : '<div id="chart" style="width:1000px;height:600px"></div><script type="module" src="/page.js"></script>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const stats = (given: number[]) => {
  const sorted = [...given].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), n: sorted.length };
};
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("benchmark server has no port");
  const runs: Record<Shape, Sample[]> = { single: [], dashboard: [] };
  // Five fresh pages per shape, alternating, so drift falls on both.
  for (let round = 0; round < 5; round++)
    for (const shape of ["single", "dashboard"] as const) {
      const page = await browser.newPage({
        viewport: { width: 1100, height: 700 },
        deviceScaleFactor: 2,
      });
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => window.layouts);
      runs[shape].push(await page.evaluate((s) => window.layouts.sample(s), shape));
      await page.close();
    }
  const summary = (samples: Sample[]) => ({
    // The first mount of each page pays for compiling the code; the rest do not.
    mounts: stats(samples.flatMap(({ mounts }) => mounts.slice(1))),
    resizes: stats(samples.flatMap(({ resizes }) => resizes)),
    pointers: stats(samples.flatMap(({ pointers }) => pointers)),
  });
  const timings = { single: summary(runs.single), dashboard: summary(runs.dashboard) };
  const result = {
    schema: 1,
    date: new Date().toISOString(),
    commit: commit(),
    environment: {
      ...machine(),
      browser: await browser.version(),
      viewport: { width: 1100, height: 700 },
      dpr: 2,
      herceg: packageVersion("herceg"),
    },
    method:
      "Production esbuild bundle; Canvas; five tables of three series of 2,000 points (30,000 points); 1000x600 CSS px; single: the five lines in one panel; dashboard: columns [2, 1] of rows [2, 1] and [1, 1] (four titled panels) with an inset over the first showing 400..600 with an indicator; mounts: createChart plus a synchronous render, 19 per page after the first; resizes: 40 synchronous renders alternating 900 and 1000 px wide; pointers: 120 pointer moves across the panels, each the event's synchronous time plus the chart's part of the next frame (from the frame's timestamp to a callback requested after the chart's); five fresh pages per shape, alternating; no competitor timings",
    timings,
    samples: runs,
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(timings)}\n`);
} finally {
  await browser.close();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
