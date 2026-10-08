import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { rectDrawing } from "../draw/rect.ts";
import { formatNumber } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import { niceDomain, tickStep } from "../scale/ticks.ts";
import { chooseInterval, niceTimeDomain, timeTicks } from "../scale/time.ts";
import type { RectGeometry } from "../scene/scene.ts";
import type { HistogramSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandContext,
  CATEGORY,
  type Frame,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  type SeriesSource,
  SeriesSplitter,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import type { Series } from "./series.ts";

export interface HistogramOptions<S extends Schema> {
  /** The number or time field whose values are counted. */
  x: NumericField<S>;
  /**
   * About how many bins, or a bin width (and where bins start). Edges are
   * round values; by default the count follows the data size.
   */
  bins?: number | { step: number; start?: number };
  /** Category field: one histogram per value, overlaid or stacked. */
  series?: CategoryField<S>;
  /** What bars measure: "count" (default), "percent" of the series' values, or "density". */
  normalize?: "count" | "percent" | "density";
  /** Stack the series' bars instead of overlaying them. */
  stack?: boolean;
  fill?: string;
  /** Default 1, or 0.5 for several overlaid series. */
  fillOpacity?: number;
  label?: string;
  /** The y axis the bars are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel; histograms cannot be split yet. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

/** Most bins a histogram draws; finer steps are widened. */
const MAX_BINS = 1000;
/** Pixels left between neighboring bars when bins are wide enough. */
const GAP = 1;

/** Bin edges and each series' counts in them, as of a table version. */
interface Binned {
  edges: Float64Array;
  /** Per series source id: counts per bin, and how many values were counted. */
  counts: Map<string, { counts: Float64Array; total: number }>;
}

/**
 * Bars counting how many values fall in each bin of x. Bins are shared by
 * every series and computed from all of the field's values: round edges
 * (multiples of 1, 2, or 5 times a power of ten, or calendar intervals for
 * times), each bin holding values from its left edge up to its right one,
 * the last also its right edge. Series reads the bars, with bin centers as
 * x, so tooltips report a bin's range and its count.
 */
export class HistogramMark implements Mark<HistogramSpec> {
  readonly spec: HistogramSpec;
  readonly table: Table<Schema>;
  readonly tooltip = "x";
  readonly zero = "y";
  readonly #split: SeriesSplitter;
  /** Bins per time zone (calendar bins depend on it), as of a table version. */
  readonly #binned = new Map<TimeZone, Binned & { table: Table; version: number }>();
  /** The bins each resolved series was counted in, for its drawing, tooltips, and summary. */
  readonly #binsOf = new WeakMap<
    Series,
    { edges: Float64Array; counts: Float64Array; total: number; size: number }
  >();
  /** The zone of the chart resolving series; charts sharing the mark may differ. */
  #zone: TimeZone = "local";

  constructor(spec: HistogramSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    requireField(table, spec.x, NUMERIC, "histogram x");
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "histogram series");
    const { bins } = spec;
    if (typeof bins === "number" && !(Number.isInteger(bins) && bins >= 1))
      throw new RangeError(`Histogram bins must be a whole number of at least 1, not ${bins}`);
    if (typeof bins === "object" && !(bins.step > 0 && Number.isFinite(bins.step)))
      throw new RangeError(`Histogram bin step must be a positive number, not ${bins.step}`);
    if (typeof bins === "object" && bins.start !== undefined && !Number.isFinite(bins.start))
      throw new RangeError(`Histogram bin start must be a finite number, not ${bins.start}`);
    this.#split = new SeriesSplitter(table, undefined, [spec.x], spec.series, spec.label);
  }

  channelKind(axis: "x" | "y") {
    return axis === "x" ? this.table.kind(this.spec.x) : "number";
  }

  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
  ): Series[] {
    this.#zone = context.zone;
    const sources = this.#split.sources();
    const { edges, counts } = this.#bins(sources);
    const bins = Math.max(0, edges.length - 1);
    const centers = new Float64Array(bins);
    // Halves first, so centers of edges near the number range's ends stay finite.
    for (let i = 0; i < bins; i++) centers[i] = edges[i]! / 2 + edges[i + 1]! / 2;
    const normalize = this.spec.normalize ?? "count";
    // Stacked series sit on the visible ones before them.
    const base = this.spec.stack ? new Float64Array(bins) : undefined;
    return sources.map((source) => {
      const id = seriesKey(key, source.id);
      const { counts: binCounts, total } = counts.get(source.id) ?? {
        counts: new Float64Array(bins),
        total: 0,
      };
      const values = new Float64Array(bins);
      for (let i = 0; i < bins; i++) {
        const count = binCounts[i]!;
        values[i] =
          normalize === "count"
            ? count
            : total === 0
              ? 0
              : normalize === "percent"
                ? (count / total) * 100
                : count / total / (edges[i + 1]! - edges[i]!);
      }
      let y = values;
      let y0: Float64Array | undefined;
      if (base) {
        y0 = Float64Array.from(base);
        y = Float64Array.from(values, (value, i) => value + y0![i]!);
        if (!hidden.has(id)) base.set(y);
      }
      const series: Series = {
        key: id,
        label: source.label,
        color: this.spec.fill ?? palette(id),
        x: centers,
        y,
        y0,
        values,
        field: undefined,
        range: false,
        rows: undefined,
        length: bins,
        sorted: true,
      };
      const size = source.rows?.length ?? this.table.length;
      this.#binsOf.set(series, { edges, counts: binCounts, total, size });
      return series;
    });
  }

  xExtent(series: readonly Series[]) {
    const edges = this.#edgesFor(series[0]);
    return edges.length > 1 && series.length > 0
      ? ([edges[0]!, edges[edges.length - 1]!] as const)
      : undefined;
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    const edges = this.#edgesFor(series[0]);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (let i = 0; i < s.length; i++) {
        // Bins reaching into the view.
        if (!(edges[i + 1]! >= lo && edges[i]! <= hi)) continue;
        for (const value of [s.y[i]!, s.y0 ? s.y0[i]! : 0]) {
          if (!Number.isFinite(value) || (log && !(value > 0))) continue;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    return min <= max ? ([min, max] as const) : undefined;
  }

  geometry(series: readonly Series[], frame: Frame): RectGeometry[] {
    const { x, y } = frame;
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    // Overlaid series show through each other.
    const overlaid = visible.length > 1 && !this.spec.stack;
    const opacity = this.spec.fillOpacity ?? (overlaid ? 0.5 : 1);
    // A bar of a log axis starts from its low end.
    const zero = y.type === "log" ? y.range[0] : y.map(0);
    const out: RectGeometry[] = [];
    for (const s of visible) {
      const edges = this.#edgesFor(s);
      const rects = frame.floats(s.key, "rect", s.length * 4);
      let count = 0;
      for (let i = 0; i < s.length; i++) {
        const top = s.y[i]!;
        if (!(top > (s.y0 ? s.y0[i]! : 0))) continue;
        const a = x.map(edges[i]!);
        const b = x.map(edges[i + 1]!);
        const tip = y.map(top);
        const root = s.y0 ? y.map(s.y0[i]!) : zero;
        if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(tip))) continue;
        const left = Math.min(a, b);
        const width = Math.abs(b - a);
        // A pixel apart when bins are wide enough to spare it.
        const gap = width > 4 * GAP ? GAP : 0;
        const at = count++ * 4;
        rects[at] = left + gap / 2;
        rects[at + 1] = Math.min(tip, Number.isFinite(root) ? root : zero);
        rects[at + 2] = width - gap;
        rects[at + 3] = Math.abs((Number.isFinite(root) ? root : zero) - tip);
      }
      out.push({
        kind: "rect",
        draw: rectDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: opacity,
        rects,
        count,
      });
    }
    return out;
  }

  /** A bin's range and what its bar measures. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const edges = this.#edgesFor(series);
    return `${format.x(edges[row]!)} – ${format.x(edges[row + 1]!)}: ${format.y(series.values[row]!)}`;
  }

  /** How many values a series counted, in how many bins over what range, and its fullest bin. */
  summarize(parts: readonly Series[], name: string, { format, locale }: SummaryContext): string {
    const [series] = parts;
    const bins = series && this.#binsOf.get(series);
    if (!series || !bins || bins.total === 0) return `${name}: no values in bins`;
    const { edges, counts, total, size } = bins;
    const f = (value: number) => formatNumber(value, locale);
    // Counts, whatever the bars measure.
    let fullest = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i]! > counts[fullest]!) fullest = i;
    const count = edges.length - 1;
    const outside = size - total;
    return (
      `${name}: ${f(total)} values in ${count} ${count === 1 ? "bin" : "bins"} from ` +
      `${format.x(edges[0]!)} to ${format.x(edges[count]!)}; the fullest, ` +
      `${format.x(edges[fullest]!)} – ${format.x(edges[fullest + 1]!)}, holds ${f(counts[fullest]!)}` +
      (outside > 0 ? `; ${f(outside)} missing or outside the bins` : "")
    );
  }

  /** The edges a series was counted in, or the current ones. */
  #edgesFor(series: Series | undefined): Float64Array {
    return (series && this.#binsOf.get(series)?.edges) ?? this.#bins(this.#split.sources()).edges;
  }

  /** The bins, computed again when the table or the time zone changes. */
  #bins(sources: readonly SeriesSource[]): Binned {
    const { table } = this;
    const cached = this.#binned.get(this.#zone);
    if (cached?.table === table && cached.version === table.version) return cached;
    const binned = this.#count(sources);
    this.#binned.set(this.#zone, { ...binned, table, version: table.version });
    return binned;
  }

  /** Bin edges from all of the field's values, and each series' counts in them. */
  #count(sources: readonly SeriesSource[]): Binned {
    const values = this.table.numbers(this.spec.x as never);
    let min = Infinity;
    let max = -Infinity;
    let finite = 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (!Number.isFinite(value)) continue;
      finite++;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const edges = finite > 0 ? this.#edges(min, max, finite) : new Float64Array(0);
    const counts = new Map<string, { counts: Float64Array; total: number }>();
    const bins = Math.max(0, edges.length - 1);
    // Edges a step apart (all but calendar bins) give a value's bin by division.
    const step = bins > 0 ? (edges[bins]! - edges[0]!) / bins : 0;
    const even =
      bins > 0 && edges.every((edge, i) => Math.abs(edge - (edges[0]! + i * step)) <= step * 1e-9);
    for (const source of sources) {
      const binCounts = new Float64Array(bins);
      let total = 0;
      const { rows } = source;
      const length = rows?.length ?? values.length;
      for (let k = 0; k < length; k++) {
        const value = values[rows ? rows[k]! : k]!;
        const bin = even ? evenBinOf(edges, step, value) : binOf(edges, value);
        if (bin < 0) continue;
        binCounts[bin]!++;
        total++;
      }
      counts.set(source.id, { counts: binCounts, total });
    }
    return { edges, counts };
  }

  /**
   * Bin edges covering [min, max] (from the start, with an explicit one):
   * round values, or calendar boundaries for times; evenly spaced edges when
   * round ones cannot be represented. `size` is how many values there are.
   */
  #edges(min: number, max: number, size: number): Float64Array {
    const { bins } = this.spec;
    const time = this.table.kind(this.spec.x as never) === "time";
    if (typeof bins === "object") return Float64Array.from(fixedEdges(min, max, bins));
    // One value, or values all alike: one bin around them.
    if (min === max) return Float64Array.from(around(min, time ? 1_800_000 : 0.5));
    // Sturges' rule unless a count is given; coarser when round edges overflow the limit.
    const target = Math.min(MAX_BINS, bins ?? Math.min(50, Math.ceil(Math.log2(size)) + 1));
    for (let count = target; count >= 1; count = Math.floor(count / 2)) {
      const edges = time ? this.#calendarEdges(min, max, count) : roundEdges(min, max, count);
      if (valid(edges, min, max)) return Float64Array.from(edges);
    }
    return Float64Array.from(evenEdges(min, max, target));
  }

  /** Calendar boundaries in the chart's zone, about `count` bins covering [min, max]. */
  #calendarEdges(min: number, max: number, count: number): number[] {
    const [lo, hi] = niceTimeDomain(min, max, count, this.#zone);
    const edges = timeTicks(lo, hi, chooseInterval(hi - lo, count), this.#zone);
    if (edges[0] !== lo) edges.unshift(lo);
    if (edges[edges.length - 1] !== hi) edges.push(hi);
    return edges;
  }
}

