// Which observations lines and areas connect, decided before they are
// projected or reduced: a row is drawn when its values are and `where` and
// `continuity.defined` hold; neighbors in a series connect unless more than
// `maxGap` apart or across a `breakBy` boundary. Each series' runs of
// connected observations are found once per data version and traced one by
// one, so level of detail never bridges a break. Where `where` leaves rows
// out, runs end at the crossing: for linear curves where the condition's
// comparison changes sign between the rows, for steps where the interval a
// row owns ends.

import type { Expression } from "../../data/expression.ts";
import { compileExpression } from "../../data/expression.ts";
import type { Table } from "../../data/table.ts";
import type { Breaks } from "../../lod/m4.ts";
import type { RangeExtremes, RangeIndex } from "../../lod/minmax-index.ts";
import type { Polyline } from "../../lod/polyline.ts";
import type { GuideKit } from "../../model/guides.ts";
import type { CalendarBreak, ContinuitySpec } from "../../spec/encoding.ts";
import type { Curve } from "../../spec/spec.ts";
import type { Series } from "../series.ts";
import type { TraceFrame } from "../trace.ts";
import { categoryField, predicate } from "./channels.ts";

/** A row left out, drawn, or left out by `where` alone (its values place a crossing). */
const HIDDEN = 0;
const DRAWN = 1;
const SUPPRESSED = 2;

const COMPARISONS = new Set(["<", "<=", ">", ">="]);

/** The runs of a series: start and end positions, and whether each meets `where` at its start or end. */
interface Runs {
  version: number;
  length: number;
  /** Start, end (exclusive), and crossings (1 at the start, 2 at the end) of each run. */
  runs: Int32Array;
  count: number;
}

/** Rows' flags, and the table rows they were found for: appends and drops keep the others'. */
interface Flags {
  version: number;
  generation: number;
  rowOffset: number;
  length: number;
  flags: Uint8Array;
}

const DAY = 86_400_000;
const extremes: RangeExtremes = { low: -1, high: -1, gap: false };

/**
 * Where position `k` of a series is in its columns (`at`), and which table
 * row it shows (`row`): a series copied from another's points (along y
 * through breaks, or through a panel's band places) keeps its rows in
 * `sources`.
 */
function positions(s: Series): { at: (k: number) => number; row: (k: number) => number } {
  const { rows, sources } = s;
  const at = rows ? (k: number) => rows[k]! : (k: number) => k;
  return { at, row: sources ? (k) => sources[k]! : at };
}

/** A mark's connectivity rules, compiled against its table. */
export class Topology {
  readonly #table: Table;
  readonly #kit: GuideKit;
  readonly #where: ((row: number) => boolean) | undefined;
  /**
   * For a `where` that compares numbers: their difference, each placed by
   * `place` (as they are drawn), whose sign says which side a row is on.
   */
  readonly #side: ((row: number, place: (v: number) => number) => number) | undefined;
  /** Whether `where` reads only the positions' field, so compares positions, not values. */
  readonly #onPositions: boolean = false;
  /** Whether the positions lie on a log scale, as extents, which know no scale, place them. */
  readonly #log: boolean;
  readonly #defined: ((row: number) => boolean) | undefined;
  readonly #maxGap: number | undefined;
  readonly #unit: CalendarBreak | undefined;
  readonly #zone: string;
  readonly #codes: (() => Int32Array) | undefined;
  readonly #curve: Curve | undefined;
  #flags: Flags | undefined;
  readonly #runs = new WeakMap<object, Runs>();
  readonly #shown = new WeakMap<object, { version: number; length: number; rows: Uint32Array }>();

