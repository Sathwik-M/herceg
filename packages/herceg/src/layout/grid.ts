// Sizes a compiled layout (layout/compile.ts) along one axis: how long each
// row or column of every grid is, and where each panel's cell and plot lie.
// Tracks size plots, as matplotlib's ratios and Plotly's row heights do:
// fixed tracks keep their pixels, flexible ones share what is left by
// weight, none under its least size, and the room titles, axes, and
// legends take goes beside them. Plots line up across tracks: the room
// before the plots of cells starting on a track (y labels, a title) is the
// most any of them needs, and so is the room after those ending on it; a
// cell spanning tracks spans the room between them too, and a nested grid's
// outer plots take the room of the cells around it. Loaded with subplots only.

import type { CompiledLayout, GridNode, LeafNode, Track } from "./compile.ts";

/** What each panel needs along an axis, by its index in the layout's order. */
export interface AxisNeeds {
  /** Room before its plot (left, or above). */
  before: ArrayLike<number>;
  /** Room after its plot (right, or below). */
  after: ArrayLike<number>;
  /** The least length of a plot: every panel's, or by panel. */
  least: number | ArrayLike<number>;
}

/** Each panel's cell and plot along the axis: a start and an end per panel, insets left at 0. */
export interface AxisPlacement {
  outer: Float64Array;
  plot: Float64Array;
}

/**
 * Why a layout does not fit: the least length it needs, or where a fixed
 * track is too short for what its cell needs (`fixed`, the panel's index).
 */
export interface Shortfall {
  needed: number;
  fixed?: { panel: number; size: number; needed: number } | undefined;
}

/** Whether a solve placed the layout or fell short. */
export function isShort(solved: AxisPlacement | Shortfall): solved is Shortfall {
  return "needed" in solved;
}

type Axis = "x" | "y";

/** A grid measured along an axis. */
interface Measured {
  tracks: Track[];
  gap: number;
  /** Room before the plots of cells starting on each track, and after those ending on it. */
  before: Float64Array;
  after: Float64Array;
  /** Each track's least plot length: its own, and that of the cells on it alone. */
  least: Float64Array;
  /** The least lengths that hold cells spanning tracks too, adding as little as can be. */
  held: Float64Array;
  cells: Cell[];
  /** From the first track's plot to the last one's, at the least. */
  inner: number;
}

/** A cell along the axis: its first and last tracks, the least length of its plots, and what it holds. */
interface Cell {
  first: number;
  last: number;
  need: number;
  content: GridNode | LeafNode;
}

/**
 * Places `layout`'s cells and plots between `start` and `end` along `axis`
 * ("x" across, "y" down), or says how much room it lacks.
 */
export function solveAxis(
  layout: CompiledLayout,
  axis: Axis,
  start: number,
  end: number,
  needs: AxisNeeds,
): AxisPlacement | Shortfall {
  const count = layout.order.length;
  const out = { outer: new Float64Array(2 * count), plot: new Float64Array(2 * count) };
  const needed = leastLength(layout, axis, needs);
  if (end - start < needed - 0.5) return { needed };
  const fixed = place(layout.root, axis, needs, start, end, 0, 0, out);
  return fixed ? { needed: 0, fixed } : out;
}

/** The least length `layout` takes along `axis` for what its panels need. */
export function leastLength(layout: CompiledLayout, axis: Axis, needs: AxisNeeds): number {
  const m = measure(layout.root, axis, needs, 0, 0);
  return m.before[0]! + m.inner + m.after[m.tracks.length - 1]!;
}

/** What a cell's content needs: room before and after its plots, and their least length. */
function needOf(content: GridNode | LeafNode, axis: Axis, needs: AxisNeeds): number[] {
  if ("panel" in content) {
    const p = content.panel;
    const { least } = needs;
    return [needs.before[p]!, needs.after[p]!, typeof least === "number" ? least : least[p]!];
  }
  const m = measure(content, axis, needs, 0, 0);
  return [m.before[0]!, m.after[m.tracks.length - 1]!, m.inner];
}

