import { type BoxStats, boxStats } from "../data/quantile.ts";
import type { CategoryField, NumberField, NumericField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import { pointDrawing } from "../draw/point.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type {
  AreaGeometry,
  Geometry,
  PointGeometry,
  RectGeometry,
  SegmentGeometry,
} from "../scene/scene.ts";
import type { BoxPlotNotchInput, BoxPlotRawInput, BoxPlotSpec, Frozen } from "../spec/spec.ts";
import { boxPlotFormError } from "./boxplot-input.ts";
import {
  DistributionMark,
  type DistributionOptions,
  STATS,
  type Stat,
  type Summary,
} from "./distribution.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type ChartMark,
  type Frame,
  NUMERIC,
  requireField,
  type SelectionDrawing,
  valueKind,
} from "./mark.ts";
import { placeAt, rowOf, type Series } from "./series.ts";

type StatisticsOptions<S extends Schema> = {
  low: NumericField<S>;
  q1: NumericField<S>;
  median: NumericField<S>;
  q3: NumericField<S>;
  high: NumericField<S>;
  whiskers?: never;
  outliers?: never;
};

type BoxPlotStyleOptions<S extends Schema> = Pick<
  DistributionOptions<S>,
  | "series"
  | "fill"
  | "fillOpacity"
  | "label"
  | "legendGroup"
  | "legend"
  | "facet"
  | "panel"
  | "clip"
  | "id"
>;

type BoxPlotRawOptions<S extends Schema> = DistributionOptions<S> &
  Omit<BoxPlotRawInput, "x" | "y">;

type BoxPlotPrecomputedOptions<S extends Schema> = StatisticsOptions<S> &
  BoxPlotNotchInput<NumberField<S>> &
  (
    | { x: CategoryField<S>; y?: never; axis?: "left" | "right" }
    | { y: CategoryField<S>; x?: never; axis?: "left" }
  ) &
  BoxPlotStyleOptions<S>;

export type BoxPlotOptions<S extends Schema> = BoxPlotRawOptions<S> | BoxPlotPrecomputedOptions<S>;

const NO_OUTLIERS: readonly number[] = [];

/** How much of its slot a box takes across its category. */
const BOX = 0.7;
/** Whisker caps' width, as a fraction of the box's. */
const CAP = 0.5;
/** Radius of outliers' dots, in pixels. */
const RADIUS = 2.5;
/** Segments a box draws: four sides, the median, two whiskers, and two caps. */
const SEGMENTS = 9;

/**
 * Boxes from raw values per category or precomputed statistic columns.
 * Raw summaries keep outliers; both inputs use the same packed geometry.
 */
export class BoxPlotMark extends DistributionMark<BoxPlotSpec, readonly number[]> {
  /** Room past the outermost whisker or outlier for an outlier's dot. */
  readonly inset: { readonly x: number; readonly y: number };
  protected readonly noun = ["box", "boxes"] as const;
  protected readonly width = BOX;

  constructor(spec: BoxPlotSpec, table: Table) {
    const problem = boxPlotFormError(spec);
    if (problem) throw new TypeError(problem);
    const precomputed = spec.median !== undefined;
    super(
      spec,
      table,
      precomputed
        ? {
            x: spec.x ?? spec.median!,
            y: spec.y ?? spec.median!,
          }
        : undefined,
    );
    if (this.horizontal && spec.axis === "right")
      throw new TypeError('boxplot axis: horizontal boxes have no right axis; drop axis: "right"');
    const room = spec.outliers === false ? 0 : RADIUS + 1;
    this.inset = this.horizontal ? { x: room, y: 0 } : { x: 0, y: room };
    if (precomputed) {
      for (const name of STATS) {
        const field = spec[name];
        if (field !== undefined)
          requireField(table, field, name === "count" ? ["number"] : NUMERIC, `boxplot ${name}`);
      }
    }
  }

  override channelKind(axis: "x" | "y") {
    if (this.spec.median !== undefined && axis === (this.horizontal ? "x" : "y"))
      return valueKind(this.table, [
        this.spec.low!,
        this.spec.q1!,
        this.spec.median,
        this.spec.q3!,
        this.spec.high!,
      ]);
    return super.channelKind(axis);
  }

  protected override groupStats(sorted: Float64Array): BoxStats {
    return boxStats(sorted, this.spec.whiskers);
  }

