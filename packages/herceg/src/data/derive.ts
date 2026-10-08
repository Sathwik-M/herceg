// Derived tables: rows computed from another table by the spec's transforms
// (filter, calculate, bin, aggregate, rolling, sort). The result is an
// ordinary table that follows its source: rows appended to the source go
// through pipelines that work row by row (filter, calculate, bin) on their
// own, and drops remove the rows they produced; any other change, or any
// other pipeline, recomputes the table.

import { tickStep } from "../scale/ticks.ts";
import type {
  AggregateOp,
  AggregateSpec,
  RollingOp,
  RollingSpec,
  TransformSpec,
} from "../spec/spec.ts";
import {
  type ColumnInput,
  encodedCategory,
  type FieldKind,
  type NumericArray,
  time,
} from "./column.ts";
import {
  compileExpression,
  type Expr,
  type Expression,
  expressionOf,
  type Fields,
  type KindOf,
} from "./expression.ts";
import {
  type CategoryField,
  type FieldName,
  type NumericField,
  type Schema,
  scanExtent,
  type Table,
  type TableChange,
  table,
} from "./table.ts";

/** A column between steps. Columns read from the source are not owned and are copied at the end. */
type Column =
  | { kind: "number" | "time"; values: NumericArray; owned: boolean }
  | { kind: "category"; codes: Int32Array; dictionary: readonly string[]; owned: boolean };

/** Rows between steps: columns of one length, and each row's source row identity. */
class Rows implements Fields {
  readonly length: number;
  readonly columns: Map<string, Column>;
  /** Source row identity (the source's rowOffset + index) of each row, while rows map to source rows. */
  readonly ids: Float64Array | undefined;

  constructor(length: number, columns: Map<string, Column>, ids: Float64Array | undefined) {
    this.length = length;
    this.columns = columns;
    this.ids = ids;
  }

  fields(): string[] {
    return [...this.columns.keys()];
  }
  has(name: string): boolean {
    return this.columns.has(name);
  }
  kind(name: string) {
    return this.#column(name).kind;
  }
  numbers(name: string): NumericArray {
    const column = this.#column(name);
    if (column.kind === "category") throw new TypeError(`Field "${name}" is a category`);
    return column.values;
  }
  categories(name: string): { codes: Int32Array; dictionary: readonly string[] } {
    const column = this.#column(name);
    if (column.kind !== "category") throw new TypeError(`Field "${name}" is not a category`);
    return column;
  }

  #column(name: string): Column {
    const column = this.columns.get(name);
    if (!column) {
      const known = this.fields()
        .map((f) => `"${f}"`)
        .join(", ");
      throw new Error(`Unknown field "${name}"; the rows have ${known}`);
    }
    return column;
  }

  /** The rows at `indexes`, in that order. */
  pick(indexes: ArrayLike<number>): Rows {
    const n = indexes.length;
    const columns = new Map<string, Column>();
    for (const [name, column] of this.columns) {
      if (column.kind === "category") {
        const codes = new Int32Array(n);
        for (let i = 0; i < n; i++) codes[i] = column.codes[indexes[i]!]!;
        columns.set(name, { ...column, codes, owned: true });
      } else {
        const values = new Float64Array(n);
        for (let i = 0; i < n; i++) values[i] = column.values[indexes[i]!]!;
        columns.set(name, { kind: column.kind, values, owned: true });
      }
    }
    let ids: Float64Array | undefined;
    if (this.ids) {
      ids = new Float64Array(n);
      for (let i = 0; i < n; i++) ids[i] = this.ids[indexes[i]!]!;
    }
    return new Rows(n, columns, ids);
  }

  /** These rows with one column added or replaced. */
  with(name: string, column: Column): Rows {
    const columns = new Map(this.columns);
    columns.set(name, column);
    return new Rows(this.length, columns, this.ids);
  }
}

