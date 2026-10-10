import type { Schema, Table } from "./table.ts";

// Identities and their differences can pass 2^32 in long streams, so word
// indexes divide rather than shift, which would wrap.

/**
 * A set of a table's rows, such as the rows selected in a grid. Rows are
 * held by identity (`rowOffset + position`), so they stay members while
 * other rows are appended or dropped, and leave when they are dropped
 * themselves. A reset starts identities again, so a set made before one is
 * empty after it. One bit per row, from the first row the set could hold.
 */
export class RowSet<S extends Schema = Schema> {
  readonly source: Table<S>;
  /** The table's generation the set belongs to. */
  readonly generation: number;
  /** Identity of bit 0, a multiple of 32. */
  #base: number;
  #words: Uint32Array;
  /** Set bits, including those of rows dropped since and not trimmed yet. */
  #count = 0;
  /** Counts the changes of membership: adding, deleting, and clearing rows. */
  #version = 0;

  constructor(source: Table<S>) {
    this.source = source;
    this.generation = source.generation;
    this.#base = source.rowOffset - (source.rowOffset % 32);
    this.#words = new Uint32Array(0);
  }

  /** Whether the set is for the table's current rows, not from before a reset. */
  get current(): boolean {
    return this.source.generation === this.generation;
  }

  /** Members still in the table. */
  get size(): number {
    if (!this.current) return 0;
    this.#trim();
    return this.#count;
  }

  /** Bytes of the bits. */
  get byteLength(): number {
    return this.#words.byteLength;
  }

  /**
   * Increments when rows are added, deleted, or cleared (not when rows the
   * table drops leave), so readers of a set that changes in place notice.
   */
  get version(): number {
    return this.#version;
  }

  /** Whether the row at `position` (an index into the table's current rows) is a member. */
  has(position: number): boolean {
    if (!this.current || !(position >= 0 && position < this.source.length)) return false;
    const bit = this.source.rowOffset + position - this.#base;
    return ((this.#words[Math.floor(bit / 32)] ?? 0) & (1 << (bit & 31))) !== 0;
  }

  add(position: number): this {
    this.addRange(position, position + 1);
    return this;
  }

  /** Adds the rows at positions `start` to `end` (exclusive). */
  addRange(start: number, end: number): this {
    this.#check();
    this.#positions(start, end);
    this.#trim();
    if (end <= start) return this;
    this.#version++;
    const first = this.source.rowOffset + start - this.#base;
    this.#reserve(first + (end - start));
    for (let bit = first; bit < first + (end - start); bit++) {
      const mask = 1 << (bit & 31);
      const word = Math.floor(bit / 32);
      if ((this.#words[word]! & mask) === 0) {
        this.#words[word]! |= mask;
        this.#count++;
      }
    }
    return this;
  }

  /** Adds the rows at these positions, in any order: one pass, for many rows at once. */
  addAll(positions: ArrayLike<number>): this {
    this.#check();
    this.#trim();
    let last = -1;
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i]!;
      this.#positions(position, position + 1);
      if (position > last) last = position;
    }
    if (last < 0) return this;
    this.#version++;
    const shift = this.source.rowOffset - this.#base;
    this.#reserve(shift + last + 1);
    const words = this.#words;
    for (let i = 0; i < positions.length; i++) {
      const bit = positions[i]! + shift;
      const word = Math.floor(bit / 32);
      const mask = 1 << (bit & 31);
      if ((words[word]! & mask) === 0) {
        words[word]! |= mask;
        this.#count++;
      }
    }
    return this;
  }

  delete(position: number): this {
    this.#check();
    this.#positions(position, position + 1);
    const bit = this.source.rowOffset + position - this.#base;
    const word = Math.floor(bit / 32);
    const mask = 1 << (bit & 31);
    if (word < this.#words.length && (this.#words[word]! & mask) !== 0) {
      this.#words[word]! &= ~mask;
      this.#count--;
      this.#version++;
    }
    return this;
  }

  clear(): this {
    this.#version++;
    this.#empty();
    return this;
  }

  /** The positions of the members, ascending. */
  positions(): Uint32Array {
    if (!this.current) return new Uint32Array(0);
    this.#trim();
    const out = new Uint32Array(this.#count);
    const shift = this.#base - this.source.rowOffset;
    let n = 0;
    for (let word = 0; word < this.#words.length; word++) {
      let bits = this.#words[word]!;
      while (bits !== 0) {
        const low = bits & -bits;
        out[n++] = word * 32 + (31 - Math.clz32(low)) + shift;
        bits ^= low;
      }
    }
    return out;
  }

  #empty() {
    this.#words = new Uint32Array(0);
    this.#base = this.source.rowOffset - (this.source.rowOffset % 32);
    this.#count = 0;
  }

  #check() {
    if (!this.current) throw new Error("The table was reset after this row set was made");
  }

  #positions(start: number, end: number) {
    if (
      !(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= this.source.length)
    )
      throw new RangeError(
        `Rows ${start} to ${end} are not in the table's ${this.source.length} rows`,
      );
  }

  #reserve(bits: number) {
    const words = Math.ceil(bits / 32);
    if (words <= this.#words.length) return;
    const grown = new Uint32Array(Math.max(words, Math.ceil(this.#words.length * 1.5)));
    grown.set(this.#words);
    this.#words = grown;
  }

  /** Forgets rows dropped from the table, moving the bits down. */
  #trim() {
    const dropped = this.source.rowOffset - this.#base;
    if (dropped <= 0) return;
    const words = Math.floor(dropped / 32);
    if (words >= this.#words.length) {
      this.#empty();
      return;
    }
    if (words > 0) {
      for (let word = 0; word < words; word++) this.#count -= popcount(this.#words[word]!);
      this.#words.copyWithin(0, words);
      this.#words.fill(0, this.#words.length - words);
      this.#base += words * 32;
    }
    // Rows dropped from the first word still kept.
    const below = this.source.rowOffset - this.#base;
    if (below > 0) {
      const mask = (1 << below) - 1;
      this.#count -= popcount(this.#words[0]! & mask);
      this.#words[0]! &= ~mask;
    }
  }
}

function popcount(word: number): number {
  let n = word - ((word >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
