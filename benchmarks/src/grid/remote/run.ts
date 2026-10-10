// Remote grid benchmark: Herceg's remote grid against AG Grid Community's
// infinite row model over the same synthetic ten-million-row source (see
// page.ts and benchmarks/README.md, "Remote grids").
//
//   npm run bench:grid-remote -- [--lib herceg,ag-grid] [--latency 0,20,100]
//                                [--jumps 40] [--out results/grid-remote.json] [--headless]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as esbuild from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { random } from "../../datasets.ts";
import { HERCEG_ALIAS, ROOT, serve } from "../../runner/build.ts";
import { heapBytes, LATENCY_ARGS, REALTIME_ARGS } from "../../runner/chrome.ts";
import { commit, machine, packageVersion } from "../../runner/environment.ts";
import { type Summary, summarize } from "../../runner/stats.ts";

const LIBRARIES: Record<string, string> = { herceg: "herceg", "ag-grid": "ag-grid-community" };

const { values: args } = parseArgs({
  options: {
    lib: { type: "string" },
    latency: { type: "string", default: "0,20,100" },
    jumps: { type: "string", default: "40" },
    /** Milliseconds jumps wait to settle (both grids): the default 50, and 0. */
    settle: { type: "string", default: "50,0" },
    out: { type: "string" },
    headless: { type: "boolean", default: false },
    seed: { type: "string", default: "1" },
  },
});

const libraries = args.lib ? args.lib.split(",") : Object.keys(LIBRARIES);
for (const id of libraries) if (!LIBRARIES[id]) throw new Error(`unknown library ${id}`);
const latencies = args.latency.split(",").map(Number);
const settles = args.settle.split(",").map(Number);
const JUMPS = Number(args.jumps);
const WARMUP = 5;
/** Scroll traces: rows a second (28 px rows: about 2,800 and 28,000 px/s), for two seconds each, three times. */
const TRACES = [
  { name: "steady", speed: 100 },
  { name: "fast", speed: 1000 },
];
const TRACE_MS = 2000;
const TRACE_TRIALS = 3;
const MEMORY_JUMPS = 50;
const ROWS = 10_000_000;
const VIEWPORT = { width: 1280, height: 720 };

declare global {
  interface Window {
    remoteBench: {
      mount(library: string, latency: number, settle?: number): Promise<number>;
      jump(row: number): Promise<{ time: number; requests: number }>;
      trace(
        from: number,
        speed: number,
        ms: number,
      ): Promise<{
        seconds: number;
        started: number;
        aborted: number;
        frames: number;
        incomplete: number;
      }>;
      heldBytes(): number;
      domNodes(): number;
      destroy(): void;
    };
  }
}

interface Metric {
  unit: "ms" | "count" | "bytes" | "ratio" | "per second";
  samples: number[];
  summary?: Summary;
}

async function build() {
  await esbuild.build({
    stdin: {
      contents: `import "./src/grid/remote/page.ts";`,
      resolveDir: ROOT,
      sourcefile: "grid-remote-entry.ts",
      loader: "ts",
    },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    outfile: join(ROOT, ".build", "grid-remote.js"),
    define: { "process.env.NODE_ENV": '"production"' },
    alias: HERCEG_ALIAS,
    logLevel: "warning",
  });
}

async function open(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(`${origin}/grid-remote.html`);
  await page.waitForFunction(() => window.remoteBench !== undefined);
  return page;
}

