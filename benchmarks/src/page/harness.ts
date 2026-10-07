// Runs benchmark scenarios inside the browser page against one adapter.
//
// Timing model: an operation starts when the harness calls into the library
// and ends when the library has finished rendering and the next frame has been
// produced. "Produced" means the requestAnimationFrame callbacks, style,
// layout, and paint for that frame have run on the main thread: a
// MessageChannel task posted from inside rAF runs after the rendering update.
// For latency scenarios Chrome runs with the frame rate limit disabled, so
// waiting for the frame measures work rather than vsync alignment. Paced
// ingestion scenarios run with normal vsync instead.

import {
  type CategoryData,
  categories,
  continueSeries,
  type GridData,
  grid,
  type PointData,
  random,
  type SeriesData,
  scatterPoints,
  timeSeries,
} from "../datasets.ts";
import type { Scenario } from "../scenarios.ts";
import type { Adapter, ChartHandle, ChartKind, ChartOptions, Point } from "./adapter.ts";

export interface Metric {
  unit: "ms" | "bytes" | "count" | "hz";
  samples: number[];
}

export interface PageResult {
  supported: boolean;
  reason?: string;
  metrics: Record<string, Metric>;
}

type AnyData = SeriesData | PointData | CategoryData | GridData;
type AnyHandle = ChartHandle<AnyData>;

const WIDTH = 800;
const HEIGHT = 400;

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now());
      channel.port2.postMessage(null);
    });
  });
}

interface Timing {
  /** Until the first frame after the call. */
  first: number;
  /** Until rendering finished and a frame was produced; equals `first` for libraries that render at once. */
  complete: number;
}

/** Times `operation` to its first frame and to completed rendering. */
async function timed(
  operation: () => unknown,
  handle?: () => AnyHandle | undefined,
): Promise<Timing> {
  const start = performance.now();
  await operation();
  const first = (await nextFrame()) - start;
  const pending = handle?.()?.rendered?.();
  if (!pending) return { first, complete: first };
  await pending;
  return { first, complete: (await nextFrame()) - start };
}

function makeData(s: Scenario, seed: number): AnyData {
  switch (s.chart) {
    case "line":
    case "area":
      return timeSeries(s.series, s.points, seed);
    case "bar":
      return categories(s.points, s.series, seed);
    case "scatter":
      return scatterPoints(s.points, seed);
    case "heatmap": {
      const side = Math.round(Math.sqrt(s.points));
      return grid(side, side, seed);
    }
  }
}

function kindFor(adapter: Adapter, s: Scenario): ChartKind<AnyData> | undefined {
  return adapter[s.chart] as ChartKind<AnyData> | undefined;
}

function stage(): HTMLElement {
  return document.getElementById("stage")!;
}

function box(width: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.style.cssText = `width:${width}px;height:${height}px;display:inline-block;vertical-align:top`;
  stage().append(element);
  return element;
}

function chartSize(s: Scenario): { width: number; height: number } {
  const charts = s.charts ?? 1;
  if (charts >= 50) return { width: 300, height: 150 };
  if (charts > 1) return { width: 600, height: 250 };
  return { width: WIDTH, height: HEIGHT };
}

function optionsFor(s: Scenario): ChartOptions {
  return { ...chartSize(s), tooltip: s.tooltip, large: s.large };
}

function clearStage() {
  stage().replaceChildren();
}

function metric(unit: Metric["unit"], samples: number[] = []): Metric {
  return { unit, samples };
}

function timePrepare(
  kind: ChartKind<AnyData>,
  data: AnyData,
  options: ChartOptions,
  samples: number,
): Metric {
  const result = metric("ms");
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    kind.prepare(data, options);
    result.samples.push(performance.now() - start);
  }
  return result;
}

async function create(
  kind: ChartKind<AnyData>,
  data: AnyData,
  options: ChartOptions,
): Promise<AnyHandle> {
  const handle = await kind.create(box(options.width, options.height), data, options);
  await handle.rendered?.();
  await nextFrame();
  return handle;
}

async function runInit(kind: ChartKind<AnyData>, s: Scenario): Promise<PageResult> {
  const data = makeData(s, 1);
  const options = optionsFor(s);
  const frame = metric("ms");
  const firstFrame = metric("ms");
  for (let i = 0; i < s.warmup + s.samples; i++) {
    const container = box(options.width, options.height);
    let handle: AnyHandle | undefined;
    const elapsed = await timed(
      async () => {
        handle = await kind.create(container, data, options);
      },
      () => handle,
    );
    handle!.destroy();
    clearStage();
    if (i >= s.warmup) {
      frame.samples.push(elapsed.complete);
      firstFrame.samples.push(elapsed.first);
    }
    await nextFrame();
  }
  return {
    supported: true,
    metrics: {
      timeToFrame: frame,
      firstFrame,
      prepare: timePrepare(kind, data, options, s.samples),
    },
  };
}