/** Edges usable for counting: finite, increasing, at most MAX_BINS bins, and covering [min, max]. */
function valid(edges: readonly number[], min: number, max: number): boolean {
  if (edges.length < 2 || edges.length - 1 > MAX_BINS) return false;
  if (!(edges[0]! <= min && edges[edges.length - 1]! >= max)) return false;
  for (let i = 0; i < edges.length; i++) {
    if (!Number.isFinite(edges[i]!) || (i > 0 && !(edges[i]! > edges[i - 1]!))) return false;
  }
  return true;
}

/** About `count` bins on multiples of a round step (1, 2, or 5 times a power of ten). */
function roundEdges(min: number, max: number, count: number): number[] {
  const [lo, hi] = niceDomain(min, max, count);
  const step = tickStep(lo, hi, count);
  const bins = Math.round((hi - lo) / step);
  return bins >= 1 && bins <= MAX_BINS ? multiples(Math.round(lo / step), step, bins) : [];
}

/**
 * Edges of fixed width `step` from `start`, or by default from the multiple
 * of `step` at or below the minimum, through the maximum. Values below an
 * explicit start fall outside the bins.
 */
function fixedEdges(min: number, max: number, bins: { step: number; start?: number }): number[] {
  const first = Math.floor(min / bins.step);
  // A start too far out for multiples of the step begins at the minimum.
  const aligned = bins.start === undefined && Number.isFinite(first * bins.step);
  const start = bins.start ?? (aligned ? first * bins.step : min);
  const from = Math.max(min, start);
  const span = max - start;
  // Steps too fine for the range widen to keep the bin count bounded.
  const step = Number.isFinite(span) ? Math.max(bins.step, span / (MAX_BINS - 1)) : bins.step;
  const count = Number.isFinite(span) ? Math.ceil(span / step - 1e-9) : MAX_BINS;
  const bounded = Math.min(MAX_BINS - 1, Math.max(1, count));
  // The last edge must reach the maximum; it may land exactly on it.
  const build = (n: number) =>
    aligned && step === bins.step ? multiples(first, step, n) : offsets(start, step, n);
  let edges = build(bounded);
  if (edges[edges.length - 1]! < max) edges = build(bounded + 1);
  if (valid(edges, from, max)) return edges;
  if (from > max) return [start, start + bins.step];
  const even = evenEdges(from, max, bounded);
  return valid(even, from, max) ? even : around(from, 0.5);
}

