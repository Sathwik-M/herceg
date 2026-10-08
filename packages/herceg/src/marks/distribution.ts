// What box plots and violins share: a number field's values grouped per
// category (and series value), each group's statistics, and how the groups
// are placed, picked, and described. The marks differ in what they draw.

import { category } from "../data/column.ts";
import { type BoxStats, boxStats } from "../data/quantile.ts";
import {
  type CategoryField,
  type NumericField,
  type Schema,
  type Table,
  table,
} from "../data/table.ts";
import type { Geometry } from "../scene/scene.ts";
import type { BoxPlotSpec, ViolinSpec } from "../spec/spec.ts";
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

/** Options box plots and violins share. */
export type DistributionOptions<S extends Schema> = (
  | { x: CategoryField<S>; y: NumericField<S> }
  | { x: NumericField<S>; y: CategoryField<S> }
) & {
  /** Category field: a shape per value in each category, side by side. */
  series?: CategoryField<S>;
  /** Opacity of the shapes' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
  /** The y axis the values are on: "left" (default) or "right". */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  id?: string;
};

const STATS = ["q1", "median", "q3", "low", "high", "count"] as const;
export type Stat = (typeof STATS)[number];

/** The statistics of every group, rebuilt when the source table changes. */
interface Summary<G> {
  version: number;
  /** A row per category (and series value) with values: `category`, `group`, and the statistics. */
  table: Table;
  /** What the mark keeps of each row's values besides its statistics. */
  groups: G[];
  split: SeriesSplitter;
}

/** Where the shapes of one series are drawn across their categories' slots. */
export interface Placement {
  /** Pixels from a category's center to the series' shapes' center. */
  offset: number;
  /** Width of the room each series has in a slot, in pixels. */
  share: number;
}

/**
 * A mark summarizing a number field's values per category. Each summary row
 * is one group; its median is the row's value, which tooltips and the
 * nearest-band search read. `G` is what the mark keeps of a group's values
 * for drawing, such as its outliers or its density.
 */
export abstract class DistributionMark<T extends BoxPlotSpec | ViolinSpec, G> implements Mark<T> {
  readonly spec: T;
  readonly table: Table;
  readonly tooltip: "x" | "y";
  readonly bandPadding = 0.2;
  abstract readonly inset: { readonly x: number; readonly y: number };
  /** True when categories are on y and values on x. */
  protected readonly horizontal: boolean;
  protected readonly category: string;
  protected readonly value: string;
  /** What one shape is called in summaries, singular and plural. */
  protected abstract readonly noun: readonly [string, string];
  /** The fraction of its series' room in a slot a shape is wide. */
  protected abstract readonly width: number;
  #summary: Summary<G> | undefined;

