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
export type AxisPlacement =
  | {
      kind: "bands";
      scale: PositionScale;
      /** Where a panel holding only some of the chart's bands places them. */
      places: BandPlaces | undefined;
      /** Chart bands the rows' band indices reach. */
      count: number;
    }
  | { kind: "cells"; scale: PositionScale; cells: AxisCells };

/** A Float64Array of at least `length` items for a stage of the work, kept between frames. */
export type Buffer = (stage: string, length: number) => Float64Array;

/** Where one axis of the image is, and where each cell (by its band or cell index) lands in it. */
export interface AxisRaster {
  /** The image's ends along the axis, in CSS pixels, ascending. */
  from: number;
  to: number;
  /** Image pixels along the axis. */
  size: number;
  /** With lattices on both axes: each cell's image pixel, -1 for none. */
  pixels: Float64Array | undefined;
  /** Each image pixel holds one lattice slot, so cells are drawn rather than reduced. */
  whole: boolean;
  /**
   * Otherwise: each cell's start and end along the axis in image pixels;
   * a cell starting at or after its end is not drawn.
   */
  starts: Float64Array | undefined;
  ends: Float64Array | undefined;
}

/**
 * Lattice slots in view along an axis: `count` slots from CSS `edge0` (the
 * first's leading edge) to `edge1` (the last's trailing one), and each of
 * the `cells` cells' slot among them (-1 for none).
 */
interface SlotView {
  count: number;
  edge0: number;
  edge1: number;
  slots: Float64Array;
  cells: number;
}

/** A lattice in view may reach this many plot lengths past the plot before images clip to it. */
const REACH = 2;

/**
 * Where both axes of a heatmap's image are for this frame, over `plot`, at
 * `ratio` image pixels per CSS pixel at most; undefined when no cell is in
 * view. Lattices on both axes (bands, or cells one width apart) keep the
 * image at the resolution of the slots in view while they fit; otherwise
 * both axes are placed as spans of the plot's pixels.
 */
export function rasterAxes(
  x: AxisPlacement,
  y: AxisPlacement,
  plot: { x: number; y: number; width: number; height: number },
  ratio: number,
  buffer: Buffer,
): [AxisRaster, AxisRaster] | undefined {
  const ends = [
    [plot.x, plot.x + plot.width],
    [plot.y, plot.y + plot.height],
  ] as const;
  const names = ["x", "y"] as const;
  const placements = [x, y] as const;
  const views = placements.map((placement, i) => slotView(placement, ends[i]!, buffer, names[i]!));
  if (views.some((view) => view?.count === 0)) return undefined;
  const lattice = views.every((view) => view !== undefined);
  const axes = placements.map((placement, i) => {
    const view = views[i];
    return view
      ? latticeAxis(view, ratio, lattice, buffer, names[i]!)
      : spanAxis(placement as CellPlacement, ends[i]!, ratio, buffer, names[i]!);
  });
  return axes[0] && axes[1] ? [axes[0], axes[1]] : undefined;
}

type CellPlacement = Extract<AxisPlacement, { kind: "cells" }>;

/**
 * The slots in view of a lattice axis, or undefined when its cells are not
 * on a lattice, or when the slots in view reach so far past the plot (deep
 * in a zoom) that an image of them would be huge.
 */