async function runUpdate(kind: ChartKind<AnyData>, s: Scenario): Promise<PageResult> {
  const datasets = [makeData(s, 1), makeData(s, 2)];
  const options = optionsFor(s);
  const handle = await create(kind, datasets[0]!, options);
  const frame = metric("ms");
  const firstFrame = metric("ms");
  for (let i = 0; i < s.warmup + s.samples; i++) {
    const elapsed = await timed(
      () => handle.setData(datasets[(i + 1) % 2]!),
      () => handle,
    );
    if (i >= s.warmup) {
      frame.samples.push(elapsed.complete);
      firstFrame.samples.push(elapsed.first);
    }
  }
  handle.destroy();
  clearStage();
  return {
    supported: true,
    metrics: {
      timeToFrame: frame,
      firstFrame,
      prepare: timePrepare(kind, datasets[1]!, options, s.samples),
    },
  };
}

function appendUnsupported(adapter: Adapter): PageResult {
  return {
    supported: false,
    reason: `${adapter.id} adapter has no rolling-window append`,
    metrics: {},
  };
}

async function runStream(
  adapter: Adapter,
  kind: ChartKind<AnyData>,
  s: Scenario,
): Promise<PageResult> {
  const data = makeData(s, 1) as SeriesData;
  const handle = await create(kind, data, optionsFor(s));
  if (!handle.append) {
    handle.destroy();
    clearStage();
    return appendUnsupported(adapter);
  }
  const frame = metric("ms");
  const ticks = s.warmup + s.samples;
  // Generate every tick up front so data generation is never timed.
  const batches = Array.from({ length: ticks }, (_, tick) =>
    continueSeries(data, s.append ?? 1, tick),
  );
  for (let i = 0; i < ticks; i++) {
    const batch = batches[i]!;
    const elapsed = await timed(
      () => handle.append!(batch.x, batch.ys, s.points),
      () => handle,
    );
    if (i >= s.warmup) frame.samples.push(elapsed.complete);
  }
  handle.destroy();
  clearStage();
  return { supported: true, metrics: { tickToFrame: frame } };
}

