// Frame timing for the grid harness.
//
// A timed operation ends with the first frame that shows the correct result.
// The harness reads what a grid shows just before a frame paints: a
// ResizeObserver callback runs after the frame's animation callbacks and
// layout, and the harness resizes a hidden probe every frame it checks to get
// one. Reading after the frame instead would also see work done in tasks
// queued before the read, which the frame did not show (a React update that a
// scroll event scheduled, for one). It is the state observed at that point,
// not proof of what the compositor presented: a library's own ResizeObserver
// running later in the same frame could still change it.
//
// Frame times are taken when the frame has been produced (a MessageChannel
// message posted during it, as in page/harness.ts) and include the check's
// own cost, which is recorded separately.

/**
 * Runs `callback` after the current frame is produced; call it from
 * requestAnimationFrame. The port is closed after use: an open port with a
 * listener keeps its listener, and what that references, alive.
 */
export function afterFrame(callback: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
}

/** The time once the next frame has been produced. */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => afterFrame(() => resolve(performance.now()))),
  );
}

let probe: HTMLElement | undefined;
let prePaint: (() => void) | null = null;

function runPrePaint(): void {
  const run = prePaint;
  prePaint = null;
  run?.();
}

/**
 * The hidden element whose resizing makes the observer run. Made outside
 * `beforePaint` so the observer's callback closes over nothing a caller
 * passed in: it lives as long as the page.
 */
function resizeProbe(): HTMLElement {
  if (probe) return probe;
  probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  new ResizeObserver(runPrePaint).observe(probe);
  return probe;
}

/**
 * Runs `callback` in this frame just before it paints (see above); call it
 * from requestAnimationFrame. Should the observer not run, `missed` runs
 * once the frame has been produced instead: the frame was not observed, and
 * reading it then would credit work done after it.
 */
export function beforePaint(callback: () => void, missed: () => void = () => {}): void {
  const probe = resizeProbe();
  prePaint = callback;
  probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
  afterFrame(() => {
    if (prePaint !== callback) return;
    prePaint = null;
    missed();
  });
}

/**
 * The next frame: `check`'s result just before it painted (or `observed:
 * false` if the frame could not be observed), the time it was produced, and
 * the check's cost.
 */
export function checkedFrame<T>(
  check: () => T,
): Promise<{ observed: boolean; value: T | undefined; time: number; spent: number }> {
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      beforePaint(
        () => {
          const t0 = performance.now();
          const value = check();
          const spent = performance.now() - t0;
          afterFrame(() => resolve({ observed: true, value, time: performance.now(), spent }));
        },
        () => resolve({ observed: false, value: undefined, time: performance.now(), spent: 0 }),
      ),
    );
  });
}

/**
 * Collects garbage (Chrome runs with --expose-gc) and pauses, untimed. It
 * ends on a timer, not a frame: after frames that changed nothing, Chrome
 * waits for the display's next refresh before producing another frame even
 * with the frame rate limit off, while after a pause it produces one at once.
 */
export async function settle(): Promise<void> {
  (globalThis as { gc?: () => void }).gc?.();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Collects garbage and waits a second, so timers a library left after destroying a grid have run. */
export async function afterTimers(): Promise<void> {
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/** Median requestAnimationFrame interval while idle. */
export async function refreshInterval(count = 30): Promise<number> {
  const times: number[] = [];
  await new Promise<void>((resolve) => {
    const step = (t: number) => {
      times.push(t);
      if (times.length > count) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const intervals = times.slice(1).map((t, i) => t - times[i]!);
  intervals.sort((a, b) => a - b);
  return intervals[intervals.length >> 1]!;
}

/** Counts long animation frames (over 50 ms) while `body` runs. */
export async function withLongFrames<T>(
  body: () => Promise<T>,
): Promise<{ value: T; longFrames: number }> {
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ type: "long-animation-frame" });
  const started = performance.now();
  try {
    const value = await body();
    // Entries arrive after their frame; give the last one time to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    entries.push(...observer.takeRecords());
    return { value, longFrames: entries.filter((entry) => entry.startTime >= started).length };
  } finally {
    observer.disconnect();
  }
}

/** A frame interval spanning k refresh periods missed k - 1 frames. */
export function droppedFrames(intervals: number[], refresh: number): number {
  return intervals.reduce(
    (sum, interval) => sum + Math.max(0, Math.round(interval / refresh) - 1),
    0,
  );
}
