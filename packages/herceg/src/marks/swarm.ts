// Beeswarm placement (`swarm`): the points of each band of a category axis
// (or each series' share of it, dodged) packed across it without overlap,
// in order of their values, as Seaborn's swarm plots are. It depends on
// pixels, so it is laid out again for each panel's scales; the order of
// the rows by value is kept while the data stays the same.

import type { NumericArray } from "../data/column.ts";
import type { BandShares } from "./dodge.ts";
import type { Frame } from "./mark.ts";
import { placeAt, rowOf, type Series } from "./series.ts";

/** Pixels left between neighboring points of a swarm. */
const CLEARANCE = 0.5;
/**
 * The most placed points a point is tested against. Points of a swarm this
 * dense stand at its edges instead, so laying out a band of n points takes
 * at most about n times this many steps.
 */
export const MAX_NEIGHBORS = 512;

/**
 * The window of placed points a point is tested against (their values,
 * offsets, and radii, a ring of MAX_NEIGHBORS + 1, since a point joins only
 * a window of at most MAX_NEIGHBORS), and the spans its neighbors block.
 */
const RING = MAX_NEIGHBORS + 1;
const windowValue = new Float64Array(RING);
const windowOffset = new Float64Array(RING);
const windowRadius = new Float64Array(RING);
const low = new Float64Array(RING);
const high = new Float64Array(RING);

/**
 * Packs one swarm: the points `start` to `end` of `values` (pixels along
 * the value axis, ascending: negated where pixels descend as values
 * ascend) with radii `radii` (how far each reaches, in
 * pixels), across a band `width` pixels wide. Each point goes to the free
 * place nearest the band's center, given the points placed before it;
 * one with none inside the band stands at its nearer edge, overlapping,
 * and leaves room for later points. Writes each point's offset from the
 * band's center to `out` and returns how many stood at an edge.
 */
export function packSwarm(
  values: Float64Array,
  radii: Float64Array,
  start: number,
  end: number,
  width: number,
  out: Float64Array,
): number {
  let widest = 0;
  for (let i = start; i < end; i++) widest = Math.max(widest, radii[i]!);
  // The window holds placed points `first` to `last` (exclusive), by count, in the ring.
  let first = 0;
  let last = 0;
  let edged = 0;
  for (let i = start; i < end; i++) {
    const value = values[i]!;
    const radius = radii[i]!;
    // Placed points too far below to touch this point, or any after it.
    while (
      first < last &&
      value - windowValue[first % RING]! >= widest + windowRadius[first % RING]! + CLEARANCE
    )
      first++;
    const half = width / 2 - radius;
    let offset = 0;
    let free = last - first <= MAX_NEIGHBORS;
    if (free) {
      // Each touching neighbor blocks the offsets within reach of it.
      let blocked = 0;
      for (let j = first; j < last; j++) {
        const at = j % RING;
        const reach = radius + windowRadius[at]! + CLEARANCE;
        const rise = value - windowValue[at]!;
        if (rise >= reach) continue;
        const span = Math.sqrt(reach * reach - rise * rise);
        low[blocked] = windowOffset[at]! - span;
        high[blocked] = windowOffset[at]! + span;
        blocked++;
      }
      // Ties alternate sides, so swarms grow evenly both ways.
      offset = nearestFree(low, high, blocked, half, last % 2 === 1);
      free = Math.abs(offset) <= half;
    }
    if (!free) {
      // No room: the point stands at the edge nearer its free place, over others.
      edged++;
      out[i] = half <= 0 ? 0 : offset < 0 ? -half : half;
      continue;
    }
    out[i] = offset;
    const at = last % RING;
    windowValue[at] = value;
    windowOffset[at] = offset;
    windowRadius[at] = radius;
    last++;
  }
  return edged;
}

/**
 * The offset nearest 0 that none of the `count` open spans (`low[k]` to
 * `high[k]`) covers: 0, or an end of the run of overlapping spans covering
 * it; the end within `half` of 0 when only one is, the left one on a tie
 * when `leftFirst`. Sorts both ends apart (natively, which is fast) and
 * sweeps them: a run holds while more spans have started than ended.
 */
function nearestFree(
  low: Float64Array,
  high: Float64Array,
  count: number,
  half: number,
  leftFirst: boolean,
): number {
  if (count === 0) return 0;
  const starts = low.subarray(0, count).sort();
  const ends = high.subarray(0, count).sort();
  let open = 0;
  let from = Number.NaN;
  let to = Number.NaN;
  for (let i = 0, j = 0; j < count; ) {
    // An end at a start's place comes first: spans touching there leave it free.
    if (i < count && starts[i]! < ends[j]!) {
      if (open === 0) {
        // A run starting at or past 0 leaves 0 free.
        if (starts[i]! >= 0) return 0;
        from = starts[i]!;
      }
      open++;
      i++;
    } else {
      open--;
      if (open === 0 && ends[j]! > 0) {
        to = ends[j]!;
        break;
      }
      j++;
    }
  }
  if (!(to > 0)) return 0;
  const nearer = -from < to || (-from === to && leftFirst) ? from : to;
  const left = -from <= half;
  const right = to <= half;
  if (left === right) return nearer;
  return left ? from : to;
}