  constructor(spec: T, table: Table) {
    const type = spec.type;
    if (!table.has(spec.x)) requireField(table, spec.x, CATEGORY, `${type} x`);
    if (!table.has(spec.y)) requireField(table, spec.y, CATEGORY, `${type} y`);
    this.horizontal = table.kind(spec.y) === "category" && table.kind(spec.x) !== "category";
    if (!this.horizontal && table.kind(spec.x) !== "category") {
      throw new TypeError(
        `${type} needs a category field on x or y, and a number or time field on the other`,
      );
    }
    this.category = this.horizontal ? spec.y : spec.x;
    this.value = this.horizontal ? spec.x : spec.y;
    requireField(table, this.value, NUMERIC, `${type} ${this.horizontal ? "x" : "y"}`);
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, `${type} series`);
    this.spec = spec;
    this.table = table;
    this.tooltip = this.horizontal ? "y" : "x";
  }

  /** What to keep of a group's ascending, finite values besides `stats`. */
  protected abstract describeGroup(sorted: Float64Array, stats: BoxStats): G;

  /** Calls `add` with every value drawn for a row, for the value axis' extent. */
  protected abstract drawnValues(row: number, add: (value: number) => void): void;

  abstract geometry(series: readonly Series[], frame: Frame): Geometry[];

  /** The lowest and highest value drawn for a row. */
  abstract span(series: Series, row: number): readonly [number, number];

  /** A row's statistics, formatted as its value axis formats values. */
  abstract pointText(series: Series, row: number, format: AxisFormat): string;

  protected summary(): Summary<G> {
    const source = this.table;
    if (this.#summary?.version === source.version) return this.#summary;
    const categories = source.categories(this.category as never);
    const series =
      this.spec.series !== undefined ? source.categories(this.spec.series as never) : undefined;
    const values = source.numbers(this.value as never);
    const width = series ? series.dictionary.length : 1;
    // The values of each group, keyed by category and series code.
    const lists = new Map<number, number[]>();
    for (let row = 0; row < source.length; row++) {
      const c = categories.codes[row]!;
      const s = series ? series.codes[row]! : 0;
      const value = values[row]!;
      if (c < 0 || s < 0 || !Number.isFinite(value)) continue;
      const key = c * width + s;
      let list = lists.get(key);
      if (!list) {
        list = [];
        lists.set(key, list);
      }
      list.push(value);
    }
    const keys = [...lists.keys()].sort((a, b) => a - b);
    const columns = Object.fromEntries(STATS.map((stat) => [stat, new Float64Array(keys.length)]));
    const groups: G[] = [];
    keys.forEach((key, i) => {
      const sorted = Float64Array.from(lists.get(key)!).sort();
      const stats = boxStats(sorted);
      for (const stat of STATS) columns[stat]![i] = stats[stat];
      groups.push(this.describeGroup(sorted, stats));
    });
    // The summary's fields are fixed; the mark reads it on the erased schema.
    const summary = table({
      category: category(keys.map((key) => categories.dictionary[Math.floor(key / width)]!)),
      group: category(keys.map((key) => (series ? series.dictionary[key % width]! : ""))),
      ...(columns as Record<Stat, Float64Array>),
    }) as unknown as Table;
    const built: Summary<G> = {
      version: source.version,
      table: summary,
      groups,
      split: new SeriesSplitter(
        summary,
        undefined,
        ["median"],
        this.spec.series !== undefined ? "group" : undefined,
        this.spec.label ?? this.value,
      ),
    };
    this.#summary = built;
    return built;
  }

  protected stat(stat: Stat): Float64Array {
    return this.summary().table.numbers(stat as never) as Float64Array;
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind((axis === "x" ? this.spec.x : this.spec.y) as never);
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return axis === (this.horizontal ? "y" : "x")
      ? fieldBands(this.table, this.category, context)
      : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { table: summary, split } = this.summary();
    const keys = (this.horizontal ? bands.y : bands.x)?.keys ?? [];
    const positions = bandIndices(summary, "category", keys, context);
    const series = buildSeries(summary, split.sources(), positions, key, palette, undefined);
    // Series are built with positions on x; horizontal shapes swap them onto y.
    if (this.horizontal) for (const s of series) [s.x, s.y] = [s.y, s.x];
    return series;
  }

  #valueExtent(series: readonly Series[], log: boolean) {
    let min = Infinity;
    let max = -Infinity;
    const add = (value: number) => {
      if (!Number.isFinite(value) || (log && !(value > 0))) return;
      if (value < min) min = value;
      if (value > max) max = value;
    };
    for (const s of series) for (let k = 0; k < s.length; k++) this.drawnValues(rowOf(s, k), add);
    return min <= max ? ([min, max] as const) : undefined;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return this.horizontal ? this.#valueExtent(series, log) : undefined;
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.horizontal ? undefined : this.#valueExtent(series, log);
  }

  /**
   * Where each visible series' shapes go in their slots: side by side when
   * several series share a category, as grouped bars are.
   */
  protected placements(series: readonly Series[], frame: Frame): Map<Series, Placement> {
    const along = this.horizontal ? frame.y : frame.x;
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    const slot = Math.abs(along.bandwidth ?? 0);
    const share = slot / Math.max(1, visible.length);
    return new Map(
      visible.map((s, i) => [s, { offset: -slot / 2 + share * i + share / 2, share }] as const),
    );
  }

  /**
   * The shape under a pixel (within its width and its span of values), or
   * else the nearest one by its median.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const horizontal = this.horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const [pa, pc] = horizontal ? [py, px] : [px, py];
    const median = this.stat("median");
    let best: Hit | undefined;
    for (const [s, { offset, share }] of this.placements(series, frame)) {
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const position = horizontal ? s.y[row]! : s.x[row]!;
        if (position < 0 || !Number.isFinite(median[row]!)) continue;
        const center = along.map(position) + offset;
        const ends = this.span(s, row)
          .map((value) => across.map(value))
          .filter(Number.isFinite);
        const inside =
          Math.abs(pa - center) <= (share * this.width) / 2 &&
          ends.length === 2 &&
          pc >= Math.min(...ends) &&
          pc <= Math.max(...ends);
        const distance = inside ? 0 : Math.hypot(pa - center, pc - across.map(median[row]!));
        if (Number.isFinite(distance) && distance < (best?.distance ?? Infinity))
          best = { series: s, position: k, distance };
      }
    }
    return best;
  }

  /** Inspection skips categories without values. */
  shows(_series: Series, row: number): boolean {
    return Number.isFinite(this.stat("median")[row]!);
  }

  /** The number of shapes and the range of their medians, over a series' parts in every panel. */
  summarize(parts: readonly Series[], name: string, { format }: SummaryContext): string {
    const f = this.horizontal ? format.x : format.y;
    const median = this.stat("median");
    const labels = this.summary().table.categories("category" as never);
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
    const [one, many] = this.noun;
    if (count === 0) return `${name}: no ${many}`;
    const label = (row: number) => labels.dictionary[labels.codes[row]!]!;
    return `${name}: ${count} ${count === 1 ? one : many}, medians from ${f(median[lowest]!)} (${label(lowest)}) to ${f(median[highest]!)} (${label(highest)})`;
  }
}
