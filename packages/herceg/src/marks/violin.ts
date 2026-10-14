import { type Density, kde, partDensity, silverman } from "../data/density.ts";
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
  type Placement,
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
  /** Two series share a center: first left (below horizontally), second right (above). */
  split?: boolean;
  /** Inner box (default), dashed quartiles with a solid median, or no inner marks. */
  inner?: "box" | "quartiles" | "none";
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
    const { bandwidth, split, inner } = spec;
    if (bandwidth !== undefined && !(bandwidth > 0 && Number.isFinite(bandwidth)))
      throw new RangeError(`violin bandwidth: expected a positive number; received ${bandwidth}`);
    if (split !== undefined && typeof split !== "boolean")
      throw new TypeError(
        `violin split: expected true or false; received ${JSON.stringify(split)}`,
      );
    if (inner !== undefined && !["box", "quartiles", "none"].includes(inner))
      throw new TypeError(
        `violin inner: expected "box", "quartiles", or "none"; received ${JSON.stringify(inner)}`,
      );
    if (split && spec.series === undefined)
      throw new TypeError("violin split: needs a series field; give one");
    super(spec, table);
    this.#checkSplit();
  }

  #checkSplit(): void {
    if (!this.spec.split) return;
    const count = this.rosterIds().length;
    if (count > 2)
      throw new RangeError(
        `violin split: expected at most two series; series field "${this.spec.series}" has ${count} values`,
      );
  }

  protected override summarizeRows(rows?: Uint32Array): Summary<Shape> {
    this.#checkSplit();
    return super.summarizeRows(rows);
  }

  /** Split halves stand on either side of the category's center; others in their slots. */
  protected override placement(s: Series, frame: Frame): Placement {
    if (!this.spec.split) return super.placement(s, frame);
    this.#checkSplit();
    const share = Math.abs((this.horizontal ? frame.y : frame.x).bandwidth ?? 0) / 2;
    // The first series' half is on the left (vertical) or the top (horizontal).
    const side = (this.rosterIds().indexOf(s.label) === 0 ? -1 : 1) * (this.horizontal ? -1 : 1);
    return { offset: (side * share * VIOLIN) / 2, share };
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
   * A selection's values of a group: their density on the whole's points,
   * over the whole's count and with its bandwidth, as wide as the whole's
   * at its peak, so it lies inside the whole's violin.
   */
  protected override describeSelected(
    sorted: Float64Array,
    stats: BoxStats,
    whole: Shape,
    n: number,
  ): Shape {
    const count = stats.count;
    const { density } = whole;
    return {
      min: count > 0 ? sorted[0]! : Number.NaN,
      max: count > 0 ? sorted[count - 1]! : Number.NaN,
      density: density && count > 0 ? within(density, partDensity(density, n, sorted)) : undefined,
      peak: whole.peak,
    };
  }

  #draws(shape: Shape): boolean {
    return !!shape.density || shape.min === shape.max || this.spec.inner !== "none";
  }

  protected override drawnSeries(series: Series[]): Series[] {
    if (this.spec.inner !== "none") return series;
    for (const s of series) {
      if (s.length === 0) continue;
      const { groups } = this.summaryOf(s);
      const rows: number[] = [];
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        if (this.#draws(groups[row]!)) rows.push(row);
      }
      if (rows.length !== s.length) {
        s.rows = Uint32Array.from(rows);
        s.length = rows.length;
      }
    }
    return series;
  }

  override shows(series: Series, row: number): boolean {
    return super.shows(series, row) && this.#draws(this.summaryOf(series).groups[row]!);
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
    const shape = groups[row]!;
    if (!this.#draws(shape)) return;
    const { min, max, density } = shape;
    add(min);
    add(max);
    for (const stat of ["low", "q1", "median", "q3", "high"] as const) add(stats[stat][row]!);
    if (!density) return;
    const { lo, hi, values, step } = density;
    add(lo);
    add(hi);
    // Where the density turns positive, as the geometry computes its points.
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
    const split = this.spec.split ?? false;
    const inner = this.spec.inner ?? "box";
    const ok = Number.isFinite;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      // A series without groups in a panel draws nothing there, but keeps its slot.
      if (s.length === 0) continue;
      const { stats, groups: shapes } = this.summaryOf(s);
      const { q1, median, q3, low, high } = stats;
      const half = share * VIOLIN * (split ? 1 : 0.5);
      const side = split ? (offset < 0 ? -1 : 1) : 0;
      const boxWidth = Math.min(BOX_MAX, Math.max(BOX_MIN, share * VIOLIN * BOX));
      const box = split ? Math.min(boxWidth, half) : boxWidth;
      // The violin's two edges as an area, and its outline as one closed line each.
      const upper = frame.polyline(s.key, "violin-upper");
      const lower = frame.polyline(s.key, "violin-lower");
      const outline = frame.polyline(s.key, "violin-outline");
      upper.reset();
      lower.reset();
      outline.reset();
      const quartiles = inner === "quartiles" ? frame.polyline(s.key, "quartiles") : undefined;
      const medianLine = inner === "quartiles" ? frame.polyline(s.key, "median-line") : undefined;
      quartiles?.reset();
      medianLine?.reset();
      let lines = inner === "box" ? frame.floats(s.key, "lines", s.length * 4) : undefined;
      const rects = inner === "box" ? frame.floats(s.key, "box", s.length * 4) : undefined;
      const dots = inner === "box" ? frame.floats(s.key, "median", s.length * 2) : undefined;
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
        const center = along.map(position) + (split ? 0 : offset);
        if (!ok(center)) continue;
        const shape = shapes[row]!;
        const density = shape.density;
        const widthAt = (value: number, c: number): number => {
          if (!density) return half;
          const { lo, values, step } = density;
          const i = Math.max(0, Math.min(values.length - 2, Math.floor((value - lo) / step)));
          const v0 = lo + i * step;
          const p0 = across.map(v0);
          const p1 = across.map(lo + (i + 1) * step);
          // Intersect the pixel-linear edge when both samples map. At a log
          // boundary, interpolate the density in data units for a new vertex.
          const t = ok(p0) && ok(p1) ? (p0 === p1 ? 0 : (c - p0) / (p1 - p0)) : (value - v0) / step;
          return half * ((values[i]! * (1 - t) + values[i + 1]! * t) / shape.peak);
        };
        if (density) {
          const { lo, values, step } = density;
          upper.break();
          lower.break();
          outline.break();
          const first = outline.count;
          const from = lower.count;
          const push = (c: number, w: number) => {
            // A horizontal violin's upper edge is above its center, at smaller y.
            const [ux, uy] = at(
              split ? center + side * w : horizontal ? center - w : center + w,
              c,
            );
            const [lx, ly] = at(split ? center : horizontal ? center + w : center - w, c);
            upper.push(ux, uy);
            lower.push(lx, ly);
            outline.push(ux, uy);
          };
          const vertices = inner === "quartiles" ? [q1[row]!, median[row]!, q3[row]!] : [];
          let vertex = 0;
          for (let i = 0; i < values.length; i++) {
            const value = lo + i * step;
            // Include drawable statistics even below the first positive grid
            // sample, so their cross-sections meet the drawn density profile.
            while (vertex < vertices.length && vertices[vertex]! < value) {
              const statistic = vertices[vertex++]!;
              const c = across.map(statistic);
              if (ok(c)) push(c, widthAt(statistic, c));
            }
            const c = across.map(value);
            if (ok(c)) push(c, half * (values[i]! / shape.peak));
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
            lines ??= frame.floats(s.key, "lines", s.length * 4);
            lines.set(
              [
                ...at(split ? center : center - half, c),
                ...at(split ? center + side * half : center + half, c),
              ],
              segments++ * 4,
            );
          }
          continue;
        }
        if (inner === "none") continue;
        if (quartiles && medianLine) {
          for (const [stat, path] of [
            [q1, quartiles],
            [median, medianLine],
            [q3, quartiles],
          ] as const) {
            const value = stat[row]!;
            const c = across.map(value);
            if (!ok(c)) continue;
            const w = widthAt(value, c);
            path.break();
            path.push(...at(split ? center : center - w, c));
            path.push(...at(split ? center + side * w : center + w, c));
          }
          continue;
        }
        const inside = center + (split ? (side * half) / 2 : 0);
        const [pl, ph, p1, p3, pm] = [low, high, q1, q3, median].map((stat) =>
          across.map(stat![row]!),
        ) as [number, number, number, number, number];
        if (ok(pl) && ok(ph)) {
          lines!.set([...at(inside, pl), ...at(inside, ph)], segments++ * 4);
        }
        if (ok(p1) && ok(p3)) {
          const [c0, c1] = [Math.min(p1, p3), Math.max(p1, p3)];
          const [x, y] = at(inside - box / 2, c0);
          rects!.set(horizontal ? [x, y, c1 - c0, box] : [x, y, box, c1 - c0], boxes++ * 4);
        }
        if (ok(pm)) dots!.set(at(inside, pm), medians++ * 2);
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
      );
      if (lines)
        out.push({
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|lines`,
          stroke: s.color,
          strokeWidth: STROKE,
          coords: lines,
          count: segments,
        });
      if (rects && dots)
        out.push(
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
            radius: split ? Math.min(box / 2, Math.max(1, box / 2 - 1)) : Math.max(1, box / 2 - 1),
            symbol: "circle",
            coords: dots,
            count: medians,
          },
        );
      if (quartiles && medianLine)
        for (const [name, path, dash] of [
          ["quartiles", quartiles, [4, 3]],
          ["median-line", medianLine, undefined],
        ] as const)
          out.push({
            kind: "line",
            draw: lineDrawing,
            key: `${s.key}|${name}`,
            stroke: s.color,
            strokeWidth: STROKE,
            dash,
            path,
          });
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
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, values from ${f(min)} to ${f(max)}, ${n} ${n === 1 ? "value" : "values"}${this.selectedText(series, row, f)}`;
  }
}

/**
 * A part's density on the points of the whole's, `values`, cut to where it
 * is positive, so that its violin ends where its values' kernels do rather
 * than running on along its center.
 */
function within(whole: Density, values: Float64Array): Density | undefined {
  let first = 0;
  while (first < values.length && !(values[first]! > 0)) first++;
  let last = values.length - 1;
  while (last > first && !(values[last]! > 0)) last--;
  if (first > last) return undefined;
  // At least two points, between which a violin's width is read.
  if (first === last) [first, last] = first > 0 ? [first - 1, last] : [first, last + 1];
  const { lo, step } = whole;
  return {
    lo: lo + first * step,
    hi: lo + last * step,
    values: values.slice(first, last + 1),
    step,
    bandwidth: whole.bandwidth,
  };
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
      "split",
      "inner",
      "fill",
      "fillOpacity",
      "label",
      "legendGroup",
      "axis",
      "facet",
      "panel",
      "clip",
      "id",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new ViolinMark(spec, table as unknown as Table);
}
