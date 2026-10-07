import type { NumericArray } from "../data/column.ts";

/** Values per block at the lowest level; each level above groups FANOUT blocks. */
const BLOCK = 64;
const FANOUT = 8;

interface Level {
  /** Values per block. */
  size: number;
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

/**
 * Block summaries of a value array for range minimum and maximum queries:
 * the positions of the first lowest and highest finite values of each block
 * of 64 values, and of each block of 512, 4,096, ... values above that, plus
 * whether a block holds a value that is not finite. A query over n values
 * reads at most about 2 * 64 values and 2 * 8 blocks per level instead of all
 * n. Memory is about 9 bytes per 64 values, 1.15 times that with all levels.
 *
 * The index describes the values at the time it was built; its owner must
 * rebuild it when they change.
 */
export class MinMaxIndex {
  readonly length: number;
  /**
   * Share of 64-value blocks that hold a gap. Where most do, most queries
   * end in a scan anyway, so reducing by scanning directly is faster.
   */
  readonly gapShare: number;
  readonly #levels: Level[] = [];

  constructor(values: NumericArray) {
    this.length = values.length;
    const leaves = leafLevel(values);
    this.#levels.push(leaves);
    let gaps = 0;
    for (const gap of leaves.gap) gaps += gap;
    this.gapShare = leaves.gap.length > 0 ? gaps / leaves.gap.length : 0;
    while (this.#levels.at(-1)!.low.length > FANOUT) {
      this.#levels.push(parentLevel(values, this.#levels.at(-1)!));
    }
  }

  /** Extremes of `values[from, to)`; `values` must be the array the index was built from. */
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

function leafLevel(values: NumericArray): Level {
  const blocks = Math.ceil(values.length / BLOCK);
  const level: Level = {
    size: BLOCK,
    low: new Int32Array(blocks),
    high: new Int32Array(blocks),
    gap: new Uint8Array(blocks),
  };
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  for (let b = 0; b < blocks; b++) {
    out.low = -1;
    out.high = -1;
    out.gap = false;
    const end = Math.min(values.length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) includeValue(values, i, out);
    level.low[b] = out.low;
    level.high[b] = out.high;
    level.gap[b] = out.gap ? 1 : 0;
  }
  return level;
}

function parentLevel(values: NumericArray, child: Level): Level {
  const blocks = Math.ceil(child.low.length / FANOUT);
  const level: Level = {
    size: child.size * FANOUT,
    low: new Int32Array(blocks),
    high: new Int32Array(blocks),
    gap: new Uint8Array(blocks),
  };
  const out: RangeExtremes = { low: -1, high: -1, gap: false };
  for (let b = 0; b < blocks; b++) {
    out.low = -1;
    out.high = -1;
    out.gap = false;
    const end = Math.min(child.low.length, (b + 1) * FANOUT);
    for (let c = b * FANOUT; c < end; c++) {
      if (child.gap[c]) out.gap = true;
      includeExtreme(values, child.low[c]!, out, true);
      includeExtreme(values, child.high[c]!, out, false);
    }
    level.low[b] = out.low;
    level.high[b] = out.high;
    level.gap[b] = out.gap ? 1 : 0;
  }
  return level;
}
