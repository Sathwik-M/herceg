// Stacked bars of series split by a field, kept current as their table
// streams: each row's segment at its position (a number, or a band index).
// Bars of several fields stack row by row (RowStack in stack.ts) when their
// positions never repeat, and by position from scratch (bar.ts) otherwise.

import type { NumericArray } from "../data/column.ts";
import type { Table } from "../data/table.ts";
import { capacityFor, makeRoom, shrunk } from "./stack.ts";
import { requireContribution } from "./stack-offset.ts";

/** One series of the stack: its rows (ascending table positions) and whether it is shown. */
export interface BarLayer {
  readonly name: string;
  readonly rows: Uint32Array;
  readonly shown: boolean;
}

/** Each row's segment, by table position: views valid until the next update. */
export interface Segments {
  /** NaN for rows not drawn: missing values, positions, or series. */
  tops: Float64Array;
  bases: Float64Array;
  totals?: Float64Array | undefined;
}

/** What a stack reads of its table: where its rows are, and what changed. */
type Rows = Pick<Table, "rowOffset" | "length" | "version" | "modifiedVersion" | "generation">;

/** Row positions in sort keys: below this, the layer above it. */
const ROW_KEYS = 2 ** 32;
/** Sort scratch longer than this (for a position of very many rows) is not kept between updates. */
const RETAINED = 1 << 16;

/**
 * Segments of bars stacked at each position: positive values up from zero
 * and negative ones down, in series order and within a series in row
 * order (hidden series count as zero). Each row links to the next row at
 * its position, in row order, so the rows a rolling window drops lead
 * their positions' lists. As the table streams, appended and dropped rows
 * restack only the positions they are at: a new position costs its own
 * rows, one the window leaves costs nothing. Any other change (values
 * replaced in place, a reset, series shown, hidden, added, or gone, or the
 * bands positions are indices of) stacks every row again.
 */
export class PositionStack {
  readonly #fill: boolean;

  constructor(fill = false) {
    this.#fill = fill;
  }
  #table: Rows | undefined;
  #version = -1;
  #modified = -1;
  #generation = -1;
  #signature = "";
  #places: object | undefined;
  /** Row identities of the live rows at the last update: from `#offset` up to `#end`. */
  #offset = 0;
  #end = 0;

  /** By row identity, live rows at `[#start, #start + live)`: each row's segment. */
  #doubles: Float64Array[] = [];
  /** By row identity: each row's position id (-1 for none), series (-1 for none), and next row. */
  #ints: Int32Array[] = [];
  #start = 0;

  /** Position ids by position, and by id: the position, its rows, and its first and last row identities. */
  #ids = new Map<number, number>();
  #free: number[] = [];
  #position = new Float64Array(0);
  #count = new Int32Array(0);
  #head = new Float64Array(0);
  #tail = new Float64Array(0);
  /** Positions to restack: ids, and whether each id is listed. */
  #dirty: number[] = [];
  #listed = new Uint8Array(0);
  /** Sort keys of one position's rows: series, then row. */
  #keys = new Float64Array(0);

