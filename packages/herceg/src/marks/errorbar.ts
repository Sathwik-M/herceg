import type { NumericArray } from "../data/column.ts";
import type { CategoryField, FieldName, NumericField, Schema, Table } from "../data/table.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { Rect, SegmentGeometry } from "../scene/scene.ts";
import type { ErrorBarSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  buildSeries,
  CATEGORY,
  type Frame,
  fieldBands,
  type Hit,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
} from "./mark.ts";
import { lowerPosition, rowOf, type Series, TableCache, visibleRange, xExtent } from "./series.ts";
import { unionExtent } from "./trace.ts";

interface ErrorBarStyle<S extends Schema> {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** Category field: one series of error bars per value. */
  series?: CategoryField<S>;
  stroke?: string;
  strokeWidth?: number;
  /** Width of the caps at each end in pixels; 0 for none. Default 8. */
  cap?: number;
  label?: string;
  id?: string;
}

/** Vertical error bars at each `x`, from `y1` to `y2`. */
export interface VerticalErrorBarOptions<S extends Schema> extends ErrorBarStyle<S> {
  x: FieldName<S>;
  y1: NumericField<S>;
  y2: NumericField<S>;
}

/** Vertical error bars at each `x`, from `y - yError` to `y + yError`. */
export interface VerticalSymmetricErrorBarOptions<S extends Schema> extends ErrorBarStyle<S> {
  x: FieldName<S>;
  y: NumericField<S>;
  yError: NumericField<S>;
}

/** Horizontal error bars at each `y`, from `x1` to `x2`. */
export interface HorizontalErrorBarOptions<S extends Schema> extends ErrorBarStyle<S> {
  y: FieldName<S>;
  x1: NumericField<S>;
  x2: NumericField<S>;
  /** Positions along y are on the left axis; only vertical error bars use the right one. */
  axis?: "left";
}

/** Horizontal error bars at each `y`, from `x - xError` to `x + xError`. */
export interface HorizontalSymmetricErrorBarOptions<S extends Schema> extends ErrorBarStyle<S> {
  y: FieldName<S>;
  x: NumericField<S>;
  xError: NumericField<S>;
  /** Positions along y are on the left axis; only vertical error bars use the right one. */
  axis?: "left";
}

export type ErrorBarOptions<S extends Schema> =
  | VerticalErrorBarOptions<S>
  | VerticalSymmetricErrorBarOptions<S>
  | HorizontalErrorBarOptions<S>
  | HorizontalSymmetricErrorBarOptions<S>;

const CAP = 8;

/** Where an interval's ends come from: two fields, or a center and a symmetric error. */
type Ends = { low: string; high: string } | { center: string; error: string };

/**
 * Intervals with caps, such as confidence intervals or min-max ranges.
 * Series are kept in chart coordinates: vertical bars hold their high end in
 * `y` and low end in `y0`, horizontal ones in `x` and `x0`. Tooltips report
 * both ends; intervals missing an end, or with an end the axis cannot
 * place, are neither drawn nor counted toward the axes.
 */
export class ErrorBarMark implements Mark<ErrorBarSpec> {
  readonly spec: ErrorBarSpec;
  readonly table: Table<Schema>;
  readonly tooltip: "x" | "y";
  readonly inset: { x: number; y: number };
  readonly #horizontal: boolean;
  /** The field intervals stand at: x for vertical bars, y for horizontal ones. */
  readonly #position: string;
  readonly #ends: Ends;
  readonly #categorical: boolean;
  readonly #split: SeriesSplitter;
  /** Ends computed from a center and an error, per table version. */
  readonly #computed = new TableCache<{ low: Float64Array; high: Float64Array }>();

