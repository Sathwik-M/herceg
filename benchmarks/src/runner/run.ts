// Browser benchmark runner. See benchmarks/README.md for methodology.
//
//   npm run bench -- [--lib echarts,uplot] [--scenario line-small-init,...]
//                    [--filter line-] [--out results/name.json] [--headless]
//                    [--sample-scale 0.5] [--timeout 120]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BrowserContext, type CDPSession, chromium, type Page } from "playwright";
import type { Bench, Metric, PageResult } from "../page/harness.ts";
import { SCENARIOS, type Scenario } from "../scenarios.ts";
import { buildPage, ROOT, serve } from "./build.ts";
import { COMPARED, commit, machine, PACKAGES, packageVersion, RUNTIMES } from "./environment.ts";
import { type Summary, summarize } from "./stats.ts";

const { values: args } = parseArgs({
  options: {
    lib: { type: "string" },
    scenario: { type: "string" },
    filter: { type: "string" },
    out: { type: "string" },
    headless: { type: "boolean", default: false },
    "sample-scale": { type: "string", default: "1" },
    /** Seconds before a library's scenario is abandoned; overrides scenario timeouts. */
    timeout: { type: "string" },
  },
});

const VIEWPORT = { width: 1280, height: 1400 };
const DEVICE_SCALE_FACTOR = 2;
const HOVER_SPACING_MS = 70;
const COMMON_ARGS = [
  "--js-flags=--expose-gc",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];
// Latency scenarios produce frames as fast as work allows; paced ingestion
// scenarios keep vsync so frame intervals mean what users see.
const LATENCY_ARGS = [...COMMON_ARGS, "--disable-frame-rate-limit", "--disable-gpu-vsync"];
const REALTIME_ARGS = COMMON_ARGS;

const libraries = args.lib ? args.lib.split(",") : COMPARED;
const sampleScale = Number(args["sample-scale"]);
const scenarios = SCENARIOS.filter(
  (s) =>
    (!args.scenario || args.scenario.split(",").includes(s.id)) &&
    (!args.filter || s.id.includes(args.filter)),
).map((s) => ({
  ...s,
  samples: Math.max(1, Math.round(s.samples * sampleScale)),
  warmup: Math.round(s.warmup * Math.min(1, sampleScale)),
  // The limit actually applied, so recorded scenarios show it.
  timeout: Number(args.timeout ?? s.timeout ?? 600),
}));

/** Waits for `promise` at most `ms`, ignoring its outcome. */
function bounded(promise: Promise<unknown>, ms = 10_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

interface ResultRow {
  scenario: string;
  library: string;
  supported: boolean;
  reason?: string;
  metrics: Record<string, Metric & { summary: Summary }>;
}

declare global {
  interface Window {
    bench: Bench;
  }
}

async function heapBytes(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
    embedderHeapUsedSize?: number;
    backingStorageSize?: number;
  };
  // V8 heap + Blink (Oilpan) heap + ArrayBuffer backing stores. Typed arrays
  // live in backing stores, so leaving them out would hide columnar data.
  return {
    js: usage.usedSize,
    embedder: usage.embedderHeapUsedSize ?? 0,
    backing: usage.backingStorageSize ?? 0,
    total: usage.usedSize + (usage.embedderHeapUsedSize ?? 0) + (usage.backingStorageSize ?? 0),
  };
}

