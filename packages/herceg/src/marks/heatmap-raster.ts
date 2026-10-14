// A heatmap's image: where its cells fall among the image's pixels along
// each axis, and painting the image from the table's rows. Both run once
// per repaint, over the rows and the image's pixels, never per cell slot,
// in buffers the chart keeps between frames.

import type { NumericArray } from "../data/column.ts";
import type { CellIndex } from "../lod/cell-index.ts";
import type { SequentialScale } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { AxisCells } from "./heatmap-cells.ts";
import type { BandPlaces } from "./series.ts";

/** One axis of a heatmap as its image places it: bands, or cells along a number or time scale. */
export interface AxisPlacement {
  scale: PositionScale;
  cells: AxisCells | undefined;
  places: BandPlaces | undefined;
  count: number;
}

/** A Float64Array of at least `length` items for a stage of the work, kept between frames. */
export type Buffer = (stage: string, length: number) => Float64Array;

/** One axis of the image, projected once per distinct cell before painting. */
interface AxisRaster {
  from: number;
  to: number;
  size: number;
  whole: boolean;
  pixels: Float64Array | undefined;
  starts: Float64Array | undefined;
  ends: Float64Array | undefined;
  project(pixels: boolean): void;
}

/** Placement state is private to this frame; only its projected arrays reach the row loop. */
function rasterAxis(
  { scale, cells, places, count: length }: AxisPlacement,
  [plot0, plot1]: readonly [number, number],
  ratio: number,
  buffer: Buffer,
  name: string,
): AxisRaster | undefined {
  let first = 0;
  let count = scale.categories?.length ?? 0;
  let slots: Int32Array | undefined;
  let a = scale.start?.(0) ?? 0;
  let b = a + count * (scale.bandwidth ?? 0);
  let starts: Float64Array | undefined;
  let ends: Float64Array | undefined;
  if (cells) {
    length = cells.length;
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    const lattice = cells.lattice;
    if (lattice) {
      const { start, width, size } = lattice;
      first = Math.max(0, Math.floor((cells.place(lo) - start) / width));
      const last = Math.min(size - 1, Math.ceil((cells.place(hi) - start) / width) - 1);
      count = Math.max(0, last - first + 1);
      if (count === 0) return undefined;
      a = scale.map(cells.value(start + first * width));
      b = scale.map(cells.value(start + (last + 1) * width));
      slots = lattice.slots;
    }
    // Deep zooms can project one slot to a huge image: clip to the plot
    // and treat it like an uneven cell instead.
    const reach = 2 * Math.abs(plot1 - plot0);
    if (!lattice || Math.min(a, b) < plot0 - reach || Math.max(a, b) > plot1 + reach) {
      const [first, last] = cells.overlapping(lo, hi);
      if (first > last) return undefined;
      const [lower, upper] = cells.extent(first, last);
      a = Math.max(plot0, Math.min(scale.map(lower), scale.map(upper)));
      b = Math.min(plot1, Math.max(scale.map(lower), scale.map(upper)));
      if (!(b > a)) return undefined;
      count = Infinity;
      starts = buffer(`${name}starts`, length).fill(0, 0, length);
      ends = buffer(`${name}ends`, length).fill(0, 0, length);
      const size = resolution(b - a, ratio);
      const per = size / (b - a);
      for (let i = first; i <= last; i++) {
        const [lower, upper] = cells.extent(i, i);
        const p = (scale.map(lower) - a) * per;
        const q = (scale.map(upper) - a) * per;
        starts[i] = snap(Math.max(0, Math.min(p, q)));
        ends[i] = snap(Math.min(size, Math.max(p, q)));
      }
    }
  }
  if (!(count > 0)) return undefined;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const size = Math.min(count, resolution(to - from, ratio));
  const axis: AxisRaster = {
    from,
    to,
    size,
    whole: size === count,
    pixels: undefined,
    starts,
    ends,
    project(pixels) {
      if (starts) return;
      const positions = buffer(`${name}${pixels ? "pixels" : "starts"}`, length);
      const ends = pixels ? undefined : buffer(`${name}ends`, length);
      for (let i = 0; i < length; i++) {
        const slot = (places ? places.at(i) : slots ? slots[i]! : i) - first;
        const at = b < a ? count - 1 - slot : slot;
        const shown = slot >= 0 && slot < count;
        positions[i] = shown
          ? pixels
            ? Math.floor((at * size) / count)
            : (at * size) / count
          : pixels
            ? -1
            : 0;
        if (ends) ends[i] = shown ? ((at + 1) * size) / count : 0;
      }
      if (pixels) axis.pixels = positions;
      else [axis.starts, axis.ends] = [positions, ends];
    },
  };
  return axis;
}

/** Round down so every image pixel is at least one device pixel wide. */
function resolution(length: number, ratio: number): number {
  return Math.max(1, Math.floor(length * ratio + 1e-6));
}

/** Keep floating point error from adding slivers of cells at pixel edges. */
function snap(value: number): number {
  const near = Math.round(value);
  return Math.abs(value - near) < 1e-6 ? near : value;
}