  constructor(
    kit: GuideKit,
    table: Table,
    spec: { continuity?: ContinuitySpec; where?: Expression; curve?: Curve },
    position: { field: unknown; log: boolean },
    zone: string,
    path: string,
  ) {
    this.#log = position.log;
    this.#kit = kit;
    this.#table = table;
    this.#zone = zone;
    this.#curve = spec.curve;
    const { continuity, where } = spec;
    if (where !== undefined) {
      if (spec.curve === "monotone")
        throw new Error(
          `${path} where: monotone curves cannot meet a condition where it changes; give a linear or step curve`,
        );
      this.#where = predicate(table, where, `${path} where`);
      this.#side = sideOf(where, table);
      const fields = fieldsOf(where);
      this.#onPositions = fields.length > 0 && fields.every((field) => field === position.field);
    }
    if (continuity?.defined !== undefined)
      this.#defined = predicate(table, continuity.defined, `${path} continuity.defined`);
    const gap = continuity?.maxGap;
    if (gap !== undefined) this.#maxGap = typeof gap === "number" ? gap : gap.milliseconds;
    const by = continuity?.breakBy;
    if (typeof by === "object") {
      const field = categoryField(table, by.field, `${path} continuity.breakBy.field`);
      this.#codes = () => table.categories(field as never).codes;
    } else this.#unit = by;
    if ("connect" in (continuity ?? {}))
      throw new Error(
        `${path} continuity.connect: not supported; break lines with breakBy: { field } or maxGap`,
      );
  }

  /** Whether the rules need a time position: `breakBy` a calendar unit, or `maxGap` as elapsed time. */
  check(kind: string, timed: boolean, path: string): void {
    if (this.#unit !== undefined && kind !== "time")
      throw new Error(
        `${path} continuity.breakBy: "${this.#unit}" breaks times; the positions hold ${kind} values; break by { field } instead`,
      );
    if (timed && kind !== "time")
      throw new Error(
        `${path} continuity.maxGap: { milliseconds } is a time; the positions hold ${kind} values; give a number`,
      );
  }

  /**
   * Each row's flag (HIDDEN, DRAWN, SUPPRESSED) by `where` and `defined`, for
   * the table's version: after appends and drops, only appended rows are
   * tested again.
   */
  #rowFlags(): Uint8Array {
    const table = this.#table;
    const kept = this.#flags;
    if (kept?.version === table.version) return kept.flags;
    const { length, rowOffset, generation } = table;
    const dropped = kept ? rowOffset - kept.rowOffset : 0;
    const keeps =
      kept !== undefined &&
      kept.generation === generation &&
      table.modifiedVersion <= kept.version &&
      dropped >= 0 &&
      dropped <= kept.length;
    let flags: Uint8Array;
    let from = 0;
    if (keeps) {
      flags = kept.flags.length >= length ? kept.flags : new Uint8Array(length * 2);
      flags.set(kept.flags.subarray(dropped, kept.length));
      from = kept.length - dropped;
    } else flags = new Uint8Array(length);
    const where = this.#where;
    const defined = this.#defined;
    for (let row = from; row < length; row++)
      flags[row] = defined && !defined(row) ? HIDDEN : where && !where(row) ? SUPPRESSED : DRAWN;
    this.#flags = { version: table.version, generation, rowOffset, length, flags };
    return flags;
  }

  /** Whether a row is drawn: false where `where` or `defined` leave it out. */
  drawn(row: number): boolean {
    return this.#rowFlags()[row] === DRAWN;
  }

  /** The series' drawn observations, as a series of those rows, found once per data version. */
  shown(series: Series): Series {
    const flags = this.#rowFlags();
    const key = series.sources ? undefined : (series.rows ?? series.x);
    const kept = key && this.#shown.get(key);
    const version = this.#table.version;
    if (kept && kept.version === version && kept.length === series.length)
      return { ...series, rows: kept.rows, length: kept.rows.length, sources: undefined };
    const { row } = positions(series);
    const found: number[] = [];
    for (let k = 0; k < series.length; k++) if (flags[row(k)] === DRAWN) found.push(row(k));
    const rows = Uint32Array.from(found);
    if (key) this.#shown.set(key, { version, length: series.length, rows });
    return { ...series, rows, length: rows.length, sources: undefined };
  }