async function main() {
  await build();
  const { server, origin } = await serve();
  const launch = (realtime: boolean) =>
    chromium.launch({
      channel: "chrome",
      headless: args.headless,
      args: realtime ? REALTIME_ARGS : LATENCY_ARGS,
    });
  const fast = await launch(false);
  const paced = await launch(true);
  const pick = random(Number(args.seed));
  const rows = Array.from({ length: WARMUP + JUMPS }, () => Math.floor(pick() * (ROWS - 50)));
  // Where each trace trial starts, the same for every library and latency.
  const origins = Array.from({ length: TRACE_TRIALS }, () => Math.floor(pick() * (ROWS / 2)));
  // Where the memory rounds jump to, as many as they say whatever `--jumps` is.
  const places = Array.from({ length: MEMORY_JUMPS }, () => Math.floor(pick() * (ROWS - 50)));
  const results: { library: string; latency: number | null; metrics: Record<string, Metric> }[] =
    [];
  for (const library of libraries) {
    for (const latency of latencies) {
      const metrics: Record<string, Metric> = { mount: { unit: "ms", samples: [] } };
      // Jumps, with the frame rate limit off: times are the grids' own.
      for (const settle of settles) {
        const suffix = settle === 50 ? "" : `Settle${settle}`;
        const times: Metric = { unit: "ms", samples: [] };
        const requests: Metric = { unit: "count", samples: [] };
        const page = await open(fast, origin);
        const mount = await page.evaluate(
          ([l, ms, wait]) => window.remoteBench.mount(l, ms, wait),
          [library, latency, settle] as const,
        );
        if (settle === 50) metrics.mount!.samples.push(mount);
        for (const [i, row] of rows.entries()) {
          const jump = await page.evaluate((r) => window.remoteBench.jump(r), row);
          if (i < WARMUP) continue;
          times.samples.push(jump.time);
          requests.samples.push(jump.requests);
        }
        await page.context().close();
        metrics[`jump${suffix}`] = times;
        metrics[`jumpRequests${suffix}`] = requests;
      }
      // Traces, with vsync: requests a second of scrolling, and frames not yet loaded.
      // At each settle time: AG Grid's debounce delays every block, Herceg's only jumps.
      for (const settle of settles)
        for (const { name, speed } of TRACES) {
          const suffix = settle === 50 ? "" : `Settle${settle}`;
          const requests: Metric = { unit: "per second", samples: [] };
          const aborted: Metric = { unit: "per second", samples: [] };
          const incomplete: Metric = { unit: "ratio", samples: [] };
          for (let trial = 0; trial < TRACE_TRIALS; trial++) {
            const traced = await open(paced, origin);
            await traced.evaluate(([l, ms, wait]) => window.remoteBench.mount(l, ms, wait), [
              library,
              latency,
              settle,
            ] as const);
            const from = origins[trial]!;
            await traced.evaluate((r) => window.remoteBench.jump(r), from);
            const trace = await traced.evaluate(
              ([f, s, ms]) => window.remoteBench.trace(f, s, ms),
              [from, speed, TRACE_MS] as const,
            );
            requests.samples.push(trace.started / trace.seconds);
            aborted.samples.push(trace.aborted / trace.seconds);
            incomplete.samples.push(trace.incomplete / trace.frames);
            await traced.context().close();
          }
          metrics[`${name}Requests${suffix}`] = requests;
          metrics[`${name}Aborted${suffix}`] = aborted;
          metrics[`${name}IncompleteFrames${suffix}`] = incomplete;
        }
      for (const metric of Object.values(metrics)) metric.summary = summarize(metric.samples);
      results.push({ library, latency, metrics });
      const line = (id: string) => {
        const s = metrics[id]!.summary!;
        return `${id} ${s.median.toFixed(id.includes("Frames") ? 2 : 1)} (p95 ${s.p95.toFixed(1)})`;
      };
      console.log(
        `${library} @${latency} ms: ${Object.keys(metrics)
          .filter((id) => id !== "mount")
          .map(line)
          .join(", ")}`,
      );
    }
    // Memory: heap after scrolling to fifty places, over the page's before mounting.
    const page = await open(fast, origin);
    const cdp = await page.context().newCDPSession(page);
    const before = await heapBytes(cdp);
    // A grid mounted and destroyed first, so code loaded once is not counted as held.
    await page.evaluate((l) => window.remoteBench.mount(l, 0), library);
    await page.evaluate(() => window.remoteBench.destroy());
    const empty = await heapBytes(cdp);
    const round = async () => {
      await page.evaluate((l) => window.remoteBench.mount(l, 0), library);
      for (const row of places) await page.evaluate((r) => window.remoteBench.jump(r), row);
      const after = await heapBytes(cdp);
      const held = await page.evaluate(() => window.remoteBench.heldBytes());
      const nodes = await page.evaluate(() => window.remoteBench.domNodes());
      await page.evaluate(() => window.remoteBench.destroy());
      return { after, held, nodes, destroyed: await heapBytes(cdp) };
    };
    const { after, held, nodes, destroyed } = await round();
    // Four more rounds: what each leaves beyond the one before, whose median
    // is what a round leaks (single differences swing by a few hundred KiB).
    const ends = [destroyed.total];
    for (let i = 0; i < 4; i++) ends.push((await round()).destroyed.total);
    const growth = ends.slice(1).map((end, i) => end - ends[i]!);
    const leak = summarize(growth).median;
    await page.context().close();
    const memory: Record<string, Metric> = {
      retainedBytes: { unit: "bytes", samples: [after.total - empty.total] },
      cacheBytes: { unit: "bytes", samples: Number.isNaN(held) ? [] : [held] },
      domNodes: { unit: "count", samples: [nodes] },
      destroyedBytes: { unit: "bytes", samples: [destroyed.total - empty.total] },
      roundGrowthBytes: { unit: "bytes", samples: growth },
      pageBytes: { unit: "bytes", samples: [empty.total - before.total] },
    };
    for (const metric of Object.values(memory)) metric.summary = summarize(metric.samples);
    results.push({ library, latency: null, metrics: memory });
    console.log(
      `${library} memory: retained ${((after.total - empty.total) / 2 ** 20).toFixed(2)} MiB, cache ${(held / 1024).toFixed(0)} KiB, ${nodes} DOM nodes, after destroy ${((destroyed.total - empty.total) / 1024).toFixed(0)} KiB, each later round ${(leak / 1024).toFixed(0)} KiB more (median)`,
    );
  }
  const browserVersion = fast.version();
  await fast.close();
  await paced.close();
  server.close();
  const output = {
    date: new Date().toISOString(),
    commit: commit(),
    method: {
      source:
        "synthetic: 10,000,000 rows computed per request in the page (an id, a number, a category), nothing stored; each answer waits `latency` ms on a timer (also at 0)",
      jump: "after a pause (GC, a frame, 50 ms), from the scroll command (model.scrollTo / api.ensureIndexVisible) to the first frame in which that row is within a row of the viewport's top and every row covering the viewport is mounted in order showing its id, read just before the frame paints; frame rate limit off; seeded random rows over the whole range",
      trace:
        "the top row moved every frame at a speed in rows a second for 2 s (vsync on); requests started and aborted per second, and the share of frames in which some row in view was not loaded",
      memory:
        "CDP Runtime.getHeapUsage after forced GC (V8 + Blink heaps + ArrayBuffer backing stores) after mounting and jumping to 50 places, over the page with a grid mounted and destroyed once; then four more rounds (mount, 50 jumps, destroy): what each leaves beyond the one before",
      warmup: WARMUP,
      jumps: JUMPS,
      traceTrials: TRACE_TRIALS,
      seed: Number(args.seed),
    },
    environment: {
      ...machine(),
      browser: `Chrome ${browserVersion}`,
      headless: args.headless,
      viewport: VIEWPORT,
      grid: { width: 1200, height: 600, rowHeight: 28, headerHeight: 32 },
      browserSettings: { jumps: LATENCY_ARGS, traces: REALTIME_ARGS },
      playwright: packageVersion("playwright"),
    },
    libraries: Object.fromEntries(
      libraries.map((id) => [
        id,
        { package: LIBRARIES[id], version: packageVersion(LIBRARIES[id]!) },
      ]),
    ),
    results,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = args.out
    ? resolve(ROOT, args.out)
    : join(ROOT, "..", "tmp", "benchmarks", `grid-remote-${stamp}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\nWrote ${out}`);
}

await main();
