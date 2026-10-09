import type { NumericArray } from "../data/column.ts";
import type { Table } from "../data/table.ts";
import { MinMaxIndex, type RangeIndex } from "../lod/minmax-index.ts";
import { INDEXED_POINTS } from "./trace.ts";

/**
 * How layers stack: "sum" adds every value to the running total, a missing
 * value counting as zero for the layers above (areas); "signed" stacks
 * positive values up and negative ones down from zero, and missing values
 * leave no segment (bars).
 */
export type StackKind = "sum" | "signed";

/** Each layer's tops and bases, row by row: views valid until the next update. */
export interface StackedLayers {
  /** Top of each layer; NaN where the layer draws nothing. */
  tops: Float64Array[];
  /** Bottom of each layer; for "sum" stacks the first has none (zero). */
  bases: (Float64Array | undefined)[];
  /** Min/max indexes of each layer's top and bottom, for stacks long enough to need them. */
  indexes: { top: RangeIndex; bottom: RangeIndex | undefined }[] | undefined;
}

/** What a stack reads of its table: where its rows are, and what changed. */
type Rows = Pick<Table, "rowOffset" | "length" | "version" | "modifiedVersion">;

const GROWTH = 1.5;
const MIN_CAPACITY = 64;
/** Scratch totals longer than this are not kept between updates. */
const RETAINED = 1 << 16;

/**
 * Stacked layers of fields sharing a table's rows, kept current as the
 * table streams: appended rows are stacked on their own and dropped rows
 * leave from the front, so a tick costs as much as the rows it adds. Any
 * other change (values replaced in place, a reset, layers shown or hidden)
 * stacks every row again. The stack owns its buffers, laid out like the
 * table's: live rows in `[start, start + length)` of a buffer with room to
 * grow.
 */
export class RowStack {
  readonly #kind: StackKind;
  #table: Rows | undefined;
  #version = -1;
  #signature = "";
  /** Table row identity (`rowOffset`) of the first live row. */
  #offset = 0;
  #start = 0;
  #length = 0;
  #tops: Float64Array[] = [];
  #bases: Float64Array[] = [];
  /** Indexes over the whole buffers, from position 0, once the stack is long. */
  #topIndexes: MinMaxIndex[] | undefined;
  #baseIndexes: MinMaxIndex[] | undefined;
  readonly #indexed: boolean;
  /** Running totals of the rows being stacked, up and down from zero. */
  #up = new Float64Array(0);
  #down = new Float64Array(0);

  /** With `indexed`, long stacks keep min/max indexes of their tops and bases for extents and tracing. */
  constructor(kind: StackKind, { indexed = false } = {}) {
    this.#kind = kind;
    this.#indexed = indexed;
  }

