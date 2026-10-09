// Runs grid scenarios inside the page against one adapter.
//
// Every timed operation starts when the harness calls the adapter and ends
// with the first frame whose visible rows, cells, selection, and row count
// match the reference (see reference.ts and frames.ts). A grid that renders
// over several frames is timed to the frame where it is complete; one that
// never shows the correct result is reported incorrect instead of timed.
// Untimed verification also compares the library's full display order with
// the reference. Streaming scenarios are in stream.ts.

import type { Adapter, Operation } from "./adapter.ts";
import { COLUMN_WIDTH, GRID_HEIGHT, GRID_WIDTH, ROW_HEIGHT } from "./adapter.ts";
import { type GridTable, gridTable, tableBytes } from "./fixture.ts";
import {
  afterTimers,
  beforePaint,
  droppedFrames,
  nextFrame,
  refreshInterval,
  settle,
  withLongFrames,
} from "./frames.ts";
import {
  applyQuery,
  box,
  expectation,
  type GridResult,
  Incorrect,
  type Mounted,
  metric,
  mount,
  sourceOrder,
  stage,
  untilCorrect,
  verifyModel,
} from "./page.ts";
import { Reference, verifyVisible } from "./reference.ts";
import type { GridScenario } from "./scenarios.ts";
import { runStream } from "./stream.ts";

export type { GridResult } from "./page.ts";

/** Scroll step sizes: about a screen of rows, three columns. */
const PAGE_DOWN = 20 * ROW_HEIGHT;
const PAGE_RIGHT = 3 * COLUMN_WIDTH;
/** Scripted scrolling speed, CSS pixels per second. */
const TRACE_SPEED = { vertical: 3000, horizontal: 1500 };

async function runMount(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const reference = new Reference(table);
  const expected = expectation(reference, null);
  const metrics = {
    fromNative: metric("ms"),
    fromColumnar: metric("ms"),
    conversion: metric("ms"),
    mountCall: metric("ms"),
    frames: metric("count"),
    unobservedFrames: metric("count"),
    columnarUnobservedFrames: metric("count"),
    checkTime: metric("ms"),
    destroy: metric("ms"),
  };
  for (let i = 0; i < s.warmup + s.samples; i++) {
    for (const from of ["native", "columnar"] as const) {
      await settle();
      let input = from === "native" ? adapter.prepare(table) : undefined;
      const element = box();
      const start = performance.now();
      if (from === "columnar") input = adapter.prepare(table);
      const converted = performance.now();
      const handle = await adapter.mount(element, table, input);
      const called = performance.now();
      const correct = await untilCorrect(handle, expected, start);
      if (i === 0 && from === "native") verifyModel(handle, sourceOrder(reference));
      const destroyStart = performance.now();
      handle.destroy();
      element.remove();
      const destroyed = (await nextFrame()) - destroyStart;
      input = undefined;
      if (i < s.warmup) continue;
      if (from === "native") {
        metrics.fromNative.samples.push(correct.toFrame);
        metrics.mountCall.samples.push(called - converted);
        metrics.frames.samples.push(correct.frames);
        metrics.unobservedFrames.samples.push(correct.unobserved);
        metrics.checkTime.samples.push(correct.checking);
        metrics.destroy.samples.push(destroyed);
      } else {
        metrics.fromColumnar.samples.push(correct.toFrame);
        metrics.columnarUnobservedFrames.samples.push(correct.unobserved);
        metrics.conversion.samples.push(converted - start);
      }
    }
  }
  return { status: "measured", metrics };
}

/** Scroll offsets for step `i`: a screen down, three columns across (back and forth), or both. */
function scrollStep(s: GridScenario, i: number, rows: number, fields: number): [number, number] {
  if (s.direction === "end") return i % 2 === 0 ? [rows * ROW_HEIGHT, 0] : [0, 0];
  const range = Math.max(PAGE_DOWN, rows * ROW_HEIGHT - 2 * GRID_HEIGHT);
  const top = s.direction === "horizontal" ? 0 : ((i + 1) * PAGE_DOWN) % range;
  const span = Math.max(COLUMN_WIDTH, fields * COLUMN_WIDTH - GRID_WIDTH - COLUMN_WIDTH);
  const x = ((i + 1) * PAGE_RIGHT) % (2 * span);
  const left = s.direction === "vertical" ? 0 : x <= span ? x : 2 * span - x;
  return [top, left];
}

