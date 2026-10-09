// Grid benchmark runner. See benchmarks/README.md ("Grids") for methodology.
//
//   npm run bench:grid -- [--lib ag-grid,glide] [--size 10k,100k] [--filter sort-]
//                         [--scenario grid-10k-mount,...] [--out results/grid.json]
//                         [--headless] [--sample-scale 0.5] [--timeout 120] [--dpr 2]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright";
import { random } from "../datasets.ts";
import type { Metric } from "../page/harness.ts";
import { buildPage, ROOT, serve } from "../runner/build.ts";
import {
  bounded,
  committedBytes,
  heapBytes,
  LATENCY_ARGS,
  REALTIME_ARGS,
} from "../runner/chrome.ts";
import { commit, machine, packageVersion } from "../runner/environment.ts";
import { type Summary, summarize } from "../runner/stats.ts";
import { GRID_HEIGHT, GRID_WIDTH } from "./adapter.ts";
import type { GridBench, GridResult } from "./harness.ts";
import { GRID_SCENARIOS, type GridScenario, SIZES } from "./scenarios.ts";

/** Adapters in src/grid/adapters, with the npm package measured and the runtime it depends on. */
const LIBRARIES: Record<string, { package: string; runtime: string[] }> = {
  herceg: { package: "herceg", runtime: [] },
  "herceg-react": { package: "@herceg/react", runtime: ["react", "react-dom"] },
  "tanstack-table": {
    package: "@tanstack/react-table",
    runtime: ["@tanstack/react-virtual", "react", "react-dom"],
  },
  "ag-grid": { package: "ag-grid-community", runtime: [] },
  glide: { package: "@glideapps/glide-data-grid", runtime: ["react", "react-dom"] },
};

const { values: args } = parseArgs({
  options: {
    lib: { type: "string" },
    size: { type: "string" },
    scenario: { type: "string" },
    filter: { type: "string" },
    out: { type: "string" },
    headless: { type: "boolean", default: false },
    "sample-scale": { type: "string", default: "1" },
    /** Seconds before a library's scenario is abandoned; overrides scenario timeouts. */
    timeout: { type: "string" },
    /** Device pixel ratio: 1 by default, 2 for high-density displays. */
    dpr: { type: "string", default: "1" },
    /** Seeds the order libraries run in within each scenario. */
    "order-seed": { type: "string", default: "1" },
    /** Seeds the fixture's values. */
    seed: { type: "string", default: "1" },
  },
});

const VIEWPORT = { width: 1280, height: 720 };
const deviceScaleFactor = Number(args.dpr);
const sampleScale = Number(args["sample-scale"]);
const libraries = (args.lib ? args.lib.split(",") : Object.keys(LIBRARIES)).filter((id) => {
  if (!LIBRARIES[id]) throw new Error(`unknown grid library ${id}`);
  return true;
});
const seed = Number(args.seed);
const sizes = args.size?.split(",");
for (const size of sizes ?? [])
  if (!(size in SIZES)) throw new Error(`--size must be among ${Object.keys(SIZES).join(", ")}`);
const scenarios = GRID_SCENARIOS.filter(
  (s) =>
    (!sizes || sizes.includes(s.sizeName)) &&
    (!args.scenario || args.scenario.split(",").includes(s.id)) &&
    (!args.filter || s.id.includes(args.filter)),
).map((s) => ({
  ...s,
  samples: Math.max(1, Math.round(s.samples * sampleScale)),
  warmup: Math.round(s.warmup * Math.min(1, sampleScale)),
  timeout: Number(args.timeout ?? s.timeout ?? 600),
  seed,
}));

/** Scenarios that measure frame pacing run with vsync; the rest with the frame rate limit off. */
const paced = (s: GridScenario) =>
  s.operation === "scroll-trace" || s.operation === "append" || s.operation === "update";

interface ResultRow {
  scenario: string;
  library: string;
  status: GridResult["status"] | "error";
  reason?: string;
  metrics: Record<string, Metric & { summary: Summary }>;
}

