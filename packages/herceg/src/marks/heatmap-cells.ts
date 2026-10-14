// Where a heatmap's cells lie along an axis of numbers or times. Cells come
// from the field's distinct values and their edges from the data alone, so
// zooming and panning never move them.

import type { NumericArray } from "../data/column.ts";
import { lowerBound, upperBound } from "../data/table.ts";
import type { CellIndex } from "../lod/cell-index.ts";
import type { Breaks } from "../lod/m4.ts";
import { usableDomain } from "../model/axis.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { BandPlaces } from "./series.ts";

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
    const i = upperBound(lower, at) - 1;
    if (i < 0) return -1;
    return at < upper[i]! || (i === upper.length - 1 && at === upper[i]) ? i : -1;
  }

  /** The first and last cells overlapping the values (lo, hi) by more than an edge; first > last for none. */
  overlapping(lo: number, hi: number): [number, number] {
    const { lower, upper } = this;
    const [from, to] = [this.place(lo), this.place(hi)];
    const first = upperBound(upper, from);
    return [first, lowerBound(lower, to, first) - 1];
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
  name = "heatmap",
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
        ? `${name}: values near ${values[wrong]} are too close to tell their cells apart`
        : `${name}Step: ${step} is too small for values near ${values[wrong]}; give a larger step`,
    );
  return new AxisCells(values, edges[0], edges[1], cells, lattice, breaks);
}

/**
 * The cells between each row's `lower` and `upper` edge (the bins of a
 * `bin` transform with `end`, say): one per distinct lower edge, ascending,
 * reaching to the upper edge its rows share. Rows without both edges, or
 * with an upper edge not above the lower, have no cell. Cells of one lower
 * edge and two upper ones, or that overlap, are refused (in errors that
 * `name` the axis). Evenly spaced cells of one width lie on a lattice.
 */
export function boundedCells(lower: NumericArray, upper: NumericArray, name: string): AxisCells {
  const [starts, cells] = distinct(lower);
  const ends = new Float64Array(starts.length).fill(Number.NaN);
  for (let row = 0; row < cells.length; row++) {
    const c = cells[row]!;
    if (c < 0) continue;
    const end = upper[row]!;
    if (!(end > lower[row]! && Number.isFinite(end))) {
      cells[row] = -1;
      continue;
    }
    if (Number.isNaN(ends[c]!)) ends[c] = end;
    else if (ends[c] !== end)
      throw new RangeError(
        `${name}1: rows from ${starts[c]} end at ${ends[c]} and at ${end}; give each cell one ${name.slice(-1)}2`,
      );
  }
  // Starts whose rows have no usable end make no cell.
  const kept = new Int32Array(starts.length);
  let n = 0;
  for (let c = 0; c < starts.length; c++) kept[c] = Number.isNaN(ends[c]!) ? -1 : n++;
  const lowerEdges = new Float64Array(n);
  const upperEdges = new Float64Array(n);
  for (let c = 0; c < starts.length; c++) {
    if (kept[c]! < 0) continue;
    lowerEdges[kept[c]!] = starts[c]!;
    upperEdges[kept[c]!] = ends[c]!;
  }
  if (n < starts.length)
    for (let row = 0; row < cells.length; row++)
      if (cells[row]! >= 0) cells[row] = kept[cells[row]!]!;
  for (let i = 1; i < n; i++)
    if (upperEdges[i - 1]! > lowerEdges[i]!)
      throw new RangeError(
        `${name}1: the cells from ${lowerEdges[i - 1]} to ${upperEdges[i - 1]} and from ${lowerEdges[i]} to ${upperEdges[i]} overlap; give cells that do not`,
      );
  return new AxisCells(
    lowerEdges,
    lowerEdges,
    upperEdges,
    cells,
    boundedLattice(lowerEdges, upperEdges),
  );
}

/** The lattice cells between edges lie on, if they are all one width, a whole number of widths apart. */
function boundedLattice(lower: Float64Array, upper: Float64Array): Lattice | undefined {
  const n = lower.length;
  if (n === 0) return undefined;
  const start = lower[0]!;
  const width = upper[0]! - start;
  if (!(width > 0 && Number.isFinite(width))) return undefined;
  const slots = new Int32Array(n);
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const slot = Math.round((lower[i]! - start) / width);
    if (!(slot > previous && slot < MAX_SLOTS)) return undefined;
    if (Math.abs(lower[i]! - (start + slot * width)) > width * TOLERANCE) return undefined;
    if (Math.abs(upper[i]! - lower[i]! - width) > width * TOLERANCE) return undefined;
    slots[i] = slot;
    previous = slot;
  }
  const dense = previous === n - 1;
  return { start, width, slots: dense ? undefined : slots, size: previous + 1 };
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
 * The column's distinct finite values and each row's index among them
 * (-1 for none). Sort and renumber for continuous cells; calendars keep
 * encounter order to avoid sorting distinct instants they only map to days.
 */
