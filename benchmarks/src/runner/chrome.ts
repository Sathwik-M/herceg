// Chrome settings and DevTools helpers shared by the chart and grid runners.

import type { CDPSession } from "playwright";

export const COMMON_ARGS = [
  "--js-flags=--expose-gc",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];
// Latency scenarios produce frames as fast as work allows; paced scenarios
// keep vsync so frame intervals mean what users see.
export const LATENCY_ARGS = [...COMMON_ARGS, "--disable-frame-rate-limit", "--disable-gpu-vsync"];
export const REALTIME_ARGS = COMMON_ARGS;

/** Waits for `promise` at most `ms`, ignoring its outcome. */
export function bounded(promise: Promise<unknown>, ms = 10_000): Promise<void> {
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

interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
}

/** Heap in use after forced garbage collection. */
export async function heapBytes(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = (await cdp.send("Runtime.getHeapUsage")) as HeapUsage;
  // V8 heap + Blink (Oilpan) heap + ArrayBuffer backing stores. Typed arrays
  // live in backing stores, so leaving them out would hide columnar data.
  return {
    js: usage.usedSize,
    embedder: usage.embedderHeapUsedSize ?? 0,
    backing: usage.backingStorageSize ?? 0,
    total: usage.usedSize + (usage.embedderHeapUsedSize ?? 0) + (usage.backingStorageSize ?? 0),
  };
}

/**
 * Heap reserved now, without collecting garbage: V8's committed heap plus
 * the Blink heap and ArrayBuffer backing stores, garbage included. Read
 * before and after an operation, it shows how much the operation made the
 * heap grow; it is not the operation's peak.
 */
export async function committedBytes(cdp: CDPSession): Promise<number> {
  const usage = (await cdp.send("Runtime.getHeapUsage")) as HeapUsage;
  return usage.totalSize + (usage.embedderHeapUsedSize ?? 0) + (usage.backingStorageSize ?? 0);
}
