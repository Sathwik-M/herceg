// The crosstab index of a row pivot (data/pivot.ts): for a row and a pivot
// value's slot, the position in the pivot's long table of their combination,
// or -1 where no row holds it. Dense while rows × values is small: one
// Int32Array of row-major entries, with room for more rows and values, which
// takes new combinations in place. Sparse otherwise: compressed rows (each
// row's slots, ascending, and their positions), found by binary search
// within the row and built again whenever combinations are added.

/** Entries a dense index holds at most, with room: 4 MiB. */
export const DENSE_ENTRIES = 2 ** 20;

export interface CrosstabIndex {
  readonly dense: boolean;
  readonly byteLength: number;
  /** The position of the combination of `row` and value slot `slot`, or -1. */
  at(row: number, slot: number): number;
  /** Whether the index can take, in place, combinations making `rows` rows and up to `values` values. */
  extends(rows: number, values: number): boolean;
}

/** An index let go of, which a build makes anew: what kind it was, for the next to keep to it. */
export function released(dense: boolean): CrosstabIndex {
  return { dense, byteLength: 0, at: () => -1, extends: () => false };
}

/**
 * Combinations by position: `rows[c]` is combination `c`'s row and
 * `slots[c]` its value's slot, for `c` below `count`.
 */
export interface Combinations {
  readonly count: number;
  readonly rows: ArrayLike<number>;
  readonly slots: Int32Array;
}

/**
 * Bytes an index of `rows` rows, `values` values, and `count` combinations
 * takes at most, with its room, while it is built beside the one it replaces.
 */
export function indexBytes(rows: number, values: number, count: number): number {
  const entries = rows * values;
  const bytes =
    entries <= 2 * DENSE_ENTRIES
      ? 4 * Math.min(2 * DENSE_ENTRIES, Math.ceil(entries * 2.25))
      : Math.min(4 * entries, 4 * (rows + 1) + 8 * count);
  return 2 * bytes;
}

/**
 * An index of `rows` rows and `values` slots over the combinations, or
 * `previous` extended with those from `from` on when it has room. Dense
 * while the entries fit `DENSE_ENTRIES` (twice that for an index dense
 * already, so a pivot near the line does not switch back and forth), or
 * take no more room than sparse would.
 */
export function buildIndex(
  rows: number,
  values: number,
  combinations: Combinations,
  previous: CrosstabIndex | null,
  from: number,
): CrosstabIndex {
  const entries = rows * values;
  const ceiling = previous?.dense ? 2 * DENSE_ENTRIES : DENSE_ENTRIES;
  const dense = entries <= ceiling || entries <= rows + 1 + 2 * combinations.count;
  if (!dense) return SparseIndex.build(rows, combinations);
  if (previous instanceof DenseIndex && previous.extends(rows, values)) {
    previous.add(combinations, from);
    return previous;
  }
  // Room for half as many again of each, as far as the ceiling allows.
  const roomy = Math.ceil(rows * 1.5) * Math.ceil(values * 1.5) <= ceiling;
  const index = new DenseIndex(
    roomy ? Math.ceil(rows * 1.5) : rows,
    roomy ? Math.ceil(values * 1.5) : values,
  );
  index.add(combinations, 0);
  return index;
}

class DenseIndex implements CrosstabIndex {
  readonly dense = true;
  readonly #entries: Int32Array;
  readonly #rows: number;
  readonly #stride: number;

  constructor(rows: number, stride: number) {
    this.#rows = rows;
    this.#stride = stride;
    this.#entries = new Int32Array(rows * stride).fill(-1);
  }

  get byteLength(): number {
    return this.#entries.byteLength;
  }

  extends(rows: number, values: number): boolean {
    return rows <= this.#rows && values <= this.#stride;
  }

  at(row: number, slot: number): number {
    return row < this.#rows && slot < this.#stride ? this.#entries[row * this.#stride + slot]! : -1;
  }

  add({ count, rows, slots }: Combinations, from: number) {
    const entries = this.#entries;
    const stride = this.#stride;
    for (let c = from; c < count; c++) entries[rows[c]! * stride + slots[c]!] = c;
  }
}

class SparseIndex implements CrosstabIndex {
  readonly dense = false;
  /** Where each row's entries start, then their end. */
  readonly #starts: Int32Array;
  /** Each entry's slot, ascending within its row, and its combination's position. */
  readonly #slots: Int32Array;
  readonly #positions: Int32Array;

  constructor(starts: Int32Array, slots: Int32Array, positions: Int32Array) {
    this.#starts = starts;
    this.#slots = slots;
    this.#positions = positions;
  }

  /**
   * Compressed rows by two counting sorts: the combinations by slot, then
   * those by row, which keeps each row's slots ascending.
   */
  static build(rows: number, { count, rows: rowOf, slots }: Combinations): SparseIndex {
    let values = 0;
    for (let c = 0; c < count; c++) if (slots[c]! >= values) values = slots[c]! + 1;
    const bySlot = new Int32Array(values + 1);
    for (let c = 0; c < count; c++) bySlot[slots[c]! + 1]!++;
    for (let s = 0; s < values; s++) bySlot[s + 1]! += bySlot[s]!;
    const order = new Int32Array(count);
    for (let c = 0; c < count; c++) order[bySlot[slots[c]!]!++] = c;
    const starts = new Int32Array(rows + 1);
    for (let c = 0; c < count; c++) starts[rowOf[c]! + 1]!++;
    for (let r = 0; r < rows; r++) starts[r + 1]! += starts[r]!;
    const next = starts.slice(0, rows);
    const entrySlots = new Int32Array(count);
    const positions = new Int32Array(count);
    for (const c of order) {
      const at = next[rowOf[c]!]!++;
      entrySlots[at] = slots[c]!;
      positions[at] = c;
    }
    return new SparseIndex(starts, entrySlots, positions);
  }

  get byteLength(): number {
    return this.#starts.byteLength + this.#slots.byteLength + this.#positions.byteLength;
  }

  /** Never: combinations added build a sparse index again. */
  extends(): boolean {
    return false;
  }

  at(row: number, slot: number): number {
    const starts = this.#starts;
    if (row + 1 >= starts.length) return -1;
    const slots = this.#slots;
    let [lo, hi] = [starts[row]!, starts[row + 1]!];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (slots[mid]! < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo < starts[row + 1]! && slots[lo] === slot ? this.#positions[lo]! : -1;
  }
}