/** The rows of a table from position `from`, as views of its columns. */
function rowsOf(source: Table, from = 0): Rows {
  const n = source.length - from;
  const columns = new Map<string, Column>();
  for (const name of source.fields()) {
    const kind = source.kind(name);
    if (kind === "category") {
      const { codes, dictionary } = source.categories(name);
      columns.set(name, {
        kind,
        codes: codes.subarray(from),
        dictionary: [...dictionary],
        owned: false,
      });
    } else {
      columns.set(name, { kind, values: source.numbers(name).subarray(from), owned: false });
    }
  }
  const ids = new Float64Array(n);
  for (let i = 0; i < n; i++) ids[i] = source.rowOffset + from + i;
  return new Rows(n, columns, ids);
}

/** Whether a step maps each row to at most one row, in order, on its own. */
function rowwise(step: TransformSpec): boolean {
  return "filter" in step || "calculate" in step || ("bin" in step && step.step !== undefined);
}

function apply(rows: Rows, step: TransformSpec): Rows {
  if ("filter" in step) return filter(rows, step.filter);
  if ("calculate" in step) return calculate(rows, step);
  if ("bin" in step) return bin(rows, step);
  if ("aggregate" in step) return aggregate(rows, step.aggregate, step.groupby ?? []);
  if ("rolling" in step) return rolling(rows, step.rolling, step.size, step.groupby ?? []);
  if ("sort" in step) return sort(rows, step.sort, step.order ?? "ascending");
  throw new TypeError(`Unknown transform ${JSON.stringify(step)}`);
}

function filter(rows: Rows, expression: Expression): Rows {
  const test = compileExpression(expression, rows);
  if (test.type !== "boolean")
    throw new TypeError(`A filter needs a true or false expression, not a ${test.type}`);
  const kept: number[] = [];
  for (let i = 0; i < rows.length; i++) if (test.at(i)) kept.push(i);
  return kept.length === rows.length ? rows : rows.pick(kept);
}

function calculate(
  rows: Rows,
  { calculate: expression, as }: { calculate: Expression; as: string },
): Rows {
  const value = compileExpression(expression, rows);
  const n = rows.length;
  if (value.type === "string") {
    const dictionary: string[] = [];
    const codeOf = new Map<string, number>();
    const codes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const text = value.at(i) as string | null;
      if (text === null) {
        codes[i] = -1;
        continue;
      }
      let code = codeOf.get(text);
      if (code === undefined) {
        code = dictionary.length;
        dictionary.push(text);
        codeOf.set(text, code);
      }
      codes[i] = code;
    }
    return rows.with(as, { kind: "category", codes, dictionary, owned: true });
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = Number(value.at(i));
  return rows.with(as, { kind: "number", values, owned: true });
}

/** The default number of bins when neither a step nor a count is given. */
const BINS = 10;

function bin(
  rows: Rows,
  step: { bin: string; as?: string; step?: number; count?: number; start?: number },
): Rows {
  const kind = rows.kind(step.bin);
  if (kind === "category")
    throw new TypeError(`Field "${step.bin}" is a category; bins need numbers or times`);
  if (step.count !== undefined && !(Number.isInteger(step.count) && step.count >= 1))
    throw new RangeError(`Bin count must be a whole number of at least 1, not ${step.count}`);
  if (step.step !== undefined && !(step.step > 0 && Number.isFinite(step.step)))
    throw new RangeError(`Bin step must be a positive number, not ${step.step}`);
  if (step.start !== undefined && !Number.isFinite(step.start))
    throw new RangeError(`Bin start must be a finite number, not ${step.start}`);
  const values = rows.numbers(step.bin);
  const extent = scanExtent(values, 0, values.length);
  // Without a spread of values (none, or one), bins are 1 wide. Round steps
  // have one significant digit; reading them back from it undoes the
  // rounding of powers of ten (0.00009999999999999999 for 0.0001).
  const automatic =
    extent && extent[1] > extent[0]
      ? Number(tickStep(extent[0], extent[1], step.count ?? BINS).toPrecision(1))
      : 1;
  const width = step.step ?? automatic;
  if (!(width > 0 && Number.isFinite(width)))
    throw new RangeError(
      `No bin step fits values from ${extent![0]} to ${extent![1]}; give a step`,
    );
  // Without a start, edges are multiples of the step, the same for every
  // batch of appended rows.
  const edge = binEdges(step.start ?? 0, width);
  const start = edge(0);
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const value = values[i]!;
    let k = Math.floor((value - start) / width);
    if (!Number.isFinite(k)) {
      out[i] = Number.NaN;
      continue;
    }
    // Past 2 ** 53 bins from the start, bin numbers are not exact: each value
    // starts its own bin, so no bin starts above its values.
    if (!Number.isSafeInteger(k)) {
      out[i] = value;
      continue;
    }
    // A value belongs to the bin whose edges hold it; division can put one
    // just below an edge it is on (0.3 / 0.1 is 2.999…).
    if (edge(k + 1) <= value) k++;
    else if (edge(k) > value) k--;
    out[i] = edge(k);
  }
  return rows.with(step.as ?? step.bin, { kind, values: out, owned: true });
}

