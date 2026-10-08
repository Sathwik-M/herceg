import { category } from "../data/column.ts";
import { boxStats } from "../data/quantile.ts";
import {
  type CategoryField,
  type NumericField,
  type Schema,
  type Table,
  table,
} from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { PointGeometry, RectGeometry, SegmentGeometry } from "../scene/scene.ts";
import type { BoxPlotSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
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
  type SummaryContext,
} from "./mark.ts";
import { rowOf, type Series } from "./series.ts";

export type BoxPlotOptions<S extends Schema> = (
  | { x: CategoryField<S>; y: NumericField<S> }
  | { x: NumericField<S>; y: CategoryField<S> }
) & {
  /** Category field: a box per value in each category, side by side. */
  series?: CategoryField<S>;
  /** Opacity of the boxes' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
  /** The y axis the values are on: "left" (default) or "right". */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  id?: string;
};

/** How much of its slot a box takes across its category. */
const BOX = 0.7;
/** Whisker caps' width, as a fraction of the box's. */
const CAP = 0.5;
/** Radius of outliers' dots, in pixels. */
const RADIUS = 2.5;
/** Segments a box draws: four sides, the median, two whiskers, and two caps. */
const SEGMENTS = 9;

const STATS = ["q1", "median", "q3", "low", "high", "count"] as const;
type Stat = (typeof STATS)[number];

/** The statistics of every box, rebuilt when the source table changes. */
interface Summary {
  version: number;
  /** A row per category (and series value) with values: `category`, `group`, and the statistics. */
  table: Table;
  outliers: number[][];
  split: SeriesSplitter;
}

/**
 * Box plots of a number field's values per category: quartiles, median,
 * whiskers by Tukey's rule, and outliers beyond them. The summary's median
 * is each box's value, which tooltips and the nearest-band search read.
 */
export class BoxPlotMark implements Mark<BoxPlotSpec> {
  readonly spec: BoxPlotSpec;
  readonly table: Table;
  readonly tooltip: "x" | "y";
  readonly bandPadding = 0.2;
  /** Room past the outermost whisker or outlier for an outlier's dot. */
  readonly inset: { readonly x: number; readonly y: number };
  readonly #horizontal: boolean;
  readonly #category: string;
  readonly #value: string;
  #summary: Summary | undefined;

  constructor(spec: BoxPlotSpec, table: Table) {
    if (!table.has(spec.x)) requireField(table, spec.x, CATEGORY, "boxplot x");
    if (!table.has(spec.y)) requireField(table, spec.y, CATEGORY, "boxplot y");
    this.#horizontal = table.kind(spec.y) === "category" && table.kind(spec.x) !== "category";
    if (!this.#horizontal && table.kind(spec.x) !== "category") {
      throw new TypeError(
        "boxplot needs a category field on x or y, and a number or time field on the other",
      );
    }
    this.#category = this.#horizontal ? spec.y : spec.x;
    this.#value = this.#horizontal ? spec.x : spec.y;
    requireField(table, this.#value, NUMERIC, `boxplot ${this.#horizontal ? "x" : "y"}`);
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "boxplot series");
    this.spec = spec;
    this.table = table;
    this.tooltip = this.#horizontal ? "y" : "x";
    this.inset = this.#horizontal ? { x: RADIUS + 1, y: 0 } : { x: 0, y: RADIUS + 1 };
  }

