// Where a heatmap's cells lie along an axis of numbers or times. Cells come
// from the field's distinct values and their edges from the data alone, so
// zooming and panning never move them.

import type { NumericArray } from "../data/column.ts";
import type { Breaks } from "../lod/m4.ts";
import { usableDomain } from "../model/axis.ts";

/** How far, in cells, values may stray from a lattice and still be drawn on it. */
const TOLERANCE = 1e-6;
/** Most lattice slots: slot numbers are whole numbers in 32-bit arrays. */
const MAX_SLOTS = 2 ** 30;

/**
 * Cells one width apart on a lattice: cell i is slot `slots[i]` (slot i
 * without `slots`), from `start + slot * width` to one width more. Gaps in
 * the data are empty slots, which take no memory.
 */
export interface Lattice {
  readonly start: number;
  readonly width: number;
  readonly slots: Int32Array | undefined;
  /** Slots from the first cell's to the last's, inclusive. */
  readonly size: number;
}

/**
 * A heatmap axis' cells along a number or time axis: their edges, and each
 * row's cell. `placeCells` places one per distinct value of a field; a
 * calendar places one per week (heatmap-calendar.ts).
 */
export class AxisCells {
  /** Each cell's value, ascending: the distinct value whose rows it holds, or its week's start. */
  readonly values: Float64Array;
  /** Cell i spans the places [lower[i], upper[i]); both ascend. */
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  /** Each row's cell, -1 for rows without one. */
  readonly cells: Int32Array;
  /** Set when the cells lie on a lattice of places (within a millionth of a cell), which draws faster. */
  readonly lattice: Lattice | undefined;
  /** The breaks cells are placed around: places are the time an axis with them shows. */
  readonly breaks: Breaks | undefined;

  constructor(
    values: Float64Array,
    lower: Float64Array,
    upper: Float64Array,
    cells: Int32Array,
    lattice: Lattice | undefined,
    breaks?: Breaks,
  ) {
    this.values = values;
    this.lower = lower;
    this.upper = upper;
    this.cells = cells;
    this.lattice = lattice;
    this.breaks = breaks;
  }

  get length(): number {
    return this.values.length;
  }

  /** Where a value is placed among the cells' edges. */
  place(value: number): number {
    return this.breaks ? this.breaks.collapse(value) : value;
  }

  /** The value at a place, as scales take it. */
  value(place: number): number {
    return this.breaks ? this.breaks.expand(place) : place;
  }

  /**
   * The cell whose span holds `value` (the last cell's holds its upper edge
   * too), or -1 in a gap or past the cells.
   */
  find(value: number): number {
    const { lower, upper } = this;
    const at = this.place(value);
    // The last cell starting at or before the value.
    let lo = 0;
    let hi = lower.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lower[mid]! <= at) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) return -1;
    return at < upper[i]! || (i === upper.length - 1 && at === upper[i]) ? i : -1;
  }

  /** The first and last cells overlapping the values (lo, hi) by more than an edge; first > last for none. */
  overlapping(lo: number, hi: number): [number, number] {
    const { lower, upper } = this;
    const [from, to] = [this.place(lo), this.place(hi)];
    let a = 0;
    let b = upper.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (upper[mid]! <= from) a = mid + 1;
      else b = mid;
    }
    const first = a;
    b = lower.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (lower[mid]! < to) a = mid + 1;
      else b = mid;
    }
    return [first, a - 1];
  }

  /** The values at the edges of cells `first` to `last`. */
  extent(first: number, last: number): [number, number] {
    return [this.value(this.lower[first]!), this.value(this.upper[last]!)];
  }
}