/**
 * The edges `start + k × width` of bins, the first exactly `start`. When the
 * start and width are exactly short decimals (0.1, 1000000000.25), edges are
 * counted in whole units of their last decimal, so 0.3 is an edge of 0.1
 * bins; otherwise (1/3, 1e-300, 0.12345678901234566) they are computed
 * directly.
 */
function binEdges(start: number, width: number): (k: number) => number {
  const direct = (k: number) => start + k * width;
  const decimals = Math.max(decimalsOf(start), decimalsOf(width));
  if (decimals === Number.POSITIVE_INFINITY) return direct;
  const scale = 10 ** decimals;
  const first = Math.round(start * scale);
  const unit = Math.round(width * scale);
  const exact =
    Number.isSafeInteger(first) &&
    Number.isSafeInteger(unit) &&
    first / scale === start &&
    unit / scale === width;
  if (!exact) return direct;
  return (k) => {
    const units = first + k * unit;
    return Number.isSafeInteger(units) ? units / scale : direct(k);
  };
}

/**
 * The fewest decimals that write `x` exactly (1 for 0.1, 2 for -0.25), or
 * Infinity when none up to 22 do with a safe integer of units.
 */
function decimalsOf(x: number): number {
  // 10 ** 22 is the largest power of ten a double holds exactly.
  for (let decimals = 0; decimals <= 22; decimals++) {
    const scale = 10 ** decimals;
    const units = Math.round(x * scale);
    if (!Number.isSafeInteger(units)) break;
    if (units / scale === x) return decimals;
  }
  return Number.POSITIVE_INFINITY;
}

/** Rows grouped by `fields`: each row's group, and each group's first row, in order of appearance. */
function groupsOf(rows: Rows, fields: readonly string[]): { group: Int32Array; firsts: number[] } {
  const group = new Int32Array(rows.length);
  const firsts: number[] = [];
  if (fields.length === 0) {
    if (rows.length > 0) firsts.push(0);
    return { group, firsts };
  }
  const keys = fields.map((name) =>
    rows.kind(name) === "category" ? rows.categories(name).codes : rows.numbers(name),
  );
  const index = new Map<string | number, number>();
  for (let i = 0; i < rows.length; i++) {
    const key = keys.length === 1 ? keys[0]![i]! : keys.map((k) => k[i]).join("\u0000");
    let g = index.get(key);
    if (g === undefined) {
      g = firsts.length;
      index.set(key, g);
      firsts.push(i);
    }
    group[i] = g;
  }
  return { group, firsts };
}

/** Operations whose result is a value of the field (a time stays a time); the others count or measure spread. */
const KEEPS_KIND = new Set<AggregateOp | RollingOp>([
  "mean",
  "median",
  "min",
  "max",
  "q1",
  "q3",
  "first",
  "last",
]);

