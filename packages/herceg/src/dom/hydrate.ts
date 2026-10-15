// Hydrating a chart rendered on a server: a module of its own, so that
// charts created in the browser carry none of it.

import type { ChartSnapshot } from "../render/snapshot-format.ts";
import { adopt } from "./adopt.ts";
import { type Chart, type ChartOptions, MountedChart } from "./chart.ts";

/**
 * Mounts a chart rendered on a server (`renderToSnapshot`) by taking over
 * the element `initial.html` put in `host`, and its nodes: what the chart
 * draws the same is not drawn again, so the page neither flashes nor
 * reflows, and focus stays where it is. Give it the options the snapshot
 * was rendered from; it keeps the snapshot's locale and time zone where they
 * set none, lays out at the snapshot's size and measures text as it did
 * until its options or size change, and keeps the markup on screen while
 * code it needs first (a GPU painter, a compiler) loads.
 *
 * ```ts
 * const chart = hydrateChart(host, options, initial);
 * ```
 */
export function hydrateChart(
  host: HTMLElement,
  options: ChartOptions,
  initial: ChartSnapshot,
): Chart {
  const adopted = adopt(host, initial, options.fonts);
  const { locale = initial.locale, timeZone = initial.timeZone } = options;
  return new MountedChart(host, { ...options, locale, timeZone }, adopted);
}

/**
 * A snapshot as the adapters' `initial` takes it: with the code that
 * hydrates it, which comes into a bundle only with this call, so that
 * pages rendered in the browser alone carry none of it.
 */
export interface Hydration {
  readonly snapshot: ChartSnapshot;
  /** `hydrateChart(host, options, snapshot)`. */
  hydrate(host: HTMLElement, options: ChartOptions): Chart;
}

/**
 * The snapshot `renderToSnapshot` wrote, for a React, Vue, or Svelte
 * `<Chart initial={hydration(snapshot)}>`, on the server and in the browser.
 */
export function hydration(snapshot: ChartSnapshot): Hydration {
  return { snapshot, hydrate: (host, options) => hydrateChart(host, options, snapshot) };
}
