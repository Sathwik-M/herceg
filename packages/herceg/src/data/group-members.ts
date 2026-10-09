// The rows of each group (data/groups.ts), for readers that list them: a
// grid showing a group's rows, selecting a group, or groups finding a
// group's extreme again. One packed vector holds every group's run of rows
// in the view's order, each in a slot with room after it, so rows streaming
// in are written into that room rather than every run being listed again.
// Runs hold row identities (less a base), so rows dropped from the front of
// the table move no entry. A run without room moves to the end of the vector
// with room for half as many again; the vector is packed anew, every run
// with a quarter more room, when its end is reached.

/** Room every slot has beyond its run when packed, and the least a moved run gets. */
const MIN_ROOM = 4;

/** Entries are identities less the base, which must fit 32 bits. */
const MAX_ENTRY = 2 ** 32 - 1;

/** What a run's rows are ordered by: a comparator of table positions, or table order. */
export type Order = ((a: number, b: number) => number) | null;

export class MemberRuns {
  /** Each run's rows: their identities less `base`. */
  #entries = new Uint32Array(0);
  /** The identity entries count from: the table's `rowOffset` when the runs were listed. */
  readonly base: number;
  /** Per group: its slot, `[slotStart, slotEnd)`, and its run within it, `[start, start + length)`. */
  #slotStart = new Int32Array(0);
  #slotEnd = new Int32Array(0);
  #start = new Int32Array(0);
  #length = new Int32Array(0);
  #count = 0;
  /** Where the last slot ends. */
  #used = 0;

  /**
   * Lists the rows the view shows (its positions in order, or every row in
   * table order without them) by group: `groups[offset + position]` is a
   * row's group, -1 for none. Positions from `limit` on have none.
   */
  constructor(
    count: number,
    indices: Uint32Array | undefined,
    length: number,
    groups: Int32Array,
    offset: number,
    limit: number,
    rowOffset: number,
  ) {
    this.base = rowOffset;
    this.#reserve(count);
    this.#count = count;
    const groupAt = (position: number) => (position < limit ? groups[offset + position]! : -1);
    const lengths = this.#length;
    for (let i = 0; i < length; i++) {
      const group = groupAt(indices ? indices[i]! : i);
      if (group >= 0) lengths[group]!++;
    }
    const starts = this.#start;
    let at = 0;
    for (let group = 0; group < count; group++) {
      this.#slotStart[group] = starts[group] = at;
      at += roomFor(lengths[group]!);
      this.#slotEnd[group] = at;
    }
    this.#entries = new Uint32Array(at + tailRoom(at));
    this.#used = at;
    const next = starts.slice(0, count);
    const entries = this.#entries;
    for (let i = 0; i < length; i++) {
      const position = indices ? indices[i]! : i;
      const group = groupAt(position);
      if (group >= 0) entries[next[group]!++] = position;
    }
  }

  /** Whether identities up to `end` (exclusive) still fit the entries. */
  fits(end: number): boolean {
    return end - this.base <= MAX_ENTRY;
  }

  get byteLength(): number {
    return this.#entries.byteLength + 4 * this.#start.byteLength;
  }

  /**
   * The most bytes runs can hold listing up to `rows` rows of `groups`
   * groups, from `runs` (or listed anew): each group's place, whose room
   * never shrinks (half again once it grows), and the entries, which packing
   * replaces, at most each run with a quarter more room and one with half
   * again, and a quarter more after them.
   */
  static bytesAt(runs: MemberRuns | null, rows: number, groups: number): number {
    const places = runs ? runs.#start.length : 0;
    const room = groups > places ? Math.max(16, Math.ceil(groups * 1.5)) : places;
    const held = runs ? runs.#entries.length : 0;
    const entries = Math.max(held, Math.ceil(1.875 * rows + 5 * groups + 65));
    return 16 * room + 4 * entries;
  }

  size(group: number): number {
    return this.#length[group]!;
  }

  /** The table position of a group's `index`th row. */
  at(group: number, index: number, rowOffset: number): number {
    return this.#entries[this.#start[group]! + index]! + this.base - rowOffset;
  }

  /** Writes a group's rows, as table positions, into `target` from `at`; returns how many. */
  copy(group: number, target: Uint32Array, at: number, rowOffset: number): number {
    const start = this.#start[group]!;
    const length = this.#length[group]!;
    target.set(this.#entries.subarray(start, start + length), at);
    const shift = rowOffset - this.base;
    if (shift !== 0) for (let i = at; i < at + length; i++) target[i]! -= shift;
    return length;
  }

  /** Where the row at `position` is among its group's rows, or -1: a binary search. */
  indexOf(group: number, position: number, rowOffset: number, order: Order): number {
    const entries = this.#entries;
    const shift = rowOffset - this.base;
    const start = this.#start[group]!;
    const end = start + this.#length[group]!;
    let [lo, hi] = [start, end];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = entries[mid]! - shift;
      if (order ? order(at, position) < 0 : at < position) lo = mid + 1;
      else hi = mid;
    }
    return lo < end && entries[lo]! - shift === position ? lo - start : -1;
  }