/** Lattices keep one pixel per slot while they fit; uneven cells span device pixels. */
export function rasterAxes(
  x: AxisPlacement,
  y: AxisPlacement,
  plot: { x: number; y: number; width: number; height: number },
  ratio: number,
  buffer: Buffer,
): [AxisRaster, AxisRaster] | undefined {
  const across = rasterAxis(x, [plot.x, plot.x + plot.width], ratio, buffer, "x");
  const down = rasterAxis(y, [plot.y, plot.y + plot.height], ratio, buffer, "y");
  if (!across || !down) return undefined;
  const pixels = !across.starts && !down.starts;
  across.project(pixels);
  down.project(pixels);
  return [across, down];
}

/** What a heatmap paints from: each row's cell along x and y (-1 for none), values, and rows. */
export interface PaintSource {
  x: NumericArray;
  y: NumericArray;
  values: NumericArray;
  /** The rows painted (a facet panel's); every row of the columns when undefined. */
  rows: Uint32Array | undefined;
  length: number;
  /** The index of the rows by cell (see lod/cell-index.ts), which spans paint cell by cell. */
  index: () => CellIndex;
}

/**
 * Paints the image (`pixels`, RGBA, `x.size` by `y.size`) from `source`'s
 * rows with finite values (a cell's rows combined into one already, for
 * heatmaps), accumulating in `buffer`'s stages, a value per image pixel.
 * Lattices drawn whole show each cell's last row; blocks of slots show the
 * mean of their rows (or with `reduce`, a heatmap's `sampling.reduce`, the
 * greatest or least). Spans show, in a pixel within one cell, that cell's
 * last row, and in a pixel holding parts of several, the mean of their rows
 * weighted by the area of each cell in it (or the greatest or least of
 * them), read cell by cell from `source.index`. Pixels without values stay
 * transparent.
 */
export function paint(
  source: PaintSource,
  x: AxisRaster,
  y: AxisRaster,
  colors: SequentialScale,
  reduce: "mean" | "max" | "min",
  pixels: Uint8ClampedArray,
  buffer: (stage: string) => Float64Array,
): void {
  const across = x.size;
  const count = across * y.size;
  pixels.fill(0, 0, count * 4);
  const regular = x.pixels !== undefined && y.pixels !== undefined;
  if (regular && x.whole && y.whole) {
    paintWhole(source, x.pixels!, y.pixels!, across, colors, pixels);
    return;
  }
  const mean = reduce === "mean";
  const max = reduce === "max";
  const totals = buffer("totals");
  if (regular) totals.fill(mean ? 0 : NaN, 0, count);
  // Until coloring, the pixel bytes hold integer counts for blocks, or
  // fractional area weights for spans. Neither needs another plot buffer.
  const weights = regular
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, count)
    : new Float32Array(pixels.buffer, pixels.byteOffset, count);
  const lasts = regular ? undefined : buffer("lasts");
  const overflowed = new Map<number, number>();
  const pass = regular
    ? (scaled: boolean) =>
        reduceBlocks(
          source,
          x,
          y,
          reduce,
          totals,
          weights as Uint32Array,
          scaled ? overflowed : undefined,
        )
    : (scaled: boolean) => {
        const index = source.index();
        const [xStarts, xEnds] = [x.starts!, x.ends!];
        const [yStarts, yEnds] = [y.starts!, y.ends!];
        const { values, order, rows: positions } = index;
        // Read repeated rows once per cell, then weight their aggregate by
        // the area of the cell in each pixel. A pixel within just one cell
        // shows its last finite row, matching tooltips and whole lattices.
        index.forEachRun((a, b, from, to) => {
          const x0 = xStarts[a]!;
          const x1 = xEnds[a]!;
          const y0 = yStarts[b]!;
          const y1 = yEnds[b]!;
          if (!(x1 > x0 && y1 > y0)) return;
          let total = mean ? 0 : NaN;
          let value = 0;
          for (let i = from; i < to; i++) {
            const k = order ? order[i]! : i;
            value = values[positions ? positions[k]! : k]!;
            if (mean) total += scaled ? value / 2 ** 64 : value;
            else if (max ? !(total >= value) : !(total <= value)) total = value;
          }
          const rows = to - from;
          for (let r = Math.floor(y0); r < y1; r++) {
            const dy = Math.min(y1, r + 1) - Math.max(y0, r);
            for (let c = Math.floor(x0); c < x1; c++) {
              const at = r * across + c;
              const w = (Math.min(x1, c + 1) - Math.max(x0, c)) * dy;
              if (scaled) {
                const weight = overflowed.get(at);
                if (weight === undefined) continue;
                totals[at]! += total * w;
                overflowed.set(at, weight + rows * w);
              } else if (weights[at] === 0) {
                lasts![at] = value;
                totals[at] = mean ? total * w : total;
                weights[at] = rows * w;
              } else {
                lasts![at] = NaN;
                if (mean) totals[at]! += total * w;
                else if (max ? !(totals[at]! >= total) : !(totals[at]! <= total))
                  totals[at] = total;
                weights[at]! += rows * w;
              }
            }
          }
        });
      };
  pass(false);
  // Only overflowed sums are repeated, with values divided by 2^64 to
  // leave room for 2^32 rows. Span weights are recounted in Float64.
  if (mean) {
    for (let i = 0; i < count; i++) {
      if (weights[i]! > 0 && (!lasts || Number.isNaN(lasts[i]!)) && !Number.isFinite(totals[i]!)) {
        overflowed.set(i, regular ? weights[i]! : 0);
        totals[i] = 0;
      }
    }
    if (overflowed.size) pass(true);
  }
  for (let i = 0; i < count; i++) {
    // Read the weight before coloring takes its bytes; empty pixels stay transparent.
    const weight = weights[i]!;
    if (weight === 0) continue;
    const scaled = overflowed.get(i);
    const value =
      lasts && !Number.isNaN(lasts[i]!)
        ? lasts[i]!
        : !mean
          ? totals[i]!
          : scaled !== undefined
            ? (totals[i]! / scaled) * 2 ** 64
            : totals[i]! / weight;
    colors.write(Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, value)), pixels, i * 4);
  }
}

