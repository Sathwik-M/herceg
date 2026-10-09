import { type Density, kde, silverman } from "../data/density.ts";
import type { BoxStats } from "../data/quantile.ts";
import type { Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import { lineDrawing } from "../draw/line.ts";
import { pointDrawing } from "../draw/point.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type {
  AreaGeometry,
  LineGeometry,
  PointGeometry,
  RectGeometry,
  SegmentGeometry,
} from "../scene/scene.ts";
import type { Frozen, ViolinSpec } from "../spec/spec.ts";
import { surface } from "../theme.ts";
import {
  DistributionMark,
  type DistributionOptions,
  type Stat,
  type Summary,
} from "./distribution.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, ChartMark, Frame } from "./mark.ts";
import { placeAt, rowOf, type Series } from "./series.ts";

export type ViolinOptions<S extends Schema> = DistributionOptions<S> & {
  /**
   * The kernel's standard deviation in data units, the same for every
   * violin; by default each violin's by Silverman's rule of thumb.
   */
  bandwidth?: number;
};

/** How much of its slot a violin takes across its category at its widest. */
const VIOLIN = 0.8;
/** The inner box's width as a fraction of the violin's, kept within these pixels. */
const BOX = 0.1;
const BOX_MIN = 3;
const BOX_MAX = 8;
/** Outline and whisker line width, in pixels. */
const STROKE = 1.5;

/** What a violin keeps of its values: their range, and their density unless they do not vary. */
interface Shape {
  min: number;
  max: number;
  density: Density | undefined;
  /** The density's largest value, which spans the violin's whole width. */
  peak: number;
}

/**
 * Violins of a number field's values per category: each group's kernel
 * density mirrored about its center, every violin as wide at its densest,
 * with the box plot's whisker range, quartile box, and median inside.
 * Groups whose values do not vary are drawn as a line across the violin's
 * width; groups whose density cannot be computed (a span beyond the largest
 * double) show only what is inside.
 */
export class ViolinMark extends DistributionMark<ViolinSpec, Shape> {
  readonly inset = { x: 0, y: 0 };
  protected readonly noun = ["violin", "violins"] as const;
  protected readonly width = VIOLIN;

  constructor(spec: ViolinSpec, table: Table) {
    const { bandwidth } = spec;
    if (bandwidth !== undefined && !(bandwidth > 0 && Number.isFinite(bandwidth)))
      throw new RangeError(`Violin bandwidth must be a positive number, not ${bandwidth}`);
    super(spec, table);
  }

  protected describeGroup(sorted: Float64Array, stats: BoxStats): Shape {
    const n = stats.count;
    const density = n > 0 ? kde(sorted, this.spec.bandwidth ?? silverman(sorted)) : undefined;
    let peak = 0;
    for (const value of density?.values ?? []) peak = Math.max(peak, value);
    return {
      min: n > 0 ? sorted[0]! : Number.NaN,
      max: n > 0 ? sorted[n - 1]! : Number.NaN,
      density: peak > 0 ? density : undefined,
      peak,
    };
  }

  /**
   * The density's span, and for log axes, which cannot place all of it, the
   * values and statistics drawn and where the density turns positive.
   */
  protected drawnValues(
    { stats, groups }: Summary<Shape>,
    row: number,
    add: (value: number) => void,
  ): void {
    const { min, max, density } = groups[row]!;
    add(min);
    add(max);
    for (const stat of ["low", "q1", "median", "q3", "high"] as const) add(stats[stat][row]!);
    if (!density) return;
    const { lo, hi, values } = density;
    add(lo);
    add(hi);
    // Where the density turns positive, as the geometry computes its points.
    const step = (hi - lo) / (values.length - 1);
    for (let i = 0; lo <= 0 && i < values.length; i++) {
      if (lo + i * step <= 0) continue;
      add(lo + i * step);
      break;
    }
  }