async function runScroll(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const reference = new Reference(table);
  const grid = await mount(adapter, table, reference);
  const stepToFrame = metric("ms");
  const frames = metric("count");
  const unobservedFrames = metric("count");
  const checkTime = metric("ms");
  try {
    for (let i = 0; i < s.warmup + s.samples; i++) {
      const [top, left] = scrollStep(s, i, reference.length, table.fields.length);
      const start = performance.now();
      grid.handle.scrollTo(top, left);
      const correct = await untilCorrect(
        grid.handle,
        expectation(reference, null, top, left),
        start,
      );
      if (i < s.warmup) continue;
      stepToFrame.samples.push(correct.toFrame);
      frames.samples.push(correct.frames);
      unobservedFrames.samples.push(correct.unobserved);
      checkTime.samples.push(correct.checking);
    }
  } finally {
    grid.destroy();
  }
  return { status: "measured", metrics: { stepToFrame, frames, unobservedFrames, checkTime } };
}

/**
 * The wheel trial in progress, if any: the runner dispatches wheel events
 * over the grid while this is set, and stops when it is cleared.
 */
let wheelTrial: number | null = null;
/** The last wheel trial whose events the runner has stopped sending and seen handled. */
let wheelDone: number | null = null;
/** Quiet time after the last wheel event, once the runner has stopped, before the grid is reset. */
const WHEEL_DRAIN_MS = 300;

/**
 * Continuous scrolling with vsync. Scripted traces set the offset every
 * frame from the time elapsed; wheel traces read the offset the browser
 * scrolled to. Each frame is checked just before it paints against the
 * offset it was produced at: a DOM grid that has not rendered rows for it
 * shows blank space, a canvas grid that has not redrawn shows content for an
 * earlier offset, and both count as incomplete frames. Distance and wheel
 * events received are read when the trial ends.
 */