/** One panel's swarm layout: each row's offset from its slot's center, and how many stood at an edge. */
export interface Layout {
  signature: string;
  /**
   * Each laid out row's offset: by row where the panel draws every row of
   * the table, otherwise in the order of `rows`.
   */
  offsets: Float64Array;
  /** The panel's rows, ascending, where it draws only some of the table's. */
  rows: Uint32Array | undefined;
  edged: number;
}

/** A row's offset in a panel's layout: 0 where it laid out none. */
export function offsetOf(layout: Layout, row: number): number {
  const { rows, offsets } = layout;
  if (!rows) return offsets[row] ?? 0;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]! < row) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo] === row ? offsets[lo]! : 0;
}

/**
 * A panel's rows in order of band, then value, each row's series, and
 * where its offset goes (see `Swarms.#byBand`).
 */
interface ByBand {
  key: readonly unknown[];
  rows: Uint32Array;
  series: Uint16Array;
  /** The rows ascending, where the panel draws only some of the table's. */
  ascending: Uint32Array | undefined;
  /** Each row's index into the layout's offsets: its row, or its place in `ascending`. */
  slots: Uint32Array;
}

/**
 * The swarms of a point mark: its rows in order of value, per band, kept
 * while the data stays the same, and each panel's layout of them.
 */
export class Swarms {
  /** Laid out per panel (its plot, which every frame of the panel shares). */
  readonly #layouts = new WeakMap<object, Layout>();
  /** Rows by band and value, by the first series' rows (each panel's series have rows of their own). */
  readonly #sorted = new WeakMap<object, ByBand>();

