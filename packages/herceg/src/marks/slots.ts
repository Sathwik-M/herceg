// Slots: the room each position of a mark gets on a number or time axis,
// from the smallest gap between its distinct positions, so marks drawn that
// wide (bars, candlesticks) never overlap their neighbors.

import { lowerBound, type Table, upperBound } from "../data/table.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TableCache } from "./series.ts";

/** Share of a slot a mark fills, and the widest it gets in pixels. */
export const FILL = 0.8;
export const MAX_WIDTH = 64;

interface Positions {
  /** Distinct finite values, ascending. */
  values: Float64Array;
  /** Smallest gap between neighboring values, linear and in log10 units. */
  gap: number;
  logGap: number;
}

export class Slots {
  readonly #table: Table;
  readonly #field: string;
  readonly #positions = new TableCache<Positions>();

  constructor(table: Table, field: string) {
    this.#table = table;
    this.#field = field;
  }

  /** The field's distinct positions and the gaps between them, per table version. */
  positions(): Positions {
    return this.#positions.get(this.#table, () => {
      const field = this.#field as never;
      const x = this.#table.numbers(field);
      const sorted = Float64Array.from(x);
      if (!this.#table.isSorted(field)) sorted.sort();
      let count = 0;
      for (const value of sorted) {
        if (Number.isFinite(value) && (count === 0 || value !== sorted[count - 1])) {
          sorted[count++] = value;
        }
      }
      const values = sorted.subarray(0, count);
      return { values, gap: minGap(values, false), logGap: minGap(values, true) };
    });
  }

  /**
   * `extent` widened by half a slot at each end, measured on the axis' own
   * scale so log axes keep positive bounds.
   */
  pad(extent: readonly [number, number], log: boolean): readonly [number, number] {
    const { gap, logGap } = this.positions();
    const [lo, hi] = log ? [Math.log10(extent[0]), Math.log10(extent[1])] : extent;
    const half = ((log ? logGap : gap) || hi - lo || 1) / 2;
    const [start, end] = log ? [10 ** (lo - half), 10 ** (hi + half)] : [lo - half, hi + half];
    // Padding that overflows or underflows keeps the data's own end.
    const usable = (value: number) => Number.isFinite(value) && (!log || value > 0);
    return [usable(start) ? start : extent[0], usable(end) ? end : extent[1]];
  }

  /** Smallest pixel distance between neighboring positions in view. */
  pixelGap(scale: PositionScale): number {
    const positions = this.positions().values;
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    // One neighbor past each edge, so zooming onto one position keeps its width.
    const start = Math.max(0, lowerBound(positions, lo) - 1);
    const end = Math.min(positions.length, upperBound(positions, hi) + 1);
    let best = Infinity;
    let previous = Number.NaN;
    for (let i = start; i < end; i++) {
      const pixel = scale.map(positions[i]!);
      if (!Number.isFinite(pixel)) continue;
      const gap = Math.abs(pixel - previous);
      if (gap < best) best = gap;
      previous = pixel;
    }
    return best > 0 && Number.isFinite(best) ? best : MAX_WIDTH / FILL;
  }

  /** Pixel width of a slot's mark: its share of the smallest gap, up to the maximum. */
  width(scale: PositionScale): number {
    return Math.min(MAX_WIDTH, this.pixelGap(scale) * FILL);
  }
}

/** Smallest gap between neighboring positions, in log10 units on log axes. */
function minGap(positions: Float64Array, log: boolean): number {
  let best = Infinity;
  let previous = Number.NaN;
  for (const position of positions) {
    if (log && !(position > 0)) continue;
    const value = log ? Math.log10(position) : position;
    if (value - previous < best) best = value - previous;
    previous = value;
  }
  return Number.isFinite(best) ? best : 0;
}
