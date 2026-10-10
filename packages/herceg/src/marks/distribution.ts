// What box plots and violins share: a number field's values grouped per
// category (and series value), each group's statistics, and how the groups
// are placed, picked, and described. The marks differ in what they draw.

import { category, type NumericArray } from "../data/column.ts";
import { type BoxStats, boxStats } from "../data/quantile.ts";
import {
  type CategoryField,
  type NumericField,
  type Schema,
  type Table,
  table,
} from "../data/table.ts";
import type { Geometry } from "../scene/scene.ts";
import type { BoxPlotSpec, Frozen, ViolinSpec } from "../spec/spec.ts";
import { BandShares } from "./dodge.ts";
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
  frozen,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import { placeAt, rowOf, type Series } from "./series.ts";

/** Options box plots and violins share. */
export type DistributionOptions<S extends Schema> = (
  | {
      x: CategoryField<S>;
      y: NumericField<S>;
      /** The y axis the values are on: "left" (default) or "right". */
      axis?: "left" | "right";
    }
  | {
      x: NumericField<S>;
      y: CategoryField<S>;
      /** Categories along y are on the left axis; only vertical shapes use the right one. */
      axis?: "left";
    }
) & {
  /** Category field: a shape per value in each category, side by side. */
  series?: CategoryField<S>;
  /** Constant color for every shape of the mark; colors come from the palette otherwise. */
  fill?: string;
  /** Opacity of the shapes' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /**
   * Marks naming the same group share series by name: series of the same
   * name share a color, one legend entry, and visibility.
   */
  legendGroup?: string;
  id?: string;
};

export const STATS = ["q1", "median", "q3", "low", "high", "count"] as const;
export type Stat = (typeof STATS)[number];

/**
 * The statistics of groups of a number field's values, by category and
 * series value: one chart's, or one facet panel's. Built once, never changed.
 */
export interface Summary<G> {
  /** A row per category (and series value) with values: `category`, `group`, and the statistics. */
  table: Table;
  /** Each statistic by summary row. */
  stats: Readonly<Record<Stat, Float64Array>>;
  /** What the mark keeps of each row's values besides its statistics. */
  groups: G[];
  /** A table row of each summary row's group, whose category places it. */
  first: Uint32Array;
  /** Summary rows by series value. */
  split: SeriesSplitter;
}

/** Where the shapes of one series are drawn across their categories' slots. */
export interface Placement {
  /** Pixels from a category's center to the series' shapes' center. */
  offset: number;
  /** Width of the room each series has in a slot, in pixels. */
  share: number;
}

const NO_ROWS = new Uint32Array(0);
/** The keys of an axis without bands; one list, as `bandIndices` keeps its mappings per list. */
const NO_KEYS: readonly string[] = [];

/**
 * A mark summarizing a number field's values per category. Each summary row
 * is one group; its median is the row's value, which tooltips and the
 * nearest-band search read. `G` is what the mark keeps of a group's values
 * for drawing, such as its outliers or its density. Split by facets, each
 * panel summarizes its own rows.
 */