  /** Adds groups, up to `count` in all, without rows. */
  grow(count: number) {
    this.#reserve(count);
    for (let group = this.#count; group < count; group++) {
      this.#slotStart[group] = this.#slotEnd[group] = this.#start[group] = this.#used;
      this.#length[group] = 0;
    }
    this.#count = count;
  }

  /** Adds a row to the end of a group's run: rows of views in table order stream in there. */
  push(group: number, identity: number) {
    this.#room(group, 1);
    this.#entries[this.#start[group]! + this.#length[group]!++] = identity - this.base;
  }

  /**
   * Adds rows to a group's run where they go among its rows in `order`:
   * `identities` must be ascending in it. A merge from the back, into the
   * room after the run.
   */
  merge(
    group: number,
    identities: ArrayLike<number>,
    order: (a: number, b: number) => number,
    rowOffset: number,
  ) {
    const k = identities.length;
    if (k === 0) return;
    this.#room(group, k);
    const entries = this.#entries;
    const base = this.base;
    const start = this.#start[group]!;
    const length = this.#length[group]!;
    this.#length[group] = length + k;
    const shift = rowOffset - base;
    let [i, j, out] = [start + length - 1, k - 1, start + length + k - 1];
    while (j >= 0) {
      const incoming = identities[j]! - rowOffset;
      if (i >= start && order(entries[i]! - shift, incoming) > 0) entries[out--] = entries[i--]!;
      else entries[out--] = identities[j--]! - base;
    }
  }

  /** Takes a group's first `count` rows out of its run. */
  dropFirst(group: number, count: number) {
    this.#start[group]! += count;
    this.#length[group]! -= count;
  }

  /** Takes the rows with identities before `identity` out of a group's run, wherever they are in it. */
  dropBefore(group: number, identity: number) {
    const entries = this.#entries;
    const limit = identity - this.base;
    const start = this.#start[group]!;
    const end = start + this.#length[group]!;
    let kept = start;
    for (let i = start; i < end; i++) {
      const entry = entries[i]!;
      if (entry >= limit) entries[kept++] = entry;
    }
    this.#length[group] = kept - start;
  }

  /** Numbers the groups anew: group `g` becomes `remap[g]`, or leaves with -1. */
  renumber(remap: Int32Array, count: number) {
    // Survivors only move down, so moving them in order overwrites nothing still needed.
    for (let group = 0; group < this.#count; group++) {
      const to = remap[group]!;
      if (to < 0 || to === group) continue;
      this.#slotStart[to] = this.#slotStart[group]!;
      this.#slotEnd[to] = this.#slotEnd[group]!;
      this.#start[to] = this.#start[group]!;
      this.#length[to] = this.#length[group]!;
    }
    this.#count = count;
  }

  /** Room for `extra` more rows after a group's run. */
  #room(group: number, extra: number) {
    const start = this.#start[group]!;
    const length = this.#length[group]!;
    const slotStart = this.#slotStart[group]!;
    const slotEnd = this.#slotEnd[group]!;
    if (start + length + extra <= slotEnd) return;
    if (length + extra <= slotEnd - slotStart) {
      // Rows dropped from the front left room there.
      this.#entries.copyWithin(slotStart, start, start + length);
      this.#start[group] = slotStart;
      return;
    }
    const capacity = Math.max(MIN_ROOM, Math.ceil((length + extra) * 1.5));
    if (this.#used + capacity > this.#entries.length) {
      this.#pack(group, capacity);
      return;
    }
    const at = this.#used;
    this.#entries.copyWithin(at, start, start + length);
    this.#slotStart[group] = this.#start[group] = at;
    this.#slotEnd[group] = at + capacity;
    this.#used = at + capacity;
  }

  /** Packs every run into a new vector, `group`'s in a slot of `capacity`. */
  #pack(group: number, capacity: number) {
    const count = this.#count;
    const lengths = this.#length;
    let total = 0;
    for (let g = 0; g < count; g++) total += g === group ? capacity : roomFor(lengths[g]!);
    const entries = new Uint32Array(total + tailRoom(total));
    let at = 0;
    for (let g = 0; g < count; g++) {
      const start = this.#start[g]!;
      entries.set(this.#entries.subarray(start, start + lengths[g]!), at);
      this.#slotStart[g] = this.#start[g] = at;
      at += g === group ? capacity : roomFor(lengths[g]!);
      this.#slotEnd[g] = at;
    }
    this.#entries = entries;
    this.#used = at;
  }

  /** Room for `count` groups. */
  #reserve(count: number) {
    if (count <= this.#start.length) return;
    const capacity = Math.max(16, Math.ceil(count * 1.5));
    const grow = (array: Int32Array) => {
      const next = new Int32Array(capacity);
      next.set(array.subarray(0, this.#count));
      return next;
    };
    this.#slotStart = grow(this.#slotStart);
    this.#slotEnd = grow(this.#slotEnd);
    this.#start = grow(this.#start);
    this.#length = grow(this.#length);
  }
}

/** A run's slot when packed: a quarter more room, and at least `MIN_ROOM`. */
function roomFor(length: number): number {
  return length + (length >> 2) + MIN_ROOM;
}

/** Room past the last slot, for runs that move and groups that start. */
function tailRoom(used: number): number {
  return Math.max(64, used >> 2);
}
