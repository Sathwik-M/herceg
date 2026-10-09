import type { Breaks, Mapping } from "../lod/m4.ts";
import { linearTicks, niceDomain } from "./ticks.ts";

export type ScaleType = "linear" | "log" | "time" | "band";

/**
 * Maps numeric domain values to pixels. Time values are epoch milliseconds;
 * band scales map category indices (0, 1, 2, ...) to band centers.
 */
export interface PositionScale {
  readonly type: ScaleType;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  map(value: number): number;
  invert(pixel: number): number;
  ticks(count: number): number[];
  /** Coefficients for inlining the mapping in hot loops. */
  mapping(): Mapping;
  /** Time scales with breaks: the time left out; values inside it are not drawn. */
  readonly breaks?: Breaks;
  /** Band scales: category labels in index order. */
  readonly categories?: readonly string[];
  /** Band scales: width of each band in pixels (negative for reversed ranges). */
  readonly bandwidth?: number;
  /** Band scales: the band's start edge. */
  start?(index: number): number;
}

/**
 * Linear mapping with precomputed coefficients so hot loops can inline it:
 * `pixel = offset + (value - origin) * factor`. Measuring from the domain
 * start keeps precision for narrow domains far from zero, such as a
 * millisecond-wide zoom into epoch timestamps.
 */
export class LinearScale implements PositionScale {
  readonly type: "linear" | "time" = "linear";
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly origin: number;
  readonly offset: number;
  readonly factor: number;

  constructor(domain: readonly [number, number], range: readonly [number, number]) {
    this.domain = domain;
    this.range = range;
    // Halving first avoids overflow for opposite-sign extremes.
    const halfSpan = domain[1] / 2 - domain[0] / 2;
    const zero = halfSpan === 0 || !Number.isFinite(halfSpan);
    // A zero-width domain maps everything to the middle of the range.
    this.origin = domain[0];
    this.factor = zero ? 0 : (range[1] - range[0]) / 2 / halfSpan;
    this.offset = zero ? (range[0] + range[1]) / 2 : range[0];
  }

  map(value: number): number {
    return this.offset + (value - this.origin) * this.factor;
  }

  invert(pixel: number): number {
    return this.factor === 0 ? this.domain[0] : this.origin + (pixel - this.offset) / this.factor;
  }

  ticks(count: number): number[] {
    return linearTicks(this.domain[0], this.domain[1], count);
  }

  mapping(): Mapping {
    return { origin: this.origin, offset: this.offset, factor: this.factor, log: false };
  }
}

/** Base-10 logarithmic scale. Domains must be finite and strictly positive. */
export class LogScale implements PositionScale {
  readonly type = "log" as const;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly #linear: LinearScale;

  constructor(domain: readonly [number, number], range: readonly [number, number]) {
    if (
      !(domain[0] > 0 && domain[1] > 0 && Number.isFinite(domain[0]) && Number.isFinite(domain[1]))
    ) {
      throw new RangeError("Log scale domain must be finite and positive");
    }
    this.domain = domain;
    this.range = range;
    this.#linear = new LinearScale([Math.log10(domain[0]), Math.log10(domain[1])], range);
  }

  map(value: number): number {
    return value > 0 ? this.#linear.map(Math.log10(value)) : Number.NaN;
  }

  invert(pixel: number): number {
    return 10 ** this.#linear.invert(pixel);
  }

  mapping(): Mapping {
    return { ...this.#linear.mapping(), log: true };
  }

  /**
   * Powers of ten, plus 2x and 5x multiples when the domain spans few
   * decades. Domains narrower than those fall back to linear ticks.
   */
  ticks(count: number): number[] {
    const lo = Math.min(this.domain[0], this.domain[1]);
    const hi = Math.max(this.domain[0], this.domain[1]);
    const first = Math.floor(Math.log10(lo));
    const last = Math.ceil(Math.log10(hi));
    const decades = last - first;
    const multiples = decades * 3 <= count ? [1, 2, 5] : [1];
    const every = Math.max(1, Math.ceil(decades / Math.max(1, count)));
    const ticks: number[] = [];
    for (let e = first; e <= last; e += every) {
      for (const m of multiples) {
        const value = Number((m * 10 ** e).toPrecision(12));
        if (value >= lo && value <= hi) ticks.push(value);
      }
    }
    return ticks.length >= 2 ? ticks : linearTicks(lo, hi, count);
  }
}

/** Expands a log domain outward to whole powers of ten, keeping its direction. */
export function niceLogDomain(start: number, stop: number): [number, number] {
  const lo = 10 ** Math.floor(Math.log10(Math.min(start, stop)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(start, stop)));
  return stop < start ? [hi, lo] : [lo, hi];
}

export { niceDomain };

/**
 * Evenly spaced bands for categories, for bars and heatmap cells. Values are
 * category indices; `map` returns band centers. `padding` is the fraction of
 * each step left empty between bands.
 */
export class BandScale implements PositionScale {
  readonly type = "band" as const;
  readonly categories: readonly string[];
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly padding: number;
  readonly step: number;
  readonly bandwidth: number;
  readonly #start: number;

  constructor(categories: readonly string[], range: readonly [number, number], padding = 0.2) {
    this.categories = categories;
    this.domain = [-0.5, categories.length - 0.5];
    this.range = range;
    this.padding = padding;
    const count = Math.max(1, categories.length);
    this.step = (range[1] - range[0]) / (count + padding);
    this.bandwidth = this.step * (1 - padding);
    this.#start = range[0] + this.step * padding;
  }

  /** Start edge of the band at `index`. */
  start(index: number): number {
    return this.#start + index * this.step;
  }

  /** Center of the band at `index`. */
  map(index: number): number {
    return this.start(index) + this.bandwidth / 2;
  }

  /** Fractional band index of a pixel; round it to get the nearest band. */
  invert(pixel: number): number {
    return (pixel - this.map(0)) / this.step;
  }

  /** Band index under a pixel, or -1 between or outside bands' slots. */
  index(pixel: number): number {
    const index = Math.round(this.invert(pixel));
    return index >= 0 && index < this.categories.length ? index : -1;
  }

  /** Every k-th band, so at most about `count` ticks. */
  ticks(count: number): number[] {
    const every = Math.max(1, Math.ceil(this.categories.length / Math.max(1, count)));
    const ticks: number[] = [];
    for (let i = 0; i < this.categories.length; i += every) ticks.push(i);
    return ticks;
  }

  mapping(): Mapping {
    return { origin: 0, offset: this.map(0), factor: this.step, log: false };
  }
}