  /**
   * The span of instants [start, end) of the calendar unit `breakBy` names
   * that holds `t`, in the chart's zone.
   */
  #span(t: number): [number, number] {
    const { toWall, fromWall } = this.#kit;
    const zone = this.#zone;
    const wall = toWall(zone, t);
    let start: number;
    let next: number;
    switch (this.#unit) {
      case "minute":
      case "hour":
      case "day": {
        const size = this.#unit === "minute" ? 60_000 : this.#unit === "hour" ? 3_600_000 : DAY;
        start = Math.floor(wall / size) * size;
        next = start + size;
        break;
      }
      case "week": {
        // Weeks from a Monday: 1970-01-01 was a Thursday.
        const day = Math.floor(wall / DAY);
        start = (day - ((((day + 3) % 7) + 7) % 7)) * DAY;
        next = start + 7 * DAY;
        break;
      }
      default: {
        const date = new Date(wall);
        const year = date.getUTCFullYear();
        const month = this.#unit === "month" ? date.getUTCMonth() : 0;
        start = Date.UTC(year, month, 1);
        next = this.#unit === "month" ? Date.UTC(year, month + 1, 1) : Date.UTC(year + 1, 0, 1);
      }
    }
    return [fromWall(zone, start), fromWall(zone, next)];
  }

  /** A series' runs, found once per data version and kept by its rows (or positions). */
  runs(s: Series): Runs {
    const table = this.#table;
    // Copies of points are made again each frame: their runs are not kept.
    const key = s.sources ? undefined : (s.rows ?? s.x);
    const kept = key && this.#runs.get(key);
    if (kept && kept.version === table.version && kept.length === s.length) return kept;
    const flags = this.#rowFlags();
    const codes = this.#codes?.();
    const { at, row: rowAt } = positions(s);
    const maxGap = this.#maxGap;
    const unit = this.#unit;
    // The calendar unit of the previous position, found anew only past its ends.
    let span: [number, number] = [Infinity, -Infinity];
    // Grown as runs are found: as long as the runs, not the series.
    let out = new Int32Array(48);
    let count = 0;
    let start = -1;
    let previousX = Number.NaN;
    let previousRow = -1;
    let previousFlag = HIDDEN;
    const close = (end: number, crossing: number) => {
      out[count * 3] = start;
      out[count * 3 + 1] = end;
      out[count * 3 + 2] = out[count * 3 + 2]! | crossing;
      count++;
      start = -1;
    };
    for (let k = 0; k < s.length; k++) {
      const row = rowAt(k);
      const x = s.x[at(k)]!;
      const flag = flags[row]!;
      let linked = previousRow >= 0;
      if (linked && maxGap !== undefined && Math.abs(x - previousX) > maxGap) linked = false;
      if (unit !== undefined && !(x >= span[0] && x < span[1])) {
        if (Number.isFinite(x)) {
          if (previousRow >= 0) linked = false;
          span = this.#span(x);
        }
      }
      if (linked && codes && !(codes[previousRow]! >= 0 && codes[previousRow] === codes[row]))
        linked = false;
      if (start >= 0 && (flag !== DRAWN || !linked))
        close(k, flag === SUPPRESSED && linked ? 2 : 0);
      if (flag === DRAWN && start < 0) {
        if ((count + 1) * 3 > out.length) {
          const grown = new Int32Array(out.length * 2);
          grown.set(out);
          out = grown;
        }
        start = k;
        out[count * 3 + 2] = previousFlag === SUPPRESSED && linked ? 1 : 0;
      }
      previousX = x;
      previousRow = row;
      previousFlag = flag;
    }
    if (start >= 0) close(s.length, 0);
    const runs = { version: table.version, length: s.length, runs: out, count };
    if (key) this.#runs.set(key, runs);
    return runs;
  }

  /**
   * Traces positions [start, end) of `s` into `path`, a run at a time,
   * each reduced by `reduce`, with `where`'s crossings at their ends.
   */
  trace(
    s: Series,
    y: Series["y"],
    frame: TraceFrame,
    path: Polyline,
    start: number,
    end: number,
    reduce: (start: number, end: number) => void,
  ): void {
    this.#runsIn(s, frame, start, end, [{ y, path }], reduce);
  }

  /**
   * Traces positions [start, end) of a band's edges `top` and `bottom` into
   * `upper` and `lower`: the runs both edges share, split where either has
   * no place (as bands are), each edge reduced by `reduce`; crossings meet
   * both edges at the same place along the band.
   */
  band(
    s: Series,
    top: Series["y"],
    bottom: Series["y"],
    frame: TraceFrame,
    upper: Polyline,
    lower: Polyline,
    start: number,
    end: number,
    reduce: (edge: Series["y"], start: number, end: number, out: Polyline) => void,
  ): void {
    const xMap = frame.x.mapping();
    const yMap = frame.y.mapping();
    const breaks = xMap.breaks;
    const { at } = positions(s);
    const placeable = (log: boolean, v: number) => Number.isFinite(v) && (!log || v > 0);
    this.#runsIn(
      s,
      frame,
      start,
      end,
      [
        { y: top, path: upper },
        { y: bottom, path: lower },
      ],
      (from, to) => {
        let runStart = -1;
        for (let k = from; k <= to; k++) {
          let valid = false;
          if (k < to) {
            const i = at(k);
            // Rows inside an axis break are left out without ending a run.
            if (breaks?.hides(s.x[i]!)) continue;
            valid =
              placeable(xMap.log, s.x[i]!) &&
              placeable(yMap.log, top[i]!) &&
              placeable(yMap.log, bottom[i]!);
          }
          if (valid && runStart < 0) runStart = k;
          else if (!valid && runStart >= 0) {
            if (runStart > from) {
              upper.break();
              lower.break();
            }
            reduce(top, runStart, k, upper);
            reduce(bottom, runStart, k, lower);
            runStart = -1;
          }
        }
      },
    );
  }

  /** The runs of `s` in [start, end), each a run of every edge, with crossings at both ends. */
  #runsIn(
    s: Series,
    frame: TraceFrame,
    start: number,
    end: number,
    edges: readonly { y: Series["y"]; path: Polyline }[],
    reduce: (start: number, end: number) => void,
  ): void {
    const { runs, count } = this.runs(s);
    const xMap = frame.x.mapping();
    const yMap = frame.y.mapping();
    const { mapValue } = this.#kit;
    const { at } = positions(s);
    const placeable = (log: boolean, v: number) => Number.isFinite(v) && (!log || v > 0);
    // A crossing meets every edge or none: where the kept row and the crossing have places on all.
    const cross = (kept: number, left: number) => {
      const crossing = this.#crossing(s, kept, left, xMap, yMap.log);
      const k = at(kept);
      if (!crossing || !placeable(xMap.log, crossing.x) || !placeable(xMap.log, s.x[k]!)) return;
      const l = at(left);
      const values = edges.map(({ y }) => between(y[k]!, y[l]!, crossing.t, yMap.log));
      if (
        !values.every((v) => placeable(yMap.log, v)) ||
        !edges.every(({ y }) => placeable(yMap.log, y[k]!))
      )
        return;
      const x = mapValue(xMap, crossing.x);
      edges.forEach(({ path }, i) => {
        path.push(x, mapValue(yMap, values[i]!));
      });
    };
    for (let r = first(runs, count, start); r < count; r++) {
      const a = runs[r * 3]!;
      const b = runs[r * 3 + 1]!;
      const crossing = runs[r * 3 + 2]!;
      if (a >= end) break;
      const from = Math.max(a, start);
      const to = Math.min(b, end);
      if (from >= to) continue;
      for (const { path } of edges) path.break();
      if (crossing & 1 && a >= start) cross(a, a - 1);
      reduce(from, to);
      if (crossing & 2 && b < end) cross(b - 1, b);
    }
  }

  /**
   * Where a run ends at a row `where` leaves out, between the drawn
   * position `kept` and the left-out one `left`: its position, and how far
   * from the kept row toward the left-out one it is in drawn coordinates
   * (`t`): of positions in the time `x.breaks` leave or on a log scale, of
   * values on a log scale with `yLog`. Steps end where the interval their
   * row owns does, at the kept row's value; linear curves where the
   * condition's comparison changes sign along the segment drawn, its sides
   * placed as positions are where it reads only the positions' field, else
   * as values.
   */
  #crossing(
    s: Series,
    kept: number,
    left: number,
    x: { readonly log: boolean; readonly breaks?: Breaks | undefined },
    yLog: boolean,
  ): { x: number; t: number } | undefined {
    const { at, row } = positions(s);
    const xk = s.x[at(kept)]!;
    const xl = s.x[at(left)]!;
    if (!Number.isFinite(xl)) return undefined;
    const after = left > kept;
    // Between the two rows as they are drawn.
    const { breaks } = x;
    const place = (v: number) => (breaks ? breaks.collapse(v) : x.log ? Math.log(v) : v);
    const unplace = (v: number) => (breaks ? breaks.expand(v) : x.log ? Math.exp(v) : v);
    const along = (t: number) => unplace(place(xk) + t * (place(xl) - place(xk)));
    switch (this.#curve) {
      case "step-after":
        return after ? { x: xl, t: 0 } : undefined;
      case "step-before":
        return after ? undefined : { x: xl, t: 0 };
      case "step":
        return { x: along(0.5), t: 0 };
    }
    const side = this.#side;
    if (!side) return undefined;
    const sides = this.#onPositions ? place : yLog ? Math.log : (v: number) => v;
    const dk = side(row(kept), sides);
    const dl = side(row(left), sides);
    const t = dk / (dk - dl);
    return Number.isFinite(t) && t >= 0 && t <= 1 ? { x: along(t), t } : undefined;
  }

  /**
   * The extent of the values `values` a series running along y draws (its
   * x holds them, its y the positions): of its drawn observations and its
   * crossings, as `extent` finds them along x.
   */
  across(s: Series, values: Series["y"], log: boolean): [number, number] | undefined {
    const along: Series = { ...s, x: s.y, sorted: s.ySorted ?? false };
    return this.extent(along, -Infinity, Infinity, values, log, undefined, false, undefined);
  }

  /**
   * The extent of the values `y` the series draws within [x0, x1], as
   * `yExtent` finds the extent of a series drawn whole: its drawn
   * observations in view (by `index` a run at a time, where it has one),
   * and where its runs, crossings included, pass the view's edges, by its
   * own curve (so `curved`, the chart's guess, is not read).
   */
  extent(
    s: Series,
    x0: number,
    x1: number,
    y: Series["y"],
    log: boolean,
    index: RangeIndex | undefined,
    _curved: boolean,
    breaks: Breaks | undefined,
  ): [number, number] | undefined {
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    let min = Infinity;
    let max = -Infinity;
    const add = (v: number) => {
      if (!Number.isFinite(v) || (log && v <= 0)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    };
    const { at } = positions(s);
    const xOf = (k: number) => s.x[at(k)]!;
    const { runs, count } = this.runs(s);
    // A run's vertex: a position's observation, or a crossing at a run's end.
    const vertex = (kept: number, left: number): [number, number] | undefined => {
      const crossing = this.#crossing(s, kept, left, { log: this.#log, breaks }, log);
      if (!crossing) return undefined;
      return [crossing.x, between(y[at(kept)]!, y[at(left)]!, crossing.t, log)];
    };
    // Crossings in view count where they are.
    const crossings = (a: number, b: number, crossing: number) => {
      for (const [kept, left, bit] of [
        [a, a - 1, 1],
        [b - 1, b, 2],
      ] as const) {
        if (!(crossing & bit)) continue;
        const v = vertex(kept, left);
        if (v && v[0] >= lo && v[0] <= hi && !breaks?.hides(v[0])) add(v[1]);
      }
    };
    if (!s.sorted) {
      // Without order, every drawn observation in view, and crossings there.
      for (let r = 0; r < count; r++) {
        const [a, b] = [runs[r * 3]!, runs[r * 3 + 1]!];
        for (let k = a; k < b; k++) {
          const x = xOf(k);
          if (x >= lo && x <= hi && !breaks?.hides(x)) add(y[at(k)]!);
        }
        crossings(a, b, runs[r * 3 + 2]!);
      }
      return min <= max ? [min, max] : undefined;
    }
    // Positions [start, end) are in view.
    const bound = (edge: number, after: boolean) => {
      let a = 0;
      let b = s.length;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (after ? xOf(mid) <= edge : xOf(mid) < edge) a = mid + 1;
        else b = mid;
      }
      return a;
    };
    const start = bound(lo, false);
    const end = bound(hi, true);
    const indexed = index !== undefined && index.length === s.length && !log && !breaks;
    const point = (k: number): [number, number] => [xOf(k), y[at(k)]!];
    // Where a run passes `edge`: between its shown vertices on either side,
    // the value its curve has there, in the positions breaks leave (or logs).
    const place = (v: number) => (breaks ? breaks.collapse(v) : this.#log ? Math.log(v) : v);
    const through = (a: number, b: number, crossing: number, edge: number, q: number) => {
      let p = q - 1;
      while (breaks && p >= a && breaks.hides(xOf(p))) p--;
      let n = q;
      while (breaks && n < b && breaks.hides(xOf(n))) n++;
      const before = p >= a ? point(p) : crossing & 1 ? vertex(a, a - 1) : undefined;
      const after = n < b ? point(n) : crossing & 2 ? vertex(b - 1, b) : undefined;
      if (!before || !after || !(before[0] < edge && edge < after[0])) return;
      switch (this.#curve) {
        case "step-after":
          return add(before[1]);
        case "step-before":
          return add(after[1]);
        case "step":
          return add(place(edge) < (place(before[0]) + place(after[0])) / 2 ? before[1] : after[1]);
        case "monotone":
          // Monotone curves stay between their observations' values: both count.
          add(before[1]);
          return add(after[1]);
      }
      const [xa, xb] = [place(before[0]), place(after[0])];
      add(between(before[1], after[1], (place(edge) - xa) / (xb - xa), log));
    };
    for (let r = Math.max(0, first(runs, count, start) - 1); r < count; r++) {
      const a = runs[r * 3]!;
      const b = runs[r * 3 + 1]!;
      const crossing = runs[r * 3 + 2]!;
      if (a > end) break;
      const from = Math.max(a, start);
      const to = Math.min(b, end);
      if (from < to) {
        if (indexed) {
          const { low, high } = index.query(y, from, to, extremes);
          if (low >= 0) {
            add(y[at(low)]!);
            add(y[at(high)]!);
          }
        } else for (let k = from; k < to; k++) if (!breaks?.hides(xOf(k))) add(y[at(k)]!);
      }
      crossings(a, b, crossing);
      through(a, b, crossing, lo, Math.min(Math.max(start, a), b));
      through(a, b, crossing, hi, Math.min(Math.max(end, a), b));
    }
    return min <= max ? [min, max] : undefined;
  }
}