/**
 * One cell per distinct finite value of `column`, ascending. Without a
 * step, each reaches halfway to the values beside it, and the first and
 * last as far past their values as toward their one neighbor. With `step`,
 * each is `step` wide around its value, but never past halfway to a
 * neighbor closer than that, so cells never overlap and values further
 * apart leave gaps. A lone value's cell spans what an axis shows for that
 * value alone (`usableDomain`). Edges come from the data alone, so zooming
 * and panning never move them, and a boundary two cells share is one
 * number, so no value falls between them. Values too close together for
 * doubles to give each a cell of its own around it, or a step too small to,
 * are refused (in errors that `name` the axis).
 *
 * On a time axis with breaks, values in time it leaves out have no cell,
 * and the others are placed in the time it shows (`Breaks.collapse`), so
 * cells either side of a break meet at its seam as if the break were not
 * there.
 */
export function placeCells(
  column: NumericArray,
  step: number | undefined,
  time: boolean,
  breaks?: Breaks,
  name = "Heatmap",
): AxisCells {
  let [values, cells] = distinct(column);
  let places = values;
  if (breaks) {
    const kept = new Int32Array(values.length);
    let shown = 0;
    for (let i = 0; i < values.length; i++) kept[i] = breaks.hides(values[i]!) ? -1 : shown++;
    if (shown < values.length) {
      values = values.filter((_, i) => kept[i]! >= 0);
      for (let k = 0; k < cells.length; k++) if (cells[k]! >= 0) cells[k] = kept[cells[k]!]!;
    }
    places = values.map((v) => breaks.collapse(v));
  }
  const n = values.length;
  // A lattice whose edges float error moves off a value's own cell is no lattice.
  let lattice = n > 0 ? latticeOf(places, step, time) : undefined;
  let edges = lattice && latticeEdges(lattice, n);
  if (edges && misplaced(places, edges) >= 0) [lattice, edges] = [undefined, undefined];
  edges ??= midpointEdges(places, step);
  const wrong = misplaced(places, edges);
  if (wrong >= 0)
    throw new RangeError(
      step === undefined
        ? `${name} values near ${values[wrong]} are too close to tell their cells apart`
        : `${name}Step ${step} is too small for values near ${values[wrong]}`,
    );
  return new AxisCells(values, edges[0], edges[1], cells, lattice, breaks);
}

/**
 * The first cell whose edges do not hold its own place with room to spare
 * (an edge float error put on or past it), or -1 when every cell does.
 */
function misplaced(places: Float64Array, [lower, upper]: [Float64Array, Float64Array]): number {
  const last = places.length - 1;
  for (let i = 0; i <= last; i++) {
    const v = places[i]!;
    if (
      !(
        lower[i]! <= v &&
        (v < upper[i]! || (i === last && v <= upper[i]!)) &&
        lower[i]! < upper[i]!
      )
    )
      return i;
  }
  return -1;
}

/** The edges of a lattice's `n` cells: one expression for each boundary, which cells share. */
export function latticeEdges(lattice: Lattice, n: number): [Float64Array, Float64Array] {
  const { start, width, slots } = lattice;
  const lower = new Float64Array(n);
  const upper = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const slot = slots ? slots[i]! : i;
    lower[i] = start + slot * width;
    upper[i] = start + (slot + 1) * width;
  }
  return [lower, upper];
}

/**
 * Edges halfway between neighboring places, the ends as far out as in;
 * with `step`, never more than half a step from a place.
 */
function midpointEdges(
  places: Float64Array,
  step: number | undefined,
): [Float64Array, Float64Array] {
  const n = places.length;
  const lower = new Float64Array(n);
  const upper = new Float64Array(n);
  if (n === 0) return [lower, upper];
  // Gaps are halved first, so that those of extreme values do not overflow.
  const half = step === undefined ? Number.POSITIVE_INFINITY : step / 2;
  for (let i = 1; i < n; i++) {
    const [p, v] = [places[i - 1]!, places[i]!];
    if (v / 2 - p / 2 <= half) {
      const mid = finite(p / 2 + v / 2);
      [upper[i - 1], lower[i]] = [mid, mid];
    } else [upper[i - 1], lower[i]] = [finite(p + half), finite(v - half)];
  }
  // The ends reach half a step out, or without one as far out as in.
  const [first, last] = [places[0]!, places[n - 1]!];
  const out =
    step === undefined && n > 1
      ? [places[1]! / 2 - first / 2, last / 2 - places[n - 2]! / 2]
      : [half, half];
  lower[0] = finite(first - out[0]!);
  upper[n - 1] = finite(last + out[1]!);
  return [lower, upper];
}