  geometry(
    series: readonly Series[],
    frame: Frame,
  ): (AreaGeometry | LineGeometry | SegmentGeometry | RectGeometry | PointGeometry)[] {
    const out: (AreaGeometry | LineGeometry | SegmentGeometry | RectGeometry | PointGeometry)[] =
      [];
    const horizontal = this.horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const fillOpacity = this.spec.fillOpacity ?? 0.25;
    const ok = Number.isFinite;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      // A series without groups in a panel draws nothing there, but keeps its slot.
      if (s.length === 0) continue;
      const { stats, groups: shapes } = this.summaryOf(s);
      const { q1, median, q3, low, high } = stats;
      const half = (share * VIOLIN) / 2;
      const box = Math.min(BOX_MAX, Math.max(BOX_MIN, share * VIOLIN * BOX));
      // The violin's two edges as an area, and its outline as one closed line each.
      const upper = frame.polyline(s.key, "violin-upper");
      const lower = frame.polyline(s.key, "violin-lower");
      const outline = frame.polyline(s.key, "violin-outline");
      upper.reset();
      lower.reset();
      outline.reset();
      const lines = frame.floats(s.key, "lines", s.length * 4);
      const rects = frame.floats(s.key, "box", s.length * 4);
      const dots = frame.floats(s.key, "median", s.length * 2);
      let segments = 0;
      let boxes = 0;
      let medians = 0;
      // Points given along the category and across it, as x and y.
      const at = (a: number, c: number) => (horizontal ? [c, a] : [a, c]) as [number, number];
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        // A panel's own categories are read at their places.
        const position = placeAt(s, horizontal ? "y" : "x", row);
        if (position < 0) continue;
        const center = along.map(position) + offset;
        if (!ok(center)) continue;
        const shape = shapes[row]!;
        const density = shape.density;
        if (density) {
          const { lo, hi, values } = density;
          const step = (hi - lo) / (values.length - 1);
          upper.break();
          lower.break();
          outline.break();
          const first = outline.count;
          const from = lower.count;
          for (let i = 0; i < values.length; i++) {
            const c = across.map(lo + i * step);
            if (!ok(c)) continue;
            const w = half * (values[i]! / shape.peak);
            // A horizontal violin's upper edge is above its center, at smaller y.
            const [ux, uy] = at(horizontal ? center - w : center + w, c);
            const [lx, ly] = at(horizontal ? center + w : center - w, c);
            upper.push(ux, uy);
            lower.push(lx, ly);
            outline.push(ux, uy);
          }
          // Back along the lower edge, closing at the first point.
          for (let i = lower.count - 1; i >= from; i--)
            outline.push(lower.coords[i * 2]!, lower.coords[i * 2 + 1]!);
          if (outline.count > first)
            outline.push(outline.coords[first * 2]!, outline.coords[first * 2 + 1]!);
        } else if (shape.min === shape.max) {
          // Values that do not vary: a line across the violin at their value.
          const c = across.map(shape.min);
          if (ok(c)) {
            lines.set([...at(center - half, c), ...at(center + half, c)], segments++ * 4);
          }
          continue;
        }
        const [pl, ph, p1, p3, pm] = [low, high, q1, q3, median].map((stat) =>
          across.map(stat![row]!),
        ) as [number, number, number, number, number];
        if (ok(pl) && ok(ph)) {
          lines.set([...at(center, pl), ...at(center, ph)], segments++ * 4);
        }
        if (ok(p1) && ok(p3)) {
          const [c0, c1] = [Math.min(p1, p3), Math.max(p1, p3)];
          const [x, y] = at(center - box / 2, c0);
          rects.set(horizontal ? [x, y, c1 - c0, box] : [x, y, box, c1 - c0], boxes++ * 4);
        }
        if (ok(pm)) dots.set(at(center, pm), medians++ * 2);
      }
      out.push(
        {
          kind: "area",
          draw: areaDrawing,
          key: `${s.key}|violin`,
          fill: s.color,
          fillOpacity,
          upper,
          lower,
          baseline: 0,
          stroke: null,
          strokeWidth: 0,
        },
        {
          kind: "line",
          draw: lineDrawing,
          key: `${s.key}|outline`,
          stroke: s.color,
          strokeWidth: STROKE,
          dash: undefined,
          path: outline,
        },
        {
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|lines`,
          stroke: s.color,
          strokeWidth: STROKE,
          coords: lines,
          count: segments,
        },
        {
          kind: "rect",
          draw: rectDrawing,
          key: `${s.key}|box`,
          fill: s.color,
          fillOpacity: 1,
          rects,
          count: boxes,
        },
        {
          kind: "point",
          draw: pointDrawing,
          key: `${s.key}|median`,
          fill: surface(frame.theme),
          fillOpacity: 1,
          opaque: true,
          radius: Math.max(1, box / 2 - 1),
          symbol: "circle",
          coords: dots,
          count: medians,
        },
      );
    }
    return out;
  }

  /** From one end of a violin to the other. */
  span(series: Series, row: number): readonly [number, number] {
    const { min, max, density } = this.summaryOf(series).groups[row]!;
    return density ? [density.lo, density.hi] : [min, max];
  }

  /** A violin's statistics, formatted as its value axis formats values. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const f = this.horizontal ? format.x : format.y;
    const { stats, groups } = this.summaryOf(series);
    const stat = (name: Stat) => stats[name][row]!;
    const { min, max } = groups[row]!;
    const n = stat("count");
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, values from ${f(min)} to ${f(max)}, ${n} ${n === 1 ? "value" : "values"}`;
  }
}

/**
 * Violins of `y` per category of `x` (or of `x` per category of `y`, for
 * horizontal violins): each group's density, with its quartiles and median.
 *
 * ```ts
 * violin(requests, { x: "region", y: "latency" })
 * ```
 */
export function violin<S extends Schema>(
  table: Table<S>,
  options: ViolinOptions<S>,
): ChartMark<Frozen<ViolinSpec>> {
  const spec: ViolinSpec = {
    type: "violin",
    x: options.x,
    y: options.y,
    ...definedFields(options, [
      "series",
      "bandwidth",
      "fill",
      "fillOpacity",
      "label",
      "axis",
      "facet",
      "panel",
      "id",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new ViolinMark(spec, table as unknown as Table);
}