/**
 * `grid` along `axis`, with at least `before` and `after` of room at its
 * outer edges (those the cell holding it gives its neighbors' plots).
 */
function measure(
  grid: GridNode,
  axis: Axis,
  needs: AxisNeeds,
  before: number,
  after: number,
): Measured {
  const tracks = axis === "x" ? grid.columns : grid.rows;
  const gap = axis === "x" ? grid.columnGap : grid.rowGap;
  const n = tracks.length;
  const room = { before: new Float64Array(n), after: new Float64Array(n) };
  room.before[0] = before;
  room.after[n - 1] = after;
  const cells = grid.cells.map((cell): Cell => {
    const [first, last] =
      axis === "x" ? [cell.column0, cell.column1 - 1] : [cell.row0, cell.row1 - 1];
    const [b, a, need] = needOf(cell.content, axis, needs);
    room.before[first] = Math.max(room.before[first]!, b!);
    room.after[last] = Math.max(room.after[last]!, a!);
    return { first, last, need: need!, content: cell.content };
  });
  const least = Float64Array.from(tracks, (track) => ("px" in track ? track.px : track.min));
  for (const cell of cells)
    if (cell.first === cell.last && "weight" in tracks[cell.first]!)
      least[cell.first] = Math.max(least[cell.first]!, cell.need);
  // The least the tracks take with cells spanning several held too: each
  // cell, by its last track, lengthens the last of its flexible tracks by
  // what it lacks, which serves the cells after it most (the least total
  // for spans of tracks). Sizing the tracks holds them as it can.
  const held = least.slice();
  for (const cell of [...cells].sort((a, b) => a.last - b.last)) {
    const lack = cell.need - spanned(cell, held, room, gap);
    if (cell.first === cell.last || lack <= 0) continue;
    for (let t = cell.last; t >= cell.first; t--)
      if ("weight" in tracks[t]!) {
        held[t] = held[t]! + lack;
        break;
      }
  }
  let inner = gap * (n - 1);
  for (let t = 0; t < n; t++) inner += held[t]!;
  for (let t = 0; t + 1 < n; t++) inner += room.after[t]! + room.before[t + 1]!;
  return { tracks, gap, ...room, least, held, cells, inner };
}

/** How long a cell's plots can be: its tracks, and the room and gaps between them. */
function spanned(
  cell: Cell,
  sizes: ArrayLike<number>,
  room: { before: ArrayLike<number>; after: ArrayLike<number> },
  gap: number,
): number {
  let length = 0;
  for (let t = cell.first; t <= cell.last; t++) {
    length += sizes[t]!;
    if (t < cell.last) length += room.after[t]! + gap + room.before[t + 1]!;
  }
  return length;
}

/**
 * Each track's share of the weight of the flexible tracks from `first` to
 * `last` (0 for others), or undefined when none of them is flexible.
 * Weights are scaled to the largest, so huge ones cannot overflow a sum.
 */
function weightsOf(tracks: readonly Track[], first: number, last: number): number[] | undefined {
  let largest = 0;
  for (let t = first; t <= last; t++) {
    const track = tracks[t]!;
    if ("weight" in track) largest = Math.max(largest, track.weight);
  }
  if (largest === 0) return undefined;
  const out = tracks.map((track, t) =>
    "weight" in track && t >= first && t <= last ? track.weight / largest : 0,
  );
  let sum = 0;
  for (const w of out) sum += w;
  return out.map((w) => w / sum);
}

/**
 * Sizes `measured`'s tracks' plots to fill `free`: fixed ones as they are,
 * flexible ones by weight, none under its least.
 */