export function distinct(column: NumericArray, sorted = true): [Float64Array, Int32Array] {
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
  const values = Float64Array.from(ids.keys());
  if (!sorted) return [values, own];
  values.sort();
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

/** Rows a vertical step looks up one at a time before it scans the cells. */
const LOOKUPS = 32;

/**
 * For marks read cell by cell (heatmaps, 2D histograms): the position in
 * `index` of the cell `columns` to the right and `rows` up from the one at
 * `position`, as `frame` draws them, or undefined when there is none; a
 * negative position asks for the top left cell. Infinite steps jump to the
 * row's (or column's) far end. On band axes holding only some of the
 * chart's bands, `places` say where the index's bands are drawn.
 */
export function stepCell(
  index: CellIndex,
  position: number,
  columns: number,
  rows: number,
  frame: { x: PositionScale; y: PositionScale },
  places: { x?: BandPlaces | undefined; y?: BandPlaces | undefined } = {},
): number | undefined {
  const { x: xPlaces, y: yPlaces } = places;
  const xs = index.x;
  const ys = index.y;
  // Which way cells run on screen: rows of categories run down the plot,
  // rows of numbers up it, and reversed domains run back.
  const right = direction(frame.x) < 0 ? -1 : 1;
  const up = direction(frame.y) < 0 ? 1 : -1;
  // The best cell so far, by a rank compared key by key (lowest first).
  let best = -1;
  let [ra, rb, rc] = [Number.POSITIVE_INFINITY, 0, 0];
  const consider = (position: number, a: number, b = 0, c = 0) => {
    if (a < ra || (a === ra && (b < rb || (b === rb && c < rc)))) {
      best = position;
      [ra, rb, rc] = [a, b, c];
    }
  };
  if (position < 0) {
    // Entering the grid: its top left cell, which places, kept in the
    // chart's order, leave where the index has it.
    const cell = index.corner(up > 0, right < 0);
    return cell < 0 ? undefined : cell;
  }
  const along = columns !== 0;
  const steps = Math.abs(along ? columns : rows);
  const ahead = Math.sign(along ? columns * right : rows * up);
  const row = index.rowOf(position);
  const [column, line] = [placeOf(xPlaces, xs[row]!), placeOf(yPlaces, ys[row]!)];
  // A step finds the next cell in its row (or column) by binary search
  // while there is one near; jumps and steps off the end scan the cells.
  if (steps !== Number.POSITIVE_INFINITY) {
    if (along) {
      const near = index.beside(xs[row]!, ys[row]!, ahead > 0);
      if (near >= 0) return near;
    } else {
      for (let j = 1; j <= LOOKUPS && line + j * ahead >= 0; j++) {
        const band = bandOf(yPlaces, line + j * ahead);
        if (band < 0) break;
        const near = index.find(xs[row]!, band);
        if (near >= 0) return near;
      }
    }
  }
  index.forEachCell((cb, rb, k) => {
    const c = placeOf(xPlaces, cb);
    const r = placeOf(yPlaces, rb);
    const offset = (along ? c - column : r - line) * ahead;
    if (offset <= 0) return;
    const across = Math.abs(along ? r - line : c - column);
    // The next cell in the same row (or column), else the nearest ahead in
    // another, so no cell is out of reach; the furthest for jumps.
    if (steps === Number.POSITIVE_INFINITY) {
      if (across === 0) consider(k, -offset);
    } else consider(k, across === 0 ? 0 : 1, offset, across);
  });
  return best < 0 ? undefined : best;
}

/** Which way a scale's values run on screen: positive rightward or downward. */
function direction(scale: PositionScale): number {
  return Math.sign((scale.range[1] - scale.range[0]) * (scale.domain[1] - scale.domain[0]));
}

/** The place of chart band `band` in a panel placing bands at `places`. */
function placeOf(places: BandPlaces | undefined, band: number): number {
  return places ? places.at(band) : band;
}

/** The chart band at place `place` in a panel placing bands at `places`. */
export function bandOf(places: BandPlaces | undefined, place: number): number {
  return places ? places.band(place) : place;
}