  protected override acceptsRow(row: number): boolean {
    if (this.spec.median === undefined) return super.acceptsRow(row);
    return STATS.every(
      (stat) =>
        stat === "count" || Number.isFinite(this.table.numbers(this.spec[stat]! as never)[row]!),
    );
  }

  /** A precomputed box is the row of its statistics; a raw one, its group's rows. */
  override summarized(series: Series, position: number): (row: number) => boolean {
    if (this.spec.median === undefined) return super.summarized(series, position);
    const row = this.summaryOf(series).first[rowOf(series, position)]!;
    return (at) => at === row;
  }

  protected override summarizeRows(rows?: Uint32Array): Summary<readonly number[]> {
    const spec = this.spec;
    if (spec.median === undefined) return super.summarizeRows(rows);
    const source = this.table;
    const categories = source.categories(this.category as never).codes;
    const series = spec.series !== undefined ? source.categories(spec.series as never) : undefined;
    const first: number[] = [];
    const length = rows?.length ?? source.length;
    for (let k = 0; k < length; k++) {
      const row = rows ? rows[k]! : k;
      if (categories[row]! >= 0 && (!series || series.codes[row]! >= 0) && this.acceptsRow(row))
        first.push(row);
    }
    // Match raw summaries' category/series order, keeping repeated boxes as separate rows.
    first.sort(
      (a, b) =>
        categories[a]! - categories[b]! ||
        (series ? series.codes[a]! - series.codes[b]! : 0) ||
        a - b,
    );
    const columns = Object.fromEntries(
      STATS.map((stat) => [stat, new Float64Array(first.length)]),
    ) as Record<Stat, Float64Array>;
    for (const stat of STATS) {
      const field = spec[stat];
      const values = field !== undefined ? source.numbers(field as never) : undefined;
      for (let i = 0; i < first.length; i++)
        columns[stat][i] = values ? values[first[i]!]! : Number.NaN;
    }
    for (let i = 0; i < first.length; i++) {
      const { low, q1, median, q3, high, count } = columns;
      if (
        !(low[i]! <= q1[i]! && q1[i]! <= median[i]! && median[i]! <= q3[i]! && q3[i]! <= high[i]!)
      )
        throw new TypeError(
          `boxplot at row ${first[i]}: expected low <= q1 <= median <= q3 <= high; received ${[low[i], q1[i], median[i], q3[i], high[i]].join(", ")}`,
        );
      if (spec.count !== undefined && !(Number.isSafeInteger(count[i]!) && count[i]! > 0))
        throw new TypeError(
          `boxplot count at row ${first[i]}: expected a whole number from 1 to ${Number.MAX_SAFE_INTEGER}; received ${count[i]}`,
        );
    }
    return this.buildSummary(
      Uint32Array.from(first),
      columns,
      first.map(() => NO_OUTLIERS),
      rows,
    );
  }