/** Edges stay finite where values near the largest doubles would reach past them. */
function finite(edge: number): number {
  return Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, edge));
}

/**
 * The column's distinct finite values, ascending, and each row's index
 * among them (-1 for none): numbered as they appear through a Map, then
 * renumbered in order, since grids have far fewer distinct values than rows.
 */
function distinct(column: NumericArray): [Float64Array, Int32Array] {
  const ids = new Map<number, number>();
  const own = new Int32Array(column.length);
  for (let i = 0; i < column.length; i++) {
    const v = column[i]!;
    if (!Number.isFinite(v)) {
      own[i] = -1;
      continue;
    }
    let id = ids.get(v);
    if (id === undefined) {
      id = ids.size;
      ids.set(v, id);
    }
    own[i] = id;
  }
  const values = Float64Array.from(ids.keys()).sort();
  const rank = new Int32Array(values.length);
  for (let k = 0; k < values.length; k++) rank[ids.get(values[k]!)!] = k;
  for (let i = 0; i < own.length; i++) if (own[i]! >= 0) own[i] = rank[own[i]!]!;
  return [values, own];
}

/**
 * The lattice ascending `places` lie on, if any: one `step` apart (gaps
 * whole numbers of steps), or without a step evenly spaced; a lone value's
 * cell is a lattice of one.
 */
export function latticeOf(
  places: Float64Array,
  step: number | undefined,
  time: boolean,
): Lattice | undefined {
  const n = places.length;
  const first = places[0]!;
  if (n === 1) {
    const [lo, hi] =
      step === undefined
        ? usableDomain([first, first], time ? "time" : "linear")
        : [first - step / 2, first + step / 2];
    const start = finite(lo);
    const width = finite(hi) - start;
    return start + width > start && Number.isFinite(start + width)
      ? { start, width, slots: undefined, size: 1 }
      : undefined;
  }
  const width = step ?? (places[n - 1]! - first) / (n - 1);
  if (!(width > 0 && Number.isFinite(width))) return undefined;
  const slots = step === undefined ? undefined : new Int32Array(n);
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const slot = step === undefined ? i : Math.round((places[i]! - first) / width);
    if (!(slot > previous && slot < MAX_SLOTS)) return undefined;
    if (Math.abs(places[i]! - (first + slot * width)) > width * TOLERANCE) return undefined;
    if (slots) slots[i] = slot;
    previous = slot;
  }
  // The outer edges stay finite, and each cell's edges apart.
  const start = first - width / 2;
  const end = start + (previous + 1) * width;
  if (!(Number.isFinite(start) && Number.isFinite(end) && start + width > start)) return undefined;
  if (!(end > start + previous * width)) return undefined;
  // Slots one apart are each cell's own index.
  const dense = previous === n - 1;
  return { start, width, slots: dense ? undefined : slots, size: previous + 1 };
}

/** The first and last cell that rows hold (every row, or `rows`); undefined when they hold none. */
export function heldCells(
  cells: AxisCells,
  rows: Uint32Array | undefined,
): [number, number] | undefined {
  if (!rows) return cells.length > 0 ? [0, cells.length - 1] : undefined;
  const own = cells.cells;
  let first = cells.length;
  let last = -1;
  for (let k = 0; k < rows.length; k++) {
    const c = own[rows[k]!]!;
    if (c < 0) continue;
    if (c < first) first = c;
    if (c > last) last = c;
  }
  return first <= last ? [first, last] : undefined;
}