function aggregate(rows: Rows, specs: readonly AggregateSpec[], groupby: readonly string[]): Rows {
  const { group, firsts } = groupsOf(rows, groupby);
  // Without groups there is always one row, even for no input: a count of 0.
  const groups = groupby.length === 0 ? 1 : firsts.length;
  const columns = new Map<string, Column>();
  // Grouping fields keep the value of each group's first row.
  const firstRows = rows.pick(firsts);
  for (const name of groupby) columns.set(name, firstRows.columns.get(name)!);
  for (const spec of specs) {
    const values = spec.field === undefined ? undefined : rows.numbers(spec.field);
    if (spec.op !== "count" && !values) throw new TypeError(`Aggregate "${spec.op}" needs a field`);
    const out = aggregateOp(spec.op, values, group, groups, rows.length);
    const kind =
      spec.field !== undefined && KEEPS_KIND.has(spec.op) && rows.kind(spec.field) === "time"
        ? "time"
        : "number";
    columns.set(spec.as, { kind, values: out, owned: true });
  }
  return new Rows(groups, columns, undefined);
}

function aggregateOp(
  op: AggregateOp,
  values: NumericArray | undefined,
  group: Int32Array,
  groups: number,
  n: number,
): Float64Array {
  const out = new Float64Array(groups);
  const finite = (i: number) => values !== undefined && Number.isFinite(values[i]!);
  switch (op) {
    case "count": {
      for (let i = 0; i < n; i++) if (!values || finite(i)) out[group[i]!]!++;
      return out;
    }
    case "sum":
    case "mean": {
      const counts = new Float64Array(groups);
      for (let i = 0; i < n; i++) {
        if (!finite(i)) continue;
        out[group[i]!]! += values![i]!;
        counts[group[i]!]!++;
      }
      if (op === "mean")
        for (let g = 0; g < groups; g++)
          out[g] = counts[g]! > 0 ? out[g]! / counts[g]! : Number.NaN;
      return out;
    }
    case "min":
    case "max": {
      out.fill(Number.NaN);
      const better =
        op === "min" ? (a: number, b: number) => a < b : (a: number, b: number) => a > b;
      for (let i = 0; i < n; i++) {
        if (!finite(i)) continue;
        const g = group[i]!;
        if (Number.isNaN(out[g]!) || better(values![i]!, out[g]!)) out[g] = values![i]!;
      }
      return out;
    }
    case "first":
    case "last": {
      out.fill(Number.NaN);
      const seen = new Uint8Array(groups);
      for (let i = 0; i < n; i++) {
        const g = group[i]!;
        if (op === "first" && seen[g]) continue;
        out[g] = values![i]!;
        seen[g] = 1;
      }
      return out;
    }
    case "stdev":
    case "variance": {
      // Welford's running mean and squared deviations; sample (n − 1) statistics.
      const counts = new Float64Array(groups);
      const means = new Float64Array(groups);
      for (let i = 0; i < n; i++) {
        if (!finite(i)) continue;
        const g = group[i]!;
        const count = ++counts[g]!;
        const delta = values![i]! - means[g]!;
        means[g]! += delta / count;
        out[g]! += delta * (values![i]! - means[g]!);
      }
      for (let g = 0; g < groups; g++) {
        const variance = counts[g]! > 1 ? out[g]! / (counts[g]! - 1) : Number.NaN;
        out[g] = op === "stdev" ? Math.sqrt(variance) : variance;
      }
      return out;
    }
    case "distinct": {
      const sets = Array.from({ length: groups }, () => new Set<number>());
      for (let i = 0; i < n; i++) if (finite(i)) sets[group[i]!]!.add(values![i]!);
      for (let g = 0; g < groups; g++) out[g] = sets[g]!.size;
      return out;
    }
    case "median":
    case "q1":
    case "q3": {
      const lists = Array.from({ length: groups }, () => [] as number[]);
      for (let i = 0; i < n; i++) if (finite(i)) lists[group[i]!]!.push(values![i]!);
      const p = op === "median" ? 0.5 : op === "q1" ? 0.25 : 0.75;
      for (let g = 0; g < groups; g++)
        out[g] = quantile(
          lists[g]!.sort((a, b) => a - b),
          p,
        );
      return out;
    }
  }
  throw new TypeError(`Unknown aggregate "${op as string}"`);
}