async function runMemory(page: Page, cdp: CDPSession, s: Scenario): Promise<PageResult> {
  const names = [
    "retainedBytes",
    "sourceBytes",
    "jsHeapBytes",
    "domHeapBytes",
    "arrayBufferBytes",
    "canvasBytes",
    "leakedBytes",
  ] as const;
  const metrics: Record<string, Metric> = Object.fromEntries(
    names.map((name) => [name, { unit: "bytes", samples: [] }]),
  );
  metrics.domNodes = { unit: "count", samples: [] };
  const push = (name: string, value: number) => metrics[name]!.samples.push(value);
  for (let i = 0; i < s.samples; i++) {
    const baseline = await heapBytes(cdp);
    await page.evaluate((scenario) => window.bench.prepareData(scenario), s);
    const withData = await heapBytes(cdp);
    const mounted = await page.evaluate((scenario) => window.bench.mount(scenario), s);
    if (!mounted.supported) return { supported: false, reason: mounted.reason, metrics: {} };
    const withCharts = await heapBytes(cdp);
    const footprint = await page.evaluate(() => window.bench.footprint());
    // Unmount releases the charts and the source data.
    await page.evaluate(() => window.bench.unmount());
    const released = await heapBytes(cdp);
    push("sourceBytes", withData.total - baseline.total);
    push("retainedBytes", withCharts.total - withData.total);
    push("jsHeapBytes", withCharts.js - withData.js);
    push("domHeapBytes", withCharts.embedder - withData.embedder);
    push("arrayBufferBytes", withCharts.backing - withData.backing);
    push("canvasBytes", footprint.canvasBytes);
    push("domNodes", footprint.domNodes);
    push("leakedBytes", released.total - baseline.total);
  }
  return { supported: true, metrics };
}

async function runHover(page: Page, s: Scenario): Promise<PageResult> {
  const mounted = await page.evaluate((scenario) => window.bench.mount(scenario), s);
  if (!mounted.supported) return { supported: false, reason: mounted.reason, metrics: {} };
  // Aim at real data points so every library has something to hit.
  const targets = await page.evaluate(
    ([scenario, count]) => window.bench.hoverTargets(scenario, count),
    [s, s.warmup + s.samples] as const,
  );
  const latency: Metric = { unit: "ms", samples: [] };
  for (const [i, target] of targets.entries()) {
    // Space moves out so throttled hover handlers (Plotly: 50 ms) run for
    // every event instead of being skipped.
    await page.waitForTimeout(HOVER_SPACING_MS);
    await page.evaluate(() => window.bench.armPointer());
    await page.mouse.move(target.x, target.y);
    const ms = await page.evaluate(() => window.bench.pointerLatency());
    if (i >= s.warmup) latency.samples.push(ms);
  }
  await page.evaluate(() => window.bench.unmount());
  return { supported: true, metrics: { pointerToFrame: latency } };
}

