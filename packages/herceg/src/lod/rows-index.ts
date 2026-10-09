// A min/max index of a field read through a list of rows: one category's rows
// of a long-format table, as `SplitRows` keeps them while the table streams.
// Loaded with marks/split.ts, so charts without a series field carry none of it.

import type { NumericArray } from "../data/column.ts";
import type { RangeExtremes } from "./minmax-index.ts";

/** Positions per block at the lowest level; each level above groups FANOUT blocks (as MinMaxIndex). */
const BLOCK = 64;
const FANOUT = 8;

interface Level {
  /** Positions per block. */
  readonly size: number;
  /** Number of the block in slot 0, counted from the list's first position ever. */
  base: number;
  /** Slots in use: blocks `base` to `base + count - 1`. */
  count: number;
  /** Offset in its block of the first lowest finite value, -1 when there is none. */
  low: Int32Array;
  /** Offset in its block of the first highest finite value, -1 when there is none. */
  high: Int32Array;
  /** 1 when the block holds a value that is not finite (a gap). */
  gap: Uint8Array;
}

/**
 * Block summaries of `values[rows[k]]` over a list of rows that takes rows
 * at its end and loses them from its front, for range minimum and maximum
 * queries by position in the list, as `MinMaxIndex` answers them for a
 * whole column (same blocks, same answers: first lowest and highest finite
 * values, and whether the range holds a gap).
 *
 * Blocks are numbered by "logical" positions, counted from the list's first
 * row ever: position k is logical `dropped + k`, where `dropped` counts the
 * rows the list has lost from its front. Drops therefore keep every block
 * where it was: the blocks they empty are discarded, and the one they cut
 * (and the blocks above it) are summarized again from the rows that stay.
 * Summaries hold extremes as offsets within their block, so nothing is
 * rewritten when positions move down. Storage follows the blocks that hold
 * rows: about 9 bytes per 64 rows, 1.15 times that with all levels, with
 * room to grow (up to twice that, or four times after drops).
 */
export class RowsIndex {
  /** Logical position of the list's first row. */
  #dropped = 0;
  /** Logical position past the list's last row. */
  #end = 0;
  /** Lowest-level blocks holding a gap. */
  #gaps = 0;
  #levels: Level[] = [];

  /** Rows covered. */
  get length(): number {
    return this.#end - this.#dropped;
  }