function slotView(
  placement: AxisPlacement,
  [plot0, plot1]: readonly [number, number],
  buffer: Buffer,
  name: string,
): SlotView | undefined {
  const { scale } = placement;
  if (placement.kind === "bands") {
    const count = scale.categories?.length ?? 0;
    const slots = buffer(`${name}slots`, placement.count);
    for (let band = 0; band < placement.count; band++)
      slots[band] = placement.places ? placement.places.at(band) : band;
    const edge0 = scale.start!(0);
    return { count, edge0, edge1: edge0 + count * scale.bandwidth!, slots, cells: placement.count };
  }
  const { cells } = placement;
  const lattice = cells.lattice;
  if (!lattice) return undefined;
  const { start, width } = lattice;
  // Places on a time axis with breaks are the time it shows, which it maps evenly.
  const lo = cells.place(Math.min(scale.domain[0], scale.domain[1]));
  const hi = cells.place(Math.max(scale.domain[0], scale.domain[1]));
  const first = Math.max(0, Math.floor((lo - start) / width));
  const last = Math.min(lattice.size - 1, Math.ceil((hi - start) / width) - 1);
  const count = Math.max(0, last - first + 1);
  const edge0 = scale.map(cells.value(start + first * width));
  const edge1 = scale.map(cells.value(start + (last + 1) * width));
  const reach = REACH * Math.abs(plot1 - plot0);
  if (Math.min(edge0, edge1) < plot0 - reach || Math.max(edge0, edge1) > plot1 + reach)
    return undefined;
  const slots = buffer(`${name}slots`, cells.length);
  for (let i = 0; i < cells.length; i++) {
    const slot = (lattice.slots ? lattice.slots[i]! : i) - first;
    slots[i] = slot >= 0 && slot < count ? slot : -1;
  }
  return { count, edge0, edge1, slots, cells: cells.length };
}

/**
 * A lattice axis of the image: a pixel per slot while the slots fit the
 * plot's pixels at `ratio`, else as many pixels as fit, each a block of
 * slots (a slot falls in the pixel its leading edge lies in). With
 * `pixels`, each cell's pixel (in the view's own buffer); otherwise each
 * cell's span of pixels.
 */
function latticeAxis(
  view: SlotView,
  ratio: number,
  pixels: boolean,
  buffer: Buffer,
  name: string,
): AxisRaster {
  const { count, edge0, edge1, slots, cells } = view;
  const from = Math.min(edge0, edge1);
  const to = Math.max(edge0, edge1);
  // Rounding down keeps every image pixel at least a device pixel wide, so
  // drawing it never skips one (and with it a block's only hot cell); a
  // millionth of a pixel of slack keeps float error from costing a pixel
  // when the slots fit exactly.
  const size = Math.min(count, Math.max(1, Math.floor((to - from) * ratio + 1e-6)));
  // Image pixels run left to right and top to bottom, slots along the scale.
  const reversed = edge1 < edge0;
  const axis: AxisRaster = {
    from,
    to,
    size,
    pixels: undefined,
    whole: size === count,
    starts: undefined,
    ends: undefined,
  };
  if (pixels) {
    for (let i = 0; i < cells; i++) {
      const slot = slots[i]!;
      if (slot >= 0) slots[i] = Math.floor(((reversed ? count - 1 - slot : slot) * size) / count);
    }
    axis.pixels = slots;
    return axis;
  }
  const starts = buffer(`${name}starts`, cells);
  const ends = buffer(`${name}ends`, cells);
  for (let i = 0; i < cells; i++) {
    const slot = slots[i]!;
    const at = reversed ? count - 1 - slot : slot;
    [starts[i], ends[i]] = slot < 0 ? [0, 0] : [(at * size) / count, ((at + 1) * size) / count];
  }
  [axis.starts, axis.ends] = [starts, ends];
  return axis;
}

/**
 * An axis of cells off a lattice: the image spans the plot's pixels where
 * cells are in view, each cell its projected edges. Cells narrower than
 * float precision on the scale are not drawn.
 */