function sizes(measured: Measured, free: number): Float64Array {
  const { tracks, least } = measured;
  // The room for every track's plots, fixed ones' included.
  const whole = free;
  const out = new Float64Array(tracks.length);
  const pool = new Set<number>();
  tracks.forEach((track, t) => {
    if ("px" in track) {
      out[t] = track.px;
      free -= track.px;
    } else pool.add(t);
  });
  // Tracks whose share is under their least size take that size; the
  // others share what is left.
  while (pool.size > 0) {
    const shares = weightsOf(
      tracks.map((track, t) => (pool.has(t) ? track : { px: 0 })),
      0,
      tracks.length - 1,
    )!;
    // Clamped against one allocation: each clamp leaves the others more.
    const total = free;
    let clamped = false;
    for (const t of pool) {
      if (total * shares[t]! < least[t]!) {
        out[t] = least[t]!;
        free -= least[t]!;
        pool.delete(t);
        clamped = true;
      }
    }
    if (clamped) continue;
    for (const t of pool) out[t] = free * shares[t]!;
    break;
  }
  // Cells spanning tracks these sizes leave short take as little as they
  // need of the least sizes that hold them all (`held`, with the rest
  // shared by weight): both fill the room and keep each track's least, and
  // every cell's length changes linearly between them, so that blend holds
  // every cell.
  const shares = weightsOf(tracks, 0, tracks.length - 1);
  let rest = 0;
  for (const track of tracks) if ("px" in track) rest += track.px;
  for (let t = 0; t < tracks.length; t++) if ("weight" in tracks[t]!) rest += measured.held[t]!;
  const holding = Float64Array.from(measured.held, (held, t) =>
    shares ? held + Math.max(0, whole - rest) * shares[t]! : held,
  );
  let blend = 0;
  for (const cell of measured.cells) {
    if (cell.first === cell.last) continue;
    const now = spanned(cell, out, measured, measured.gap);
    const held = spanned(cell, holding, measured, measured.gap);
    if (now < cell.need - 0.5 && held > now)
      blend = Math.max(blend, Math.min(1, (cell.need - now) / (held - now)));
  }
  if (blend > 0)
    for (let t = 0; t < out.length; t++) out[t] = out[t]! + blend * (holding[t]! - out[t]!);
  return out;
}

/**
 * Places `grid` from `start` to `end`, writing its panels' cells and plots
 * into `out`, with at least `before` and `after` of room at its outer edges;
 * the first cell too short for what it holds (of fixed tracks), if any.
 */
function place(
  grid: GridNode,
  axis: Axis,
  needs: AxisNeeds,
  start: number,
  end: number,
  before: number,
  after: number,
  out: AxisPlacement,
): Shortfall["fixed"] {
  const measured = measure(grid, axis, needs, before, after);
  const { tracks, gap } = measured;
  let free = end - start - gap * (tracks.length - 1);
  for (let t = 0; t < tracks.length; t++) free -= measured.before[t]! + measured.after[t]!;
  const sized = sizes(measured, free);
  // Where each track's plots start.
  const starts = new Float64Array(tracks.length);
  for (let t = 0, at = start; t < tracks.length; t++) {
    starts[t] = at + measured.before[t]!;
    at = starts[t]! + sized[t]! + measured.after[t]! + gap;
  }
  for (const cell of measured.cells) {
    const from = starts[cell.first]!;
    const to = starts[cell.last]! + sized[cell.last]!;
    const roomBefore = measured.before[cell.first]!;
    const roomAfter = measured.after[cell.last]!;
    if (to - from < cell.need - 0.5)
      return { panel: firstPanel(cell.content), size: to - from, needed: cell.need };
    if ("panel" in cell.content) {
      const p = cell.content.panel;
      out.outer[2 * p] = from - roomBefore;
      out.outer[2 * p + 1] = to + roomAfter;
      out.plot[2 * p] = from;
      out.plot[2 * p + 1] = to;
      continue;
    }
    const short = place(
      cell.content,
      axis,
      needs,
      from - roomBefore,
      to + roomAfter,
      roomBefore,
      roomAfter,
      out,
    );
    if (short) return short;
  }
  return undefined;
}

/** The first panel a cell's content holds, to name in messages. */
function firstPanel(content: GridNode | LeafNode): number {
  if ("panel" in content) return content.panel;
  return content.cells[0] ? firstPanel(content.cells[0].content) : 0;
}