  constructor(spec: ErrorBarSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    const vertical = spec.yError !== undefined || (spec.y1 !== undefined && spec.y2 !== undefined);
    const horizontal =
      spec.xError !== undefined || (spec.x1 !== undefined && spec.x2 !== undefined);
    if (vertical === horizontal) {
      throw new Error(
        "Error bars need x with y1 and y2, or with y and yError (vertical); or y with x1 and x2, or with x and xError (horizontal)",
      );
    }
    this.#horizontal = horizontal;
    const [along, across] = horizontal ? (["y", "x"] as const) : (["x", "y"] as const);
    const position = spec[along];
    if (position === undefined) throw new Error(`Error bars need ${along}`);
    this.#position = position;
    requireField(table, position, [...NUMERIC, ...CATEGORY], `error bar ${along}`);
    const error = horizontal ? spec.xError : spec.yError;
    if (error !== undefined) {
      const center = spec[across];
      if (center === undefined) throw new Error(`Error bars with ${across}Error need ${across}`);
      requireField(table, center, NUMERIC, `error bar ${across}`);
      requireField(table, error, NUMERIC, `error bar ${across}Error`);
      this.#ends = { center, error };
    } else {
      const low = spec[`${across}1`]!;
      const high = spec[`${across}2`]!;
      requireField(table, low, NUMERIC, `error bar ${across}1`);
      requireField(table, high, NUMERIC, `error bar ${across}2`);
      this.#ends = { low, high };
    }
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "error bar series");
    this.#categorical = table.kind(position) === "category";
    this.tooltip = horizontal ? "y" : "x";
    // Caps reach half their width past each position, along the position axis.
    const half = (spec.cap ?? CAP) / 2;
    this.inset = horizontal ? { x: 0, y: half } : { x: half, y: 0 };
    const ends = this.#ends;
    const defaultLabel =
      "center" in ends ? `${ends.center} ± ${ends.error}` : `${ends.low}–${ends.high}`;
    this.#split = new SeriesSplitter(
      table,
      this.#categorical ? undefined : position,
      ["center" in ends ? ends.center : ends.high],
      spec.series,
      spec.label ?? defaultLabel,
    );
  }

  channelKind(axis: "x" | "y") {
    if ((axis === "y") === this.#horizontal) return this.table.kind(this.#position);
    const ends = this.#ends;
    const fields = "center" in ends ? [ends.center] : [ends.low, ends.high];
    return fields.some((field) => this.table.kind(field as never) === "time") ? "time" : "number";
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return (axis === "y") === this.#horizontal && this.#categorical
      ? fieldBands(this.table, this.#position, context)
      : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { spec, table } = this;
    const positions = this.#categorical
      ? bandIndices(
          table,
          this.#position,
          (this.#horizontal ? bands.y : bands.x)?.keys ?? [],
          context,
        )
      : table.numbers(this.#position as never);
    const { low, high } = this.#endColumns();
    const series = buildSeries(table, this.#split.sources(), positions, key, palette, spec.stroke);
    for (const s of series) {
      s.y = high;
      s.y0 = low;
      s.values = high;
      s.range = true;
      // Series are built with positions on x; horizontal bars swap them onto
      // y, where binary search over x no longer applies.
      if (this.#horizontal) {
        [s.x, s.y, s.x0, s.y0] = [s.y, s.x, s.y0, undefined];
        s.sorted = false;
      }
    }
    return series;
  }

  xExtent(series: readonly Series[], log: boolean) {
    if (this.#horizontal) return unionExtent(series.map((s) => this.#interval(s, log)));
    return this.#categorical ? undefined : unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    if (!this.#horizontal) return unionExtent(series.map((s) => this.#interval(s, log, x0, x1)));
    return this.#categorical ? undefined : unionExtent(series.map((s) => xExtent(swap(s), log)));
  }

  geometry(series: readonly Series[], frame: Frame): SegmentGeometry[] {
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const half = (this.spec.cap ?? CAP) / 2;
    const out: SegmentGeometry[] = [];
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const [start, end] = horizontal
        ? [0, s.length]
        : visibleRange(s, along.domain[0], along.domain[1]);
      const { positions, lows, highs } = columns(s, horizontal);
      // A stem and up to two caps per interval.
      const coords = frame.floats(s.key, "segments", (end - start) * 12);
      let count = 0;
      const push = (a: number, b: number, c: number, d: number) => {
        const at = count * 4;
        // Coordinates are written along, across; horizontal bars swap them.
        coords[at] = horizontal ? b : a;
        coords[at + 1] = horizontal ? a : b;
        coords[at + 2] = horizontal ? d : c;
        coords[at + 3] = horizontal ? c : d;
        count++;
      };
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        const at = positions[row]!;
        if (this.#categorical && at < 0) continue;
        const p = along.map(at);
        const lo = across.map(lows[row]!);
        const hi = across.map(highs[row]!);
        if (!(Number.isFinite(p) && Number.isFinite(lo) && Number.isFinite(hi))) continue;
        push(p, lo, p, hi);
        if (half > 0) {
          push(p - half, lo, p + half, lo);
          push(p - half, hi, p + half, hi);
        }
      }
      out.push({
        kind: "segments",
        draw: segmentDrawing,
        key: s.key,
        stroke: s.color,
        strokeWidth: this.spec.strokeWidth ?? 1.5,
        coords,
        count,
      });
    }
    return out;
  }

  /**
   * The interval nearest a pixel, measured to its stem and caps as drawn
   * (clipped to the plot). Sorted positions are searched outward from the
   * pointer in both directions until positions alone are farther than the
   * best match.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const pointer = horizontal ? py : px;
    const half = (this.spec.cap ?? CAP) / 2;
    const { plot } = frame;
    let best: Hit | undefined;
    for (const s of series) {
      const { positions, lows, highs } = columns(s, horizontal);
      /** Considers position k; returns how far along the position axis it stands. */
      const consider = (k: number): number => {
        const row = rowOf(s, k);
        const at = positions[row]!;
        const p = along.map(at);
        if (!Number.isFinite(p)) return 0;
        const offset = Math.abs(p - pointer);
        if (this.#categorical && at < 0) return offset;
        const a = across.map(lows[row]!);
        const b = across.map(highs[row]!);
        if (!(Number.isFinite(a) && Number.isFinite(b))) return offset;
        // Stem and caps, each an axis-aligned segment, in screen coordinates.
        const pieces = [
          [p, a, p, b],
          [p - half, a, p + half, a],
          [p - half, b, p + half, b],
        ];
        for (const [u1, v1, u2, v2] of pieces) {
          const distance = horizontal
            ? clippedDistance(px, py, v1!, u1!, v2!, u2!, plot)
            : clippedDistance(px, py, u1!, v1!, u2!, v2!, plot);
          if (distance < (best?.distance ?? Infinity)) best = { series: s, position: k, distance };
        }
        return offset;
      };
      // Caps reach `half` past their position, so positions within that of
      // the best distance may still be closer.
      const farther = (offset: number) => offset - half > (best?.distance ?? Infinity);
      if (!s.sorted) {
        for (let k = 0; k < s.length; k++) consider(k);
        continue;
      }
      const after = lowerPosition(s, along.invert(pointer));
      for (let k = after - 1; k >= 0 && !farther(consider(k)); k--);
      for (let k = after; k < s.length && !farther(consider(k)); k++);
    }
    return best;
  }

  /**
   * [min, max] of both ends of the drawable intervals whose position lies in
   * [from, to]: intervals missing an end, or with an end a log axis cannot
   * place, do not count.
   */
  #interval(
    s: Series,
    log: boolean,
    from = Number.NEGATIVE_INFINITY,
    to = Number.POSITIVE_INFINITY,
  ): [number, number] | undefined {
    const { positions, lows, highs } = columns(s, this.#horizontal);
    const lo = this.#categorical ? 0 : Math.min(from, to);
    const hi = this.#categorical ? Number.POSITIVE_INFINITY : Math.max(from, to);
    const [start, end] = s.sorted ? visibleRange(s, lo, hi) : [0, s.length];
    const usable = (value: number) => Number.isFinite(value) && (!log || value > 0);
    let min = Infinity;
    let max = -Infinity;
    for (let k = start; k < end; k++) {
      const row = rowOf(s, k);
      const at = positions[row]!;
      if (!(at >= lo && at <= hi) || !Number.isFinite(at)) continue;
      const a = lows[row]!;
      const b = highs[row]!;
      if (!(usable(a) && usable(b))) continue;
      min = Math.min(min, a, b);
      max = Math.max(max, a, b);
    }
    return min <= max ? [min, max] : undefined;
  }

  /** The low and high end of every row: the end fields, or the center minus and plus the error. */
  #endColumns(): { low: NumericArray; high: NumericArray } {
    const ends = this.#ends;
    if (!("center" in ends)) {
      return {
        low: this.table.numbers(ends.low as never),
        high: this.table.numbers(ends.high as never),
      };
    }
    return this.#computed.get(this.table, () => {
      const center = this.table.numbers(ends.center as never);
      const error = this.table.numbers(ends.error as never);
      const low = new Float64Array(center.length);
      const high = new Float64Array(center.length);
      for (let i = 0; i < center.length; i++) {
        const e = Math.abs(error[i]!);
        low[i] = center[i]! - e;
        high[i] = center[i]! + e;
      }
      return { low, high };
    });
  }
}

