// Streaming scenarios: appends or updates offered on a timer at a fixed rate
// for a fixed duration, while frames run at the display rate (vsync). A grid
// that blocks the main thread receives fewer ticks; each delivered tick is
// timed from its call to the first frame showing its result. Every trial
// starts from a freshly mounted grid over the same table, so trials measure
// the same workload and the first tick (which may copy data before its first
// write) is reported apart from the rest.

import { random } from "../datasets.ts";
import type { Adapter, GridHandle } from "./adapter.ts";
import { appendBatch, type GridTable, gridTable, updateValues } from "./fixture.ts";
import {
  afterFrame,
  beforePaint,
  droppedFrames,
  nextFrame,
  refreshInterval,
  settle,
} from "./frames.ts";
import {
  applyQuery,
  type GridResult,
  Incorrect,
  metric,
  mount,
  sourceOrder,
  verifyModel,
} from "./page.ts";
import { type Expected, Reference, verifyVisible } from "./reference.ts";
import type { GridScenario } from "./scenarios.ts";

/** Display rows and fields kept per tick to check the top of the grid. */
const WINDOW_ROWS = 32;
const WINDOW_FIELDS = 12;
const CORRECT_WITHIN_MS = 30_000;

/** One timer tick: a change, the same change for a reference, and what the top of the grid shows after it. */
interface Tick {
  apply(handle: GridHandle): void;
  mutate(reference: Reference): void;
  expected: Expected;
}

/** Freezes the top of the grid as the reference shows it now. */
function topWindow(reference: Reference, order: readonly number[] | null): Expected {
  const count = order ? order.length : reference.length;
  const rows = Math.min(WINDOW_ROWS, count);
  const fields = Math.min(WINDOW_FIELDS, reference.fields.length);
  const ids = Array.from({ length: rows }, (_, i) => (order ? order[i]! : reference.start + i));
  const text = ids.map((id) => Array.from({ length: fields }, (_, f) => reference.text(id, f)));
  return {
    count,
    fields: reference.fields.length,
    idAt: (i) => ids[i]!,
    text: (id, field) => text[ids.indexOf(id)]?.[field] ?? "(outside the checked window)",
    top: 0,
    left: 0,
  };
}

/**
 * Builds every tick up front, so generating data and expectations is never
 * timed. Each tick keeps the grid at the top, as a live view of the top of
 * its order does: Herceg keeps the rows in view in place when sorted rows
 * arrive above them, so it has to be asked; for grids that keep the pixel
 * offset, the call changes nothing.
 */
function buildTicks(s: GridScenario, table: GridTable, count: number): Tick[] {
  const reference = new Reference(table);
  const sort = s.sort ?? [];
  const filter = s.filter ?? null;
  let order = sort.length > 0 || filter ? reference.order(sort, filter) : null;
  const next = random(7);
  const ticks: Tick[] = [];
  for (let k = 0; k < count; k++) {
    let tick: Omit<Tick, "expected">;
    if (s.operation === "append") {
      const batch = appendBatch(table, s.batch!, k, s.seed);
      const evict = s.evict ? batch.length : 0;
      tick = {
        apply(handle) {
          handle.append(batch, evict);
          handle.scrollTo(0, 0);
        },
        mutate(target) {
          target.evict(evict);
          target.append(batch);
        },
      };
    } else {
      const field = reference.fieldIndex(s.field!);
      // Ten rows on screen, the rest anywhere.
      const onScreen = new Set<number>();
      const shown = Math.min(20, order ? order.length : reference.length);
      while (onScreen.size < Math.min(10, shown)) {
        const index = Math.floor(next() * shown);
        onScreen.add(order ? order[index]! : reference.start + index);
      }
      const ids = [...onScreen];
      const taken = new Set(ids);
      while (ids.length < s.batch!) {
        const id = reference.start + Math.floor(next() * reference.length);
        if (!taken.has(id)) {
          taken.add(id);
          ids.push(id);
        }
      }
      const changed = Int32Array.from(ids);
      const values = updateValues(table, field, changed, k, s.seed);
      tick = {
        apply(handle) {
          handle.update(field, changed, values);
          handle.scrollTo(0, 0);
        },
        mutate: (target) => target.update(field, changed, values),
      };
    }
    tick.mutate(reference);
    if (order) order = reference.order(sort, filter, order);
    ticks.push({ ...tick, expected: topWindow(reference, order) });
  }
  return ticks;
}