function spanAxis(
  { scale, cells }: CellPlacement,
  [plot0, plot1]: readonly [number, number],
  ratio: number,
  buffer: Buffer,
  name: string,
): AxisRaster | undefined {
  const lo = Math.min(scale.domain[0], scale.domain[1]);
  const hi = Math.max(scale.domain[0], scale.domain[1]);
  const [first, last] = cells.overlapping(lo, hi);
  if (first > last) return undefined;
  const [lower, upper] = cells.extent(first, last);
  const [a, b] = [scale.map(lower), scale.map(upper)];
  const from = Math.max(plot0, Math.min(a, b));
  const to = Math.min(plot1, Math.max(a, b));
  if (!(to > from)) return undefined;
  const size = Math.max(1, Math.floor((to - from) * ratio + 1e-6));
  const per = size / (to - from);
  const starts = buffer(`${name}starts`, cells.length).fill(0, 0, cells.length);
  const ends = buffer(`${name}ends`, cells.length).fill(0, 0, cells.length);
  // Edges a millionth of a pixel from a pixel boundary are on it, so float
  // error never gives a pixel a sliver of a cell.
  const snap = (v: number) => {
    const near = Math.round(v);
    return Math.abs(v - near) < 1e-6 ? near : v;
  };
  for (let i = first; i <= last; i++) {
    const [lower, upper] = cells.extent(i, i);
    const p = (scale.map(lower) - from) * per;
    const q = (scale.map(upper) - from) * per;
    starts[i] = snap(Math.max(0, Math.min(p, q)));
    ends[i] = snap(Math.min(size, Math.max(p, q)));
  }
  return { from, to, size, pixels: undefined, whole: false, starts, ends };
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
 * rows with finite values, accumulating in `buffer`'s stages, a value per
 * image pixel. Lattices drawn whole show each cell's last row; blocks of
 * slots show the mean of their rows (or with `reduce`, the greatest or
 * least). Spans show, in a pixel within one cell, that cell's last row, and
 * in a pixel holding parts of several, the mean of their rows weighted by
 * the area of each cell in it (or the greatest or least of them), read
 * cell by cell from `source.index`. Pixels without values stay transparent.
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
  const count = x.size * y.size;
  pixels.fill(0, 0, count * 4);
  if (x.pixels && y.pixels) {
    if (x.whole && y.whole) paintWhole(source, x.pixels, y.pixels, x.size, colors, pixels);
    else paintBlocks(source, x.pixels, y.pixels, x.size, count, colors, reduce, pixels, buffer);
  } else paintSpans(source.index(), x, y, colors, reduce, pixels, buffer);
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

/**
 * Blocks of slots: each pixel colored by the mean (or the greatest or
 * least) of its rows' finite values, accumulated in one pass over the rows
 * (and a second for sums that overflow).
 */
function paintBlocks(
  source: PaintSource,
  xPixels: Float64Array,
  yPixels: Float64Array,
  across: number,
  count: number,
  colors: SequentialScale,
  reduce: "mean" | "max" | "min",
  pixels: Uint8ClampedArray,
  buffer: (stage: string) => Float64Array,
): void {
  // Sums for means, otherwise the greatest or least value so far (NaN for none yet).
  const totals = buffer("totals").fill(reduce === "mean" ? 0 : Number.NaN, 0, count);
  // Until it is colored, each pixel's four bytes count its block's values.
  const counts = new Uint32Array(pixels.buffer, pixels.byteOffset, count);
  const pass = (scaled: Set<number> | undefined) => {
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
        } else if (reduce === "max" ? !(totals[at]! >= value) : !(totals[at]! <= value)) {
          totals[at] = value;
        }
      }
    }
  };
  pass(undefined);
  if (reduce !== "mean") {
    for (let i = 0; i < count; i++)
      if (!Number.isNaN(totals[i]!)) colors.write(totals[i]!, pixels, i * 4);
    return;
  }
  // Sums of values near the largest doubles can overflow. Those blocks are
  // summed again with every value divided by 2^64, which leaves room for
  // 2^32 rows; only values under about 1e-288 lose precision that way.
  const overflowed = overflowing(totals, (i) => counts[i]! > 0, count);
  if (overflowed.size > 0) {
    for (const i of overflowed) totals[i] = 0;
    pass(overflowed);
  }
  for (let i = 0; i < count; i++) {
    // Read the count before the color takes its bytes; empty blocks stay transparent.
    const n = counts[i]!;
    if (n === 0) continue;
    const mean = overflowed.has(i) ? (totals[i]! / n) * 2 ** 64 : totals[i]! / n;
    colors.write(finite(mean), pixels, i * 4);
  }
}

/** A value within the finite doubles. */
function finite(value: number): number {
  return Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, value));
}

/** Pixels with values whose sums overflowed. */
function overflowing(totals: Float64Array, filled: (i: number) => boolean, count: number) {
  const overflowed = new Set<number>();
  for (let i = 0; i < count; i++) if (filled(i) && !Number.isFinite(totals[i]!)) overflowed.add(i);
  return overflowed;
}

