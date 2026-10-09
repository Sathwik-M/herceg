// One level of row groups (data/groups.ts): the groups of the grouping
// fields down to one of them, each with its parent among the level above, its
// count of rows, and running aggregates, and the table, one row per group,
// that charts and grids read. Rows are added to and taken from every level
// they belong to. Sums are compensated (Neumaier) and keep a bound on the
// error their compensation gathers; a sum whose bound passes an ulp of it
// (values cancelling, as when a large one leaves a rolling window) is
// computed again exactly, as are minimums and maximums whose value left.

import type { ColumnInput, NumericArray } from "./column.ts";
import type { GroupKey, GroupOp } from "./groups.ts";
import { Table, type TableChange } from "./table.ts";

/** An aggregate as levels compute it: `field` is the index of its values among those read, -1 for none. */
export interface LevelAggregate {
  readonly name: string;
  readonly op: GroupOp;
  readonly field: number;
}

/**
 * The table of a level. An update writes several aggregates and appends new
 * groups, or resets the table; `hold` gathers what it writes into one change,
 * which `tell` gives listeners once every level's table is written, so none
 * sees some aggregates or levels updated and others not. (A `Table` method
 * doing this would be in every chart's bundle.)
 */
export class GroupTable extends Table {
  readonly #listeners = new Set<(change: TableChange) => void>();
  #held: {
    appended: number;
    start: number;
    end: number;
    fields: Set<string>;
    reset: boolean;
  } | null = null;

  constructor(columns: Record<string, ColumnInput>) {
    super(columns);
    super.subscribe((change) => {
      const held = this.#held;
      if (!held) {
        this.tell(change);
        return;
      }
      // Writes replace, append, or reset, which move no row.
      held.reset ||= change.reset;
      held.appended += change.appended;
      if (change.updated) {
        held.start = Math.min(held.start, change.updated.start);
        held.end = Math.max(held.end, change.updated.end);
      }
      for (const field of change.fields) held.fields.add(field);
    });
  }

  override subscribe(listener: (change: TableChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Makes the writes `write` makes, telling no listener; returns them as one change, or null for none. */
  hold(write: () => void): TableChange | null {
    const held = {
      appended: 0,
      start: Number.POSITIVE_INFINITY,
      end: 0,
      fields: new Set<string>(),
      reset: false,
    };
    this.#held = held;
    try {
      write();
    } finally {
      this.#held = null;
    }
    if (held.reset) return { dropped: 0, appended: 0, updated: null, fields: [], reset: true };
    const updated = held.fields.size > 0 ? { start: held.start, end: held.end } : null;
    if (!updated && held.appended === 0) return null;
    return { dropped: 0, appended: held.appended, updated, fields: [...held.fields], reset: false };
  }

  /** Tells listeners of a change. */
  tell(change: TableChange) {
    for (const listener of [...this.#listeners]) listener(change);
  }
}

/**
 * Unchanged groups between two changed ones that are written over rather
 * than ending a run: another `replace` costs about as much as copying them.
 */
const GAP = 64;

export class GroupLevel {
  readonly depth: number;
  /** Whether the level is the last, whose groups hold rows rather than groups. */
  readonly last: boolean;
  readonly aggregates: readonly LevelAggregate[];
  count = 0;
  /** Each group's own value of the level's grouping field: a label, a number, or null. */
  values: (string | number | null)[] = [];
  /** Each group's parent, a group of the level above; -1 on the first level. */
  parents = new Int32Array(0);
  /** Rows per group. */
  rows = new Float64Array(0);
  /** Per aggregate: a running count, sum, minimum, or maximum per group. */
  running: Float64Array[];
  /** Per aggregate, for sums and means: what rounding left out of the running sum. */
  low: (Float64Array | null)[];
  /** Per aggregate, for sums and means: a bound on the error of the running sum and `low` together. */
  error: (Float64Array | null)[];
  /** Per aggregate, for sums and means: 1 where summing the group's own rows overflowed. */
  overflowed: (Uint8Array | null)[];
  /** Per aggregate, for sums and means: the values summed. */
  finite: (Float64Array | null)[];
  /** Groups whose aggregates are to be computed again (a minimum or maximum left them, or a sum lost its accuracy). */
  stale = new Uint8Array(0);
  staleCount = 0;
  /** Groups changed since the table was last written, and their marks. */
  changed: number[] = [];
  #marked = new Uint8Array(0);
  /** Keys and ids of groups, made when first asked for. */
  keys: (GroupKey | undefined)[] = [];
  ids: (string | undefined)[] = [];
  /** Set once the level's table is made. */
  table!: GroupTable;
  /** The table's version and length as last written here. */
  published = { version: -1, length: 0 };

  constructor(depth: number, last: boolean, aggregates: readonly LevelAggregate[]) {
    this.depth = depth;
    this.last = last;
    this.aggregates = aggregates;
    this.running = aggregates.map(() => new Float64Array(0));
    this.low = aggregates.map(({ op }) =>
      op === "sum" || op === "mean" ? new Float64Array(0) : null,
    );
    this.error = this.low.map((low) => low && new Float64Array(0));
    this.overflowed = this.low.map((low) => low && new Uint8Array(0));
    this.finite = this.low.map((low) => low && new Float64Array(0));
  }

  /** Bytes the level's arrays take per group of room: its parent, rows, marks, and each aggregate's running values. */
  get bytesPerGroup(): number {
    return 14 + this.aggregates.reduce((sum, _, k) => sum + 8 + (this.low[k] ? 25 : 0), 0);
  }

  get byteLength(): number {
    let bytes = this.parents.byteLength + this.rows.byteLength + 2 * this.stale.byteLength;
    for (const running of this.running) bytes += running.byteLength;
    for (const low of this.low) bytes += 3 * (low?.byteLength ?? 0);
    for (const overflowed of this.overflowed) bytes += overflowed?.byteLength ?? 0;
    return bytes;
  }

  /** Adds a group without rows. */
  add(value: string | number | null, parent: number): number {
    const group = this.count++;
    if (group >= this.rows.length) this.#reserve(Math.max(64, Math.ceil((group + 1) * 1.5)));
    this.values[group] = value;
    this.parents[group] = parent;
    return group;
  }

  /** Records that a group's aggregates changed, for the next write of the table. */
  mark(group: number) {
    if (this.#marked[group]) return;
    this.#marked[group] = 1;
    this.changed.push(group);
  }

  /** Forgets which groups changed: the table was written with all of them. */
  unmark() {
    for (const group of this.changed) this.#marked[group] = 0;
    this.changed.length = 0;
  }

  /** Marks a group's aggregates to be computed again. */
  spoil(group: number) {
    if (this.stale[group]) return;
    this.stale[group] = 1;
    this.staleCount++;
  }

  /** Empties the aggregates of groups `from` to `to`. */
  clear(from: number, to: number) {
    this.rows.fill(0, from, to);
    this.aggregates.forEach(({ op }, k) => {
      this.running[k]!.fill(op === "min" || op === "max" ? Number.NaN : 0, from, to);
      this.low[k]?.fill(0, from, to);
      this.error[k]?.fill(0, from, to);
      this.overflowed[k]?.fill(0, from, to);
      this.finite[k]?.fill(0, from, to);
    });
  }

  /** Empties one group's aggregates. */
  empty(group: number) {
    this.clear(group, group + 1);
  }

  /** Forgets every group, and the room they took, to number them afresh. */
  forget() {
    this.unmark();
    this.count = 0;
    this.values = [];
    this.keys = [];
    this.ids = [];
    this.parents = new Int32Array(0);
    this.rows = new Float64Array(0);
    this.running = this.running.map(() => new Float64Array(0));
    this.low = this.low.map((low) => low && new Float64Array(0));
    this.error = this.error.map((error) => error && new Float64Array(0));
    this.overflowed = this.overflowed.map((overflowed) => overflowed && new Uint8Array(0));
    this.finite = this.finite.map((finite) => finite && new Float64Array(0));
    this.stale = new Uint8Array(0);
    this.#marked = new Uint8Array(0);
    this.staleCount = 0;
  }

  /**
   * Adds a row to a group (`sign` 1) or takes one away (-1), reading
   * aggregate `k`'s value at `columns[field][index]`; returns the group's
   * rows after. Taking away a group's minimum or maximum makes it stale.
   */
  change(group: number, sign: 1 | -1, columns: readonly ArrayLike<number>[], index: number) {
    this.mark(group);
    this.rows[group]! += sign;
    const aggregates = this.aggregates;
    for (let k = 0; k < aggregates.length; k++) {
      const { op, field } = aggregates[k]!;
      if (field < 0) continue;
      const value = columns[field]![index]!;
      if (!Number.isFinite(value)) continue;
      const running = this.running[k]!;
      if (op === "count") {
        running[group]! += sign;
      } else if (op === "sum" || op === "mean") {
        const low = this.low[k]!;
        const error = this.error[k]!;
        const finite = this.finite[k]!;
        finite[group]! += sign;
        // Without values, a sum is 0 exactly, whatever rounding left.
        if (finite[group] === 0) running[group] = low[group] = error[group] = 0;
        else addCompensated(running, low, error, group, sign * value);
        // Nothing can be taken back from an infinite sum (an overflow).
        if (sign < 0 && !Number.isFinite(running[group]!)) this.spoil(group);
      } else if (sign < 0) {
        if (value === running[group]) this.spoil(group);
      } else {
        const current = running[group]!;
        if (Number.isNaN(current) || (op === "min" ? value < current : value > current))
          running[group] = value;
      }
    }
    return this.rows[group]!;
  }

  /**
   * Computes again what taking rows away cannot keep of a group: its
   * minimums and maximums, and sums that lost their accuracy (exactly) or
   * overflowed, from its rows at `positions` (in table order, as a
   * computation from scratch adds them).
   */
  recompute(group: number, positions: Uint32Array, columns: readonly ArrayLike<number>[]) {
    this.aggregates.forEach(({ op, field }, k) => {
      if (field < 0) return;
      const values = columns[field]!;
      const running = this.running[k]!;
      if (op === "min" || op === "max") {
        const lower = op === "min";
        let extreme = Number.NaN;
        for (const position of positions) {
          const value = values[position]!;
          if (!Number.isFinite(value)) continue;
          if (Number.isNaN(extreme) || (lower ? value < extreme : value > extreme)) extreme = value;
        }
        running[group] = extreme;
      } else if (op === "sum" || op === "mean") {
        const [low, error] = [this.low[k]!, this.error[k]!];
        if (accurate(running, low, error, group, false)) return;
        const sum = new ExactSum();
        for (const position of positions) {
          const value = values[position]!;
          if (Number.isFinite(value)) sum.add(value);
        }
        sum.write(running, low, error, group);
        this.overflowed[k]![group] = sum.overflowed ? 1 : 0;
      }
    });
  }

  /**
   * Computes the sums of stale groups again exactly from the level below
   * (once `fold` gave them their other aggregates): their error is then the
   * error of their groups' sums.
   */
  resum(child: GroupLevel) {
    const stale = this.stale;
    this.low.forEach((low, k) => {
      if (!low) return;
      const sums = new Map<number, { sum: ExactSum; error: number }>();
      for (let c = 0; c < child.count; c++) {
        const group = child.parents[c]!;
        if (!stale[group]) continue;
        let entry = sums.get(group);
        if (!entry) {
          entry = { sum: new ExactSum(), error: 0 };
          sums.set(group, entry);
        }
        entry.sum.add(child.running[k]![c]!);
        entry.sum.add(child.low[k]![c]!);
        entry.error += child.error[k]![c]!;
      }
      const error = this.error[k]!;
      for (const [group, entry] of sums) {
        entry.sum.write(this.running[k]!, low, error, group);
        error[group]! += entry.error;
      }
    });
  }

  /**
   * Makes stale the groups (of `groups`, or all) whose sums may no longer
   * be within an ulp of their rows' exact sums. A last-level sum that
   * overflowed adding its rows is let be; one above may have overflowed
   * adding its groups' sums, which its rows need not.
   */
  checkSums(groups: readonly number[] | null) {
    this.low.forEach((low, k) => {
      if (!low) return;
      const [high, error, overflowed] = [this.running[k]!, this.error[k]!, this.overflowed[k]!];
      const check = (group: number) => {
        if (!accurate(high, low, error, group, this.last || overflowed[group] === 1))
          this.spoil(group);
      };
      if (groups) groups.forEach(check);
      else for (let group = 0; group < this.count; group++) check(group);
    });
  }

  /**
   * The stale groups whose sums are not accurate even once summed again
   * from the level below, or overflowed there (their rows may not).
   */
  inexact(): number[] {
    const groups: number[] = [];
    for (let group = 0; group < this.count; group++) {
      if (!this.stale[group]) continue;
      const off = this.low.some(
        (low, k) => low && !accurate(this.running[k]!, low, this.error[k]!, group, false),
      );
      if (off) groups.push(group);
    }
    return groups;
  }

  /** Marks the stale groups, whose aggregates were computed again, changed. */
  settle() {
    for (let group = 0; group < this.count; group++) {
      if (!this.stale[group]) continue;
      this.stale[group] = 0;
      this.mark(group);
    }
    this.staleCount = 0;
  }

  /** Aggregate `k` of a group. */
  result(k: number, group: number): number {
    const { op, field } = this.aggregates[k]!;
    if (op === "count") return field < 0 ? this.rows[group]! : this.running[k]![group]!;
    if (op === "min" || op === "max") return this.running[k]![group]!;
    const n = this.finite[k]![group]!;
    const sum = this.running[k]![group]! + this.low[k]![group]!;
    return op === "sum" ? sum : n > 0 ? sum / n : Number.NaN;
  }

  /**
   * Adds the rows, at window indices `from` to `to`, of the groups `slots`
   * gives them (-1 for none), reading the values of aggregate `k`'s field at
   * `columns[field][index - offset]`: a pass over each column.
   */
  accumulate(
    slots: Int32Array,
    from: number,
    to: number,
    columns: readonly NumericArray[],
    offset: number,
  ) {
    const rows = this.rows;
    for (let index = from; index < to; index++) {
      const group = slots[index]!;
      if (group >= 0) rows[group]!++;
    }
    this.aggregates.forEach(({ op, field }, k) => {
      if (field < 0) return;
      const values = columns[field]!;
      const out = this.running[k]!;
      if (op === "count") {
        for (let index = from; index < to; index++) {
          const group = slots[index]!;
          if (group >= 0 && Number.isFinite(values[index - offset]!)) out[group]!++;
        }
      } else if (op === "sum" || op === "mean") {
        const [low, error, finite] = [this.low[k]!, this.error[k]!, this.finite[k]!];
        for (let index = from; index < to; index++) {
          const group = slots[index]!;
          const value = values[index - offset]!;
          if (group < 0 || !Number.isFinite(value)) continue;
          addCompensated(out, low, error, group, value);
          finite[group]!++;
        }
      } else {
        const lower = op === "min";
        for (let index = from; index < to; index++) {
          const group = slots[index]!;
          const value = values[index - offset]!;
          if (group < 0 || !Number.isFinite(value)) continue;
          const current = out[group]!;
          if (Number.isNaN(current) || (lower ? value < current : value > current))
            out[group] = value;
        }
      }
    });
  }

  /**
   * Adds the aggregates of `child`'s groups to their parents here: of every
   * child, or with `only`, of children of the groups `only` marks.
   */
  fold(child: GroupLevel, only: Uint8Array | null) {
    const parents = child.parents;
    for (let c = 0; c < child.count; c++) {
      const group = parents[c]!;
      if (only && !only[group]) continue;
      this.rows[group]! += child.rows[c]!;
      this.aggregates.forEach(({ op }, k) => {
        const out = this.running[k]!;
        const value = child.running[k]![c]!;
        if (op === "count") out[group]! += value;
        else if (op === "sum" || op === "mean") {
          const [low, error] = [this.low[k]!, this.error[k]!];
          addCompensated(out, low, error, group, value);
          addCompensated(out, low, error, group, child.low[k]![c]!);
          error[group]! += child.error[k]![c]!;
          // An overflow adding groups' sums is not their rows' own.
          this.overflowed[k]![group] = 0;
          this.finite[k]![group]! += child.finite[k]![c]!;
        } else if (!Number.isNaN(value)) {
          const current = out[group]!;
          if (Number.isNaN(current) || (op === "min" ? value < current : value > current))
            out[group] = value;
        }
      });
    }
  }

  /**
   * Numbers the groups anew: group `g` becomes `remap[g]`, or leaves with -1;
   * parents become `parentRemap[parent]` when the level above was numbered anew.
   */
  renumber(remap: Int32Array | null, count: number, parentRemap: Int32Array | null) {
    const parents = this.parents;
    if (remap) {
      for (let group = 0; group < this.count; group++) {
        const to = remap[group]!;
        if (to < 0 || to === group) continue;
        parents[to] = parents[group]!;
        this.rows[to] = this.rows[group]!;
        this.values[to] = this.values[group]!;
        for (const running of this.running) running[to] = running[group]!;
        for (const low of this.low) if (low) low[to] = low[group]!;
        for (const error of this.error) if (error) error[to] = error[group]!;
        for (const overflowed of this.overflowed)
          if (overflowed) overflowed[to] = overflowed[group]!;
        for (const finite of this.finite) if (finite) finite[to] = finite[group]!;
      }
      this.values.length = count;
      this.clear(count, this.count);
      this.count = count;
      this.keys = [];
      this.ids = [];
    }
    if (parentRemap) {
      for (let group = 0; group < this.count; group++)
        parents[group] = parentRemap[parents[group]!]!;
      this.keys = [];
      this.ids = [];
    }
  }

  /**
   * Writes the table: where values of the groups marked changed differ
   * (every group's without marks), in runs of groups, then the groups added
   * since; or anew with `reset`, or when someone else changed it. Returns
   * the change for the table's listeners, who are not told yet, or null.
   * `columns` gives groups' columns as the table takes them.
   */
  publish(
    reset: boolean,
    everyGroup: boolean,
    columns: (from: number, to: number) => Record<string, ColumnInput>,
  ): TableChange | null {
    const table = this.table;
    const { version, length: old } = this.published;
    const changed = this.changed;
    const change = table.hold(() => {
      if (reset || table.version !== version || table.length !== old || old > this.count) {
        table.reset(columns(0, this.count) as never);
        return;
      }
      const groups = everyGroup
        ? null
        : changed.filter((group) => group < old).sort((a, b) => a - b);
      const count = groups ? groups.length : old;
      this.aggregates.forEach(({ name }, k) => {
        const column = table.numbers(name);
        // Runs of changed groups, as start and end pairs.
        const runs: number[] = [];
        for (let i = 0; i < count; i++) {
          const group = groups ? groups[i]! : i;
          if (Object.is(this.result(k, group), column[group])) continue;
          const last = runs.length - 1;
          if (last > 0 && group - runs[last]! <= GAP) runs[last] = group + 1;
          else runs.push(group, group + 1);
        }
        for (let r = 0; r < runs.length; r += 2) {
          const [start, end] = [runs[r]!, runs[r + 1]!];
          const values = new Float64Array(end - start);
          for (let group = start; group < end; group++)
            values[group - start] = this.result(k, group);
          table.replace(name, start, values);
        }
      });
      if (this.count > old) table.append(columns(old, this.count) as never);
    });
    this.unmark();
    this.published = { version: table.version, length: table.length };
    return change;
  }

  /** Gives back the room of groups gone once it is more than twice what the groups left need. */
  trim() {
    const capacity = Math.max(64, Math.ceil(this.count * 1.5));
    if (this.rows.length > 2 * capacity) this.#reserve(capacity);
  }

  /** Room for `capacity` groups, at least as many as there are. */
  #reserve(capacity: number) {
    const grow = <A extends Float64Array | Int32Array | Uint8Array>(array: A): A => {
      const next = new (array.constructor as new (length: number) => A)(capacity);
      next.set(array.length > capacity ? array.subarray(0, capacity) : array);
      return next;
    };
    const old = this.rows.length;
    this.parents = grow(this.parents);
    this.rows = grow(this.rows);
    this.running = this.running.map(grow);
    this.low = this.low.map((low) => low && grow(low));
    this.error = this.error.map((error) => error && grow(error));
    this.overflowed = this.overflowed.map((overflowed) => overflowed && grow(overflowed));
    this.finite = this.finite.map((finite) => finite && grow(finite));
    this.stale = grow(this.stale);
    this.#marked = grow(this.#marked);
    if (capacity > old) this.clear(old, capacity);
  }
}

/** The unit roundoff: an addition's result is off by at most this much of it. */
const ROUNDOFF = 2 ** -53;

/**
 * Adds `value` to the sum of `group` in `high`, keeping in `low` what
 * rounding left out (Neumaier's compensated summation, whose correction is
 * exact), and adding to `error` what adding that to `low` rounded away
 * (exactly, by Knuth's two-sum): the sum is `high + low`, off from the
 * exact sum by at most `error` and one rounding. An overflow to an infinity
 * keeps no compensation, and its error is unknown (infinite).
 */
export function addCompensated(
  high: Float64Array,
  low: Float64Array,
  error: Float64Array,
  group: number,
  value: number,
) {
  const sum = high[group]!;
  const next = sum + value;
  high[group] = next;
  if (!Number.isFinite(next)) {
    error[group] = Number.POSITIVE_INFINITY;
    return;
  }
  const lost = Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
  const before = low[group]!;
  const kept = before + lost;
  low[group] = kept;
  const back = kept - before;
  const dropped = before - (kept - back) + (lost - back);
  if (dropped !== 0) error[group]! += Math.abs(dropped);
}

/**
 * Whether a compensated sum is still within an ulp of the exact sum. With
 * `overflow`, sums that overflowed adding rows are let be, nothing better
 * being told of them until rows leave; never a missing sum (groups that
 * overflowed both ways).
 */
function accurate(
  high: Float64Array,
  low: Float64Array,
  error: Float64Array,
  group: number,
  overflow: boolean,
) {
  const sum = high[group]! + low[group]!;
  if (!Number.isFinite(sum)) return overflow && !Number.isNaN(sum);
  return error[group]! <= 2 * ROUNDOFF * Math.abs(sum);
}

/**
 * An exact sum of finite numbers: Shewchuk's nonoverlapping partials, as
 * Python's `math.fsum` keeps them, rounded once at the end. A partial that
 * overflows leaves only the plain sum.
 */
class ExactSum {
  #partials: number[] = [];
  #plain = 0;
  #overflowed = false;

  /** Whether a partial overflowed, leaving the plain sum. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  add(value: number) {
    this.#plain += value;
    if (this.#overflowed) return;
    const partials = this.#partials;
    let x = value;
    let kept = 0;
    for (let i = 0; i < partials.length; i++) {
      let y = partials[i]!;
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y;
      if (!Number.isFinite(high)) {
        this.#overflowed = true;
        partials.length = 0;
        return;
      }
      const low = y - (high - x);
      if (low !== 0) partials[kept++] = low;
      x = high;
    }
    partials.length = kept;
    partials.push(x);
  }

  /** Writes the sum as `high`, the rest of it as `low`, and what rounding the rest lost as `error`. */
  write(high: Float64Array, low: Float64Array, error: Float64Array, group: number) {
    if (this.#overflowed) {
      high[group] = this.#plain;
      low[group] = 0;
      error[group] = Number.POSITIVE_INFINITY;
      return;
    }
    const sum = rounded(this.#partials);
    const rest = this.#less(sum);
    high[group] = sum;
    low[group] = rounded(rest.#partials);
    error[group] = Math.abs(rounded(rest.#less(low[group]!).#partials));
  }

  /** This sum less `value`, exactly. */
  #less(value: number): ExactSum {
    const rest = new ExactSum();
    for (const partial of this.#partials) rest.add(partial);
    rest.add(-value);
    return rest;
  }
}

/** Nonoverlapping partials (ascending in magnitude) rounded once, half to even as `math.fsum` does. */
function rounded(partials: readonly number[]): number {
  let n = partials.length;
  if (n === 0) return 0;
  let high = partials[--n]!;
  let low = 0;
  while (n > 0) {
    const x = high;
    const y = partials[--n]!;
    high = x + y;
    low = y - (high - x);
    if (low !== 0) break;
  }
  // A tie the last rounding broke the wrong way, by the partials below it.
  if (n > 0 && ((low < 0 && partials[n - 1]! < 0) || (low > 0 && partials[n - 1]! > 0))) {
    const y = low * 2;
    const x = high + y;
    if (y === x - high) high = x;
  }
  return high;
}