  /** Bytes the summaries take, with their room to grow. */
  get byteLength(): number {
    let bytes = 0;
    for (const { low, high, gap } of this.#levels)
      bytes += low.byteLength + high.byteLength + gap.byteLength;
    return bytes;
  }

  /** Share of 64-row blocks that hold a gap, as `RangeIndex.gapShare`. */
  get gapShare(): number {
    const leaves = this.#levels[0]?.count ?? 0;
    return leaves > 0 ? this.#gaps / leaves : 0;
  }

  /**
   * Brings the index to `rows[0, count)`, a list that has lost `dropped`
   * rows from its front since it began: only blocks the list gained or cut
   * since the last call are summarized. A list that does not continue the
   * one covered (fewer rows at the end, or rows back at the front) is
   * summarized from scratch.
   */
  update(values: NumericArray, rows: Uint32Array, dropped: number, count: number): void {
    const end = dropped + count;
    const before = this.#end;
    if (dropped === this.#dropped && end === before) return;
    if (dropped < this.#dropped || dropped >= before || end < before) {
      this.#levels = [];
      this.#gaps = 0;
      this.#dropped = dropped;
      this.#end = end;
      this.#summarize(values, rows, dropped, end, 0, 0);
      return;
    }
    // The blocks holding the new first row lost rows from their front.
    const cut = dropped > this.#dropped ? dropped : end;
    this.#dropped = dropped;
    this.#end = end;
    this.#summarize(values, rows, cut, Math.min(cut + 1, end), before, end);
  }

  /** Extremes of rows `[from, to)` of the list, by position in it. */
  query(
    values: NumericArray,
    rows: Uint32Array,
    from: number,
    to: number,
    out: RangeExtremes,
  ): RangeExtremes {
    out.low = -1;
    out.high = -1;
    out.gap = false;
    const dropped = this.#dropped;
    const levels = this.#levels;
    const end = to + dropped;
    // Leading rows up to the first block boundary.
    let i = Math.min(end, Math.ceil((from + dropped) / BLOCK) * BLOCK);
    scanRows(values, rows, from, i - dropped, out);
    // Whole blocks, the largest aligned ones that fit.
    while (i + BLOCK <= end) {
      let depth = 0;
      while (depth + 1 < levels.length) {
        const size = levels[depth + 1]!.size;
        if (i % size !== 0 || i + size > end) break;
        depth++;
      }
      const { size, base, low, high, gap } = levels[depth]!;
      const slot = i / size - base;
      if (gap[slot]) out.gap = true;
      if (low[slot]! >= 0) includeExtreme(values, rows, i + low[slot]! - dropped, out, true);
      if (high[slot]! >= 0) includeExtreme(values, rows, i + high[slot]! - dropped, out, false);
      i += size;
    }
    // Trailing rows.
    scanRows(values, rows, i - dropped, to, out);
    return out;
  }

  /**
   * Summarizes again the blocks holding logical positions `[a0, a1)` and
   * `[b0, b1)` at every level, bottom up, after fitting each level's slots
   * to the blocks that hold rows. A level created now summarizes every
   * block below; levels of at most FANOUT blocks end the hierarchy.
   */
  #summarize(
    values: NumericArray,
    rows: Uint32Array,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
  ): void {
    // Empty ranges hold no block.
    let firstA = a0 < a1 ? Math.floor(a0 / BLOCK) : 0;
    let lastA = a0 < a1 ? Math.ceil(a1 / BLOCK) : 0;
    let firstB = b0 < b1 ? Math.floor(b0 / BLOCK) : 0;
    let lastB = b0 < b1 ? Math.ceil(b1 / BLOCK) : 0;
    for (let depth = 0; ; depth++) {
      const below = this.#levels[depth - 1];
      // A level of at most FANOUT blocks is one query step; none is needed above it.
      if (below && below.count <= FANOUT) {
        this.#levels.length = depth;
        break;
      }
      const size = BLOCK * FANOUT ** depth;
      const first = Math.floor(this.#dropped / size);
      const last = Math.ceil(this.#end / size);
      let level = this.#levels[depth];
      if (!level) {
        level = { size, base: first, count: 0, ...slots(last - first) };
        this.#levels[depth] = level;
        firstA = first;
        lastA = last;
        lastB = firstB;
      }
      this.#fit(level, first, last);
      for (let b = Math.max(firstA, first); b < Math.min(lastA, last); b++)
        this.#block(values, rows, depth, b);
      for (let b = Math.max(firstB, first); b < Math.min(lastB, last); b++)
        this.#block(values, rows, depth, b);
      firstA = Math.floor(firstA / FANOUT);
      lastA = Math.ceil(lastA / FANOUT);
      firstB = Math.floor(firstB / FANOUT);
      lastB = Math.ceil(lastB / FANOUT);
    }
  }

  /**
   * Moves a level's slots so slot 0 holds block `first` and `count` covers
   * up to block `last`: emptied blocks leave from the front, and the arrays
   * grow by doubling, or shrink when four times larger than needed.
   */
  #fit(level: Level, first: number, last: number): void {
    const shift = first - level.base;
    const kept = level.count - shift;
    if (shift > 0) {
      if (level.size === BLOCK)
        for (let s = 0; s < Math.min(shift, level.count); s++) this.#gaps -= level.gap[s]!;
      if (kept > 0) {
        level.low.copyWithin(0, shift, level.count);
        level.high.copyWithin(0, shift, level.count);
        level.gap.copyWithin(0, shift, level.count);
      }
      // Slots past the kept ones are summarized before they are read; gap
      // flags are cleared since the gap count adjusts from them.
      level.gap.fill(0, Math.max(0, kept), level.count);
      level.base = first;
    }
    const blocks = last - first;
    const capacity = level.low.length;
    if (blocks > capacity || capacity > 4 * Math.max(blocks, 4)) {
      const next = slots(blocks > capacity ? Math.max(blocks, 2 * capacity) : 2 * blocks);
      const used = Math.max(0, Math.min(kept, level.count, blocks));
      next.low.set(level.low.subarray(0, used));
      next.high.set(level.high.subarray(0, used));
      next.gap.set(level.gap.subarray(0, used));
      level.low = next.low;
      level.high = next.high;
      level.gap = next.gap;
    }
    level.count = blocks;
  }

  /** Summarizes block `b` of level `depth`: from its rows at the lowest level, else from its children. */
  #block(values: NumericArray, rows: Uint32Array, depth: number, b: number): void {
    const level = this.#levels[depth]!;
    const slot = b - level.base;
    const dropped = this.#dropped;
    const start = b * level.size;
    const out = scratch;
    out.low = -1;
    out.high = -1;
    out.gap = false;
    if (depth === 0) {
      const end = Math.min(this.#end, start + BLOCK);
      scanRows(values, rows, Math.max(start, dropped) - dropped, end - dropped, out);
      this.#gaps += Number(out.gap) - level.gap[slot]!;
    } else {
      const child = this.#levels[depth - 1]!;
      const from = Math.max(b * FANOUT, child.base);
      const to = Math.min((b + 1) * FANOUT, child.base + child.count);
      for (let c = from; c < to; c++) {
        const at = c - child.base;
        if (child.gap[at]) out.gap = true;
        const offset = c * child.size - dropped;
        if (child.low[at]! >= 0) includeExtreme(values, rows, offset + child.low[at]!, out, true);
        if (child.high[at]! >= 0)
          includeExtreme(values, rows, offset + child.high[at]!, out, false);
      }
    }
    // Positions in the list back to offsets in the block.
    const origin = start - dropped;
    level.low[slot] = out.low < 0 ? -1 : out.low - origin;
    level.high[slot] = out.high < 0 ? -1 : out.high - origin;
    level.gap[slot] = out.gap ? 1 : 0;
  }
}

const scratch: RangeExtremes = { low: -1, high: -1, gap: false };

function slots(count: number): { low: Int32Array; high: Int32Array; gap: Uint8Array } {
  const capacity = Math.max(count, 4);
  return {
    low: new Int32Array(capacity),
    high: new Int32Array(capacity),
    gap: new Uint8Array(capacity),
  };
}

/**
 * Merges rows `[from, to)` of the list into `out`, which holds the extremes
 * of the rows before them: ties keep the earlier row.
 */
function scanRows(
  values: NumericArray,
  rows: Uint32Array,
  from: number,
  to: number,
  out: RangeExtremes,
): void {
  let { low, high, gap } = out;
  let lowValue = low < 0 ? Number.POSITIVE_INFINITY : values[rows[low]!]!;
  let highValue = high < 0 ? Number.NEGATIVE_INFINITY : values[rows[high]!]!;
  for (let k = from; k < to; k++) {
    const value = values[rows[k]!]!;
    // Finite values satisfy v - v === 0; NaN and infinities do not.
    if (!(value - value === 0)) {
      gap = true;
      continue;
    }
    if (value < lowValue) {
      low = k;
      lowValue = value;
    }
    if (value > highValue) {
      high = k;
      highValue = value;
    }
  }
  out.low = low;
  out.high = high;
  out.gap = gap;
}

/** Merges a block's extreme at position `k`; blocks arrive in order, so ties keep the earlier one. */
function includeExtreme(
  values: NumericArray,
  rows: Uint32Array,
  k: number,
  out: RangeExtremes,
  low: boolean,
): void {
  const value = values[rows[k]!]!;
  if (low) {
    if (out.low < 0 || value < values[rows[out.low]!]!) out.low = k;
  } else if (out.high < 0 || value > values[rows[out.high]!]!) {
    out.high = k;
  }
}