  #summarize(): Summary {
    const source = this.table;
    if (this.#summary?.version === source.version) return this.#summary;
    const categories = source.categories(this.#category as never);
    const groups =
      this.spec.series !== undefined ? source.categories(this.spec.series as never) : undefined;
    const values = source.numbers(this.#value as never);
    const width = groups ? groups.dictionary.length : 1;
    // The values of each box, keyed by category and group code.
    const boxes = new Map<number, number[]>();
    for (let row = 0; row < source.length; row++) {
      const c = categories.codes[row]!;
      const g = groups ? groups.codes[row]! : 0;
      const value = values[row]!;
      if (c < 0 || g < 0 || !Number.isFinite(value)) continue;
      const key = c * width + g;
      let list = boxes.get(key);
      if (!list) {
        list = [];
        boxes.set(key, list);
      }
      list.push(value);
    }
    const keys = [...boxes.keys()].sort((a, b) => a - b);
    const columns = Object.fromEntries(STATS.map((stat) => [stat, new Float64Array(keys.length)]));
    const outliers: number[][] = [];
    keys.forEach((key, i) => {
      const stats = boxStats(Float64Array.from(boxes.get(key)!).sort());
      for (const stat of STATS) columns[stat]![i] = stats[stat];
      outliers.push(stats.outliers);
    });
    // The summary's fields are fixed; the mark reads it on the erased schema.
    const summary = table({
      category: category(keys.map((key) => categories.dictionary[Math.floor(key / width)]!)),
      group: category(keys.map((key) => (groups ? groups.dictionary[key % width]! : ""))),
      ...(columns as Record<Stat, Float64Array>),
    }) as unknown as Table;
    const built: Summary = {
      version: source.version,
      table: summary,
      outliers,
      split: new SeriesSplitter(
        summary,
        undefined,
        ["median"],
        this.spec.series !== undefined ? "group" : undefined,
        this.spec.label ?? this.#value,
      ),
    };
    this.#summary = built;
    return built;
  }

  #stat(stat: Stat): Float64Array {
    return this.#summarize().table.numbers(stat as never) as Float64Array;
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind((axis === "x" ? this.spec.x : this.spec.y) as never);
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return axis === (this.#horizontal ? "y" : "x")
      ? fieldBands(this.table, this.#category, context)
      : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { table: summary, split } = this.#summarize();
    const keys = (this.#horizontal ? bands.y : bands.x)?.keys ?? [];
    const positions = bandIndices(summary, "category", keys, context);
    const series = buildSeries(summary, split.sources(), positions, key, palette, undefined);
    // Series are built with positions on x; horizontal boxes swap them onto y.
    if (this.#horizontal) for (const s of series) [s.x, s.y] = [s.y, s.x];
    return series;
  }

  /** Everything drawn along the value axis: boxes, whiskers, and outliers. */
  #valueExtent(series: readonly Series[], log: boolean) {
    const stats = (["low", "q1", "median", "q3", "high"] as const).map((stat) => this.#stat(stat));
    const { outliers } = this.#summarize();
    let min = Infinity;
    let max = -Infinity;
    const add = (value: number) => {
      if (!Number.isFinite(value) || (log && !(value > 0))) return;
      if (value < min) min = value;
      if (value > max) max = value;
    };
    for (const s of series) {
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        for (const stat of stats) add(stat[row]!);
        for (const value of outliers[row]!) add(value);
      }
    }
    return min <= max ? ([min, max] as const) : undefined;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return this.#horizontal ? this.#valueExtent(series, log) : undefined;
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.#horizontal ? undefined : this.#valueExtent(series, log);
  }

  geometry(
    series: readonly Series[],
    frame: Frame,
  ): (RectGeometry | SegmentGeometry | PointGeometry)[] {
    const out: (RectGeometry | SegmentGeometry | PointGeometry)[] = [];
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const [q1, median, q3, low, high] = (["q1", "median", "q3", "low", "high"] as const).map(
      (stat) => this.#stat(stat),
    );
    const { outliers } = this.#summarize();
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    // Several series share each category's slot side by side, as grouped bars do.
    const slot = Math.abs(along.bandwidth ?? 0);
    const share = slot / Math.max(1, visible.length);
    const width = share * BOX;
    const fillOpacity = this.spec.fillOpacity ?? 0.25;
    visible.forEach((s, group) => {
      const offset = -slot / 2 + share * group + share / 2;
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
    });
    return out;
  }

  /** From the lowest to the highest value drawn for a box: whiskers and outliers. */
  span(_series: Series, row: number): readonly [number, number] {
    const values = [this.#stat("low")[row]!, this.#stat("high")[row]!];
    values.push(...this.#summarize().outliers[row]!);
    return [Math.min(...values), Math.max(...values)];
  }

  /**
   * The box under a pixel, or else the nearest one by its median, where the
   * boxes are drawn: side by side when several series share a category.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const [pa, pc] = horizontal ? [py, px] : [px, py];
    const low = this.#stat("low");
    const high = this.#stat("high");
    const median = this.#stat("median");
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    const slot = Math.abs(along.bandwidth ?? 0);
    const share = slot / Math.max(1, visible.length);
    let best: Hit | undefined;
    visible.forEach((s, group) => {
      const offset = -slot / 2 + share * group + share / 2;
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const position = horizontal ? s.y[row]! : s.x[row]!;
        if (position < 0 || !Number.isFinite(median[row]!)) continue;
        const center = along.map(position) + offset;
        const ends = [across.map(low[row]!), across.map(high[row]!)].filter(Number.isFinite);
        const inside =
          Math.abs(pa - center) <= (share * BOX) / 2 &&
          ends.length === 2 &&
          pc >= Math.min(...ends) &&
          pc <= Math.max(...ends);
        const distance = inside ? 0 : Math.hypot(pa - center, pc - across.map(median[row]!));
        if (Number.isFinite(distance) && distance < (best?.distance ?? Infinity))
          best = { series: s, position: k, distance };
      }
    });
    return best;
  }

  /** Inspection skips categories without a box. */
  shows(_series: Series, row: number): boolean {
    return Number.isFinite(this.#stat("median")[row]!);
  }

  /** A box's statistics, formatted as its value axis formats values. */
  pointText(_series: Series, row: number, format: AxisFormat): string {
    const f = this.#horizontal ? format.x : format.y;
    const stat = (name: Stat) => this.#stat(name)[row]!;
    const outliers = this.#summarize().outliers[row]!.length;
    const n = stat("count");
    return `median ${f(stat("median"))}, quartiles ${f(stat("q1"))} to ${f(stat("q3"))}, whiskers ${f(stat("low"))} to ${f(stat("high"))}, ${n} ${n === 1 ? "value" : "values"}${outliers ? `, ${outliers} ${outliers === 1 ? "outlier" : "outliers"}` : ""}`;
  }

  /** Boxes and the range of their medians, over a series' parts in every panel. */
  summarize(parts: readonly Series[], name: string, { format }: SummaryContext): string {
    const f = this.#horizontal ? format.x : format.y;
    const median = this.#stat("median");
    const labels = this.#summarize().table.categories("category" as never);
    let count = 0;
    let lowest = -1;
    let highest = -1;
    for (const part of parts) {
      for (let k = 0; k < part.length; k++) {
        const row = rowOf(part, k);
        if (!Number.isFinite(median[row]!)) continue;
        count++;
        if (lowest < 0 || median[row]! < median[lowest]!) lowest = row;
        if (highest < 0 || median[row]! > median[highest]!) highest = row;
      }
    }
    if (count === 0) return `${name}: no boxes`;
    const label = (row: number) => labels.dictionary[labels.codes[row]!]!;
    return `${name}: ${count} ${count === 1 ? "box" : "boxes"}, medians from ${f(median[lowest]!)} (${label(lowest)}) to ${f(median[highest]!)} (${label(highest)})`;
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