/** The p-quantile of ascending values, interpolating linearly between ranks (as NumPy and pandas do). */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (sorted.length - 1) * p;
  const below = Math.floor(rank);
  const above = Math.min(sorted.length - 1, below + 1);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (rank - below);
}

function rolling(
  rows: Rows,
  specs: readonly RollingSpec[],
  size: number,
  groupby: readonly string[],
): Rows {
  if (!(Number.isInteger(size) && size >= 1))
    throw new RangeError(`Rolling size must be a whole number of at least 1, not ${size}`);
  const { group, firsts } = groupsOf(rows, groupby);
  // Each group's rows, in order.
  const members = Array.from({ length: firsts.length }, () => [] as number[]);
  for (let i = 0; i < rows.length; i++) members[group[i]!]!.push(i);
  let out = rows;
  for (const spec of specs) {
    let values = rows.numbers(spec.field);
    // Means of values spread wider than the largest double can differ by
    // more than it: such values are halved, and the results doubled back.
    const extent = scanExtent(values, 0, values.length);
    const halved = extent !== undefined && !Number.isFinite(extent[1] - extent[0]);
    if (halved) values = Float64Array.from(values, (value) => value / 2);
    const result = new Float64Array(rows.length);
    for (const list of members) rollingOp(spec.op, values, list, size, result);
    if (halved && spec.op !== "count") for (let i = 0; i < result.length; i++) result[i]! *= 2;
    const kind = KEEPS_KIND.has(spec.op) && rows.kind(spec.field) === "time" ? "time" : "number";
    out = out.with(spec.as, { kind, values: result, owned: true });
  }
  return out;
}

/**
 * One rolling operation over a group's rows: each row takes the operation
 * over the finite values among itself and the `size` − 1 rows before it.
 * The window is a queue kept as two stacks (the "two stacks" sliding
 * window): the front holds the aggregate of each value and those after it,
 * the back one running aggregate, and the window's is their combination.
 * Aggregates only ever combine, never subtract a value that left, so huge
 * values leaving a window do not wipe out small ones (as running sums do),
 * and each row costs O(1) amortized.
 */