declare global {
  interface Window {
    gridBench: GridBench;
  }
}

/**
 * One memory sample, in its own page so nothing from an earlier sample
 * remains: heap readings between the steps of `GridBench.memory`. "Reserved"
 * readings are V8's committed heap (plus the Blink heap and backing stores)
 * without collecting garbage, before and after a step: how much the step
 * made the heap grow, not its peak.
 */
async function memorySample(
  page: Page,
  cdp: CDPSession,
  s: GridScenario,
): Promise<Record<string, number>> {
  const step = (body: () => unknown) => page.evaluate(body);
  const baseline = await heapBytes(cdp);
  const columnBytes = await page.evaluate((scenario) => window.gridBench.memory.data(scenario), s);
  const data = await heapBytes(cdp);
  await step(() => window.gridBench.memory.reference());
  const checked = await heapBytes(cdp);
  await step(() => window.gridBench.memory.input());
  const input = await heapBytes(cdp);
  const beforeMount = await committedBytes(cdp);
  await step(() => window.gridBench.memory.mount());
  const afterMount = await committedBytes(cdp);
  const mounted = await heapBytes(cdp);
  const footprint = await page.evaluate(() => window.gridBench.memory.footprint());
  const beforeSort = await committedBytes(cdp);
  await step(() => window.gridBench.memory.sort());
  const afterSort = await committedBytes(cdp);
  const sorted = await heapBytes(cdp);
  await step(() => window.gridBench.memory.verify());
  await step(() => window.gridBench.memory.destroy());
  const destroyed = await heapBytes(cdp);
  // Growth per mount is the difference between two rounds of mounts: a
  // library that keeps its last grid until the next one retains the same
  // after both.
  const cycles = 5;
  await page.evaluate((count) => window.gridBench.memory.cycles(count), cycles);
  const cycled = await heapBytes(cdp);
  await page.evaluate((count) => window.gridBench.memory.cycles(count), cycles);
  const cycledTwice = await heapBytes(cdp);
  await step(() => window.gridBench.memory.release());
  const released = await heapBytes(cdp);
  return {
    columnBytes,
    sourceBytes: data.total - baseline.total,
    inputBytes: input.total - checked.total,
    retainedBytes: mounted.total - input.total,
    mountReservedBytes: afterMount - beforeMount,
    sortRetainedBytes: sorted.total - mounted.total,
    sortReservedBytes: afterSort - beforeSort,
    destroyLeakBytes: destroyed.total - input.total,
    cycleRetainedBytes: cycled.total - input.total,
    cycleGrowthBytes: (cycledTwice.total - cycled.total) / cycles,
    leakedBytes: released.total - baseline.total,
    canvasBytes: footprint.canvasBytes,
    domNodes: footprint.domNodes,
  };
}

/** Wheel scrolling: 50 px per event every 16 ms (about 3,000 px/s). */
const WHEEL_STEP = 50;
const WHEEL_INTERVAL_MS = 16;

/**
 * Dispatches wheel events over the grid while the page's wheel trace asks
 * for them (`wheelTrial` is set), on a fixed schedule: events go through the
 * DevTools protocol without waiting for the page, so a busy grid does not
 * slow the input down (the browser coalesces events the page has not taken
 * yet, as with real input). When the trial ends, the driver stops, waits for
 * every event it sent to be handled, and tells the page (`wheelStopped`),
 * which resets the grid only then.
 */