  /**
   * The stack of `layers` (in stacking order), whose rows stand at
   * `positions` with `values` (the table's columns), as of the table's
   * current version. With `bands`, positions are band indices (-1 for
   * none) of the band list `places`, whose identity says they changed.
   */
  update(
    table: Rows,
    positions: ArrayLike<number>,
    values: NumericArray,
    layers: readonly BarLayer[],
    bands: boolean,
    places: object | undefined,
  ): Segments {
    try {
      return this.#update(table, positions, values, layers, bands, places);
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  #update(
    table: Rows,
    positions: ArrayLike<number>,
    values: NumericArray,
    layers: readonly BarLayer[],
    bands: boolean,
    places: object | undefined,
  ): Segments {
    const signature = JSON.stringify(layers.map(({ name, shown }) => [name, shown]));
    const same = this.#table === table && this.#signature === signature && this.#places === places;
    const current =
      same && this.#generation === table.generation && this.#modified === table.modifiedVersion;
    if (
      !current ||
      (this.#version !== table.version && !this.#follow(table, layers, positions, bands))
    ) {
      this.#rebuild(table, layers, positions, bands, same);
    }
    this.#table = table;
    this.#signature = signature;
    this.#places = places;
    this.#restack(table, values, layers);
    // Once most position ids are free, numbering them again gives the memory back.
    if (this.#ids.size * 4 < this.#count.length && this.#count.length > 1024)
      this.#renumber(table.length);
    this.#version = table.version;
    this.#modified = table.modifiedVersion;
    this.#generation = table.generation;
    this.#offset = table.rowOffset;
    this.#end = table.rowOffset + table.length;
    const view = (buffer: Float64Array) => buffer.subarray(this.#start, this.#start + table.length);
    return {
      tops: view(this.#doubles[0]!),
      bases: view(this.#doubles[1]!),
      totals: this.#fill ? view(this.#doubles[2]!) : undefined,
    };
  }

  /** Bytes the stack holds: its buffers by row and by position, and its sort scratch, not its `Map`. */
  get byteLength(): number {
    let bytes = this.#keys.byteLength;
    for (const buffer of [...this.#doubles, ...this.#ints]) bytes += buffer.byteLength;
    for (const buffer of [this.#position, this.#count, this.#head, this.#tail, this.#listed])
      bytes += buffer.byteLength;
    return bytes;
  }

  /** Lets go of every buffer; the next update stacks every row again. */
  clear(): void {
    if (!this.#table) return;
    this.#table = undefined;
    this.#doubles = [];
    this.#ints = [];
    this.#ids = new Map();
    this.#free = [];
    this.#allocatePositions(0);
    this.#dirty = [];
    this.#keys = new Float64Array(0);
  }

  /**
   * Stacks every row; with `reuse`, in the buffers of the last update if
   * they fit, so stacks whose values change every tick do not allocate
   * every tick. Others (another chart's hidden series, say) get new ones:
   * a chart sharing the mark still reads the old.
   */
  #rebuild(
    table: Rows,
    layers: readonly BarLayer[],
    positions: ArrayLike<number>,
    bands: boolean,
    reuse: boolean,
  ) {
    const length = table.length;
    const capacity = reuse ? (this.#doubles[0]?.length ?? 0) : 0;
    if (capacity < length || capacity > 4 * capacityFor(length)) {
      const size = capacityFor(length);
      this.#doubles = Array.from({ length: this.#fill ? 3 : 2 }, () => new Float64Array(size));
      this.#ints = [new Int32Array(size), new Int32Array(size), new Int32Array(size)];
    }
    this.#start = 0;
    this.#ids.clear();
    this.#free = [];
    this.#listed.fill(0);
    this.#dirty = [];
    this.#take(table.rowOffset, layers, positions, bands, 0, length);
  }

  /**
   * Follows rows appended and dropped since the last update, marking the
   * positions they are at to be restacked; false when it cannot.
   */
  #follow(
    table: Rows,
    layers: readonly BarLayer[],
    positions: ArrayLike<number>,
    bands: boolean,
  ): boolean {
    const offset = table.rowOffset;
    const end = offset + table.length;
    // Identities only move forward, and some rows from before must remain.
    if (offset < this.#offset || end < this.#end || offset >= this.#end) return false;
    const [at, , next] = this.#ints as [Int32Array, Int32Array, Int32Array];
    for (let identity = this.#offset; identity < offset; identity++) {
      const slot = this.#start + identity - this.#offset;
      const p = at[slot]!;
      if (p < 0) continue;
      // Rows are linked in row order: the dropped ones lead their positions.
      this.#head[p] = next[slot]! > 0 ? identity + next[slot]! : -1;
      this.#count[p]!--;
      this.#mark(p);
    }
    this.#start += offset - this.#offset;
    const kept = this.#end - offset;
    this.#reserve(kept, table.length - kept);
    this.#take(offset, layers, positions, bands, kept, table.length);
    return true;
  }

  /** Makes room after the `kept` live rows for `count` more. */
  #reserve(kept: number, count: number) {
    const all = [...this.#doubles, ...this.#ints];
    const room = shrunk(all, this.#start, kept, count) ?? makeRoom(all, this.#start, kept, count);
    if (!room) return;
    const doubles = this.#fill ? 3 : 2;
    this.#doubles = room.slice(0, doubles) as Float64Array[];
    this.#ints = room.slice(doubles) as Int32Array[];
    this.#start = 0;
  }

  /**
   * Takes in table rows `[from, to)` (their identities from `offset`):
   * each row of a series at a position joins the end of the position's
   * list, which is marked to be restacked.
   */
  #take(
    offset: number,
    layers: readonly BarLayer[],
    positions: ArrayLike<number>,
    bands: boolean,
    from: number,
    to: number,
  ) {
    const [tops, bases] = this.#doubles as [Float64Array, Float64Array];
    const [at, layer, next] = this.#ints as [Int32Array, Int32Array, Int32Array];
    const start = this.#start;
    tops.fill(Number.NaN, start + from, start + to);
    bases.fill(Number.NaN, start + from, start + to);
    at.fill(-1, start + from, start + to);
    layer.fill(-1, start + from, start + to);
    next.fill(0, start + from, start + to);
    layers.forEach(({ rows }, l) => {
      for (let k = lowerRow(rows, from); k < rows.length; k++) layer[start + rows[k]!] = l;
    });
    for (let row = from; row < to; row++) {
      const slot = start + row;
      const position = positions[row]!;
      // Rows without a series or a place are not drawn, so not stacked.
      if (layer[slot]! < 0 || !(bands ? position >= 0 : Number.isFinite(position))) continue;
      const p = this.#idOf(position);
      const identity = offset + row;
      if (this.#count[p]! > 0) {
        const tail = this.#tail[p]!;
        next[start + tail - offset] = identity - tail;
      } else {
        this.#head[p] = identity;
      }
      this.#tail[p] = identity;
      this.#count[p]!++;
      at[slot] = p;
      this.#mark(p);
    }
  }

  /** Restacks the marked positions, and frees those left without rows. */
  #restack(table: Rows, values: NumericArray, layers: readonly BarLayer[]) {
    const [tops, bases] = this.#doubles as [Float64Array, Float64Array];
    const [, layer, next] = this.#ints as [Int32Array, Int32Array, Int32Array];
    const start = this.#start;
    const offset = table.rowOffset;
    for (const p of this.#dirty) {
      this.#listed[p] = 0;
      const count = this.#count[p]!;
      if (count === 0) {
        this.#ids.delete(this.#position[p]!);
        this.#free.push(p);
        continue;
      }
      if (this.#keys.length < count) this.#keys = new Float64Array(capacityFor(count));
      const keys = this.#keys;
      let identity = this.#head[p]!;
      for (let i = 0; i < count; i++) {
        const slot = start + identity - offset;
        keys[i] = layer[slot]! * ROW_KEYS + (identity - offset);
        identity += next[slot]!;
      }
      // Series order, then row order, as stackBars stacks: a position's few
      // rows by insertion, many by a typed sort.
      if (count > 16) keys.subarray(0, count).sort();
      else
        for (let i = 1; i < count; i++) {
          const key = keys[i]!;
          let j = i;
          for (; j > 0 && keys[j - 1]! > key; j--) keys[j] = keys[j - 1]!;
          keys[j] = key;
        }
      let total = 0;
      if (this.#fill) {
        for (let i = 0; i < count; i++) {
          const l = Math.floor(keys[i]! / ROW_KEYS);
          const row = keys[i]! - l * ROW_KEYS;
          const value = layers[l]!.shown ? values[row]! : 0;
          requireContribution(value, `bar stack "fill" row ${row}`);
          if (Number.isFinite(value)) total += value;
        }
        if (!Number.isFinite(total))
          throw new RangeError(
            'bar stack "fill": total exceeds finite numeric range; rescale the values',
          );
      }
      let up = 0;
      let down = 0;
      for (let i = 0; i < count; i++) {
        const l = Math.floor(keys[i]! / ROW_KEYS);
        const row = keys[i]! - l * ROW_KEYS;
        const raw = layers[l]!.shown ? values[row]! : 0;
        const value = this.#fill && Number.isFinite(raw) ? (total > 0 ? raw / total : 0) : raw;
        const slot = start + row;
        if (this.#fill) this.#doubles[2]![slot] = total;
        if (!Number.isFinite(value)) {
          tops[slot] = Number.NaN;
          bases[slot] = Number.NaN;
        } else if (value >= 0) {
          bases[slot] = up;
          up += value;
          tops[slot] = up;
        } else {
          bases[slot] = down;
          down += value;
          tops[slot] = down;
        }
      }
    }
    this.#dirty = [];
    if (this.#keys.length > RETAINED) this.#keys = new Float64Array(0);
  }

  /** The id of a position, numbered when it first has a row. */
  #idOf(position: number): number {
    let p = this.#ids.get(position);
    if (p !== undefined) return p;
    p = this.#free.pop() ?? this.#ids.size;
    if (p >= this.#count.length) this.#allocatePositions(capacityFor(p + 1));
    this.#ids.set(position, p);
    this.#position[p] = position;
    this.#count[p] = 0;
    return p;
  }

  #mark(p: number) {
    if (this.#listed[p]) return;
    this.#listed[p] = 1;
    this.#dirty.push(p);
  }

  /**
   * Numbers the positions with rows again from 0, in arrays sized for
   * them, rewriting the position of each of the `length` live rows.
   */
  #renumber(length: number) {
    const capacity = capacityFor(this.#ids.size);
    const renumbered = new Int32Array(this.#count.length).fill(-1);
    const position = new Float64Array(capacity);
    const count = new Int32Array(capacity);
    const head = new Float64Array(capacity);
    const tail = new Float64Array(capacity);
    let n = 0;
    for (const [value, p] of this.#ids) {
      renumbered[p] = n;
      position[n] = value;
      count[n] = this.#count[p]!;
      head[n] = this.#head[p]!;
      tail[n] = this.#tail[p]!;
      this.#ids.set(value, n++);
    }
    [this.#position, this.#count, this.#head, this.#tail] = [position, count, head, tail];
    this.#listed = new Uint8Array(capacity);
    this.#free = [];
    const at = this.#ints[0]!;
    for (let slot = this.#start; slot < this.#start + length; slot++)
      if (at[slot]! >= 0) at[slot] = renumbered[at[slot]!]!;
  }

  /** Room for `capacity` position ids, keeping the ones numbered. */
  #allocatePositions(capacity: number) {
    const grow = <T extends Float64Array | Int32Array | Uint8Array>(
      old: T,
      make: new (n: number) => T,
    ) => {
      const next = new make(capacity);
      next.set(old.subarray(0, Math.min(old.length, capacity)));
      return next;
    };
    this.#position = grow(this.#position, Float64Array);
    this.#count = grow(this.#count, Int32Array);
    this.#head = grow(this.#head, Float64Array);
    this.#tail = grow(this.#tail, Float64Array);
    this.#listed = grow(this.#listed, Uint8Array);
  }
}

/** The first index of `rows` (ascending) at least `row`. */
function lowerRow(rows: Uint32Array, row: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]! < row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
