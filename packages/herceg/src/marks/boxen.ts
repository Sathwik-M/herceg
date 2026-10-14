import { type LetterDepth, letterDepth, letterValues } from "../data/letter-values.ts";
import { type BoxStats, quantile } from "../data/quantile.ts";
import type { Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { PointGeometry, RectGeometry, SegmentGeometry } from "../scene/scene.ts";
import type { BoxenSpec, Frozen } from "../spec/spec.ts";
import { boxenOptionError } from "./boxen-input.ts";
import {
  DistributionMark,
  type DistributionOptions,
  type Stat,
  type Summary,
} from "./distribution.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, ChartMark, Frame } from "./mark.ts";
import { placeAt, rowOf, type Series } from "./series.ts";

export type BoxenOptions<S extends Schema> = DistributionOptions<S> &
  Pick<BoxenSpec, "depth" | "outlierProportion" | "trustAlpha" | "widthMethod" | "outliers">;

/** How much of its slot the quartile box takes across its category. */
const WIDTH = 0.8;
/** Radius of outliers' dots, in pixels. */
const RADIUS = 2.5;
/** The defaults of `outlierProportion` and `trustAlpha`, Seaborn's. */
const PROPORTION = 0.007;
const ALPHA = 0.05;

/** What a boxen mark keeps of a group's values. */
interface Letters {
  /** The levels: letter values each side. */
  k: number;
  /** The 2k letter values, lowest first; box i spans values i and i + 1. */
  values: Float64Array;
  /** Values beyond the outermost letter values, ascending. */
  outliers: number[];
}

type LetterStats = BoxStats & { letters: Letters };

/**
 * Letter-value plots of a number field's values per category: 2k - 1 boxes
 * between consecutive letter values, the quartile box widest and darkest,
 * each level out narrower and lighter, a line at the median, and dots at
 * the values beyond the outermost boxes.
 */
export class BoxenMark extends DistributionMark<BoxenSpec, Letters> {
  readonly inset: { readonly x: number; readonly y: number };
  protected readonly noun = ["box", "boxes"] as const;
  protected readonly width = WIDTH;

  constructor(spec: BoxenSpec, table: Table) {
    const problem = boxenOptionError(spec);
    if (problem) throw new TypeError(problem);
    super(spec, table);
    const room = spec.outliers === false ? 0 : RADIUS + 1;
    this.inset = this.horizontal ? { x: room, y: 0 } : { x: 0, y: room };
  }

  protected override groupStats(sorted: Float64Array): LetterStats {
    const { depth = "tukey", outlierProportion = PROPORTION, trustAlpha = ALPHA } = this.spec;
    const n = sorted.length;
    const k = n > 0 ? letterDepth(n, depth as LetterDepth, outlierProportion, trustAlpha) : 1;
    // No values (a group a selection holds none of) have no letter values.
    const values =
      n > 0 ? letterValues(sorted, k, depth === "full") : new Float64Array(2 * k).fill(Number.NaN);
    const low = values[0]!;
    const high = values[2 * k - 1]!;
    const outliers: number[] = [];
    for (let i = 0; i < n && sorted[i]! < low; i++) outliers.push(sorted[i]!);
    for (let i = n - 1; i >= 0 && sorted[i]! > high; i--) outliers.push(sorted[i]!);
    outliers.sort((a, b) => a - b);
    return {
      count: n,
      q1: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      q3: quantile(sorted, 0.75),
      low: n > 0 ? low : Number.NaN,
      high: n > 0 ? high : Number.NaN,
      outliers,
      letters: { k, values, outliers },
    };
  }

  protected describeGroup(_sorted: Float64Array, stats: BoxStats): Letters {
    return (stats as LetterStats).letters;
  }

  /** The letter values, and the outliers drawn. */
  protected drawnValues(
    { groups }: Summary<Letters>,
    row: number,
    add: (value: number) => void,
  ): void {
    const { values, outliers } = groups[row]!;
    for (const value of values) add(value);
    if (this.spec.outliers !== false) for (const value of outliers) add(value);
  }

  /**
   * Each box's width relative to the quartile box's, by `widthMethod`, as
   * Seaborn's: level j of k (0 outermost) is 2^(j + 1 - k) wide
   * ("exponential"), (j + 1) / k ("linear"), or, for "area", as wide as
   * its share of values over its height, the tails' boxes holding half
   * the share of the box inside them. A box without height has none.
   */
  #widths({ k, values }: Letters): Float64Array {
    const method = this.spec.widthMethod ?? "exponential";
    const boxes = 2 * k - 1;
    const widths = new Float64Array(boxes);
    for (let i = 0; i < boxes; i++) {
      const level = i < k ? i : boxes - 1 - i;
      const exponent = level - 1 - k;
      if (method === "linear") widths[i] = level + 1;
      else if (method === "exponential") widths[i] = 2 ** exponent;
      else {
        const height = values[i + 1]! - values[i]!;
        const tail = level < k - 1 ? 1 : 0;
        widths[i] = height > 0 ? 2 ** (exponent - tail) / height : 0;
      }
    }
    let widest = 0;
    for (const width of widths) if (width > widest) widest = width;
    for (let i = 0; i < boxes; i++) widths[i] = widest > 0 ? widths[i]! / widest : 0;
    return widths;
  }

  geometry(
    series: readonly Series[],
    frame: Frame,
  ): (RectGeometry | SegmentGeometry | PointGeometry)[] {
    const out: (RectGeometry | SegmentGeometry | PointGeometry)[] = [];
    const horizontal = this.horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const fillOpacity = this.spec.fillOpacity ?? 0.7;
    const outliers = this.spec.outliers !== false;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      // A series without groups in a panel draws nothing there, but keeps its slot.
      if (s.length === 0) continue;
      const { groups, stats } = this.summaryOf(s);
      let levels = 0;
      let boxes = 0;
      let dots = 0;
      for (let k = 0; k < s.length; k++) {
        const letters = groups[rowOf(s, k)]!;
        levels = Math.max(levels, letters.k);
        boxes += 2 * letters.k - 1;
        if (outliers) dots += letters.outliers.length;
      }
      // A level's boxes across the groups, filled lighter the farther out they are.
      const rects = Array.from({ length: levels }, (_, depth) =>
        frame.floats(s.key, `level${depth}`, s.length * 2 * 4),
      );
      const counts = new Array<number>(levels).fill(0);
      const lines = frame.floats(s.key, "lines", (boxes * 4 + s.length) * 4);
      const coords = frame.floats(s.key, "outliers", dots * 2);
      let segments = 0;
      dots = 0;
      // Points given along the category and across it, as x and y.
      const segment = (a0: number, c0: number, a1: number, c1: number) => {
        const at = segments++ * 4;
        if (horizontal) lines.set([c0, a0, c1, a1], at);
        else lines.set([a0, c0, a1, c1], at);
      };
      const full = share * WIDTH * this.partWidth(s);
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        // A panel's own categories are read at their places.
        const position = placeAt(s, horizontal ? "y" : "x", row);
        if (position < 0) continue;
        const center = along.map(position) + offset;
        if (!Number.isFinite(center)) continue;
        const letters = groups[row]!;
        const widths = this.#widths(letters);
        const { k: depth, values } = letters;
        for (let i = 0; i < 2 * depth - 1; i++) {
          // Each part is drawn where its values can be placed: on a log
          // axis the outer boxes may reach zero or below while the rest shows.
          const p0 = across.map(values[i]!);
          const p1 = across.map(values[i + 1]!);
          const width = full * widths[i]!;
          if (!Number.isFinite(p0) || !Number.isFinite(p1) || !(width > 0)) continue;
          // Outer levels of groups with fewer levels than the deepest are lighter too.
          const level = (i < depth ? i : 2 * depth - 2 - i) + levels - depth;
          const [c0, c1] = [Math.min(p0, p1), Math.max(p0, p1)];
          const [a0, a1] = [center - width / 2, center + width / 2];
          const at = counts[level]!++ * 4;
          if (horizontal) rects[level]!.set([c0, a0, c1 - c0, a1 - a0], at);
          else rects[level]!.set([a0, c0, a1 - a0, c1 - c0], at);
          segment(a0, c0, a1, c0);
          segment(a0, c1, a1, c1);
          segment(a0, c0, a0, c1);
          segment(a1, c0, a1, c1);
        }
        const pm = across.map(stats.median[row]!);
        if (Number.isFinite(pm)) segment(center - full / 2, pm, center + full / 2, pm);
        if (!outliers) continue;
        for (const value of letters.outliers) {
          const c = across.map(value);
          if (!Number.isFinite(c)) continue;
          coords[dots * 2] = horizontal ? c : center;
          coords[dots * 2 + 1] = horizontal ? center : c;
          dots++;
        }
      }
      for (let level = 0; level < levels; level++)
        out.push({
          kind: "rect",
          draw: rectDrawing,
          key: `${s.key}|level${level}`,
          fill: s.color,
          // Seaborn's shading: 2^((level + 1 - k) / 3) of the quartile box's.
          fillOpacity: fillOpacity * 2 ** ((level + 1 - levels) / 3),
          rects: rects[level]!,
          count: counts[level]!,
        });
      out.push(
        {
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|lines`,
          stroke: s.color,
          strokeWidth: 1,
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

  /** From the outermost box (or outlier drawn) to the other. */
  span(series: Series, row: number): readonly [number, number] {
    const { stats, groups } = this.summaryOf(series);
    const low = stats.low[row]!;
    const high = stats.high[row]!;
    if (this.spec.outliers === false) return [low, high];
    const { outliers } = groups[row]!;
    return [Math.min(low, outliers[0] ?? low), Math.max(high, outliers.at(-1) ?? high)];
  }

  /** A group's median, quartiles, letter values, and counts, formatted as its value axis formats values. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const f = this.horizontal ? format.x : format.y;
    const { stats, groups } = this.summaryOf(series);
    const stat = (name: Stat) => stats[name][row]!;
    const { k, outliers } = groups[row]!;
    const n = stat("count");
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, ${k} ${k === 1 ? "level" : "levels"} from ${f(stat("low"))} to ${f(stat("high"))}, ${n} ${n === 1 ? "value" : "values"}${outliers.length ? `, ${outliers.length} ${outliers.length === 1 ? "outlier" : "outliers"}` : ""}${this.selectedText(series, row, f)}`;
  }
}

/**
 * Letter-value plots of `y` per category of `x` (or of `x` per category of
 * `y`, for horizontal boxes): nested boxes out from the median between the
 * quartiles, eighths, sixteenths, ..., and the values beyond them as dots.
 *
 * ```ts
 * boxen(requests, { x: "region", y: "latency" })
 * ```
 */
export function boxen<S extends Schema>(
  table: Table<S>,
  options: BoxenOptions<S>,
): ChartMark<Frozen<BoxenSpec>> {
  const spec: BoxenSpec = {
    type: "boxen",
    x: options.x,
    y: options.y,
    ...definedFields(options, [
      "series",
      "depth",
      "outlierProportion",
      "trustAlpha",
      "widthMethod",
      "outliers",
      "fill",
      "fillOpacity",
      "label",
      "legendGroup",
      "axis",
      "facet",
      "panel",
      "id",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BoxenMark(spec, table as unknown as Table);
}