/** The first run that ends after `start`, by binary search. */
function first(runs: Int32Array, count: number, start: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3 + 1]! <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * For a condition comparing two numbers (`<`, `<=`, `>`, `>=`): the
 * difference of its sides at a row, each placed by `place` (logs on a log
 * scale, as it draws them), which changes sign where the condition does;
 * undefined for other conditions.
 */
function sideOf(
  where: Expression,
  table: Table,
): ((row: number, place: (v: number) => number) => number) | undefined {
  if (!Array.isArray(where) || !COMPARISONS.has(where[0] as string) || where.length !== 3)
    return undefined;
  const sides = () =>
    [
      compileExpression(where[1] as Expression, table),
      compileExpression(where[2] as Expression, table),
    ] as const;
  let [left, right] = sides();
  if (left.type !== "number" || right.type !== "number") return undefined;
  // Expressions read the columns of the version they were compiled for.
  let version = table.version;
  return (row, place) => {
    if (version !== table.version) {
      version = table.version;
      [left, right] = sides();
    }
    const [a, b] = [left.at(row) as number, right.at(row) as number];
    // Sides the scale cannot place (nonpositive on a log scale) compare as they are.
    const d = place(a) - place(b);
    return Number.isFinite(d) ? d : a - b;
  };
}

/** The fields an expression reads. */
function fieldsOf(e: Expression): string[] {
  if (!Array.isArray(e)) return [];
  if (e[0] === "field") return typeof e[1] === "string" ? [e[1]] : [];
  return (e as readonly Expression[]).slice(1).flatMap(fieldsOf);
}

/** The value `t` of the way from `a` to `b`, in drawn coordinates: of their logs with `log`. */
function between(a: number, b: number, t: number, log: boolean): number {
  if (t === 0) return a;
  return log ? Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a))) : a + t * (b - a);
}