function rollingOp(
  op: RollingOp,
  values: NumericArray,
  list: readonly number[],
  size: number,
  out: Float64Array,
): void {
  const capacity = Math.min(size, list.length);
  // Front stack: suffix aggregates, the newest at index 0, `front` of them.
  const fn = new Float64Array(capacity);
  const fMean = new Float64Array(capacity);
  const fM2 = new Float64Array(capacity);
  const fMin = new Float64Array(capacity);
  const fMax = new Float64Array(capacity);
  let front = 0;
  // Back stack: one running aggregate of the newest values.
  const back = { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
  const result = { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
  for (let k = 0; k < list.length; k++) {
    // Push value k on the back.
    const value = values[list[k]!]!;
    if (Number.isFinite(value)) add(back, 1, value, 0, value, value);
    // Drop the value that left the window from the front, refilling it from
    // the back when empty.
    if (k >= size) {
      if (front === 0) {
        // The back's positions (k − size + 1 … k − 1, oldest first) after the
        // one leaving, as suffix aggregates: newest first.
        const first = k - size + 1;
        const running = { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
        for (let p = k - 1; p >= first; p--) {
          const v = values[list[p]!]!;
          if (Number.isFinite(v)) add(running, 1, v, 0, v, v);
          // Stored oldest last: index (k − 1 − p).
          fn[front] = running.n;
          fMean[front] = running.mean;
          fM2[front] = running.m2;
          fMin[front] = running.min;
          fMax[front] = running.max;
          front++;
        }
        // The back now holds only position k.
        reset(back);
        if (Number.isFinite(value)) add(back, 1, value, 0, value, value);
      } else {
        front--;
      }
    }
    // The window: the oldest front aggregate (covering all of the front) and the back.
    reset(result);
    if (front > 0) {
      const top = front - 1;
      add(result, fn[top]!, fMean[top]!, fM2[top]!, fMin[top]!, fMax[top]!);
    }
    add(result, back.n, back.mean, back.m2, back.min, back.max);
    const row = list[k]!;
    switch (op) {
      case "count":
        out[row] = result.n;
        break;
      case "sum":
        out[row] = result.n > 0 ? result.mean * result.n : 0;
        break;
      case "mean":
        out[row] = result.n > 0 ? result.mean : Number.NaN;
        break;
      case "stdev":
        out[row] = result.n > 1 ? Math.sqrt(result.m2 / (result.n - 1)) : Number.NaN;
        break;
      case "min":
        out[row] = result.n > 0 ? result.min : Number.NaN;
        break;
      case "max":
        out[row] = result.n > 0 ? result.max : Number.NaN;
        break;
    }
  }
}

/** Running count, mean, sum of squared deviations, minimum, and maximum. */
interface Moments {
  n: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
}

function reset(m: Moments): void {
  m.n = 0;
  m.mean = 0;
  m.m2 = 0;
  m.min = Infinity;
  m.max = -Infinity;
}

/** Combines another aggregate into `m` (Chan, Golub, and LeVeque's pairwise update). */
function add(m: Moments, n: number, mean: number, m2: number, min: number, max: number): void {
  if (n === 0) return;
  if (m.n === 0) {
    // Copied: the update would square the mean, which overflows for huge values.
    m.n = n;
    m.mean = mean;
    m.m2 = m2;
    m.min = min;
    m.max = max;
    return;
  }
  const total = m.n + n;
  const delta = mean - m.mean;
  // Weights first, and products in this order, so squared deviations a double
  // holds do not overflow on the way (1.4e154 squared does, before its weight
  // of a half).
  const weight = n / total;
  m.mean += delta * weight;
  m.m2 += m2 + delta * (delta * (m.n * weight));
  m.n = total;
  if (min < m.min) m.min = min;
  if (max > m.max) m.max = max;
}

function sort(rows: Rows, field: string, order: "ascending" | "descending"): Rows {
  const sign = order === "descending" ? -1 : 1;
  const indexes = Array.from({ length: rows.length }, (_, i) => i);
  if (rows.kind(field) === "category") {
    const { codes, dictionary } = rows.categories(field);
    const label = (i: number) => (codes[i]! < 0 ? undefined : dictionary[codes[i]!]!);
    // Missing values last, whatever the order.
    indexes.sort((a, b) => {
      const [x, y] = [label(a), label(b)];
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
      return x < y ? -sign : x > y ? sign : 0;
    });
  } else {
    const values = rows.numbers(field);
    indexes.sort((a, b) => {
      const [x, y] = [values[a]!, values[b]!];
      if (Number.isNaN(x) || Number.isNaN(y))
        return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
      return (x - y) * sign;
    });
  }
  const sorted = rows.pick(indexes);
  return new Rows(sorted.length, sorted.columns, undefined);
}

/** Column inputs for a table, copying columns still read from the source. */
function inputsOf(rows: Rows): Record<string, ColumnInput> {
  // A null-prototype record keeps fields such as "__proto__" ordinary keys.
  const inputs: Record<string, ColumnInput> = Object.create(null);
  for (const [name, column] of rows.columns) {
    if (column.kind === "category") {
      inputs[name] = encodedCategory(
        column.owned ? column.codes : column.codes.slice(),
        column.dictionary,
      );
    } else {
      const values = column.owned ? column.values : column.values.slice();
      inputs[name] = column.kind === "time" ? time(values) : values;
    }
  }
  return inputs;
}

/** Runs transforms over a table's rows from position `from`. */
function run(source: Table, transforms: readonly TransformSpec[], from = 0): Rows {
  let rows = rowsOf(source, from);
  transforms.forEach((step, i) => {
    try {
      rows = apply(rows, step);
    } catch (error) {
      throw new Error(`Transform ${i} (${Object.keys(step)[0]}): ${(error as Error).message}`);
    }
  });
  return rows;
}

/**
 * A table of rows derived from `source` by `transforms`, kept current as the
 * source changes. The derived table keeps its source alive; the source holds
 * the derived table only weakly, so one no longer referenced stops following.
 */
/** Each derived table's source, kept alive as long as the derived table is. */
const sources = new WeakMap<Table, Table>();
/** Stops a collected derived table's subscription to its source. */
const followers = new FinalizationRegistry<() => void>((stop) => stop());

export function deriveTable(
  source: Table,
  transforms: readonly TransformSpec[],
  options: { name?: string } = {},
): Table {
  const first = run(source, transforms);
  const derived = table(
    inputsOf(first),
    options.name === undefined ? {} : { name: options.name },
  ) as unknown as Table;
  // Identities of the source rows behind the derived rows, while every step works row by row.
  const incremental = transforms.every(rowwise);
  let ids: number[] = incremental ? Array.from(first.ids ?? []) : [];
  let idStart = 0;
  // The derived table keeps its source alive, so chains of derived tables
  // hold together; the source's subscription holds the derived table weakly
  // and ends when it is collected.
  sources.set(derived, source);
  const ref = new WeakRef(derived);
  const stop = source.subscribe((change: TableChange) => {
    const target = ref.deref();
    if (!target) {
      stop();
      return;
    }
    if (incremental && !change.reset && change.updated === null) {
      // Drop rows whose source rows left, then append those of new rows.
      let dropped = 0;
      while (idStart + dropped < ids.length && ids[idStart + dropped]! < source.rowOffset)
        dropped++;
      if (dropped > 0) {
        target.dropFirst(dropped);
        idStart += dropped;
        if (idStart > 1024 && idStart * 2 > ids.length) {
          ids = ids.slice(idStart);
          idStart = 0;
        }
      }
      if (change.appended > 0) {
        const added = run(source, transforms, source.length - change.appended);
        if (added.length > 0) {
          target.append(batchOf(added) as never);
          for (let i = 0; i < added.length; i++) ids.push(added.ids![i]!);
        }
      }
      return;
    }
    const rows = run(source, transforms);
    target.reset(inputsOf(rows) as never);
    ids = incremental ? Array.from(rows.ids ?? []) : [];
    idStart = 0;
  });
  followers.register(derived, stop);
  return derived;
}

/** Rows as a batch for `Table.append`: categories as their labels. */
function batchOf(rows: Rows): Record<string, ArrayLike<unknown>> {
  const batch: Record<string, ArrayLike<unknown>> = Object.create(null);
  for (const [name, column] of rows.columns) {
    if (column.kind === "category") {
      batch[name] = Array.from(column.codes, (code) =>
        code < 0 ? null : column.dictionary[code]!,
      );
    } else {
      batch[name] = column.owned ? column.values : column.values.slice();
    }
  }
  return batch;
}

/** An aggregate operation and the field it reads; `count()` reads none. */
export interface Aggregation<F extends string = string> {
  op: AggregateOp;
  field?: F;
}

export const count = () => ({ op: "count" }) as const;
export const sum = <F extends string>(field: F) => ({ op: "sum", field }) as const;
export const mean = <F extends string>(field: F) => ({ op: "mean", field }) as const;
export const median = <F extends string>(field: F) => ({ op: "median", field }) as const;
export const min = <F extends string>(field: F) => ({ op: "min", field }) as const;
export const max = <F extends string>(field: F) => ({ op: "max", field }) as const;
export const q1 = <F extends string>(field: F) => ({ op: "q1", field }) as const;
export const q3 = <F extends string>(field: F) => ({ op: "q3", field }) as const;
export const stdev = <F extends string>(field: F) => ({ op: "stdev", field }) as const;
export const variance = <F extends string>(field: F) => ({ op: "variance", field }) as const;
export const distinct = <F extends string>(field: F) => ({ op: "distinct", field }) as const;
export const first = <F extends string>(field: F) => ({ op: "first", field }) as const;
export const last = <F extends string>(field: F) => ({ op: "last", field }) as const;

/** The kind of a calculated field: text makes categories; numbers and truth values numbers. */
type CalculatedKind<K> = K extends "string" ? "category" : K extends "value" ? FieldKind : "number";

/** Operations that give a value of their field, so a time stays a time. */
type KeepsKind = "mean" | "median" | "min" | "max" | "q1" | "q3" | "first" | "last";

/** The kind of an aggregate or rolling result. */
type ResultKind<S extends Schema, A> = A extends { op: KeepsKind; field: infer F }
  ? F extends keyof S
    ? S[F] extends "time"
      ? "time"
      : "number"
    : "number"
  : "number";

/**
 * Transforms of a table, built step by step; `table()` makes the derived
 * table. Each step's field names are checked against the fields the steps
 * before it produce.
 *
 * ```ts
 * const hourly = derive(readings)
 *   .filter(col("temp").gt(-40))
 *   .bin("time", { step: 3_600_000, as: "hour" })
 *   .aggregate({ groupby: ["hour", "site"], ops: { mean: mean("temp"), n: count() } })
 *   .table();
 * ```
 */
export class Derivation<S extends Schema> {
  readonly source: Table;
  readonly transforms: readonly TransformSpec[];

  constructor(source: Table, transforms: readonly TransformSpec[] = []) {
    this.source = source;
    this.transforms = transforms;
  }

  #then<T extends Schema>(step: TransformSpec): Derivation<T> {
    return new Derivation<T>(this.source, [...this.transforms, step]);
  }

  /** Keeps rows where `condition` is true. */
  filter(condition: Expr | boolean): Derivation<S> {
    return this.#then({ filter: expressionOf(condition) });
  }

  /** Adds or replaces the field `as` with the value of `value`, a number unless it gives text. */
  calculate<A extends string, V extends Expr | number | string | boolean>(
    as: A,
    value: V,
  ): Derivation<Omit<S, A> & { [P in A]: CalculatedKind<KindOf<V>> }> {
    return this.#then({ calculate: expressionOf(value), as });
  }

  /** Replaces a number or time field (or adds `as`) with the start of its bin. */
  bin<F extends NumericField<S>, A extends string = F>(
    field: F,
    options: { step?: number; count?: number; start?: number; as?: A } = {},
  ): Derivation<Omit<S, A> & { [P in A]: S[F] }> {
    return this.#then({ bin: field, ...options });
  }

  /** One row per group of `groupby` values (one row without), with each operation's result. */
  aggregate<
    G extends FieldName<S> = never,
    O extends Record<string, Aggregation<NumericField<S>>> = {},
  >(options: {
    groupby?: readonly G[];
    ops: O;
  }): Derivation<Omit<Pick<S, G>, keyof O> & { [P in keyof O & string]: ResultKind<S, O[P]> }> {
    return this.#then({
      aggregate: Object.entries(options.ops).map(([as, { op, field }]) =>
        field === undefined ? { op, as } : { op, field, as },
      ),
      ...(options.groupby ? { groupby: [...options.groupby] } : {}),
    });
  }

  /** Adds each operation over the trailing `size` rows, within each `groupby` group. */
  rolling<O extends Record<string, { op: RollingOp; field: NumericField<S> }>>(options: {
    size: number;
    groupby?: readonly CategoryField<S>[];
    ops: O;
  }): Derivation<Omit<S, keyof O> & { [P in keyof O & string]: ResultKind<S, O[P]> }> {
    return this.#then({
      rolling: Object.entries(options.ops).map(([as, { op, field }]) => ({ op, field, as })),
      size: options.size,
      ...(options.groupby ? { groupby: [...options.groupby] } : {}),
    });
  }

  /** Orders rows by a field, stably; missing values last. */
  sort(field: FieldName<S>, order: "ascending" | "descending" = "ascending"): Derivation<S> {
    return this.#then({ sort: field, order });
  }

  /** The derived table, kept current as the source changes. */
  table(options: { name?: string } = {}): Table<S> {
    return deriveTable(this.source, this.transforms, options) as unknown as Table<S>;
  }
}

/** Starts transforms of a table: `derive(table).filter(...).aggregate(...).table()`. */
export function derive<S extends Schema>(source: Table<S>): Derivation<S> {
  return new Derivation<S>(source as unknown as Table);
}