/** Median requestAnimationFrame interval while idle. */
async function refreshInterval(frames = 30): Promise<number> {
  const times: number[] = [];
  await new Promise<void>((resolve) => {
    const step = (t: number) => {
      times.push(t);
      if (times.length > frames) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const intervals = times.slice(1).map((t, i) => t - times[i]!);
  intervals.sort((a, b) => a - b);
  return intervals[intervals.length >> 1]!;
}

/** Ingestion measurements from one trial. */
interface IngestTrial {
  intervals: number[];
  appendTimes: number[];
  dropped: number;
  longFrames: number;
  rate: number;
  drain: number;
}

/**
 * One paced-ingestion trial: for `durationMs` of wall-clock time a timer
 * appends data at `rateHz` while the display runs at its normal refresh rate.
 * Libraries decide when to render; one that blocks the main thread receives
 * fewer ticks.
 */
async function ingestTrial(
  handles: AnyHandle[],
  datasets: SeriesData[],
  s: Scenario,
  refresh: number,
  trial: number,
): Promise<IngestTrial> {
  const rate = s.rateHz ?? 10;
  const duration = s.durationMs ?? 5000;
  const capacity = Math.ceil((duration * rate) / 1000);
  // Later trials continue where earlier ones could have ended, so x keeps increasing.
  const batches = datasets.map((data) =>
    Array.from({ length: capacity }, (_, tick) =>
      continueSeries(data, s.append ?? 1, trial * capacity + tick),
    ),
  );

  const intervals: number[] = [];
  let previous = 0;
  let running = true;
  const loop = (t: number) => {
    if (previous) intervals.push(t - previous);
    previous = t;
    if (running) requestAnimationFrame(loop);
  };
  const longFrames: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => longFrames.push(...list.getEntries()));
  const pending: Promise<unknown>[] = [];
  const appendTimes: number[] = [];
  let timer = 0;
  const started = performance.now();
  let delivered = 0;
  try {
    observer.observe({ type: "long-animation-frame" });
    requestAnimationFrame(loop);
    await new Promise<void>((resolve, reject) => {
      timer = window.setInterval(() => {
        try {
          if (performance.now() - started >= duration || delivered >= capacity) {
            resolve();
            return;
          }
          const t0 = performance.now();
          handles.forEach((handle, c) => {
            const batch = batches[c]![delivered]!;
            pending.push(Promise.resolve(handle.append!(batch.x, batch.ys, s.points)));
          });
          appendTimes.push(performance.now() - t0);
          delivered++;
        } catch (error) {
          reject(error);
        }
      }, 1000 / rate);
    });
    window.clearInterval(timer);
    const deadline = performance.now();
    // Drain asynchronous appends and progressive rendering before measuring.
    await Promise.all(pending);
    for (const handle of handles) await handle.rendered?.();
    await nextFrame();
    const drain = performance.now() - deadline;
    running = false;
    // Long-animation-frame entries arrive after their frame; give the last one time to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    longFrames.push(...observer.takeRecords());
    let dropped = 0;
    // A frame interval spanning k refresh periods missed k - 1 frames.
    for (const interval of intervals) dropped += Math.max(0, Math.round(interval / refresh) - 1);
    return {
      intervals,
      appendTimes,
      dropped,
      longFrames: longFrames.filter((entry) => entry.startTime >= started).length,
      rate: (delivered * 1000) / (deadline - started),
      drain,
    };
  } finally {
    running = false;
    window.clearInterval(timer);
    observer.disconnect();
  }
}

async function runIngest(
  adapter: Adapter,
  kind: ChartKind<AnyData>,
  s: Scenario,
): Promise<PageResult> {
  const options = optionsFor(s);
  const datasets = Array.from({ length: s.charts ?? 1 }, (_, c) =>
    timeSeries(s.series, s.points, 1 + c),
  );
  const handles: AnyHandle[] = [];
  try {
    for (const data of datasets) handles.push(await create(kind, data, options));
    if (handles.some((handle) => !handle.append)) return appendUnsupported(adapter);
    const refresh = await refreshInterval();
    const measured: IngestTrial[] = [];
    for (let i = 0; i < s.warmup + s.samples; i++) {
      const trial = await ingestTrial(handles, datasets, s, refresh, i);
      if (i >= s.warmup) measured.push(trial);
    }
    return {
      supported: true,
      metrics: {
        frameInterval: metric(
          "ms",
          measured.flatMap((trial) => trial.intervals),
        ),
        appendTime: metric(
          "ms",
          measured.flatMap((trial) => trial.appendTimes),
        ),
        droppedFrames: metric(
          "count",
          measured.map((trial) => trial.dropped),
        ),
        longFrames: metric(
          "count",
          measured.map((trial) => trial.longFrames),
        ),
        achievedRate: metric(
          "hz",
          measured.map((trial) => trial.rate),
        ),
        drainTime: metric(
          "ms",
          measured.map((trial) => trial.drain),
        ),
        refreshInterval: metric("ms", [refresh]),
      },
    };
  } finally {
    for (const handle of handles) handle.destroy();
    clearStage();
  }
}

async function runResize(kind: ChartKind<AnyData>, s: Scenario): Promise<PageResult> {
  const options = optionsFor(s);
  const handle = await create(kind, makeData(s, 1), options);
  const container = stage().lastElementChild as HTMLElement;
  const frame = metric("ms");
  for (let i = 0; i < s.warmup + s.samples; i++) {
    const small = i % 2 === 0;
    const width = small ? 600 : WIDTH;
    const height = small ? 300 : HEIGHT;
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    const elapsed = await timed(
      () => handle.resize(width, height),
      () => handle,
    );
    if (i >= s.warmup) frame.samples.push(elapsed.complete);
  }
  handle.destroy();
  clearStage();
  return { supported: true, metrics: { resizeToFrame: frame } };
}

async function runDashboard(kind: ChartKind<AnyData>, s: Scenario): Promise<PageResult> {
  const count = s.charts ?? 10;
  const options = optionsFor(s);
  const first = Array.from({ length: count }, (_, c) => timeSeries(s.series, s.points, 1 + c));
  const second = Array.from({ length: count }, (_, c) => timeSeries(s.series, s.points, 101 + c));
  const init = metric("ms");
  const update = metric("ms");
  for (let i = 0; i < s.warmup + s.samples; i++) {
    const handles: AnyHandle[] = [];
    const initElapsed = await timed(async () => {
      for (const data of first)
        handles.push(await kind.create(box(options.width, options.height), data, options));
      for (const handle of handles) await handle.rendered?.();
    });
    // Periodic refresh: every chart receives new data in the same task.
    const updateElapsed = await timed(async () => {
      await Promise.all(handles.map((handle, c) => handle.setData(second[c]!)));
      for (const handle of handles) await handle.rendered?.();
    });
    for (const handle of handles) handle.destroy();
    clearStage();
    if (i >= s.warmup) {
      init.samples.push(initElapsed.complete);
      update.samples.push(updateElapsed.complete);
    }
    await nextFrame();
  }
  return { supported: true, metrics: { initAllToFrame: init, updateAllToFrame: update } };
}

// State for scenarios driven step by step from Node (hover, memory).
let active: AnyHandle[] = [];
let retainedData: AnyData[] = [];

function unsupported(adapter: Adapter, s: Scenario): PageResult | undefined {
  if (kindFor(adapter, s)) return undefined;
  return {
    supported: false,
    reason: `${adapter.id} has no built-in ${s.chart} chart`,
    metrics: {},
  };
}

/** Client positions of data points to aim pointer moves at. */
function hoverTargets(s: Scenario, count: number): Point[] {
  const handle = active[0]!;
  const data = retainedData[0]!;
  const targets: Point[] = [];
  if (s.chart === "scatter") {
    const points = data as PointData;
    const next = random(42);
    for (let i = 0; i < count; i++) {
      const index = Math.floor(next() * points.x.length);
      targets.push(handle.pixelOf(0, index, points.x[index]!, points.y[index]!));
    }
    return targets;
  }
  const series = data as SeriesData;
  const length = series.x.length;
  for (let i = 0; i < count; i++) {
    // Sweep from 5% to 95% of the series, left to right.
    const index = Math.round(length * (0.05 + (0.9 * i) / Math.max(1, count - 1)));
    targets.push(handle.pixelOf(0, index, series.x[index]!, series.ys[0]![index]!));
  }
  return targets;
}

export interface Bench {
  id: string;
  renderer: Adapter["renderer"];
  run(s: Scenario): Promise<PageResult>;
  /** Creates source data only, so its memory can be excluded. */
  prepareData(s: Scenario): number;
  /** Mounts the scenario's charts for hover or memory measurement. */
  mount(s: Scenario): Promise<{ supported: boolean; reason?: string }>;
  hoverTargets(s: Scenario, count: number): Point[];
  /** DOM elements and estimated canvas backing-store bytes under the stage. */
  footprint(): { domNodes: number; canvasBytes: number };
  armPointer(): void;
  pointerLatency(): Promise<number>;
  unmount(): Promise<void>;
  gpu(): string;
}

let pointerDone: Promise<number> = Promise.resolve(0);

export function installHarness(adapter: Adapter): void {
  const bench: Bench = {
    id: adapter.id,
    renderer: adapter.renderer,
    async run(s) {
      const missing = unsupported(adapter, s);
      if (missing) return missing;
      const kind = kindFor(adapter, s)!;
      switch (s.operation) {
        case "init":
          return runInit(kind, s);
        case "update":
          return runUpdate(kind, s);
        case "stream":
          return runStream(adapter, kind, s);
        case "ingest":
          return runIngest(adapter, kind, s);
        case "resize":
          return runResize(kind, s);
        case "dashboard":
          return runDashboard(kind, s);
        default:
          throw new Error(`${s.operation} is driven by the runner`);
      }
    },
    prepareData(s) {
      retainedData = Array.from({ length: s.charts ?? 1 }, (_, c) => makeData(s, 1 + c));
      return retainedData.length;
    },
    async mount(s) {
      const missing = unsupported(adapter, s);
      if (missing) return missing;
      const kind = kindFor(adapter, s)!;
      const options = optionsFor(s);
      if (retainedData.length === 0) bench.prepareData(s);
      active = [];
      for (const data of retainedData) active.push(await create(kind, data, options));
      await nextFrame();
      return { supported: true };
    },
    hoverTargets,
    footprint() {
      const root = stage();
      let canvasBytes = 0;
      for (const canvas of root.querySelectorAll("canvas"))
        canvasBytes += canvas.width * canvas.height * 4;
      return { domNodes: root.getElementsByTagName("*").length, canvasBytes };
    },
    armPointer() {
      pointerDone = new Promise((resolve) => {
        const listener = () => {
          const start = performance.now();
          window.removeEventListener("pointermove", listener, true);
          nextFrame().then((end) => resolve(end - start));
        };
        window.addEventListener("pointermove", listener, true);
      });
    },
    pointerLatency: () => pointerDone,
    async unmount() {
      for (const handle of active) handle.destroy();
      active = [];
      retainedData = [];
      clearStage();
      await nextFrame();
    },
    gpu() {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    },
  };
  (window as unknown as { bench: Bench }).bench = bench;
}