/**
 * Spans of pixels: each cell covers a rectangle of pixels, wholly or in
 * part, and adds the sum of its rows' values to each by the area it covers
 * there (or takes their greatest or least), so a cell is painted once
 * however many rows repeat it, and the result does not depend on the rows'
 * order. A pixel within one cell shows that cell's last row (`lasts`, NaN
 * once a second cell reaches the pixel), so cells the image draws larger
 * than a pixel show what tooltips report even at their edges.
 */
function paintSpans(
  index: CellIndex,
  xAxis: AxisRaster,
  yAxis: AxisRaster,
  colors: SequentialScale,
  reduce: "mean" | "max" | "min",
  pixels: Uint8ClampedArray,
  buffer: (stage: string) => Float64Array,
): void {
  const across = xAxis.size;
  const count = across * yAxis.size;
  const totals = buffer("totals");
  const lasts = buffer("lasts");
  // Until it is colored, each pixel's four bytes hold its rows' weight: the
  // area their cells cover there, a row at a time.
  const weights = new Float32Array(pixels.buffer, pixels.byteOffset, count);
  const xStarts = xAxis.starts!;
  const xEnds = xAxis.ends!;
  const yStarts = yAxis.starts!;
  const yEnds = yAxis.ends!;
  const { values, order, rows: positions } = index;
  const mean = reduce === "mean";
  /**
   * Adds each cell's rows to the pixels it covers; with `scaled`, to
   * overflowed ones only, scaled down, their weights summed in Float64.
   */
  const pass = (scaled: Map<number, number> | undefined) =>
    index.forEachRun((a, b, from, to) => {
      const x0 = xStarts[a]!;
      const x1 = xEnds[a]!;
      const y0 = yStarts[b]!;
      const y1 = yEnds[b]!;
      if (!(x1 > x0 && y1 > y0)) return;
      // The cell's rows (the index holds those with values): their sum, or
      // greatest or least, and the last of them.
      let total = mean ? 0 : Number.NaN;
      let value = 0;
      for (let i = from; i < to; i++) {
        const k = order ? order[i]! : i;
        value = values[positions ? positions[k]! : k]!;
        if (mean) total += scaled ? value / 2 ** 64 : value;
        else if (reduce === "max" ? !(total >= value) : !(total <= value)) total = value;
      }
      const rows = to - from;
      for (let r = Math.floor(y0); r < y1; r++) {
        const dy = Math.min(y1, r + 1) - Math.max(y0, r);
        for (let c = Math.floor(x0); c < x1; c++) {
          const at = r * across + c;
          const w = (Math.min(x1, c + 1) - Math.max(x0, c)) * dy;
          if (scaled) {
            const weight = scaled.get(at);
            if (weight === undefined) continue;
            totals[at]! += total * w;
            scaled.set(at, weight + rows * w);
          } else if (weights[at] === 0) {
            [lasts[at], totals[at], weights[at]] = [value, mean ? total * w : total, rows * w];
          } else {
            lasts[at] = Number.NaN;
            if (mean) totals[at]! += total * w;
            else if (reduce === "max" ? !(totals[at]! >= total) : !(totals[at]! <= total))
              totals[at] = total;
            weights[at]! += rows * w;
          }
        }
      }
    });
  pass(undefined);
  // Sums near the largest doubles can overflow: as for blocks, those pixels
  // are summed again, scaled down by 2^64.
  const shared = (i: number) => weights[i]! > 0 && Number.isNaN(lasts[i]!);
  const overflowed = new Map<number, number>();
  if (mean) for (const i of overflowing(totals, shared, count)) overflowed.set(i, 0);
  if (overflowed.size > 0) {
    for (const i of overflowed.keys()) totals[i] = 0;
    pass(overflowed);
  }
  for (let i = 0; i < count; i++) {
    // Read the weight before the color takes its bytes; uncovered pixels stay transparent.
    const w = weights[i]!;
    if (w === 0) continue;
    const scaled = overflowed.get(i);
    const value = !Number.isNaN(lasts[i]!)
      ? lasts[i]!
      : !mean
        ? totals[i]!
        : scaled !== undefined
          ? (totals[i]! / scaled) * 2 ** 64
          : totals[i]! / w;
    // A mean of finite values is finite, though rounding may carry it past the largest double.
    colors.write(finite(value), pixels, i * 4);
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
