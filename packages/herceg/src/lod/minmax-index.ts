import type { NumericArray } from "../data/column.ts";

/** Values per block at the lowest level; each level above groups FANOUT blocks. */
const BLOCK = 64;
const FANOUT = 8;

interface Level {
  /** Values per block. */
  size: number;
  /** Blocks in use; the arrays may hold more for growth. */
  count: number;
  /** Position of the first lowest finite value per block, -1 when there is none. */
  low: Int32Array;
  /** Position of the first highest finite value per block, -1 when there is none. */
  high: Int32Array;
  /** 1 when the block holds a value that is not finite (a gap). */
  gap: Uint8Array;
}

/** Result of a range query, reused between queries to avoid allocation. */
export interface RangeExtremes {
  /** Position of the first lowest finite value, -1 when the range has none. */
  low: number;
  /** Position of the first highest finite value, -1 when the range has none. */
  high: number;
  /** Whether the range holds a value that is not finite. */
  gap: boolean;
}

/** Range extremes over a value array, as level of detail and extents query them. */
export interface RangeIndex {
  /** Values covered, from position 0. */
  readonly length: number;
  /**
   * Share of 64-value blocks that hold a gap. Where most do, most queries
   * end in a scan anyway, so reducing by scanning directly is faster.
   */
  readonly gapShare: number;
  /** Extremes of `values[from, to)`, by their positions in `values`. */
  query(values: NumericArray, from: number, to: number, out: RangeExtremes): RangeExtremes;
}

/**
 * Block summaries of a value array for range minimum and maximum queries:
 * the positions of the first lowest and highest finite values of each block
 * of 64 values, and of each block of 512, 4,096, ... values above that, plus
 * whether a block holds a value that is not finite. A query over n values
 * reads at most about 2 * 64 values and 2 * 8 blocks per level instead of all
 * n. Memory is about 9 bytes per 64 values, 1.15 times that with all levels.
 *
 * The index covers `values[0, length)`. Values appended after that are taken
 * in with `extend`, and values changed in place with `update`, each
 * recomputing only the blocks they touch.
 */
export class MinMaxIndex implements RangeIndex {
  #length = 0;
  #gaps = 0;
  readonly #levels: Level[] = [];

  constructor(values: NumericArray, length = values.length) {
    this.extend(values, length);
  }

  get length(): number {
    return this.#length;
  }

