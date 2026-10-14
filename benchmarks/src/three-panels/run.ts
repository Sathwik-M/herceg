// Run from the repo root: node --experimental-strip-types benchmarks/src/three-panels/run.ts --out PATH
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { chromium } from "playwright";
import { HERCEG_ALIAS } from "../runner/build.ts";
import { commit, machine, packageVersion } from "../runner/environment.ts";
import type { Sample } from "./page.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("--out: expected a result path; give --out PATH");
const output = resolve(values.out);
const directory = mkdtempSync(join(dirname(output), "three-panels-"));
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
      : '<div id="chart" style="width:1000px;height:500px"></div><script type="module" src="/page.js"></script>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 650 },
    deviceScaleFactor: 1,
  });
  const cdp = await page.context().newCDPSession(page);
  const memory = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return cdp.send("Runtime.getHeapUsage");
  };
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("benchmark server has no port");
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => window.threePanels);
  const before = await memory();
  await page.evaluate(() => window.threePanels.mount());
  const live = await memory();
  const samples: Sample[] = [];
  for (let i = 0; i < 5; i++) samples.push(await page.evaluate(() => window.threePanels.sample()));
  const after = await memory();
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.threePanels.sample());
  const stress = await memory();
  const counts = await page.evaluate(() => window.threePanels.counts());
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return extension ? gl!.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  await page.evaluate(() => window.threePanels.destroy());
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const destroyed = await memory();
  const stats = (given: number[]) => {
    const sorted = [...given].sort((a, b) => a - b);
    return {
      p50: sorted[Math.floor(sorted.length * 0.5)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
      p99: sorted[Math.floor(sorted.length * 0.99)]!,
    };
  };
  const result = {
    schema: 1,
    date: new Date().toISOString(),
    commit: commit(),
    environment: {
      ...machine(),
      browser: await browser.version(),
      gpu,
      viewport: { width: 1100, height: 650 },
      dpr: 1,
      herceg: packageVersion("herceg"),
    },
    method:
      "Production esbuild bundle; Canvas CPU; two separate tables of 50,000 points each; 1000x500 CSS px; radius 1.5px; 30 warmup turns; 5 samples of 120 turns of panel a; rAF pacing; draws measure setter plus synchronous render() (JavaScript including painting, excluding rAF wait); frame intervals include pacing; memory is CDP Runtime.getHeapUsage after forced GC; 600 further turns test retained storage; no competitor timings",
    sourceBytes: 2 * 3 * 50_000 * 8,
    estimatedCanvasBytes: {
      main: 4 * 1000 * 500,
      panels:
        4 *
        samples[0]!.panels.reduce(
          (sum, plot) => sum + Math.ceil(plot.width) * Math.ceil(plot.height),
          0,
        ),
    },
    memory: { before, live, after, stress, destroyed },
    counts,
    timings: {
      draws: stats(samples.flatMap(({ draws }) => draws)),
      frames: stats(samples.flatMap(({ frames }) => frames)),
    },
    samples,
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ timings: result.timings, memory: result.memory, counts })}\n`,
  );
} finally {
  await browser.close();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