/**
 * The edges `index * step` for `count` bins from `first`. On a decimal step
 * (few decimals) they are integers divided by a power of ten, so the edge
 * at 0.3 is exactly 0.3 and the value 0.3 falls in the bin it starts.
 */
function multiples(first: number, step: number, count: number): number[] {
  const digits = decimals(step);
  if (digits > 0 && digits <= 15) {
    const scale = 10 ** digits;
    const unit = Math.round(step * scale);
    if (Number.isSafeInteger(first * unit) && Number.isSafeInteger((first + count) * unit)) {
      return Array.from({ length: count + 1 }, (_, i) => ((first + i) * unit) / scale);
    }
  }
  return Array.from({ length: count + 1 }, (_, i) => (first + i) * step);
}

/**
 * `start + i * step` for `count` bins; on a decimal grid (start and step
 * with few decimals), integers divided by a power of ten as in `multiples`.
 */
function offsets(start: number, step: number, count: number): number[] {
  const digits = Math.max(decimals(start), decimals(step));
  if (digits <= 15) {
    const scale = 10 ** digits;
    const first = Math.round(start * scale);
    const unit = Math.round(step * scale);
    if (unit > 0 && Number.isSafeInteger(first) && Number.isSafeInteger(first + count * unit)) {
      return Array.from({ length: count + 1 }, (_, i) => (first + i * unit) / scale);
    }
  }
  return Array.from({ length: count + 1 }, (_, i) => start + i * step);
}