  /**
   * A precomputed box is one row, drawn dimmed unless the selection holds
   * it; raw boxes show their selected values' own box over the whole's.
   */
  override selectedGeometry(
    series: readonly Series[],
    frame: Frame,
    drawing: SelectionDrawing,
  ): Geometry[] {
    if (this.spec.median === undefined) return super.selectedGeometry(series, frame, drawing);
    const [lit, dimmed] = [[], []] as [Series[], Series[]];
    for (const s of series) {
      const { first } = this.summaryOf(s);
      const parts: [number[], number[]] = [[], []];
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        parts[drawing.selected[first[row]!] === 1 ? 0 : 1].push(row);
      }
      const [on, off] = parts.map((rows) => Uint32Array.from(rows));
      lit.push({ ...s, rows: on, length: on!.length });
      dimmed.push({ ...s, rows: off, length: off!.length });
    }
    return [...drawing.dimmed(dimmed), ...drawing.lit(lit)];
  }

  protected describeGroup(_sorted: Float64Array, stats: BoxStats): number[] {
    return stats.outliers;
  }

  /** Boxes, whiskers, and outliers. */
  protected drawnValues(
    { stats, groups }: Summary<readonly number[]>,
    row: number,
    add: (value: number) => void,
  ): void {
    for (const stat of ["low", "q1", "median", "q3", "high"] as const) add(stats[stat][row]!);
    if (this.spec.outliers !== false) for (const value of groups[row]!) add(value);
    if (this.spec.notch) {
      for (const value of this.notchBounds(stats, row)) add(value);
    }
  }

  private notchBounds(
    stats: Summary<readonly number[]>["stats"],
    row: number,
  ): readonly [number, number] {
    const q1 = stats.q1[row]!;
    const q3 = stats.q3[row]!;
    const median = stats.median[row]!;
    const divisor = Math.sqrt(stats.count[row]!);
    const iqr = q3 - q1;
    const half = 1.57 * (Number.isFinite(iqr) ? iqr / divisor : q3 / divisor - q1 / divisor);
    if (Number.isFinite(half)) return [median - half, median + half];
    // An overflowing half-width can cancel with the median to give one finite
    // endpoint. Scale by a power of two so each endpoint is computed independently.
    const reducedHalf = (1.57 * (q3 / 4 - q1 / 4)) / divisor;
    return [(median / 4 - reducedHalf) * 4, (median / 4 + reducedHalf) * 4];
  }

  geometry(
    series: readonly Series[],
    frame: Frame,
  ): (AreaGeometry | RectGeometry | SegmentGeometry | PointGeometry)[] {
    const out: (AreaGeometry | RectGeometry | SegmentGeometry | PointGeometry)[] = [];
    const horizontal = this.horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const fillOpacity = this.spec.fillOpacity ?? 0.25;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      // A series without groups in a panel draws nothing there, but keeps its slot.
      if (s.length === 0) continue;
      const { stats, groups: outliers } = this.summaryOf(s);
      const { q1, median, q3, low, high } = stats;
      const width = share * BOX * this.partWidth(s);
      // Outliers stay in the summary (tooltips count them) when not drawn.
      const dotted = this.spec.outliers !== false;
      let points = 0;
      if (dotted) for (let k = 0; k < s.length; k++) points += outliers[rowOf(s, k)]!.length;
      const rects = frame.floats(s.key, "box", s.length * 4);
      const lines = frame.floats(s.key, "lines", s.length * (this.spec.notch ? 15 : SEGMENTS) * 4);
      const coords = frame.floats(s.key, "outliers", points * 2);
      const upper = this.spec.notch ? frame.polyline(s.key, "notch-upper") : undefined;
      const lower = this.spec.notch ? frame.polyline(s.key, "notch-lower") : undefined;
      upper?.reset();
      lower?.reset();
      let boxes = 0;
      let segments = 0;
      let dots = 0;
      // Points given along the category and across it, as x and y.
      const segment = (a0: number, c0: number, a1: number, c1: number) => {
        const at = segments++ * 4;
        if (horizontal) lines.set([c0, a0, c1, a1], at);
        else lines.set([a0, c0, a1, c1], at);
      };
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        // A panel's own categories are read at their places.
        const position = placeAt(s, horizontal ? "y" : "x", row);
        if (position < 0) continue;
        const center = along.map(position) + offset;
        if (!Number.isFinite(center)) continue;
        // Each part is drawn where its values can be placed: on a log axis a
        // lower whisker may reach zero or below while the rest shows.
        const [p1, pm, p3, pl, ph] = [q1, median, q3, low, high].map((stat) =>
          across.map(stat![row]!),
        ) as [number, number, number, number, number];
        const ok = Number.isFinite;
        const [a0, a1] = [center - width / 2, center + width / 2];
        if (upper && lower) {
          const [notchLow, notchHigh] = this.notchBounds(stats, row);
          const values = [p1, across.map(notchLow), pm, across.map(notchHigh), p3];
          const widths = [width / 2, width / 2, width / 4, width / 2, width / 2];
          if (values.every(ok)) {
            upper.break();
            lower.break();
            for (let i = 0; i < values.length; i++) {
              const c = values[i]!;
              const left = center - widths[i]!;
              const right = center + widths[i]!;
              upper.push(horizontal ? c : right, horizontal ? right : c);
              lower.push(horizontal ? c : left, horizontal ? left : c);
            }
          }
          for (let i = 1; i < values.length; i++) {
            if (!ok(values[i - 1]!) || !ok(values[i]!)) continue;
            for (const sign of [-1, 1])
              segment(
                center + sign * widths[i - 1]!,
                values[i - 1]!,
                center + sign * widths[i]!,
                values[i]!,
              );
          }
          if (ok(p1)) segment(a0, p1, a1, p1);
          if (ok(p3)) segment(a0, p3, a1, p3);
        } else if (ok(p1) && ok(p3)) {
          const [c0, c1] = [Math.min(p1, p3), Math.max(p1, p3)];
          const at = boxes++ * 4;
          if (horizontal) rects.set([c0, a0, c1 - c0, a1 - a0], at);
          else rects.set([a0, c0, a1 - a0, c1 - c0], at);
          segment(a0, c0, a1, c0);
          segment(a0, c1, a1, c1);
          segment(a0, c0, a0, c1);
          segment(a1, c0, a1, c1);
        }
        if (ok(pm))
          segment(
            center - width / (this.spec.notch ? 4 : 2),
            pm,
            center + width / (this.spec.notch ? 4 : 2),
            pm,
          );
        const cap = (width * CAP) / 2;
        for (const [box, end] of [
          [p1, pl],
          [p3, ph],
        ] as const) {
          if (!ok(box) || !ok(end)) continue;
          segment(center, box, center, end);
          segment(center - cap, end, center + cap, end);
        }
        if (!dotted) continue;
        for (const value of outliers[row]!) {
          const c = across.map(value);
          if (!Number.isFinite(c)) continue;
          coords[dots * 2] = horizontal ? c : center;
          coords[dots * 2 + 1] = horizontal ? center : c;
          dots++;
        }
      }
      out.push(
        upper && lower
          ? {
              kind: "area",
              draw: areaDrawing,
              key: `${s.key}|box`,
              fill: s.color,
              fillOpacity,
              upper,
              lower,
              baseline: 0,
              stroke: null,
              strokeWidth: 0,
            }
          : {
              kind: "rect",
              draw: rectDrawing,
              key: `${s.key}|box`,
              fill: s.color,
              fillOpacity,
              rects,
              count: boxes,
            },
        {
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|lines`,
          stroke: s.color,
          strokeWidth: 1.5,
          coords: lines,
          count: segments,
        },
        {
          kind: "point",
          draw: pointDrawing,
          key: `${s.key}|outliers`,
          fill: s.color,
          fillOpacity: 0.75,
          opaque: false,
          radius: RADIUS,
          symbol: "circle",
          coords,
          count: dots,
        },
      );
    }
    return out;
  }

  /** The whiskers, outliers, and notch interval bound a box's span. */
  span(series: Series, row: number): readonly [number, number] {
    const { stats, groups } = this.summaryOf(series);
    // Outliers are ascending, and bound the span only when drawn.
    const outliers = this.spec.outliers === false ? NO_OUTLIERS : groups[row]!;
    const low = stats.low[row]!;
    const high = stats.high[row]!;
    const [notchLow, notchHigh] = this.spec.notch
      ? this.notchBounds(stats, row)
      : [stats.median[row]!, stats.median[row]!];
    return [
      Math.min(low, outliers[0] ?? low, notchLow),
      Math.max(high, outliers.at(-1) ?? high, notchHigh),
    ];
  }

  /** A box's statistics, formatted as its value axis formats values. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const f = this.horizontal ? format.x : format.y;
    const { stats, groups } = this.summaryOf(series);
    const stat = (name: Stat) => stats[name][row]!;
    const outliers = groups[row]!.length;
    const n = stat("count");
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, whiskers ${f(stat("low"))} to ${f(stat("high"))}${Number.isFinite(n) ? `, ${n} ${n === 1 ? "value" : "values"}` : ""}${outliers ? `, ${outliers} ${outliers === 1 ? "outlier" : "outliers"}` : ""}${this.selectedText(series, row, f)}`;
  }
}

/**
 * Box plots of `y` per category of `x` (or of `x` per category of `y`, for
 * horizontal boxes): quartiles, median, whiskers, and outliers.
 *
 * ```ts
 * boxplot(requests, { x: "region", y: "latency" })
 * ```
 */
export function boxplot<S extends Schema>(
  table: Table<S>,
  options: BoxPlotOptions<S>,
): ChartMark<Frozen<BoxPlotSpec>> {
  const spec = {
    type: "boxplot",
    ...definedFields(options, [
      "x",
      "y",
      "low",
      "q1",
      "median",
      "q3",
      "high",
      "count",
      "whiskers",
      "notch",
      "outliers",
      "series",
      "fill",
      "fillOpacity",
      "label",
      "legendGroup",
      "legend",
      "axis",
      "facet",
      "panel",
      "clip",
      "id",
    ]),
  } as unknown as BoxPlotSpec;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BoxPlotMark(spec, table as unknown as Table);
}