interface Trial {
  /** The first tick, which may copy data before its first write; undefined if overtaken. */
  first: { toFrame: number; processing: number } | undefined;
  /** Ticks after the first that showed, from the call to the frame. */
  tickToFrame: number[];
  /** Time inside the call, for every delivered tick after the first. */
  processing: number[];
  /** How late each tick was delivered against the offered schedule. */
  lateness: number[];
  /** Intervals of the frames overlapping the offered period. */
  intervals: number[];
  unresolved: number;
  delivered: number;
  /** From the end of the offered period until the last delivered tick showed. */
  drain: number;
  /** Long animation frames overlapping the offered period. */
  longFrames: number;
  /** Frames the harness could not observe before they painted. */
  unobserved: number;
  checking: number;
}

/**
 * When ticks are offered, in milliseconds from the start: one slot per
 * 1/rate seconds over the duration (50 over 5 s at 10 Hz), each after the
 * first moved by up to a refresh interval (seeded, the same for every
 * library). Without that, ticks every 100 ms against frames every 16.7 ms
 * would land at one phase of the frame for a whole trial, and the wait for
 * the next frame, part of every latency, would depend on that phase.
 */
function tickSlots(s: GridScenario, refresh: number): number[] {
  const interval = 1000 / (s.rateHz ?? 10);
  const count = Math.ceil((s.durationMs ?? 5000) / interval);
  const next = random(11);
  return Array.from({ length: count }, (_, k) => (k === 0 ? 0 : k * interval + next() * refresh));
}

/**
 * Offers ticks in their slots during the offered period, a fixed span of
 * the scenario's duration from the first tick. A grid that blocks the main
 * thread past its next slots misses them and receives fewer ticks; no tick
 * is delivered after the period, and the time from its end until the last
 * delivered tick showed is the drain. A tick overtaken by the next before it
 * showed counts as unresolved. Frame intervals and long animation frames
 * are those overlapping the period, so stalls across either end count.
 */
async function pacedTrial(
  handle: GridHandle,
  ticks: Tick[],
  s: GridScenario,
  slots: number[],
): Promise<Trial> {
  const duration = s.durationMs ?? 5000;
  const trial: Trial = {
    first: undefined,
    tickToFrame: [],
    processing: [],
    lateness: [],
    intervals: [],
    unresolved: 0,
    delivered: 0,
    drain: 0,
    longFrames: 0,
    unobserved: 0,
    checking: 0,
  };
  let pending: { index: number; start: number; processing: number; expected: Expected } | undefined;
  let running = true;
  let previous = 0;
  let lastProblem: string | undefined;
  const frames: [start: number, end: number][] = [];
  const loop = (t: number) => {
    if (previous) frames.push([previous, t]);
    previous = t;
    if (!running) return;
    requestAnimationFrame(loop);
    const tick = pending;
    if (!tick) return;
    beforePaint(
      () => {
        const t0 = performance.now();
        lastProblem = verifyVisible(handle.visible(), tick.expected);
        trial.checking += performance.now() - t0;
        if (lastProblem || pending !== tick) return;
        pending = undefined;
        afterFrame(() => {
          const shown = performance.now();
          shownAt[tick.index] = shown;
          const toFrame = shown - tick.start;
          if (tick.index === 0) trial.first = { toFrame, processing: tick.processing };
          else trial.tickToFrame.push(toFrame);
        });
      },
      () => {
        trial.unobserved++;
      },
    );
  };
  let started = 0;
  /** When each delivered tick's frame was produced. */
  const shownAt: number[] = [];
  const deliver = (index: number, slot: number) => {
    trial.lateness.push(performance.now() - (started + slot));
    if (pending) trial.unresolved++;
    const t0 = performance.now();
    ticks[index]!.apply(handle);
    const processing = performance.now() - t0;
    if (index > 0) trial.processing.push(processing);
    trial.delivered++;
    pending = { index, start: t0, processing, expected: ticks[index]!.expected };
  };
  const longFrames: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => longFrames.push(...list.getEntries()));
  observer.observe({ type: "long-animation-frame" });
  try {
    // A frame first, so the interval of a stall in the first tick is recorded.
    requestAnimationFrame(loop);
    await nextFrame();
    started = performance.now();
    const ends = started + duration;
    deliver(0, 0);
    await new Promise<void>((resolve, reject) => {
      // Slots are used in order, each at most once; slots already past are missed.
      let next = 1;
      const wait = () => {
        const now = performance.now() - started;
        while (next < slots.length && slots[next]! <= now) next++;
        const slot = slots[next];
        if (slot === undefined || slot >= duration || trial.delivered >= ticks.length) {
          window.setTimeout(resolve, Math.max(0, duration - now));
          return;
        }
        next++;
        const fire = () => {
          const at = performance.now() - started;
          if (at >= duration) {
            resolve();
            return;
          }
          // Timers may fire a fraction of a millisecond early.
          if (at < slot) {
            window.setTimeout(fire, slot - at);
            return;
          }
          try {
            deliver(trial.delivered, slot);
            wait();
          } catch (error) {
            reject(error);
          }
        };
        window.setTimeout(fire, slot - now);
      };
      wait();
    });
    const last = trial.delivered - 1;
    const deadline = performance.now() + CORRECT_WITHIN_MS;
    while (shownAt[last] === undefined && performance.now() < deadline) await nextFrame();
    const shown = shownAt[last];
    if (shown === undefined || shown > deadline)
      throw new Incorrect(lastProblem ?? "the last tick never showed");
    trial.drain = Math.max(0, shown - ends);
    running = false;
    // Long-animation-frame entries arrive after their frame.
    await new Promise((resolve) => setTimeout(resolve, 100));
    longFrames.push(...observer.takeRecords());
  } finally {
    running = false;
    observer.disconnect();
  }
  const ends = started + duration;
  const overlaps = (from: number, to: number) => to > started && from < ends;
  trial.intervals = frames
    .filter(([from, to]) => overlaps(from, to))
    .map(([from, to]) => to - from);
  trial.longFrames = longFrames.filter((entry) =>
    overlaps(entry.startTime, entry.startTime + entry.duration),
  ).length;
  return trial;
}