export abstract class DistributionMark<T extends BoxPlotSpec | ViolinSpec, G>
  implements Mark<Frozen<T>>
{
  declare readonly [MARK]: true;
  readonly spec: Frozen<T>;
  readonly table: Table;
  readonly tooltip: "x" | "y";
  readonly summarizes = true;
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
  /** One chart's summary of all rows, as of a table version. */
  #whole: { version: number; summary: Summary<G> } | undefined;
  /** Facet panels' summaries, by their first panel's rows: charts split rows apart. */
  readonly #panels = new WeakMap<
    Uint32Array,
    { version: number; rows: readonly Uint32Array[]; summaries: Summary<G>[] }
  >();
  /**
   * The summary each series reads, by its values (the summary's medians),
   * which panels' copies of a series share.
   */
  readonly #summaries = new WeakMap<NumericArray, Summary<G>>();
  /**
   * Each summary's band positions, by the chart's band indices of the
   * table's rows they were read from: charts sharing the mark may have others.
   */
  readonly #positions = new WeakMap<Summary<G>, WeakMap<Int32Array, Int32Array>>();
  /** The series one chart's summary has, in its order, as of a table version. */
  #roster: { version: number; ids: string[] } | undefined;
  /** Each drawn series' slot in its bands, as geometry last placed it. */
  readonly #shares = new BandShares();

  constructor(input: T, table: Table, axes?: { x: string; y: string }) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    const type = spec.type;
    const x = axes?.x ?? spec.x!;
    const y = axes?.y ?? spec.y!;
    if (!table.has(x)) requireField(table, x, CATEGORY, `${type} x`);
    if (!table.has(y)) requireField(table, y, CATEGORY, `${type} y`);
    this.horizontal = table.kind(y) === "category" && table.kind(x) !== "category";
    if (!this.horizontal && table.kind(x) !== "category") {
      throw new TypeError(
        `${type} needs a category field on x or y, and a number or time field on the other`,
      );
    }
    this.category = this.horizontal ? y : x;
    this.value = this.horizontal ? x : y;
    requireField(table, this.value, NUMERIC, `${type} ${this.horizontal ? "x" : "y"}`);
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, `${type} series`);
    this.table = table;
    this.tooltip = this.horizontal ? "y" : "x";
  }

  /** What to keep of a group's ascending, finite values besides `stats`. */
  protected abstract describeGroup(sorted: Float64Array, stats: BoxStats): G;

  /** Calls `add` with every value drawn for a row of `summary`, for the value axis' extent. */
  protected abstract drawnValues(
    summary: Summary<G>,
    row: number,
    add: (value: number) => void,
  ): void;

  abstract geometry(series: readonly Series[], frame: Frame): Geometry[];

  /** The lowest and highest value drawn for a row. */
  abstract span(series: Series, row: number): readonly [number, number];

  /** A row's statistics, formatted as its value axis formats values. */
  abstract pointText(series: Series, row: number, format: AxisFormat): string;

  /** The summary a series of this mark reads. */
  protected summaryOf(series: Series): Summary<G> {
    return this.#summaries.get(series.values)!;
  }

  /** Resolved groups eligible for drawing and navigation; by default, every summary row. */
  protected drawnSeries(series: Series[]): Series[] {
    return series;
  }

  /** One chart's summary, of every row. */
  #wholeSummary(): Summary<G> {
    const { version } = this.table;
    if (this.#whole?.version !== version) this.#whole = { version, summary: this.summarizeRows() };
    return this.#whole.summary;
  }

  /**
   * The statistics of each category's (and series value's) values at
   * `rows` of the table, or at every row.
   */
  protected summarizeRows(rows?: Uint32Array): Summary<G> {
    const source = this.table;
    const categories = source.categories(this.category as never);
    const series =
      this.spec.series !== undefined ? source.categories(this.spec.series as never) : undefined;
    const values = source.numbers(this.value as never);
    const width = series ? series.dictionary.length : 1;
    // The values of each group, keyed by category and series code, and a row of it.
    const lists = new Map<number, number[]>();
    const firsts = new Map<number, number>();
    const length = rows ? rows.length : source.length;
    for (let k = 0; k < length; k++) {
      const row = rows ? rows[k]! : k;
      const c = categories.codes[row]!;
      const s = series ? series.codes[row]! : 0;
      const value = values[row]!;
      if (c < 0 || s < 0 || !Number.isFinite(value)) continue;
      const key = c * width + s;
      let list = lists.get(key);
      if (!list) {
        list = [];
        lists.set(key, list);
        firsts.set(key, row);
      }
      list.push(value);
    }
    const keys = [...lists.keys()].sort((a, b) => a - b);
    const columns = Object.fromEntries(STATS.map((stat) => [stat, new Float64Array(keys.length)]));
    const groups: G[] = [];
    keys.forEach((key, i) => {
      const sorted = Float64Array.from(lists.get(key)!).sort();
      const stats = this.groupStats(sorted);
      for (const stat of STATS) columns[stat]![i] = stats[stat];
      groups.push(this.describeGroup(sorted, stats));
    });
    return this.buildSummary(
      Uint32Array.from(keys, (key) => firsts.get(key)!),
      columns as Record<Stat, Float64Array>,
      groups,
    );
  }

  /** Raw statistics; box plots may choose a different whisker rule. */
  protected groupStats(sorted: Float64Array): BoxStats {
    return boxStats(sorted);
  }

  /** Builds the shared series and placement representation from summary columns. */
  protected buildSummary(
    first: Uint32Array,
    columns: Record<Stat, Float64Array>,
    groups: G[],
  ): Summary<G> {
    const source = this.table;
    const categories = source.categories(this.category as never);
    const series =
      this.spec.series !== undefined ? source.categories(this.spec.series as never) : undefined;
    const summary = table({
      category: category(
        Array.from(first, (row) => categories.dictionary[categories.codes[row]!]!),
      ),
      group: category(
        Array.from(first, (row) => (series ? series.dictionary[series.codes[row]!]! : "")),
      ),
      ...columns,
    }) as unknown as Table;
    const built: Summary<G> = {
      table: summary,
      stats: Object.fromEntries(
        STATS.map((stat) => [stat, summary.numbers(stat as never) as Float64Array]),
      ) as Record<Stat, Float64Array>,
      groups,
      first,
      split: new SeriesSplitter(
        summary,
        undefined,
        ["median"],
        this.spec.series !== undefined ? "group" : undefined,
        this.spec.label ?? this.value,
      ),
    };
    this.#summaries.set(built.stats.median, built);
    return built;
  }

  /**
   * Facet panels' summaries, one per panel of `rows`: kept while the table
   * and the panels' rows are the same, so redrawing sorts nothing again.
   */
  #panelSummaries(rows: readonly Uint32Array[]): Summary<G>[] {
    const { version } = this.table;
    const key = rows[0]!;
    const cached = this.#panels.get(key);
    if (
      cached?.version === version &&
      cached.rows.length === rows.length &&
      cached.rows.every((r, p) => r === rows[p])
    )
      return cached.summaries;
    const summaries = rows.map((panel) => this.summarizeRows(panel));
    this.#panels.set(key, { version, rows, summaries });
    return summaries;
  }

  /**
   * Each row's band on the chart's category axis, from the band of a table
   * row of its group (`bands`): a summary-sized array, kept per summary and
   * band indices, so panels read the chart's mapping rather than make their own.
   */
  #placed(summary: Summary<G>, bands: Int32Array): Int32Array {
    let byBands = this.#positions.get(summary);
    if (!byBands) {
      byBands = new WeakMap();
      this.#positions.set(summary, byBands);
    }
    let positions = byBands.get(bands);
    if (!positions) {
      positions = Int32Array.from(summary.first, (row) => bands[row]!);
      byBands.set(bands, positions);
    }
    return positions;
  }

  /** Each table row's band index on the chart's category axis. */
  #bands(bands: Bands, context: BandContext): Int32Array {
    const keys = (this.horizontal ? bands.y : bands.x)?.keys ?? NO_KEYS;
    return bandIndices(this.table, this.category, keys, context);
  }

  /**
   * The series values one chart's summary has groups of, in its order: by
   * the first category each has values in, as its summary lists them. A
   * pass over the rows per table version, with nothing summarized.
   */
  protected rosterIds(): readonly string[] {
    const source = this.table;
    if (this.#roster?.version === source.version) return this.#roster.ids;
    let ids = ["median"];
    if (this.spec.series !== undefined) {
      const categories = source.categories(this.category as never).codes;
      const { codes, dictionary } = source.categories(this.spec.series as never);
      const first = new Float64Array(dictionary.length).fill(Infinity);
      for (let row = 0; row < source.length; row++) {
        const c = categories[row]!;
        const s = codes[row]!;
        if (c >= 0 && s >= 0 && this.acceptsRow(row) && c < first[s]!) first[s] = c;
      }
      const order = Array.from(dictionary, (_, s) => s).filter((s) => first[s]! < Infinity);
      ids = order.sort((a, b) => first[a]! - first[b]! || a - b).map((s) => dictionary[s]!);
    }
    this.#roster = { version: source.version, ids };
    return ids;
  }

  protected acceptsRow(row: number): boolean {
    return Number.isFinite(this.table.numbers(this.value as never)[row]!);
  }

  channelKind(axis: "x" | "y") {
    return axis === (this.horizontal ? "y" : "x")
      ? "category"
      : this.table.kind(this.value as never);
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
    split = false,
  ): Series[] {
    // Facets summarize each panel's rows (summarizePanels).
    if (split) {
      const label = this.spec.label ?? this.value;
      return this.rosterIds().map((name) => {
        const id = seriesKey(key, name);
        const series = this.spec.series === undefined ? label : name;
        return this.#series(
          id,
          series,
          this.spec.fill ?? palette(id, series),
          NO_ROWS,
          NO_ROWS,
          NO_ROWS,
          0,
        );
      });
    }
    const summary = this.#wholeSummary();
    const positions = this.#placed(summary, this.#bands(bands, context));
    const series = buildSeries(
      summary.table,
      summary.split.sources(),
      positions,
      key,
      palette,
      this.spec.fill,
    );
    // Series are built with positions on x; horizontal shapes swap them onto y.
    if (this.horizontal) for (const s of series) [s.x, s.y] = [s.y, s.x];
    return this.drawnSeries(series);
  }

  /**
   * Each panel's shapes, one series per series of `roster`, from the
   * statistics of the panel's rows; a series with no group in a panel has
   * no shapes there, but keeps its slot.
   */
  summarizePanels(
    roster: readonly Series[],
    rows: readonly Uint32Array[],
    _xGroupOf: readonly number[],
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[][] {
    const ids = this.rosterIds();
    const indices = this.#bands(bands, context);
    return this.#panelSummaries(rows).map((summary) => {
      const positions = this.#placed(summary, indices);
      const median = summary.stats.median;
      const sources = new Map(summary.split.sources().map((source) => [source.id, source]));
      const series = roster.map(({ key, label, color }, i) => {
        // Without a series field, the one series has every summary row.
        const found = sources.get(ids[i]!);
        const length = found ? (found.rows?.length ?? median.length) : 0;
        const rows = found ? found.rows : NO_ROWS;
        return this.#series(key, label, color, positions, median, rows, length);
      });
      return this.drawnSeries(series);
    });
  }

  /**
   * A series of `length` summary rows (`rows`, or the first), at
   * `positions` along the category axis, with `median` values.
   */
  #series(
    key: string,
    label: string,
    color: string,
    positions: NumericArray,
    median: NumericArray,
    rows: Uint32Array | undefined,
    length: number,
  ): Series {
    const [x, y] = this.horizontal ? [median, positions] : [positions, median];
    return {
      key,
      label,
      color,
      x,
      y,
      y0: undefined,
      values: median,
      field: undefined,
      range: false,
      rows,
      length,
      sorted: false,
    };
  }

  #valueExtent(series: readonly Series[], log: boolean) {
    let min = Infinity;
    let max = -Infinity;
    const add = (value: number) => {
      if (!Number.isFinite(value) || (log && !(value > 0))) return;
      if (value < min) min = value;
      if (value > max) max = value;
    };
    for (const s of series) {
      if (s.length === 0) continue;
      const summary = this.summaryOf(s);
      for (let k = 0; k < s.length; k++) this.drawnValues(summary, rowOf(s, k), add);
    }
    return min <= max ? ([min, max] as const) : undefined;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return this.horizontal ? this.#valueExtent(series, log) : undefined;
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.horizontal ? undefined : this.#valueExtent(series, log);
  }

  /**
   * Where each visible series' shapes go in their slots, as geometry draws
   * them: side by side when several series share a category, as grouped
   * bars are, and in a legend group at the group's places for their names.
   * The slots are kept for picking and inspection, which see only some of
   * the series (the visible ones with groups).
   */
  protected placements(series: readonly Series[], frame: Frame): Map<Series, Placement> {
    this.#shares.split(series, frame, this.spec.legendGroup, true);
    const out = new Map<Series, Placement>();
    for (const s of series) if (!frame.hidden.has(s.key)) out.set(s, this.placement(s, frame));
    return out;
  }

  /** Where a series' shapes go in their slots, as geometry last placed them. */
  protected placement(s: Series, frame: Frame): Placement {
    const along = this.horizontal ? frame.y : frame.x;
    const { center, width } = this.#shares.of(s, along.bandwidth ?? 0);
    return { offset: center, share: width };
  }

  /** Where a group's shape is drawn, off its category's center, for inspection. */
  displace(s: Series, _row: number, frame: Frame): readonly [number, number] {
    const { offset } = this.placement(s, frame);
    return this.horizontal ? [0, offset] : [offset, 0];
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
    let best: Hit | undefined;
    for (const s of series) {
      if (s.length === 0 || frame.hidden.has(s.key)) continue;
      const { offset, share } = this.placement(s, frame);
      const { median } = this.summaryOf(s).stats;
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        // A panel's own categories are read at their places.
        const position = placeAt(s, horizontal ? "y" : "x", row);
        if (position < 0 || !this.shows(s, row)) continue;
        const center = along.map(position) + offset;
        const ends = this.span(s, row)
          .map((value) => across.map(value))
          .filter(Number.isFinite);
        let low = Math.min(...ends);
        let high = Math.max(...ends);
        if (ends.length < 2) {
          // A log axis can omit one extreme but still show the rest of a shape.
          // Bound its drawable values rather than fall back to its median alone.
          this.drawnValues(this.summaryOf(s), row, (value) => {
            const pixel = across.map(value);
            if (!Number.isFinite(pixel)) return;
            low = Math.min(low, pixel);
            high = Math.max(high, pixel);
          });
        }
        const inside =
          Math.abs(pa - center) <= (share * this.width) / 2 &&
          Number.isFinite(low) &&
          Number.isFinite(high) &&
          pc >= low &&
          pc <= high;
        const distance = inside ? 0 : Math.hypot(pa - center, pc - across.map(median[row]!));
        if (Number.isFinite(distance) && distance < (best?.distance ?? Infinity))
          best = { series: s, position: k, distance };
      }
    }
    return best;
  }

  /**
   * Whether a row is one of a group's values: of its category and series
   * value, with a value the statistics count. (A precomputed box plot's box
   * is its one row: see `BoxPlotMark`.)
   */
  summarized(series: Series, position: number): (row: number) => boolean {
    const summary = this.summaryOf(series);
    const row = rowOf(series, position);
    const label = (field: string) => {
      const { codes, dictionary } = summary.table.categories(field as never);
      return dictionary[codes[row]!]!;
    };
    const source = this.table;
    const categories = source.categories(this.category as never);
    const category = categories.dictionary.indexOf(label("category"));
    const field = this.spec.series;
    const groups = field === undefined ? undefined : source.categories(field as never);
    const group = groups?.dictionary.indexOf(label("group"));
    return (at) =>
      categories.codes[at] === category &&
      (!groups || groups.codes[at] === group) &&
      this.acceptsRow(at);
  }

  /** Inspection skips categories without values. */
  shows(series: Series, row: number): boolean {
    return Number.isFinite(this.summaryOf(series).stats.median[row]!);
  }

  /**
   * The number of shapes and the range of their medians, over a series'
   * parts in every panel, each read with its own summary.
   */
  summarize(parts: readonly Series[], name: string, { format }: SummaryContext): string {
    const f = this.horizontal ? format.x : format.y;
    let count = 0;
    // The lowest and highest medians, and their categories.
    let lowest: [number, string] | undefined;
    let highest: [number, string] | undefined;
    for (const part of parts) {
      if (part.length === 0) continue;
      const summary = this.summaryOf(part);
      const { median } = summary.stats;
      const labels = summary.table.categories("category" as never);
      for (let k = 0; k < part.length; k++) {
        const row = rowOf(part, k);
        const value = median[row]!;
        if (!Number.isFinite(value)) continue;
        count++;
        const label = () => labels.dictionary[labels.codes[row]!]!;
        if (!lowest || value < lowest[0]) lowest = [value, label()];
        if (!highest || value > highest[0]) highest = [value, label()];
      }
    }
    const [one, many] = this.noun;
    if (!lowest || !highest) return `${name}: no ${many}`;
    return `${name}: ${count} ${count === 1 ? one : many}, medians from ${f(lowest[0])} (${lowest[1]}) to ${f(highest[0])} (${highest[1]})`;
  }
}