async function main() {
  for (const library of libraries) await buildPage(library);
  const { server, origin } = await serve();
  const launch = async (chromeArgs: string[]) => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: args.headless,
      args: chromeArgs,
    });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    return { browser, context };
  };
  let latency = await launch(LATENCY_ARGS);
  const browserVersion = latency.browser.version();
  let realtime = scenarios.some((s) => s.operation === "ingest")
    ? await launch(REALTIME_ARGS)
    : latency;

  const rows: ResultRow[] = [];
  const renderers: Record<string, unknown> = {};
  let gpu = "unknown";
  let userAgent = "";

  /**
   * Runs one scenario in a fresh page, from page creation to measurement,
   * within the scenario's time limit. Resources it created are left in
   * `opened` for the caller to clean up.
   */
  const measure = async (
    context: BrowserContext,
    library: string,
    s: Scenario,
    opened: { page?: Page; cdp?: CDPSession },
  ): Promise<PageResult> => {
    const page = await context.newPage();
    opened.page = page;
    await page.goto(`${origin}/${library}.html`);
    await page.waitForFunction(() => window.bench !== undefined);
    renderers[library] ??= await page.evaluate(() => window.bench.renderer);
    if (gpu === "unknown") gpu = await page.evaluate(() => window.bench.gpu());
    userAgent ||= await page.evaluate(() => navigator.userAgent);
    const cdp = await context.newCDPSession(page);
    opened.cdp = cdp;
    if (s.operation === "memory") return runMemory(page, cdp, s);
    if (s.operation === "hover") return runHover(page, s);
    return page.evaluate((scenario) => window.bench.run(scenario), s);
  };

  let complete = false;
  try {
    for (const library of libraries) {
      for (const s of scenarios) {
        const ingest = s.operation === "ingest";
        const { context } = ingest ? realtime : latency;
        const started = performance.now();
        const opened: { page?: Page; cdp?: CDPSession } = {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: PageResult;
        try {
          result = await Promise.race([
            measure(context, library, s, opened),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timed out after ${s.timeout} s`)),
                (s.timeout ?? 600) * 1000,
              );
            }),
          ]);
        } catch (error) {
          result = {
            supported: false,
            reason: `error: ${(error as Error).message.split("\n")[0]}`,
            metrics: {},
          };
        } finally {
          clearTimeout(timer);
          // A page still running a timed-out scenario, or a crashed one, may
          // never answer; cleaning it up must not stall the run.
          if (opened.cdp) await bounded(opened.cdp.detach());
          if (opened.page) await bounded(opened.page.close({ runBeforeUnload: false }));
        }
        if (result.reason?.startsWith("error")) {
          // A crashed or stuck page can leave its browser unable to open tabs.
          // Later scenarios get a fresh browser once the old one has exited;
          // closing it waits for Playwright to force-kill it if needed.
          const shared = realtime === latency;
          const failed = ingest ? realtime : latency;
          await failed.browser.close().catch(() => {});
          const fresh = await launch(ingest && !shared ? REALTIME_ARGS : LATENCY_ARGS);
          if (ingest && !shared) realtime = fresh;
          else {
            latency = fresh;
            if (shared) realtime = fresh;
          }
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
          supported: result.supported,
          reason: result.reason,
          metrics,
        });
        const headline = Object.entries(metrics)[0];
        const text = result.supported
          ? `${headline?.[0]} median ${headline?.[1].summary.median.toFixed(2)} ${headline?.[1].unit}`
          : `skipped (${result.reason})`;
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        console.log(`${library.padEnd(9)} ${s.id.padEnd(24)} ${text} [${seconds}s]`);
      }
    }

    complete = true;
  } finally {
    // Results gathered so far are written even if the run cannot continue.
    await latency.browser.close().catch(() => {});
    if (realtime !== latency) await realtime.browser.close().catch(() => {});
    server.close();
    writeResults({ rows, renderers, gpu, userAgent, browserVersion, complete });
  }
}

function writeResults(run: {
  rows: ResultRow[];
  renderers: Record<string, unknown>;
  gpu: string;
  userAgent: string;
  browserVersion: string;
  complete: boolean;
}) {
  const { rows, renderers, gpu, userAgent, browserVersion, complete } = run;
  const output = {
    schema: 1,
    date: new Date().toISOString(),
    commit: commit(),
    /** False when the run stopped early; the results cover what finished. */
    complete,
    method: {
      timing:
        "operation start until rendering finished and the next frame was produced (rAF + MessageChannel); frame rate limit disabled except for ingest scenarios",
      memory:
        "CDP Runtime.getHeapUsage after forced GC: V8 heap + Blink heap + ArrayBuffer backing stores",
      sampleScale,
    },
    environment: {
      ...machine(),
      browser: `Chrome ${browserVersion}`,
      userAgent,
      gpu,
      headless: args.headless,
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      chromeArgs: { latency: LATENCY_ARGS, realtime: REALTIME_ARGS },
    },
    libraries: Object.fromEntries(
      libraries.map((id) => [
        id,
        {
          package: PACKAGES[id] ?? id,
          version: packageVersion(PACKAGES[id] ?? id),
          renderer: renderers[id],
          runtime: Object.fromEntries(
            (RUNTIMES[id] ?? []).map((name) => [name, packageVersion(name)]),
          ),
        },
      ]),
    ),
    scenarios: Object.fromEntries(scenarios.map((s) => [s.id, s])),
    results: rows,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = args.out
    ? resolve(ROOT, args.out)
    : join(ROOT, "..", "tmp", "benchmarks", `bench-${stamp}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\nWrote ${out}`);
}

await main();