export async function runStream(adapter: Adapter, s: GridScenario): Promise<GridResult> {
  const table = gridTable(s.size, s.seed);
  const sort = s.sort ?? [];
  const filter = s.filter ?? null;
  const queried = sort.length > 0 || filter !== null;
  const refresh = await refreshInterval();
  const slots = tickSlots(s, refresh);
  const offered = slots.length;
  const ticks = buildTicks(s, table, offered);
  const trials: Trial[] = [];
  for (let i = 0; i < s.warmup + s.samples; i++) {
    const grid = await mount(adapter, table, new Reference(table));
    try {
      if (queried) await applyQuery(grid.handle, new Reference(table), sort, filter);
      await settle();
      const trial = await pacedTrial(grid.handle, ticks, s, slots);
      // The end state, from the ticks this trial delivered.
      const replay = new Reference(table);
      for (const tick of ticks.slice(0, trial.delivered)) tick.mutate(replay);
      verifyModel(grid.handle, queried ? replay.order(sort, filter) : sourceOrder(replay));
      if (i >= s.warmup) trials.push(trial);
    } finally {
      grid.destroy();
    }
  }
  const all = (pick: (trial: Trial) => number[]) => trials.flatMap(pick);
  const each = (pick: (trial: Trial) => number) => trials.map(pick);
  return {
    status: "measured",
    metrics: {
      tickToFrame: metric(
        "ms",
        all((trial) => trial.tickToFrame),
      ),
      firstTickToFrame: metric(
        "ms",
        trials.flatMap((trial) => (trial.first ? [trial.first.toFrame] : [])),
      ),
      processing: metric(
        "ms",
        all((trial) => trial.processing),
      ),
      firstTickProcessing: metric(
        "ms",
        trials.flatMap((trial) => (trial.first ? [trial.first.processing] : [])),
      ),
      lateness: metric(
        "ms",
        all((trial) => trial.lateness),
      ),
      frameInterval: metric(
        "ms",
        all((trial) => trial.intervals),
      ),
      droppedFrames: metric(
        "count",
        each((trial) => droppedFrames(trial.intervals, refresh)),
      ),
      longFrames: metric(
        "count",
        each((trial) => trial.longFrames),
      ),
      offeredTicks: metric("count", [offered]),
      deliveredTicks: metric(
        "count",
        each((trial) => trial.delivered),
      ),
      unresolvedTicks: metric(
        "count",
        each((trial) => trial.unresolved),
      ),
      drainTime: metric(
        "ms",
        each((trial) => trial.drain),
      ),
      unobservedFrames: metric(
        "count",
        each((trial) => trial.unobserved),
      ),
      checkTime: metric(
        "ms",
        each((trial) => trial.checking),
      ),
      refreshInterval: metric("ms", [refresh]),
    },
  };
}