/**
 * Distance from (px, py) to the part of an axis-aligned segment inside the
 * plot; Infinity when none of it is.
 */
function clippedDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  plot: Rect,
): number {
  const left = Math.max(plot.x, Math.min(x1, x2));
  const right = Math.min(plot.x + plot.width, Math.max(x1, x2));
  const top = Math.max(plot.y, Math.min(y1, y2));
  const bottom = Math.min(plot.y + plot.height, Math.max(y1, y2));
  if (left > right || top > bottom) return Infinity;
  const dx = px < left ? left - px : px > right ? px - right : 0;
  const dy = py < top ? top - py : py > bottom ? py - bottom : 0;
  return Math.hypot(dx, dy);
}

/** A series' positions and ends, whichever axis holds them. */
function columns(s: Series, horizontal: boolean) {
  return horizontal
    ? { positions: s.y, lows: s.x0!, highs: s.x }
    : { positions: s.x, lows: s.y0!, highs: s.y };
}

/** A horizontal series with positions on x, so position helpers apply. */
function swap(s: Series): Series {
  return { ...s, x: s.y, sorted: false };
}

/**
 * Error bars: vertical intervals at each `x` (from `y1` to `y2`, or `y ±
 * yError`), or horizontal ones at each `y` (from `x1` to `x2`, or `x ±
 * xError`). Pair them with points or bars to show the center.
 *
 * ```ts
 * errorBar(stats, { x: "group", y1: "low", y2: "high" })
 * errorBar(stats, { x: "group", y: "mean", yError: "se" })
 * errorBar(fits, { y: "model", x1: "lower", x2: "upper", cap: 0 })
 * ```
 */
export function errorBar<S extends Schema>(
  table: Table<S>,
  options: ErrorBarOptions<S>,
): ErrorBarMark {
  const spec: ErrorBarSpec = {
    type: "errorbar",
    ...(definedFields(options as Partial<Record<keyof ErrorBarSpec, unknown>>, [
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "xError",
      "yError",
      "series",
      "stroke",
      "strokeWidth",
      "cap",
      "label",
      "id",
      "axis",
      "facet",
    ]) as Omit<ErrorBarSpec, "type">),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new ErrorBarMark(spec, table as unknown as Table);
}