  /**
   * The stack of `layers` (each a field's values for the table's live rows;
   * undefined for a hidden layer, which stacks as zero) as of the table's
   * current version. `signature` names which layers are shown.
   */
  update(
    table: Rows,
    layers: readonly (NumericArray | undefined)[],
    signature: string,
  ): StackedLayers {
    const end = table.rowOffset + table.length;
    const current = this.#table === table && this.#signature === signature;
    if (!current || table.modifiedVersion > this.#version || layers.length !== this.#tops.length) {
      this.#rebuild(table, layers, signature);
    } else if (this.#version !== table.version) {
      // Rows before the table's first are gone; rows past the stack's last are new.
      const dropped = Math.min(this.#length, Math.max(0, table.rowOffset - this.#offset));
      this.#start += dropped;
      this.#length -= dropped;
      this.#offset += dropped;
      if (dropped > 0) this.#shrink();
      const appended = end - (this.#offset + this.#length);
      if (this.#offset !== table.rowOffset || appended < 0) this.#rebuild(table, layers, signature);
      else if (appended > 0) {
        this.#reserve(appended);
        this.#stack(layers, table.length - appended, table.length, this.#start + this.#length);
        this.#length += appended;
        const end = this.#start + this.#length;
        this.#topIndexes?.forEach((index, l) => {
          index.extend(this.#tops[l]!, end);
        });
        this.#baseIndexes?.forEach((index, l) => {
          index.extend(this.#bases[l]!, end);
        });
      }
      this.#version = table.version;
    }
    const view = (buffer: Float64Array) => buffer.subarray(this.#start, this.#start + this.#length);
    const first = this.#kind === "sum" ? 0 : -1;
    return {
      tops: this.#tops.map(view),
      bases: this.#bases.map((buffer, i) => (i === first ? undefined : view(buffer))),
      indexes: this.#indexes()
        ? this.#tops.map((top, l) => ({
            top: this.#view(this.#topIndexes![l]!, top),
            bottom: l === first ? undefined : this.#view(this.#baseIndexes![l]!, this.#bases[l]!),
          }))
        : undefined,
    };
  }

  /** Whether the stack keeps indexes now; builds them when it first does. */
  #indexes(): boolean {
    if (!this.#indexed || this.#length < INDEXED_POINTS) {
      this.#topIndexes = undefined;
      this.#baseIndexes = undefined;
      return false;
    }
    const end = this.#start + this.#length;
    this.#topIndexes ??= this.#tops.map((buffer) => new MinMaxIndex(buffer, end));
    this.#baseIndexes ??= this.#bases.map((buffer) => new MinMaxIndex(buffer, end));
    return true;
  }

  /** An index over a whole buffer, answering by live row instead of buffer position. */
  #view(index: MinMaxIndex, buffer: Float64Array): RangeIndex {
    const start = this.#start;
    return {
      length: this.#length,
      gapShare: index.gapShare,
      query: (_values, from, to, out) => {
        index.query(buffer, start + from, start + to, out);
        if (out.low >= 0) out.low -= start;
        if (out.high >= 0) out.high -= start;
        return out;
      },
    };
  }

  #rebuild(table: Rows, layers: readonly (NumericArray | undefined)[], signature: string) {
    const length = table.length;
    const capacity = Math.max(MIN_CAPACITY, Math.ceil(length * GROWTH));
    this.#tops = layers.map(() => new Float64Array(capacity));
    this.#bases = layers.map(() => new Float64Array(capacity));
    this.#topIndexes = undefined;
    this.#baseIndexes = undefined;
    this.#table = table;
    this.#signature = signature;
    this.#version = table.version;
    this.#offset = table.rowOffset;
    this.#start = 0;
    this.#length = length;
    this.#stack(layers, 0, length, 0);
  }

  /**
   * Moves the live rows into smaller buffers once drops leave them less than
   * a quarter full, as tables do, so a window that shrinks gives memory back.
   */
  #shrink() {
    const capacity = this.#tops[0]?.length ?? 0;
    if (capacity <= MIN_CAPACITY || this.#length * 4 >= capacity) return;
    const smaller = Math.max(MIN_CAPACITY, Math.ceil(this.#length * GROWTH));
    const move = (buffer: Float64Array) => {
      const next = new Float64Array(smaller);
      next.set(buffer.subarray(this.#start, this.#start + this.#length));
      return next;
    };
    this.#tops = this.#tops.map(move);
    this.#bases = this.#bases.map(move);
    this.#start = 0;
    this.#topIndexes = undefined;
    this.#baseIndexes = undefined;
  }

  /** Lets go of every buffer; the next update stacks every row again. */
  clear(): void {
    if (!this.#table) return;
    this.#table = undefined;
    this.#tops = [];
    this.#bases = [];
    this.#topIndexes = undefined;
    this.#baseIndexes = undefined;
    this.#up = new Float64Array(0);
    this.#down = new Float64Array(0);
    this.#length = 0;
  }

  /** Makes room for `count` rows after the live ones. */
  #reserve(count: number) {
    const required = this.#length + count;
    const capacity = this.#tops[0]?.length ?? 0;
    if (this.#start + required <= capacity) return;
    // Rows move, so indexes over buffer positions are built again.
    this.#topIndexes = undefined;
    this.#baseIndexes = undefined;
    const buffers = [...this.#tops, ...this.#bases];
    if (required * GROWTH <= capacity) {
      // Move the live rows to the front, as the table does.
      for (const buffer of buffers) buffer.copyWithin(0, this.#start, this.#start + this.#length);
    } else {
      const grown = Math.ceil(required * GROWTH);
      const move = (buffer: Float64Array) => {
        const next = new Float64Array(grown);
        next.set(buffer.subarray(this.#start, this.#start + this.#length));
        return next;
      };
      this.#tops = this.#tops.map(move);
      this.#bases = this.#bases.map(move);
    }
    this.#start = 0;
  }

  /** Stacks table rows `[from, to)` into buffer positions from `at`. */
  #stack(layers: readonly (NumericArray | undefined)[], from: number, to: number, at: number) {
    const count = to - from;
    const signed = this.#kind === "signed";
    // Rebuilds of long stacks use scratch as long as the table, which is
    // not kept; streaming ticks reuse a short one.
    const up = this.#up.length >= count ? this.#up.fill(0, 0, count) : new Float64Array(count);
    const down = !signed
      ? up
      : this.#down.length >= count
        ? this.#down.fill(0, 0, count)
        : new Float64Array(count);
    if (count <= RETAINED) {
      this.#up = up;
      if (signed) this.#down = down;
    }
    layers.forEach((values, l) => {
      const top = this.#tops[l]!;
      const base = this.#bases[l]!;
      for (let i = 0; i < count; i++) {
        const p = at + i;
        const value = values ? values[from + i]! : 0;
        if (!Number.isFinite(value)) {
          top[p] = Number.NaN;
          base[p] = signed ? Number.NaN : up[i]!;
          continue;
        }
        if (signed && value < 0) {
          base[p] = down[i]!;
          down[i]! += value;
          top[p] = down[i]!;
        } else {
          base[p] = up[i]!;
          up[i]! += value;
          top[p] = up[i]!;
        }
      }
    });
  }
}