async function driveWheel(page: Page, cdp: CDPSession, done: Promise<unknown>): Promise<void> {
  let finished = false;
  const finish = () => {
    finished = true;
  };
  done.then(finish, finish);
  const at = { x: GRID_WIDTH / 2, y: GRID_HEIGHT / 2 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  let active: number | null = null;
  const sent = new Set<Promise<unknown>>();
  const timer = setInterval(() => {
    if (active === null) return;
    const event = cdp
      .send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...at,
        deltaX: 0,
        deltaY: WHEEL_STEP,
      })
      .catch(() => {});
    sent.add(event);
    event.then(() => sent.delete(event));
  }, WHEEL_INTERVAL_MS);
  try {
    while (!finished) {
      const trial = await page.evaluate(() => window.gridBench.wheelTrial);
      if (active !== null && trial !== active) {
        const stopped = active;
        active = null;
        await Promise.all(sent);
        await page.evaluate((id) => window.gridBench.wheelStopped(id), stopped);
      }
      active = trial;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    clearInterval(timer);
  }
}

/** Library order within a scenario, shuffled so drift over a run does not favor one library. */
function shuffled(ids: string[], next: () => number): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function main() {
  for (const library of libraries) await buildPage(library, "grid");
  const { server, origin } = await serve();
  const launch = async (realtime: boolean) => {
    const browser: Browser = await chromium.launch({
      channel: "chrome",
      headless: args.headless,
      args: realtime ? REALTIME_ARGS : LATENCY_ARGS,
    });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
    return { browser, context };
  };
  let latency = await launch(false);
  const browserVersion = latency.browser.version();
  let realtime = scenarios.some(paced) ? await launch(true) : undefined;

  const rows: ResultRow[] = [];
  const configurations: Record<string, Pick<GridBench, "renderer" | "processing">> = {};
  let gpu = "unknown";
  let userAgent = "";
  const order = random(Number(args["order-seed"]));

  const measure = async (
    context: BrowserContext,
    library: string,
    s: GridScenario,
    opened: { page?: Page; cdp?: CDPSession },
  ): Promise<GridResult> => {
    let page = await context.newPage();
    opened.page = page;
    await page.goto(`${origin}/grid-${library}.html`);
    await page.waitForFunction(() => window.gridBench !== undefined);
    configurations[library] ??= await page.evaluate(() => ({
      renderer: window.gridBench.renderer,
      processing: window.gridBench.processing,
    }));
    if (gpu === "unknown") gpu = await page.evaluate(() => window.gridBench.gpu());
    userAgent ||= await page.evaluate(() => navigator.userAgent);
    if (s.operation === "memory") {
      const metrics: Record<string, Metric> = {};
      for (let i = 0; i < s.samples; i++) {
        if (i > 0) {
          await page.close();
          opened.page = page = await context.newPage();
          await page.goto(`${origin}/grid-${library}.html`);
          await page.waitForFunction(() => window.gridBench !== undefined);
        }
        opened.cdp = await context.newCDPSession(page);
        for (const [name, value] of Object.entries(await memorySample(page, opened.cdp, s))) {
          metrics[name] ??= { unit: name === "domNodes" ? "count" : "bytes", samples: [] };
          metrics[name].samples.push(value);
        }
        await opened.cdp.detach();
        opened.cdp = undefined;
      }
      return { status: "measured", metrics };
    }
    const result = page.evaluate((scenario) => window.gridBench.run(scenario), s);
    if (s.operation === "scroll-trace" && s.direction === "wheel") {
      opened.cdp = await context.newCDPSession(page);
      await driveWheel(page, opened.cdp, result);
    }
    return result;
  };

  let complete = false;
  try {
    for (const s of scenarios) {
      for (const library of shuffled(libraries, order)) {
        const isPaced = paced(s);
        const { context } = isPaced ? realtime! : latency;
        const started = performance.now();
        const opened: { page?: Page; cdp?: CDPSession } = {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result:
          | GridResult
          | { status: "error"; reason: string; metrics: Record<string, Metric> };
        try {
          result = await Promise.race([
            measure(context, library, s, opened),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timed out after ${s.timeout} s`)),
                s.timeout * 1000,
              );
            }),
          ]);
        } catch (error) {
          const message = (error as Error).message.split("\n")[0]!;
          // Memory steps report a wrong frame as an error from inside the page.
          const wrong = /incorrect: (.*)/.exec(message);
          result = wrong
            ? { status: "incorrect", reason: wrong[1]!, metrics: {} }
            : { status: "error", reason: message, metrics: {} };
        } finally {
          clearTimeout(timer);
          // A page still running a timed-out scenario, or a crashed one, may
          // never answer; cleaning it up must not stall the run.
          if (opened.cdp) await bounded(opened.cdp.detach());
          if (opened.page) await bounded(opened.page.close({ runBeforeUnload: false }));
        }
        if (result.status === "error") {
          // A crashed or stuck page can leave its browser unable to open tabs.
          const failed = isPaced ? realtime! : latency;
          await failed.browser.close().catch(() => {});
          if (isPaced) realtime = await launch(true);
          else latency = await launch(false);
        }
        const metrics = Object.fromEntries(
          Object.entries(result.metrics).map(([name, m]) => [
            name,
            { ...m, summary: summarize(m.samples) },
          ]),
        );
        rows.push({
          scenario: s.id,
          library,
          status: result.status,
          reason: result.reason,
          metrics,
        });
        const headline = Object.entries(metrics)[0];
        const text =
          result.status === "measured"
            ? `${headline?.[0]} median ${headline?.[1].summary.median.toFixed(2)} ${headline?.[1].unit}`
            : `${result.status} (${result.reason})`;
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        console.log(`${library.padEnd(15)} ${s.id.padEnd(32)} ${text} [${seconds}s]`);
      }
    }
    complete = true;
  } finally {
    await latency.browser.close().catch(() => {});
    await realtime?.browser.close().catch(() => {});
    server.close();
    writeResults({ rows, configurations, gpu, userAgent, browserVersion, complete });
  }
}

function writeResults(run: {
  rows: ResultRow[];
  configurations: Record<string, Pick<GridBench, "renderer" | "processing">>;
  gpu: string;
  userAgent: string;
  browserVersion: string;
  complete: boolean;
}) {
  const output = {
    schema: 1,
    suite: "grid",
    date: new Date().toISOString(),
    commit: commit(),
    /** False when the run stopped early; the results cover what finished. */
    complete: run.complete,
    method: {
      timing:
        "operation start until the end of the first frame whose visible rows, cells, selection, and row count match the reference, read just before the frame paints (ResizeObserver callback) and timed at a MessageChannel message posted then; raw times, including the check, whose cost is recorded as checkTime; frame rate limit disabled except for scroll traces, appends, and updates, which run with vsync",
      memory:
        "CDP Runtime.getHeapUsage after forced GC: V8 heap + Blink heap + ArrayBuffer backing stores, one fresh page per sample; reserved = committed heap growth over a step without GC (not a peak)",
      sampleScale,
      orderSeed: Number(args["order-seed"]),
      seed,
    },
    environment: {
      ...machine(),
      browser: `Chrome ${run.browserVersion}`,
      userAgent: run.userAgent,
      gpu: run.gpu,
      headless: args.headless,
      viewport: VIEWPORT,
      deviceScaleFactor,
      grid: {
        width: GRID_WIDTH,
        height: GRID_HEIGHT,
        rowHeight: 28,
        headerHeight: 32,
        columnWidth: 120,
      },
      browserSettings: { latency: LATENCY_ARGS, realtime: REALTIME_ARGS },
      playwright: packageVersion("playwright"),
    },
    libraries: Object.fromEntries(
      libraries.map((id) => {
        const { package: name, runtime } = LIBRARIES[id]!;
        return [
          id,
          {
            package: name,
            version: packageVersion(name),
            ...run.configurations[id],
            runtime: Object.fromEntries(
              runtime.map((dependency) => [dependency, packageVersion(dependency)]),
            ),
          },
        ];
      }),
    ),
    scenarios: Object.fromEntries(scenarios.map((s) => [s.id, s])),
    results: run.rows,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = args.out
    ? resolve(ROOT, args.out)
    : join(ROOT, "..", "tmp", "benchmarks", `grid-${stamp}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\nWrote ${out}`);
}

await main();