async function runScrollTrace(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const reference = new Reference(table);
  const grid = await mount(adapter, table, reference);
  const refresh = await refreshInterval();
  const wheel = s.direction === "wheel";
  const maxTop = reference.length * ROW_HEIGHT - GRID_HEIGHT;
  const span = Math.max(
    COLUMN_WIDTH,
    table.fields.length * COLUMN_WIDTH - GRID_WIDTH - COLUMN_WIDTH,
  );
  const across = s.direction === "diagonal" ? TRACE_SPEED.horizontal : 0;
  const metrics = {
    frameInterval: metric("ms"),
    frames: metric("count"),
    droppedFrames: metric("count"),
    incompleteFrames: metric("count"),
    unobservedFrames: metric("count"),
    longFrames: metric("count"),
    scrolled: metric("count"),
    ...(wheel && { wheelEvents: metric("count") }),
    checkTime: metric("ms"),
    refreshInterval: metric("ms", [refresh]),
  };
  let events = 0;
  let lastEvent = 0;
  const countEvent = () => {
    events++;
    lastEvent = performance.now();
  };
  window.addEventListener("wheel", countEvent, { capture: true, passive: true });
  try {
    for (let trial = 0; trial < s.warmup + s.samples; trial++) {
      grid.handle.scrollTo(0, 0);
      await untilCorrect(grid.handle, expectation(reference, null), performance.now());
      await settle();
      const intervals: number[] = [];
      let incomplete = 0;
      let unobserved = 0;
      let checking = 0;
      let scrolled = 0;
      let received = 0;
      let from = 0;
      const { longFrames } = await withLongFrames(
        () =>
          new Promise<void>((resolve) => {
            let previous = 0;
            let started = 0;
            const step = (t: number) => {
              if (previous) intervals.push(t - previous);
              else {
                started = t;
                events = 0;
                from = grid.handle.scrollOffset().top;
                if (wheel) wheelTrial = trial;
              }
              previous = t;
              if (t - started >= (s.durationMs ?? 3000)) {
                wheelTrial = null;
                scrolled = grid.handle.scrollOffset().top - from;
                received = events;
                resolve();
                return;
              }
              let offset = grid.handle.scrollOffset();
              if (!wheel) {
                const seconds = (t - started) / 1000;
                const x = Math.round(seconds * across) % (2 * span);
                offset = {
                  top: Math.round(Math.min(maxTop, seconds * TRACE_SPEED.vertical)),
                  left: x <= span ? x : 2 * span - x,
                };
                grid.handle.scrollTo(offset.top, offset.left);
              }
              requestAnimationFrame(step);
              beforePaint(
                () => {
                  const c0 = performance.now();
                  // Wheel input may have moved the body since the frame began.
                  if (wheel) offset = grid.handle.scrollOffset();
                  const expected = expectation(reference, null, offset.top, offset.left);
                  if (verifyVisible(grid.handle.visible(), expected)) incomplete++;
                  checking += performance.now() - c0;
                },
                () => {
                  unobserved++;
                },
              );
            };
            requestAnimationFrame(step);
          }),
      );
      // Wheel events already sent land before the grid is reset for the next trial.
      if (wheel) {
        const waited = performance.now();
        while (wheelDone !== trial) {
          if (performance.now() - waited > 10_000) throw new Error("the wheel driver did not stop");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        while (performance.now() - lastEvent < WHEEL_DRAIN_MS)
          await new Promise((resolve) => setTimeout(resolve, WHEEL_DRAIN_MS));
      }
      if (trial < s.warmup) continue;
      metrics.frameInterval.samples.push(...intervals);
      metrics.frames.samples.push(intervals.length);
      metrics.droppedFrames.samples.push(droppedFrames(intervals, refresh));
      metrics.incompleteFrames.samples.push(incomplete);
      metrics.unobservedFrames.samples.push(unobserved);
      metrics.longFrames.samples.push(longFrames);
      metrics.scrolled.samples.push(scrolled);
      metrics.wheelEvents?.samples.push(received);
      metrics.checkTime.samples.push(checking / Math.max(1, intervals.length));
    }
  } finally {
    wheelTrial = null;
    window.removeEventListener("wheel", countEvent, { capture: true });
    grid.destroy();
  }
  if (metrics.scrolled.samples.some((pixels) => pixels < GRID_HEIGHT))
    throw new Error(`the trace scrolled only ${metrics.scrolled.samples.join(", ")} px`);
  return { status: "measured", metrics };
}

/** Sort or filter: from source order to the query's result, each sample from a reset grid. */
async function runQuery(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const reference = new Reference(table);
  const grid = await mount(adapter, table, reference);
  const { handle } = grid;
  const sort = s.sort ?? [];
  const filter = s.filter ?? null;
  const apply = () => (filter ? handle.filter(filter) : handle.sort(sort));
  const reset = () => (filter ? handle.filter(null) : handle.sort([]));
  const order = reference.order(filter ? [] : sort, filter);
  const expected = expectation(reference, order);
  const unsorted = expectation(reference, null);
  const metrics = {
    toFrame: metric("ms"),
    processing: metric("ms"),
    frames: metric("count"),
    unobservedFrames: metric("count"),
    checkTime: metric("ms"),
  };
  try {
    // Untimed verification of the library's complete result first.
    await apply();
    await untilCorrect(handle, expected, performance.now());
    verifyModel(handle, order);
    for (let i = 0; i < s.warmup + s.samples; i++) {
      await reset();
      await untilCorrect(handle, unsorted, performance.now());
      await settle();
      const start = performance.now();
      await apply();
      const processed = performance.now();
      const correct = await untilCorrect(handle, expected, start);
      if (i < s.warmup) continue;
      metrics.toFrame.samples.push(correct.toFrame);
      metrics.processing.samples.push(processed - start);
      metrics.frames.samples.push(correct.frames);
      metrics.unobservedFrames.samples.push(correct.unobserved);
      metrics.checkTime.samples.push(correct.checking);
    }
  } finally {
    grid.destroy();
  }
  return { status: "measured", metrics };
}

/** Selects one displayed row or a displayed-order range under a sort, then reads the selection back. */
async function runSelect(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const reference = new Reference(table);
  const grid = await mount(adapter, table, reference);
  const { handle } = grid;
  const range = s.select! < 1;
  const metrics = {
    toFrame: metric("ms"),
    processing: metric("ms"),
    frames: metric("count"),
    unobservedFrames: metric("count"),
    checkTime: metric("ms"),
    ...(range && { readSelection: metric("ms") }),
  };
  try {
    const order = await applyQuery(handle, reference, s.sort ?? [], null);
    const position = new Int32Array(reference.length);
    order.forEach((id, index) => {
      position[id - reference.start] = index;
    });
    const count = range ? Math.floor(order.length * s.select!) : s.select!;
    const none = expectation(reference, order);
    for (let i = 0; i < s.warmup + s.samples; i++) {
      handle.clearSelection();
      await untilCorrect(handle, none, performance.now());
      await settle();
      const first = count === 1 ? i % 15 : 0;
      const selected = (id: number) => {
        const p = position[id - reference.start]!;
        return p >= first && p < first + count;
      };
      const start = performance.now();
      handle.selectRange(first, first + count);
      const processed = performance.now();
      const correct = await untilCorrect(
        handle,
        expectation(reference, order, 0, 0, selected),
        start,
      );
      let read = 0;
      if (metrics.readSelection) {
        const r0 = performance.now();
        const ids = handle.selectedIds();
        read = performance.now() - r0;
        if (ids.length !== count)
          throw new Incorrect(`reads ${ids.length} selected rows, expected ${count}`);
        for (let k = 0; k < ids.length; k++)
          if (!selected(ids[k]!)) throw new Incorrect(`reads row ${ids[k]} as selected`);
      }
      if (i < s.warmup) continue;
      metrics.toFrame.samples.push(correct.toFrame);
      metrics.processing.samples.push(processed - start);
      metrics.frames.samples.push(correct.frames);
      metrics.unobservedFrames.samples.push(correct.unobserved);
      metrics.checkTime.samples.push(correct.checking);
      metrics.readSelection?.samples.push(read);
    }
  } finally {
    grid.destroy();
  }
  return { status: "measured", metrics };
}

const OPERATION: Partial<Record<GridScenario["operation"], Operation>> = {
  sort: "sort",
  filter: "filter",
  select: "select",
  append: "append",
  update: "update",
};

/** State for the memory scenario, which the runner drives step by step in a fresh page per sample. */
let held: {
  scenario: GridScenario;
  table?: GridTable;
  reference?: Reference;
  sorted?: number[];
  input?: unknown;
  grid?: Mounted;
} | null = null;

export interface GridBench {
  id: string;
  renderer: string;
  processing: Adapter["processing"];
  run(s: GridScenario): Promise<GridResult>;
  /** The wheel trial that wants wheel events now, or null. */
  readonly wheelTrial: number | null;
  /** The runner has stopped sending wheel events for `trial`, and they have been handled. */
  wheelStopped(trial: number): void;
  /** Memory steps, called in this order with heap readings in between. */
  memory: {
    /** Creates the fixture; returns its column buffer bytes. */
    data(s: GridScenario): number;
    /** Computes what the sort step should show, so its memory is not counted later. */
    reference(): void;
    /** Converts the fixture to the library's native input and keeps both. */
    input(): void;
    /** Mounts the grid; no garbage collection, so the runner reads the heap as the mount left it. */
    mount(): Promise<void>;
    footprint(): { domNodes: number; canvasBytes: number };
    /** Sorts and waits for the correct frame; also without collecting garbage. */
    sort(): Promise<void>;
    /** Compares the library's sorted order with the reference, after the readings. */
    verify(): void;
    /** Destroys the grid, keeping the data and native input; returns a second later. */
    destroy(): Promise<void>;
    /** Mounts and destroys the grid `count` times; returns a second later. */
    cycles(count: number): Promise<void>;
    /** Drops the data and input too. */
    release(): Promise<void>;
  };
  gpu(): string;
}

export function installGridHarness(adapter: Adapter): void {
  const bench: GridBench = {
    id: adapter.id,
    renderer: adapter.renderer,
    processing: adapter.processing,
    get wheelTrial() {
      return wheelTrial;
    },
    wheelStopped(trial) {
      wheelDone = trial;
    },
    async run(s) {
      const operation = OPERATION[s.operation];
      const reason = operation && adapter.unsupported?.[operation];
      if (reason) return { status: "unsupported", reason, metrics: {} };
      try {
        switch (s.operation) {
          case "mount":
            return await runMount(adapter, s);
          case "scroll":
            return await runScroll(adapter, s);
          case "scroll-trace":
            return await runScrollTrace(adapter, s);
          case "sort":
          case "filter":
            return await runQuery(adapter, s);
          case "select":
            return await runSelect(adapter, s);
          case "append":
          case "update":
            return await runStream(adapter, s);
          case "memory":
            throw new Error("memory is driven by the runner");
        }
      } catch (error) {
        if (error instanceof Incorrect)
          return {
            status: "incorrect",
            reason: error.message.replace(/^incorrect: /, ""),
            metrics: {},
          };
        throw error;
      } finally {
        stage().replaceChildren();
      }
    },
    memory: {
      data(s) {
        const table = gridTable(s.size, s.seed);
        held = { scenario: s, table };
        return tableBytes(table);
      },
      reference() {
        held!.reference = new Reference(held!.table!);
        held!.sorted = held!.reference.order(held!.scenario.sort ?? [], null);
      },
      input() {
        held!.input = adapter.prepare(held!.table!);
      },
      async mount() {
        held!.grid = await mount(adapter, held!.table!, held!.reference!, held!.input);
      },
      footprint() {
        let canvasBytes = 0;
        for (const canvas of stage().querySelectorAll("canvas"))
          canvasBytes += canvas.width * canvas.height * 4;
        return { domNodes: stage().getElementsByTagName("*").length, canvasBytes };
      },
      async sort() {
        const { grid, reference, sorted, scenario } = held!;
        await grid!.handle.sort(scenario.sort ?? []);
        await untilCorrect(grid!.handle, expectation(reference!, sorted!), performance.now());
      },
      verify() {
        verifyModel(held!.grid!.handle, held!.sorted!);
      },
      async destroy() {
        held!.grid?.destroy();
        held!.grid = undefined;
        await afterTimers();
      },
      async cycles(count) {
        for (let i = 0; i < count; i++) {
          const grid = await mount(adapter, held!.table!, held!.reference!, held!.input);
          grid.destroy();
          await nextFrame();
        }
        await afterTimers();
      },
      async release() {
        held?.grid?.destroy();
        held = null;
        stage().replaceChildren();
        await afterTimers();
      },
    },
    gpu() {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    },
  };
  (window as unknown as { gridBench: GridBench }).gridBench = bench;
}