  /**
   * Share of 64-value blocks that hold a gap. Where most do, most queries
   * end in a scan anyway, so reducing by scanning directly is faster.
   */
  get gapShare(): number {
    const blocks = Math.ceil(this.#length / BLOCK);
    return blocks > 0 ? this.#gaps / blocks : 0;
  }

  /** Takes in `values[this.length, length)`, appended since the last call. */
  extend(values: NumericArray, length: number): void {
    const from = this.#length;
    this.#length = Math.max(from, length);
    this.update(values, from, this.#length);
  }

  /** Recomputes the blocks holding `values[from, to)` after they changed in place. */
  update(values: NumericArray, from: number, to: number): void {
    if (to <= from) return;
    let first = Math.floor(from / BLOCK);
    let last = Math.ceil(Math.min(to, this.#length) / BLOCK);
    for (let depth = 0; ; depth++) {
      const below = this.#levels[depth - 1];
      // A level of at most FANOUT blocks is one query step; none is needed above it.
      if (below && below.count <= FANOUT) {
        this.#levels.length = depth;
        break;
      }
      const blocks = below ? Math.ceil(below.count / FANOUT) : Math.ceil(this.#length / BLOCK);
      // A level created now summarizes every block below, not only the changed ones.
      if (!this.#levels[depth]) {
        first = 0;
        last = blocks;
      }
      const level = this.#level(depth, blocks);
      for (let b = first; b < last; b++) {
        if (depth === 0) this.#leaf(values, level, b);
        else summarize(values, this.#levels[depth - 1]!, level, b);
      }
      first = Math.floor(first / FANOUT);
      last = Math.ceil(last / FANOUT);
    }
  }

  /** Extremes of `values[from, to)`; `values` must be the array the index covers. */
  query(values: NumericArray, from: number, to: number, out: RangeExtremes): RangeExtremes {
    out.low = -1;
    out.high = -1;
    out.gap = false;
    let i = from;
    // Leading values up to the first block boundary.
    const head = Math.min(to, Math.ceil(from / BLOCK) * BLOCK);
    for (; i < head; i++) includeValue(values, i, out);
    // Whole blocks, the largest aligned ones that fit.
    while (i + BLOCK <= to) {
      let level = 0;
      while (level + 1 < this.#levels.length) {
        const size = this.#levels[level + 1]!.size;
        if (i % size !== 0 || i + size > to) break;
        level++;
      }
      const { size, low, high, gap } = this.#levels[level]!;
      const block = i / size;
      if (gap[block]) out.gap = true;
      includeExtreme(values, low[block]!, out, true);
      includeExtreme(values, high[block]!, out, false);
      i += size;
    }
    // Trailing values.
    for (; i < to; i++) includeValue(values, i, out);
    return out;
  }

  /** Level `depth` with room for `blocks` blocks, grown by doubling. */
  #level(depth: number, blocks: number): Level {
    let level = this.#levels[depth];
    if (!level) {
      level = {
        size: BLOCK * FANOUT ** depth,
        low: new Int32Array(Math.max(blocks, 4)),
        high: new Int32Array(Math.max(blocks, 4)),
        gap: new Uint8Array(Math.max(blocks, 4)),
        count: 0,
      };
      this.#levels[depth] = level;
    }
    if (blocks > level.low.length) {
      const capacity = Math.max(blocks, level.low.length * 2);
      level.low = grow(level.low, new Int32Array(capacity));
      level.high = grow(level.high, new Int32Array(capacity));
      level.gap = grow(level.gap, new Uint8Array(capacity));
    }
    level.count = blocks;
    return level;
  }

  #leaf(values: NumericArray, level: Level, b: number): void {
    const out: RangeExtremes = { low: -1, high: -1, gap: false };
    const end = Math.min(this.#length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) includeValue(values, i, out);
    this.#gaps += Number(out.gap) - level.gap[b]!;
    level.low[b] = out.low;
    level.high[b] = out.high;
    level.gap[b] = out.gap ? 1 : 0;
  }
}

function grow<T extends Int32Array | Uint8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}

function includeValue(values: NumericArray, i: number, out: RangeExtremes): void {
  const value = values[i]!;
  // Finite values satisfy v - v === 0; NaN and infinities do not.
  if (!(value - value === 0)) {
    out.gap = true;
    return;
  }
  if (out.low < 0 || value < values[out.low]!) out.low = i;
  if (out.high < 0 || value > values[out.high]!) out.high = i;
}

/** Merges a block's extreme; blocks arrive in order, so ties keep the earlier position. */
function includeExtreme(values: NumericArray, at: number, out: RangeExtremes, low: boolean): void {
  if (at < 0) return;
  if (low) {
    if (out.low < 0 || values[at]! < values[out.low]!) out.low = at;
  } else if (out.high < 0 || values[at]! > values[out.high]!) {
    out.high = at;
  }
}

/** Summarizes block `b` of `level` from its FANOUT children in `child`. */
function summarize(values: NumericArray, child: Level, level: Level, b: number): void {
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  const end = Math.min(child.count, (b + 1) * FANOUT);
  for (let c = b * FANOUT; c < end; c++) {
    if (child.gap[c]) out.gap = true;
    includeExtreme(values, child.low[c]!, out, true);
    includeExtreme(values, child.high[c]!, out, false);
  }
  level.low[b] = out.low;
  level.high[b] = out.high;
  level.gap[b] = out.gap ? 1 : 0;
}