/** Decimal places in a number's shortest representation. */
function decimals(value: number): number {
  const [mantissa, exponent] = String(Math.abs(value)).split("e");
  const places = mantissa!.split(".")[1]?.length ?? 0;
  return Math.max(0, places - Number(exponent ?? 0));
}

/**
 * `count` equal bins from `min` to `max` by interpolation, which neither
 * overflows nor accumulates error; neighbors closer than the precision of
 * the values merge.
 */
function evenEdges(min: number, max: number, count: number): number[] {
  const edges: number[] = [min];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const edge = i === count ? max : min * (1 - t) + max * t;
    if (edge > edges[edges.length - 1]!) edges.push(edge);
  }
  return edges.length >= 2 ? edges : around(min, 0.5);
}

/** One bin around `value`, at least `half` to each side and wide enough to represent. */
function around(value: number, half: number): number[] {
  const width = Math.max(half, Math.abs(value) * 2 ** -40);
  const lo = value - width;
  const hi = value + width;
  // At the ends of the number range the bin keeps the value as its edge.
  return [Number.isFinite(lo) ? lo : value, Number.isFinite(hi) ? hi : value];
}

/** `binOf` for edges a `step` apart: the bin by division, corrected for rounding at edges. */
function evenBinOf(edges: Float64Array, step: number, value: number): number {
  const bins = edges.length - 1;
  if (!(value >= edges[0]! && value <= edges[bins]!)) return -1;
  let bin = Math.min(bins - 1, Math.floor((value - edges[0]!) / step));
  if (value < edges[bin]!) bin--;
  else if (bin < bins - 1 && value >= edges[bin + 1]!) bin++;
  return bin;
}