/**
 * One pixel per slot. Missing values leave their cell transparent rather
 * than erasing an earlier value for the same cell; the cell index agrees.
 */
function paintWhole(
  source: PaintSource,
  xPixels: Float64Array,
  yPixels: Float64Array,
  across: number,
  colors: SequentialScale,
  pixels: Uint8ClampedArray,
): void {
  for (const turn = new Turns(source); turn.next(); ) {
    const { x, y, values, length } = turn;
    for (let k = 0; k < length; k++) {
      const a = x[k]!;
      const b = y[k]!;
      const value = values[k]!;
      if (a < 0 || b < 0 || !Number.isFinite(value)) continue;
      const c = xPixels[a]!;
      const r = yPixels[b]!;
      if (c >= 0 && r >= 0) colors.write(value, pixels, (r * across + c) * 4);
    }
  }
}

/** Reduce lattice blocks separately so the row loop only reads integer counts. */
function reduceBlocks(
  source: PaintSource,
  xAxis: AxisRaster,
  yAxis: AxisRaster,
  reduce: "mean" | "max" | "min",
  totals: Float64Array,
  counts: Uint32Array,
  scaled: Map<number, number> | undefined,
): void {
  const across = xAxis.size;
  const xPixels = xAxis.pixels!;
  const yPixels = yAxis.pixels!;
  for (const turn = new Turns(source); turn.next(); ) {
    const { x, y, values, length } = turn;
    for (let k = 0; k < length; k++) {
      const a = x[k]!;
      const b = y[k]!;
      const value = values[k]!;
      if (a < 0 || b < 0 || !Number.isFinite(value)) continue;
      const c = xPixels[a]!;
      const r = yPixels[b]!;
      if (c < 0 || r < 0) continue;
      const at = r * across + c;
      if (scaled) {
        if (scaled.has(at)) totals[at]! += value / 2 ** 64;
      } else if (reduce === "mean") {
        totals[at]! += value;
        counts[at]!++;
      } else {
        if (reduce === "max" ? !(totals[at]! >= value) : !(totals[at]! <= value))
          totals[at] = value;
        counts[at] = 1;
      }
    }
  }
}

/** Positions of a facet panel's rows read at a time. */
const CHUNK = 4096;
/** Buffers for chunks of rows, kept once made: chunks are read one at a time, in turn. */
let buffers: { x: Int32Array; y: Int32Array; values: Float64Array } | undefined;

/**
 * A paint source's cells and values by position, for loops over every row
 * of large grids: the columns themselves, in one turn, or for a facet
 * panel's rows, CHUNK positions a turn, gathered into buffers kept for
 * this. The loops read arrays directly either way, and nothing is
 * allocated per row, panel, or table.
 */
class Turns {
  x: NumericArray;
  y: NumericArray;
  values: NumericArray;
  /** How many positions the current turn holds. */
  length = 0;
  readonly #source: PaintSource;
  #next = 0;

  constructor(source: PaintSource) {
    this.#source = source;
    ({ x: this.x, y: this.y, values: this.values } = source);
  }

  /** Moves to the next turn's positions; false when there are no more. */
  next(): boolean {
    const s = this.#source;
    const start = this.#next;
    if (start >= s.length) return false;
    if (!s.rows) {
      this.length = s.length;
      this.#next = s.length;
      return true;
    }
    buffers ??= {
      x: new Int32Array(CHUNK),
      y: new Int32Array(CHUNK),
      values: new Float64Array(CHUNK),
    };
    const { x, y, values } = buffers;
    const length = Math.min(CHUNK, s.length - start);
    for (let i = 0; i < length; i++) {
      const row = s.rows[start + i]!;
      x[i] = s.x[row]!;
      y[i] = s.y[row]!;
      values[i] = s.values[row]!;
    }
    [this.x, this.y, this.values, this.length] = [x, y, values, length];
    this.#next = start + length;
    return true;
  }
}
