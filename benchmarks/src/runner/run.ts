// Browser benchmark runner. See benchmarks/README.md for methodology.
//
//   npm run bench -- [--lib echarts,uplot] [--scenario line-small-init,...]
//                    [--filter line-] [--out results/name.json] [--headless]
//                    [--sample-scale 0.5] [--timeout 120]
//                    [--browser chrome|firefox|webkit]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  firefox,
  type Page,
  webkit,
} from "playwright";
import type { Bench, Metric, PageResult } from "../page/harness.ts";
import { SCENARIOS, type Scenario } from "../scenarios.ts";
import { buildPage, ROOT, serve } from "./build.ts";
import { bounded, heapBytes, LATENCY_ARGS, REALTIME_ARGS } from "./chrome.ts";
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
    /** Installed Chrome, or Playwright's Firefox or WebKit build. */
    browser: { type: "string", default: "chrome" },
  },
});

const BROWSERS = ["chrome", "firefox", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];
if (!BROWSERS.includes(args.browser as BrowserName))
  throw new Error(`--browser must be one of ${BROWSERS.join(", ")}, not ${args.browser}`);
const browserName = args.browser as BrowserName;
/** Heap sizes come from Chrome's DevTools protocol; other browsers skip memory scenarios. */
const measuresMemory = browserName === "chrome";

const VIEWPORT = { width: 1280, height: 1400 };
const DEVICE_SCALE_FACTOR = 2;
const HOVER_SPACING_MS = 70;
// Firefox paints as soon as it can with a frame rate of 0 ("ASAP mode").
// WebKit has no such setting: its latencies include waiting for vsync.
const FIREFOX_LATENCY_PREFS = { "layout.frame_rate": 0 };

/** How each kind of scenario runs, recorded with the results. */
const BROWSER_SETTINGS = {
  chrome: { latency: LATENCY_ARGS, realtime: REALTIME_ARGS },
  firefox: { latency: FIREFOX_LATENCY_PREFS, realtime: {} },
  webkit: { latency: "default (frames follow vsync)", realtime: "default" },
}[browserName];

const libraries = args.lib ? args.lib.split(",") : COMPARED;
const sampleScale = Number(args["sample-scale"]);
const scenarios = SCENARIOS.filter(
  (s) =>
    (!args.scenario || args.scenario.split(",").includes(s.id)) &&
    (!args.filter || s.id.includes(args.filter)) &&
    (measuresMemory || s.operation !== "memory"),
).map((s) => ({
  ...s,
  samples: Math.max(1, Math.round(s.samples * sampleScale)),
  warmup: Math.round(s.warmup * Math.min(1, sampleScale)),
  // The limit actually applied, so recorded scenarios show it.
  timeout: Number(args.timeout ?? s.timeout ?? 600),
}));

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
  const launch = async (realtime: boolean) => {
    const headless = args.headless;
    let browser: Browser;
    if (browserName === "firefox") {
      const firefoxUserPrefs = realtime ? {} : FIREFOX_LATENCY_PREFS;
      browser = await firefox.launch({ headless, firefoxUserPrefs });
    } else if (browserName === "webkit") {
      browser = await webkit.launch({ headless });
    } else {
      const chromeArgs = realtime ? REALTIME_ARGS : LATENCY_ARGS;
      browser = await chromium.launch({ channel: "chrome", headless, args: chromeArgs });
    }
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    return { browser, context };
  };
  let latency = await launch(false);
  const browserVersion = latency.browser.version();
  // Paced scenarios run with the display's refresh on.
  const paced = (s: Scenario) => s.operation === "ingest" || s.operation === "orbit";
  let realtime = scenarios.some(paced) ? await launch(true) : latency;

  const rows: ResultRow[] = [];
  const renderers: Record<string, unknown> = {};
  let gpu = "unknown";
  let userAgent = "";
  /** Idle frame cadence in the latency browser, which bounds what WebKit timings can show. */
  let frameCadence: number | undefined;

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
    if (frameCadence === undefined && context === latency.context)
      frameCadence = await page.evaluate(() => window.bench.refreshInterval());
    if (s.operation === "memory") {
      const cdp = await context.newCDPSession(page);
      opened.cdp = cdp;
      return runMemory(page, cdp, s);
    }
    if (s.operation === "hover") return runHover(page, s);
    return page.evaluate((scenario) => window.bench.run(scenario), s);
  };

  let complete = false;
  try {
    for (const library of libraries) {
      for (const s of scenarios) {
        const ingest = paced(s);
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
          const fresh = await launch(ingest && !shared);
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
    writeResults({ rows, renderers, gpu, userAgent, browserVersion, frameCadence, complete });
  }
}

function writeResults(run: {
  rows: ResultRow[];
  renderers: Record<string, unknown>;
  gpu: string;
  userAgent: string;
  browserVersion: string;
  frameCadence: number | undefined;
  complete: boolean;
}) {
  const { rows, renderers, gpu, userAgent, browserVersion, frameCadence, complete } = run;
  const output = {
    schema: 1,
    date: new Date().toISOString(),
    commit: commit(),
    /** False when the run stopped early; the results cover what finished. */
    complete,
    method: {
      timing:
        browserName === "webkit"
          ? "operation start until rendering finished and the next frame was produced (rAF + MessageChannel); frames follow vsync, so short operations include waiting for it"
          : "operation start until rendering finished and the next frame was produced (rAF + MessageChannel); frame rate limit disabled except for ingest and orbit scenarios",
      memory: measuresMemory
        ? "CDP Runtime.getHeapUsage after forced GC: V8 heap + Blink heap + ArrayBuffer backing stores"
        : "not measured: heap sizes need Chrome's DevTools protocol, so memory scenarios were skipped",
      sampleScale,
    },
    environment: {
      ...machine(),
      browser: `${{ chrome: "Chrome", firefox: "Firefox", webkit: "WebKit" }[browserName]} ${browserVersion}`,
      userAgent,
      gpu,
      headless: args.headless,
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      browserSettings: BROWSER_SETTINGS,
      /** Playwright drives the browser; Firefox and WebKit are its own builds. */
      playwright: packageVersion("playwright"),
      browserBuild: browserBuild(browserName),
      /** Median idle requestAnimationFrame interval in latency scenarios, ms. */
      frameCadence,
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

/** The Playwright browser build used, from playwright-core's browsers.json; Chrome is the installed one. */
function browserBuild(name: BrowserName): string {
  if (name === "chrome") return "installed Google Chrome";
  try {
    const path = join(ROOT, "..", "node_modules", "playwright-core", "browsers.json");
    const { browsers } = JSON.parse(readFileSync(path, "utf8")) as {
      browsers: { name: string; revision: string; browserVersion?: string }[];
    };
    const build = browsers.find((browser) => browser.name === name);
    return build ? `${name} revision ${build.revision}` : "unknown";
  } catch {
    return "unknown";
  }
}

await main();