/**
 * The bin holding `value`: the last edge at or below it, with the final
 * bin also holding its right edge; -1 outside the edges or for a missing value.
 */
function binOf(edges: Float64Array, value: number): number {
  const bins = edges.length - 1;
  if (!(value >= edges[0]! && value <= edges[bins]!)) return -1;
  let lo = 0;
  let hi = bins;
  while (hi - lo > 1) {
    const middle = (lo + hi) >> 1;
    if (value >= edges[middle]!) lo = middle;
    else hi = middle;
  }
  return lo;
}

/**
 * Bars counting the values of a field in round bins: a histogram.
 *
 * ```ts
 * histogram(requests, { x: "latency" })
 * histogram(requests, { x: "latency", series: "region", bins: { step: 10 } })
 * ```
 */
export function histogram<S extends Schema>(
  table: Table<S>,
  options: HistogramOptions<S>,
): HistogramMark {
  const spec: HistogramSpec = {
    type: "histogram",
    x: options.x,
    ...definedFields(options, [
      "series",
      "normalize",
      "stack",
      "fill",
      "fillOpacity",
      "label",
      "axis",
      "facet",
      "panel",
      "id",
    ]),
  };
  if (options.bins !== undefined)
    spec.bins = typeof options.bins === "number" ? options.bins : { ...options.bins };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HistogramMark(spec, table as unknown as Table);
}
