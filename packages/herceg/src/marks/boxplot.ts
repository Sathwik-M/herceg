import type { BoxStats } from "../data/quantile.ts";
import type { Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { PointGeometry, RectGeometry, SegmentGeometry } from "../scene/scene.ts";
import type { BoxPlotSpec } from "../spec/spec.ts";
import { DistributionMark, type DistributionOptions, type Stat } from "./distribution.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, Frame } from "./mark.ts";
import { rowOf, type Series } from "./series.ts";

export type BoxPlotOptions<S extends Schema> = DistributionOptions<S>;

/** How much of its slot a box takes across its category. */
const BOX = 0.7;
/** Whisker caps' width, as a fraction of the box's. */
const CAP = 0.5;
/** Radius of outliers' dots, in pixels. */
const RADIUS = 2.5;
/** Segments a box draws: four sides, the median, two whiskers, and two caps. */
const SEGMENTS = 9;

/**
 * Box plots of a number field's values per category: quartiles, median,
 * whiskers by Tukey's rule, and outliers beyond them. Each box keeps its
 * outliers besides its statistics.
 */
export class BoxPlotMark extends DistributionMark<BoxPlotSpec, number[]> {
  /** Room past the outermost whisker or outlier for an outlier's dot. */
  readonly inset = this.horizontal ? { x: RADIUS + 1, y: 0 } : { x: 0, y: RADIUS + 1 };
  protected readonly noun = ["box", "boxes"] as const;
  protected readonly width = BOX;

  protected describeGroup(_sorted: Float64Array, stats: BoxStats): number[] {
    return stats.outliers;
  }

  /** Boxes, whiskers, and outliers. */
  protected drawnValues(row: number, add: (value: number) => void): void {
    for (const stat of ["low", "q1", "median", "q3", "high"] as const) add(this.stat(stat)[row]!);
    for (const value of this.summary().groups[row]!) add(value);
  }

  geometry(
    series: readonly Series[],
    frame: Frame,
  ): (RectGeometry | SegmentGeometry | PointGeometry)[] {
    const out: (RectGeometry | SegmentGeometry | PointGeometry)[] = [];
    const horizontal = this.horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const [q1, median, q3, low, high] = (["q1", "median", "q3", "low", "high"] as const).map(
      (stat) => this.stat(stat),
    );
    const outliers = this.summary().groups;
    const fillOpacity = this.spec.fillOpacity ?? 0.25;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      const width = share * BOX;
      let points = 0;
      for (let k = 0; k < s.length; k++) points += outliers[rowOf(s, k)]!.length;
      const rects = frame.floats(s.key, "box", s.length * 4);
      const lines = frame.floats(s.key, "lines", s.length * SEGMENTS * 4);
      const coords = frame.floats(s.key, "outliers", points * 2);
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
        const position = horizontal ? s.y[row]! : s.x[row]!;
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
        if (ok(p1) && ok(p3)) {
          const [c0, c1] = [Math.min(p1, p3), Math.max(p1, p3)];
          const at = boxes++ * 4;
          if (horizontal) rects.set([c0, a0, c1 - c0, a1 - a0], at);
          else rects.set([a0, c0, a1 - a0, c1 - c0], at);
          segment(a0, c0, a1, c0);
          segment(a0, c1, a1, c1);
          segment(a0, c0, a0, c1);
          segment(a1, c0, a1, c1);
        }
        if (ok(pm)) segment(a0, pm, a1, pm);
        const cap = (width * CAP) / 2;
        for (const [box, end] of [
          [p1, pl],
          [p3, ph],
        ] as const) {
          if (!ok(box) || !ok(end)) continue;
          segment(center, box, center, end);
          segment(center - cap, end, center + cap, end);
        }
        for (const value of outliers[row]!) {
          const c = across.map(value);
          if (!Number.isFinite(c)) continue;
          coords[dots * 2] = horizontal ? c : center;
          coords[dots * 2 + 1] = horizontal ? center : c;
          dots++;
        }
      }
      out.push(
        {
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

  /** From the lowest to the highest value drawn for a box: whiskers and outliers. */
  span(_series: Series, row: number): readonly [number, number] {
    // Outliers are ascending.
    const outliers = this.summary().groups[row]!;
    const low = this.stat("low")[row]!;
    const high = this.stat("high")[row]!;
    return [Math.min(low, outliers[0] ?? low), Math.max(high, outliers.at(-1) ?? high)];
  }

  /** A box's statistics, formatted as its value axis formats values. */
  pointText(_series: Series, row: number, format: AxisFormat): string {
    const f = this.horizontal ? format.x : format.y;
    const stat = (name: Stat) => this.stat(name)[row]!;
    const outliers = this.summary().groups[row]!.length;
    const n = stat("count");
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, whiskers ${f(stat("low"))} to ${f(stat("high"))}, ${n} ${n === 1 ? "value" : "values"}${outliers ? `, ${outliers} ${outliers === 1 ? "outlier" : "outliers"}` : ""}`;
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
): BoxPlotMark {
  const spec: BoxPlotSpec = {
    type: "boxplot",
    x: options.x,
    y: options.y,
    ...definedFields(options, ["series", "fillOpacity", "label", "axis", "facet", "id"]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BoxPlotMark(spec, table as unknown as Table);
}