  /**
   * The layout of the series a frame draws (parts of series lay out their
   * whole series together), whose values along the other axis are
   * `values`: each row's offset in pixels from its slot's center along the
   * banded `axis` (see `offsetOf`), computed once per panel and scene.
   */
  offsets(
    series: readonly Series[],
    frame: Frame,
    axis: "x" | "y",
    shares: BandShares,
    reachOf: (row: number) => number,
    values: NumericArray,
    version: number,
  ): Layout {
    const band = axis === "x" ? frame.x : frame.y;
    const across = axis === "x" ? frame.y : frame.x;
    const wholes = [...new Set(series.map((s) => s.whole ?? s))];
    const shown = wholes.map((s) =>
      series.some((part) => (part.whole ?? part) === s && !frame.hidden.has(part.key)),
    );
    const mapping = across.mapping();
    const signature = [
      version,
      values.length,
      band.bandwidth,
      band.domain,
      across.domain,
      across.range,
      mapping.offset,
      mapping.factor,
      wholes.map((s, i) => {
        const { index, count } = shares.slotOf(s);
        return `${s.key}:${shown[i]}:${index}/${count}`;
      }),
    ].join("|");
    const kept = this.#layouts.get(frame.plot);
    if (kept?.signature === signature) return kept;
    const byBand = this.#byBand(wholes, axis, values, version);
    // Facets' panels each draw some rows: their offsets take as many places.
    const rows = byBand.ascending;
    const offsets = new Float64Array(rows ? rows.length : values.length);
    const edged = this.#layout(
      byBand,
      wholes,
      shown,
      axis,
      frame,
      shares,
      reachOf,
      values,
      offsets,
    );
    const layout = { signature, offsets, rows, edged };
    this.#layouts.set(frame.plot, layout);
    return layout;
  }

  /** A panel's last layout, as its geometry made it, for inspection and picking. */
  last(frame: Frame): Layout | undefined {
    return this.#layouts.get(frame.plot);
  }

  /**
   * Lays out the swarms of the shown series, one per band and slot, of
   * the points drawn in view (and a radius past it), into `out` at their
   * rows' slots.
   */
  #layout(
    { rows, series, slots: slotOf }: ByBand,
    wholes: readonly Series[],
    shown: readonly boolean[],
    axis: "x" | "y",
    frame: Frame,
    shares: BandShares,
    reachOf: (row: number) => number,
    values: NumericArray,
    out: Float64Array,
  ): number {
    const band = axis === "x" ? frame.x : frame.y;
    const across = axis === "x" ? frame.y : frame.x;
    const breaks = across.breaks;
    const { plot } = frame;
    const [lo, hi] = axis === "x" ? [plot.y, plot.y + plot.height] : [plot.x, plot.x + plot.width];
    const slots = wholes.map((s) => shares.slotOf(s));
    const count = slots[0]?.count ?? 1;
    // Pixels ascend with values on x, descend on y (either way reversed):
    // swarms read them ascending.
    const [from, to] = [Math.min(...across.domain), Math.max(...across.domain)];
    const sign = across.map(to) < across.map(from) ? -1 : 1;
    // Each kept point's group (band and slot), pixel along the value axis, reach, and slot in `out`.
    const n = rows.length;
    const groups = new Float64Array(n);
    const pixels = new Float64Array(n);
    const radii = new Float64Array(n);
    const kept = new Uint32Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const index = series[k]!;
      if (!shown[index]) continue;
      const s = wholes[index]!;
      const row = rows[k]!;
      const at = placeAt(s, axis, row);
      const pixel = across.map(values[row]!);
      const reach = reachOf(row);
      // Times a break hides are not drawn (only time x axes have breaks).
      if (at < 0 || !Number.isFinite(pixel) || !(reach > 0) || breaks?.hides(values[row]!))
        continue;
      if (pixel < lo - reach || pixel > hi + reach) continue;
      groups[m] = at * count + slots[index]!.index;
      pixels[m] = sign * pixel;
      radii[m] = reach;
      kept[m] = slotOf[k]!;
      m++;
    }
    if (m === 0) return 0;
    // Points of each group together, still in order of value: rows come
    // by band, so only dodged slots need gathering, band by band.
    const by = Uint32Array.from({ length: m }, (_, i) => i);
    if (count > 1) gather(groups, count, by, m);
    const sortedPixels = Float64Array.from(by, (i) => pixels[i]!);
    const sortedRadii = Float64Array.from(by, (i) => radii[i]!);
    const offsets = new Float64Array(m);
    const width = Math.abs(band.bandwidth ?? 0) / count;
    let edged = 0;
    for (let start = 0; start < m; ) {
      let end = start + 1;
      while (end < m && groups[by[end]!] === groups[by[start]!]) end++;
      edged += packSwarm(sortedPixels, sortedRadii, start, end, width, offsets);
      start = end;
    }
    for (let k = 0; k < m; k++) out[kept[by[k]!]!] = offsets[k]!;
    return edged;
  }

  /**
   * Rows of the series in order of band along `axis`, then value (rows of
   * one value in their series' and their own order), with the index of
   * each row's series; kept while the table's version and the series'
   * positions and rows stay the same. Values ascend however the value axis runs, so swarms grow from
   * their low values, as Seaborn's do.
   */
  #byBand(
    wholes: readonly Series[],
    axis: "x" | "y",
    values: NumericArray,
    version: number,
  ): ByBand {
    const key = [values, version, ...wholes.flatMap((s) => [s[axis], s.rows, s.places?.[axis]])];
    const first = wholes[0]?.rows ?? values;
    const cached = this.#sorted.get(first);
    if (
      cached &&
      cached.key.length === key.length &&
      cached.key.every((part, i) => part === key[i])
    )
      return cached;
    const length = wholes.reduce((sum, s) => sum + s.length, 0);
    const rows = new Uint32Array(length);
    const series = new Uint16Array(length);
    const bands = new Float64Array(length);
    // Missing values sort last; they are not drawn.
    const by = new Float64Array(length);
    let k = 0;
    wholes.forEach((s, index) => {
      for (let p = 0; p < s.length; p++) {
        const row = rowOf(s, p);
        const value = values[row]!;
        rows[k] = row;
        series[k] = index;
        bands[k] = placeAt(s, axis, row);
        by[k] = Number.isNaN(value) ? Infinity : value;
        k++;
      }
    });
    const order = Uint32Array.from({ length }, (_, i) => i).sort(
      (a, b) => bands[a]! - bands[b]! || by[a]! - by[b]! || a - b,
    );
    const byValue = Uint32Array.from(order, (i) => rows[i]!);
    // A panel drawing every row keeps its offsets by row; others by their place among their rows.
    let ascending: Uint32Array | undefined;
    let slots = byValue;
    if (length !== values.length) {
      const byRow = Uint32Array.from({ length }, (_, i) => i).sort(
        (a, b) => byValue[a]! - byValue[b]!,
      );
      ascending = Uint32Array.from(byRow, (i) => byValue[i]!);
      slots = new Uint32Array(length);
      byRow.forEach((i, place) => {
        slots[i] = place;
      });
    }
    const sorted = {
      key,
      rows: byValue,
      series: Uint16Array.from(order, (i) => series[i]!),
      ascending,
      slots,
    };
    this.#sorted.set(first, sorted);
    return sorted;
  }
}

/**
 * Orders `by` (0 to `m`) by `groups` (`band * count + slot`, ascending by
 * band), keeping each group's order: within each band's run, a counting
 * sort by slot.
 */
function gather(groups: Float64Array, count: number, by: Uint32Array, m: number): void {
  const starts = new Uint32Array(count + 1);
  const run = new Uint32Array(m);
  for (let a = 0; a < m; ) {
    const band = Math.floor(groups[a]! / count);
    let z = a;
    while (z < m && Math.floor(groups[z]! / count) === band) z++;
    starts.fill(0);
    for (let i = a; i < z; i++) starts[(groups[i]! % count) + 1]!++;
    for (let k = 1; k <= count; k++) starts[k]! += starts[k - 1]!;
    for (let i = a; i < z; i++) run[a + starts[groups[i]! % count]!++] = i;
    by.set(run.subarray(a, z), a);
    a = z;
  }
}
