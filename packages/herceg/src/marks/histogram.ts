import type { NumericArray } from "../data/column.ts";
import type { CategoryField, NumberField, NumericField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import { rectDrawing } from "../draw/rect.ts";
import { formatNumber } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import type { PositionScale } from "../scale/scale.ts";
import { niceDomain, tickStep } from "../scale/ticks.ts";
import { chooseInterval, niceTimeDomain, timeTicks } from "../scale/time.ts";
import type { AreaGeometry, RectGeometry } from "../scene/scene.ts";
import type { Frozen, HistogramSpec } from "../spec/spec.ts";
import { BandShares, STILL } from "./dodge.ts";
import { histogramFormError, MAX_BINS, requireHistogramEdges } from "./histogram-input.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandContext,
  CATEGORY,
  type ChartMark,
  type Frame,
  frozen,
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
import type { Series } from "./series.ts";

interface HistogramStyle<S extends Schema> {
  /** Approximate bin count, fixed width/start, or exact finite increasing edges (2–1001). */
  bins?: number | { step: number; start?: number } | readonly number[];
  /** Category field: one histogram per value. */
  series?: CategoryField<S>;
  /** A number field each row counts as, in place of 1; rows missing a weight, or with a negative one, are not counted. */
  weight?: NumberField<S>;
  /**
   * Counts (default), frequency (counts per unit of the binned axis),
   * probability, percent, or probability density per unit of the binned axis.
   */
  normalize?: "count" | "frequency" | "probability" | "percent" | "density";
  /** Weight normalized series by their share of finite values, including values outside bins. */
  commonNorm?: boolean;
  /** Accumulate bins per series; cumulative density integrates bin widths. */
  cumulative?: boolean;
  /**
   * "bars" (default); "step", an area whose top steps across each bin; or
   * "poly", an area through the bins' centers.
   */
  element?: "bars" | "step" | "poly";
  fill?: string;
  /**
   * Bars: 1, or 0.5 for several overlaid series. Steps and polygons: 0.75,
   * or 0.25 overlaid.
   */
  fillOpacity?: number;
  label?: string;
  /** Draw all rows in every facet panel instead of counting that panel's rows. */
  facet?: "repeat";
  /** The subplot to draw in, or "*" for every panel. */
  panel?: string;
  /**
   * Marks naming the same group share series by name: series of the same
   * name share a color, one legend entry, and visibility.
   */
  legendGroup?: string;
  id?: string;
}

/** Exactly one number or time field: x for vertical bars, y for horizontal bars. */
export type HistogramOptions<S extends Schema> = HistogramStyle<S> &
  (
    | { x: NumericField<S>; y?: never; axis?: "left" | "right" }
    | { y: NumericField<S>; x?: never; axis?: "left" }
  ) &
  // "fill" stacks series as shares of each bin.
  ({ stack?: boolean | "fill"; dodge?: false } | { stack?: false; dodge?: boolean });

/** Pixels left between neighboring bars when bins are wide enough. */
const GAP = 1;

/**
 * What one series counted: per bin and in all (weights, with a `weight`
 * field), how many rows it has and how many of them the bins hold, and
 * what its finite values count for.
 */
interface Counted {
  counts: Float64Array;
  total: number;
  size: number;
  inBins: number;
  finite: number;
}

/** The edges a series was counted in, and what it counted. */
interface Bins extends Counted {
  edges: Float64Array;
}

/** Bin edges, their centers, and what each series source counted in them. */
interface Binned {
  edges: Float64Array;
  centers: Float64Array;
  /** By series source, in order. */
  counted: Counted[];
}

/** A facet split's counts: each binned axis group's bins and each panel's counts, as of what they were made from. */
interface PanelCounts {
  version: number;
  zone: TimeZone;
  /** The panels' rows, and the binned axis group of each. */
  rows: readonly Uint32Array[];
  groups: string;
  /** Per binned axis group. */
  bins: { edges: Float64Array; centers: Float64Array }[];
  /** Per panel, by series code (0 without a series field), for codes with rows there. */
  counted: Map<number, Counted>[];
}

const NO_BINS = new Float64Array(0);
/**
 * Bars counting how many values fall in each bin of x or y. Bins are shared by
 * every series and computed from all of the field's values: round edges
 * (multiples of 1, 2, or 5 times a power of ten, or calendar intervals for
 * times), each bin holding values from its left edge up to its right one,
 * the last also its right edge. Series reads the bars, with bin centers as
 * positions, so tooltips report a bin's range and its count. Split by facets, each
 * panel counts its own rows, in bins chosen from the rows of the panels
 * sharing its binned axis scale.
 */
export class HistogramMark implements Mark<Frozen<HistogramSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<HistogramSpec>;
  readonly table: Table<Schema>;
  readonly tooltip: "x" | "y";
  readonly summarizes = true;
  readonly zero: "x" | "y";
  readonly #horizontal: boolean;
  readonly #field: string;
  readonly #explicit: Float64Array | undefined;
  /** With `dodge`, each series' share of the bins. */
  readonly #shares: BandShares | undefined;
  readonly #split: SeriesSplitter;
  /** One chart's bins per time zone (calendar bins depend on it), as of a table version. */
  readonly #binned = new Map<TimeZone, Binned & { table: Table; version: number }>();
  /** The series a split histogram lists, as of a table version (see `#present`). */
  #seriesPresent:
    | { version: number; sources: { id: string; label: string }[]; codes: number[] }
    | undefined;
  /** Facet splits' counts, by their first panel's rows: charts split rows apart. */
  readonly #panels = new WeakMap<Uint32Array, PanelCounts>();
  /**
   * The bins each series was counted in, for its drawing, tooltips, and
   * summary, by its values, which only it holds.
   */
  readonly #bins = new WeakMap<NumericArray, Bins>();

  constructor(input: HistogramSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    const problem = histogramFormError(spec);
    if (problem) throw new TypeError(problem);
    this.#horizontal = spec.y !== undefined;
    this.#field = (spec.y ?? spec.x)!;
    this.tooltip = this.#horizontal ? "y" : "x";
    this.zero = this.#horizontal ? "x" : "y";
    requireField(table, this.#field, NUMERIC, `histogram ${this.tooltip}`);
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "histogram series");
    if (spec.weight !== undefined) requireField(table, spec.weight, ["number"], "histogram weight");
    const { bins } = spec;
    if (typeof bins === "number" && !(Number.isInteger(bins) && bins >= 1))
      throw new RangeError(
        `histogram bins: expected a whole number of at least 1; received ${bins}`,
      );
    if (Array.isArray(bins)) {
      requireHistogramEdges(bins);
      this.#explicit = Float64Array.from(bins);
    }
    const fixed =
      typeof bins === "object" && !Array.isArray(bins)
        ? (bins as { step: number; start?: number })
        : undefined;
    if (fixed && !(fixed.step > 0 && Number.isFinite(fixed.step)))
      throw new RangeError(
        `histogram bins.step: expected a positive number; received ${fixed.step}`,
      );
    if (fixed && fixed.start !== undefined && !Number.isFinite(fixed.start))
      throw new RangeError(
        `histogram bins.start: expected a finite number; received ${fixed.start}`,
      );
    this.#split = new SeriesSplitter(table, undefined, [this.#field], spec.series, spec.label);
    if (spec.dodge) this.#shares = new BandShares();
  }

  channelKind(axis: "x" | "y") {
    return axis === this.tooltip ? this.table.kind(this.#field) : "number";
  }

  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
    split = false,
  ): Series[] {
    // Facets count each panel's rows (summarizePanels), so need no rows by series.
    const sources = split ? this.#present().sources : this.#split.sources();
    const roster = sources.map((source) => {
      const id = seriesKey(key, source.id);
      const color = palette(id, source.label, this.spec.fill);
      return { key: id, label: source.label, color: this.spec.fill ?? color };
    });
    if (split) return roster.map(({ key, label, color }) => withoutBins(key, label, color));
    const { edges, centers, counted } = this.#binsIn(context.zone);
    return this.#bars(roster, edges, centers, counted, hidden);
  }

  /** Each panel's bars: its rows counted in the bins of its binned axis' panels. */
  summarizePanels(
    roster: readonly Series[],
    rows: readonly Uint32Array[],
    xGroupOf: readonly number[],
    hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
    yGroupOf: readonly number[] = xGroupOf,
  ): Series[][] {
    const groupOf = this.#horizontal ? yGroupOf : xGroupOf;
    const { bins, counted } = this.#panelCounts(rows, groupOf, context.zone);
    const { codes } = this.#present();
    return rows.map((_, p) => {
      const { edges, centers } = bins[groupOf[p]!]!;
      const found = codes.map((code) => counted[p]!.get(code));
      return this.#bars(roster, edges, centers, found, hidden);
    });
  }

  /**
   * The roster's bars over `edges` (bin `centers` along the binned axis): each series'
   * counts (`counted`, in order), measured as `normalize` says over its
   * own, and stacked on the visible series before it. A series without
   * rows here has no bars.
   */
  #bars(
    roster: readonly Pick<Series, "key" | "label" | "color">[],
    edges: Float64Array,
    centers: Float64Array,
    counted: readonly (Counted | undefined)[],
    hidden: ReadonlySet<string>,
  ): Series[] {
    const bins = centers.length;
    const { stack } = this.spec;
    const all = counted.reduce((sum, s) => sum + (s?.finite ?? 0), 0);
    const measures = counted.map((found) => found && this.#measure(found, edges, all));
    // Stacked series sit on the visible ones before them; filled stacks
    // divide each bin among the visible series.
    const base = stack ? new Float64Array(bins) : undefined;
    let whole: Float64Array | undefined;
    if (stack === "fill") {
      whole = new Float64Array(bins);
      measures.forEach((values, i) => {
        if (!values || hidden.has(roster[i]!.key)) return;
        for (let b = 0; b < bins; b++) whole![b]! += values[b]!;
      });
    }
    return roster.map((entry, i) => {
      const found = counted[i];
      const measured = measures[i];
      if (!found || !measured) {
        const empty = withoutBins(entry.key, entry.label, entry.color);
        this.#bins.set(empty.values, {
          edges,
          counts: NO_BINS,
          total: 0,
          size: 0,
          inBins: 0,
          finite: 0,
        });
        return empty;
      }
      // Filled stacks measure each series' share of its bin; bins of nothing hold no share.
      const values = whole
        ? Float64Array.from(measured, (value, b) =>
            whole[b]! > 0 ? value / whole[b]! : Number.NaN,
          )
        : measured;
      let y = values;
      let y0: Float64Array | undefined;
      if (base) {
        y0 = Float64Array.from(base);
        y = Float64Array.from(values, (value, b) => value + y0![b]!);
        if (!hidden.has(entry.key)) base.set(y);
      }
      this.#bins.set(values, { edges, ...found });
      // A literal like other marks' series, so code reading series sees one shape.
      return {
        key: entry.key,
        label: entry.label,
        color: entry.color,
        x: this.#horizontal ? y : centers,
        y: this.#horizontal ? centers : y,
        x0: this.#horizontal ? y0 : undefined,
        y0: this.#horizontal ? undefined : y0,
        values,
        field: undefined,
        range: false,
        rows: undefined,
        length: bins,
        sorted: !this.#horizontal,
      };
    });
  }

  /**
   * What a series' bars measure, bin by bin, as `normalize` says over its
   * own counts, weighted by its share of `all` the finite values with
   * `commonNorm`. Cumulative densities are probabilities, and cumulative
   * frequencies counts, as Seaborn's are.
   */
  #measure(found: Counted, edges: Float64Array, all: number): Float64Array {
    const { counts, total } = found;
    const { cumulative, commonNorm, normalize = "count" } = this.spec;
    const bins = counts.length;
    const values = new Float64Array(bins);
    const share = commonNorm && normalize !== "count" ? (all === 0 ? 0 : found.finite / all) : 1;
    const raw = normalize === "count" || normalize === "frequency";
    const perWidth = !cumulative && (normalize === "density" || normalize === "frequency");
    let accumulated = 0;
    for (let b = 0; b < bins; b++) {
      accumulated += counts[b]!;
      const count = cumulative ? accumulated : counts[b]!;
      let height = raw ? count : total === 0 ? 0 : count / total;
      if (normalize === "percent") height *= 100;
      if (perWidth) {
        const width = edges[b + 1]! - edges[b]!;
        height =
          this.#explicit && !Number.isFinite(width)
            ? height / (edges[b + 1]! / 2 - edges[b]! / 2) / 2
            : height / width;
      }
      values[b] = height * share;
    }
    return values;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return this.#horizontal
      ? this.#measureExtent(series, -Infinity, Infinity, log)
      : this.#edgeExtent(series, log && this.#explicit !== undefined);
  }

  #edgeExtent(series: readonly Series[], log: boolean) {
    let lo = Infinity;
    let hi = -Infinity;
    // Series of panels with binned axis scales of their own may have other bins.
    for (const s of series) {
      if (s.length === 0) continue;
      const { edges } = this.#binsOf(s);
      if (!log) {
        lo = Math.min(lo, edges[0]!);
        hi = Math.max(hi, edges[edges.length - 1]!);
      } else {
        for (const edge of edges) {
          if (!(edge > 0)) continue;
          lo = Math.min(lo, edge);
          hi = Math.max(hi, edge);
        }
      }
    }
    return lo <= hi ? ([lo, hi] as const) : undefined;
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    return this.#horizontal
      ? this.#edgeExtent(series, log)
      : this.#measureExtent(series, x0, x1, log);
  }

  #measureExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      const { edges } = this.#binsOf(s);
      const ends = this.#horizontal ? s.x : s.y;
      const bases = this.#horizontal ? s.x0 : s.y0;
      for (let i = 0; i < s.length; i++) {
        // Bins reaching into the view.
        if (!(edges[i + 1]! >= lo && edges[i]! <= hi)) continue;
        for (const value of [ends[i]!, bases ? bases[i]! : 0]) {
          if (!Number.isFinite(value) || (log && !(value > 0))) continue;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    return min <= max ? ([min, max] as const) : undefined;
  }

  geometry(series: readonly Series[], frame: Frame): (RectGeometry | AreaGeometry)[] {
    // Dodged series keep their room in panels where they have no rows, as grouped bars do.
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    // Overlaid series show through each other.
    const overlaid = visible.length > 1 && !this.spec.stack && !this.spec.dodge;
    const element = this.spec.element ?? "bars";
    if (element !== "bars") {
      const opacity = this.spec.fillOpacity ?? (overlaid ? 0.25 : 0.75);
      return visible.map((s) => this.#outline(s, frame, element === "step", opacity));
    }
    const opacity = this.spec.fillOpacity ?? (overlaid ? 0.5 : 1);
    const out: RectGeometry[] = [];
    // Dodged series split each bin, a legend group's marks by the group's series.
    this.#shares?.split(series, frame, this.spec.legendGroup, true);
    for (const s of visible) {
      const rects = frame.floats(s.key, "rect", s.length * 4);
      let count = 0;
      for (let i = 0; i < s.length; i++) {
        const rect = this.binRect(s, i, frame);
        if (rect) rects.set(rect, count++ * 4);
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

  /**
   * A series' bins as an area: its top stepping across each bin (`step`),
   * or through the bins' centers, down to zero or the series below it,
   * outlined along its top. Bins without a measure (a filled stack's empty
   * bins) or an edge the binned axis can place break it.
   */
  #outline(s: Series, frame: Frame, step: boolean, fillOpacity: number): AreaGeometry {
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const tops = horizontal ? s.x : s.y;
    const bases = horizontal ? s.x0 : s.y0;
    const centers = horizontal ? s.y : s.x;
    const { edges } = this.#binsOf(s);
    const low = this.#base(across);
    const at = (value: number) => {
      const pixel = across.map(value);
      return Number.isFinite(pixel) ? pixel : low;
    };
    const upper = frame.polyline(s.key, "upper");
    const lower = frame.polyline(s.key, "lower");
    upper.reset();
    lower.reset();
    const add = (position: number, top: number, base: number) => {
      if (horizontal) {
        upper.push(at(top), position);
        lower.push(at(base), position);
      } else {
        upper.push(position, at(top));
        lower.push(position, at(base));
      }
    };
    for (let b = 0; b < s.length; b++) {
      const top = tops[b]!;
      const base = bases ? bases[b]! : 0;
      const from = along.map(step ? edges[b]! : centers[b]!);
      const to = step ? along.map(edges[b + 1]!) : from;
      if (!(Number.isFinite(top) && Number.isFinite(base) && Number.isFinite(from + to))) {
        upper.break();
        lower.break();
        continue;
      }
      add(from, top, base);
      if (step) add(to, top, base);
    }
    return {
      kind: "area",
      draw: areaDrawing,
      key: s.key,
      fill: s.color,
      fillOpacity,
      upper,
      lower,
      baseline: low,
      stroke: s.color,
      strokeWidth: frame.theme.lineWidth,
    };
  }

  /**
   * The bin of `s` drawn under a pixel, or -1: inside its bar (or step), or
   * for polygons, under the polygon between two bins' centers, in the bin
   * the pixel's position falls in. Clicks read it.
   */
  binAt(s: Series, px: number, py: number, frame: Pick<Frame, "x" | "y">): number {
    if ((this.spec.element ?? "bars") !== "poly") {
      for (let b = 0; b < s.length; b++) {
        const rect = this.binRect(s, b, frame);
        if (!rect) continue;
        const [x, y, width, height] = rect;
        if (px >= x && px <= x + width && py >= y && py <= y + height) return b;
      }
      return -1;
    }
    const horizontal = this.#horizontal;
    const [along, across] = horizontal ? [frame.y, frame.x] : [frame.x, frame.y];
    const [pa, pc] = horizontal ? [py, px] : [px, py];
    const tops = horizontal ? s.x : s.y;
    const bases = horizontal ? s.x0 : s.y0;
    const centers = horizontal ? s.y : s.x;
    const { edges } = this.#binsOf(s);
    // As `#outline` draws them.
    const low = this.#base(across);
    const at = (value: number) => {
      const pixel = across.map(value);
      return Number.isFinite(pixel) ? pixel : low;
    };
    for (let b = 0; b + 1 < s.length; b++) {
      const [from, to] = [along.map(centers[b]!), along.map(centers[b + 1]!)];
      if (!(pa >= Math.min(from, to) && pa <= Math.max(from, to))) continue;
      const ends = [tops[b]!, tops[b + 1]!, bases?.[b] ?? 0, bases?.[b + 1] ?? 0];
      if (!ends.every(Number.isFinite)) continue;
      const t = from === to ? 0 : (pa - from) / (to - from);
      const top = at(ends[0]!) + t * (at(ends[1]!) - at(ends[0]!));
      const base = at(ends[2]!) + t * (at(ends[3]!) - at(ends[2]!));
      if (pc < Math.min(top, base) || pc > Math.max(top, base)) continue;
      // Past the edge the two bins share, the pixel is in the second.
      const edge = along.map(edges[b + 1]!);
      return (pa - edge) * (to - edge) > 0 ? b + 1 : b;
    }
    return -1;
  }

  /**
   * The rectangle (x, y, width, height) a bin's bar is drawn in, as last
   * drawn, or undefined when it is not drawn (empty, or on a log axis that
   * cannot place it).
   */
  binRect(
    s: Series,
    bin: number,
    frame: Pick<Frame, "x" | "y">,
  ): readonly [number, number, number, number] | undefined {
    const horizontal = this.#horizontal;
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    const top = (horizontal ? s.x : s.y)[bin]!;
    const bases = horizontal ? s.x0 : s.y0;
    if (!(top > (bases ? bases[bin]! : 0))) return undefined;
    const { edges } = this.#binsOf(s);
    const a = along.map(edges[bin]!);
    const b = along.map(edges[bin + 1]!);
    const tip = across.map(top);
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(tip))) return undefined;
    const zero = this.#base(across);
    const root = bases ? across.map(bases[bin]!) : zero;
    const base = Number.isFinite(root) ? root : zero;
    const { start, share } = this.#bar(s, a, b);
    return horizontal
      ? [Math.min(tip, base), start, Math.abs(base - tip), share]
      : [start, Math.min(tip, base), share, Math.abs(base - tip)];
  }

  /**
   * The pixel bins are measured from on `across`: zero, or on a log axis
   * its low end (for vertical bins, the plot's bottom), where values it
   * cannot place, zeros among them, lie too. Bars, steps, and polygons
   * stand on it alike.
   */
  #base(across: PositionScale): number {
    if (across.type !== "log") return across.map(0);
    return this.#horizontal ? across.map(Math.min(...across.domain)) : across.range[0];
  }

  /** Where a bin's bar is drawn across a bin from pixel `a` to `b`: a pixel's gap, and with `dodge` the series' share. */
  #bar(s: Series, a: number, b: number): { start: number; share: number } {
    const width = Math.abs(b - a);
    // A pixel apart when bins are wide enough to spare it; steps and polygons fill their bins.
    const gap = width > 4 * GAP && (this.spec.element ?? "bars") === "bars" ? GAP : 0;
    const start = Math.min(a, b) + gap / 2;
    if (!this.#shares) return { start, share: width - gap };
    const { center, width: share } = this.#shares.of(s, width - gap);
    return { start: start + (width - gap) / 2 + center - share / 2, share };
  }

  /** Where a dodged bin's bar is drawn, off its bin's center, for inspection. */
  displace(s: Series, row: number, frame: Frame): readonly [number, number] {
    if (!this.#shares) return STILL;
    const along = this.#horizontal ? frame.y : frame.x;
    const { edges } = this.#binsOf(s);
    const { start, share } = this.#bar(s, along.map(edges[row]!), along.map(edges[row + 1]!));
    const shift = start + share / 2 - along.map(this.#horizontal ? s.y[row]! : s.x[row]!);
    return this.#horizontal ? [0, shift] : [shift, 0];
  }

  /** Dodged bars stand anywhere in their bins; a histogram's few bins are all read. */
  maxDisplacement(): number {
    return this.#shares && !this.#horizontal ? Infinity : 0;
  }

  /** A bin crossing zero on a logarithmic binned axis has no mapped edge or bar. */
  shows(series: Series, row: number, y: PositionScale, x: PositionScale): boolean {
    const along = this.#horizontal ? y : x;
    if (along.type !== "log") return true;
    // Polygons are drawn through bins' centers; bars and steps across their edges.
    if (this.spec.element === "poly")
      return Number.isFinite(along.map((this.#horizontal ? series.y : series.x)[row]!));
    const { edges } = this.#binsOf(series);
    return Number.isFinite(along.map(edges[row]!)) && Number.isFinite(along.map(edges[row + 1]!));
  }

  /**
   * Whether a row is counted in bin `position` of a series: its value from
   * the bin's left edge (a cumulative bin's first edge) up to its right one
   * (the last bin's included), and its series field the series'.
   */
  summarized(series: Series, position: number): (row: number) => boolean {
    const { edges } = this.#binsOf(series);
    const [lo, hi] = [edges[this.spec.cumulative ? 0 : position]!, edges[position + 1]!];
    const last = position === edges.length - 2;
    const values = this.table.numbers(this.#field as never);
    const field = this.spec.series;
    const codes = field === undefined ? undefined : this.table.categories(field as never);
    const code = codes?.dictionary.indexOf(String((JSON.parse(series.key) as unknown[])[1]));
    // Rows without a usable weight count in no bin.
    const weights = this.#weights();
    return (row) => {
      const value = values[row]!;
      const weight = weights ? weights[row]! : 1;
      return (
        (!codes || codes.codes[row] === code) &&
        weight >= 0 &&
        weight < Infinity &&
        value >= lo &&
        (last ? value <= hi : value < hi)
      );
    };
  }

  /** A bin's range and what its bar measures. */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const { edges } = this.#binsOf(series);
    const along = this.#horizontal ? format.y : format.x;
    const across = this.#horizontal ? format.x : format.y;
    const start = this.spec.cumulative ? 0 : row;
    return `${along(edges[start]!)} – ${along(edges[row + 1]!)}: ${this.spec.cumulative ? "cumulative " : ""}${across(series.values[row]!)}`;
  }

  /**
   * How many values a series counted, in how many bins over what range (in
   * every panel: the bins of each binned axis scale), and its fullest bin.
   */
  summarize(parts: readonly Series[], name: string, { format, locale }: SummaryContext): string {
    const f = (value: number) => formatNumber(value, locale);
    const along = this.#horizontal ? format.y : format.x;
    let [values, weighed, outside, lo, hi] = [0, 0, 0, Infinity, -Infinity];
    const grids = new Set<Float64Array>();
    // The fullest bar of any panel: counts (or weights), whatever the bars measure.
    let fullest: { edges: Float64Array; bin: number; count: number } | undefined;
    for (const part of parts) {
      const bins = this.#binsOf(part);
      values += bins.inBins;
      weighed += bins.total;
      outside += bins.size - bins.inBins;
      const { edges, counts } = bins;
      if (counts.length === 0) continue;
      grids.add(edges);
      lo = Math.min(lo, edges[0]!);
      hi = Math.max(hi, edges[edges.length - 1]!);
      for (let bin = 0; bin < counts.length; bin++)
        if (!fullest || counts[bin]! > fullest.count) fullest = { edges, bin, count: counts[bin]! };
    }
    const weight = this.spec.weight;
    const left =
      outside > 0
        ? `; ${f(outside)} missing${weight === undefined ? "" : ` a value or ${weight}`} or outside the bins`
        : "";
    if (values === 0 || !fullest)
      return `${name}: no values in bins${this.spec.cumulative ? "; bars are cumulative" : ""}${left}`;
    const [grid] = grids;
    const count = grid!.length - 1;
    const where =
      grids.size === 1
        ? `${count} ${count === 1 ? "bin" : "bins"}`
        : `the bins of ${grids.size} ${this.tooltip} scales`;
    const { edges, bin } = fullest;
    return (
      `${name}: ${f(values)} ${values === 1 ? "value" : "values"}` +
      (weight === undefined ? "" : `, ${weight} ${f(weighed)} in all,`) +
      ` in ${where} from ` +
      `${along(lo)} to ${along(hi)}; ` +
      (this.spec.cumulative
        ? grids.size > 1
          ? "bars are cumulative within each panel; "
          : `bars are cumulative from ${along(lo)}; `
        : "") +
      `the fullest, ${along(edges[bin]!)} – ${along(edges[bin + 1]!)}, holds ` +
      `${weight === undefined ? "" : `${weight} `}${f(fullest.count)}${left}`
    );
  }

  /** The bins a series of this mark was counted in. */
  #binsOf(series: Series): Bins {
    return (
      this.#bins.get(series.values) ?? {
        edges: NO_BINS,
        counts: NO_BINS,
        total: 0,
        size: 0,
        inBins: 0,
        finite: 0,
      }
    );
  }

  /** The `weight` field's values, when rows count as their weights. */
  #weights(): NumericArray | undefined {
    const { weight } = this.spec;
    return weight === undefined ? undefined : this.table.numbers(weight as never);
  }

  /**
   * The series a split histogram lists, as one chart's sources list them
   * (each series value with rows, in the field's order), and each one's
   * series code (0 without a series field): one pass over the codes per
   * table version, without grouping rows.
   */
  #present(): { sources: { id: string; label: string }[]; codes: number[] } {
    const { table } = this;
    if (this.#seriesPresent?.version === table.version) return this.#seriesPresent;
    const field = this.spec.series;
    let present: { sources: { id: string; label: string }[]; codes: number[] };
    if (field === undefined) {
      present = {
        sources: [{ id: this.#field, label: this.spec.label ?? this.#field }],
        codes: [0],
      };
    } else {
      const { codes, dictionary } = table.categories(field as never);
      const seen = new Uint8Array(dictionary.length);
      for (let row = 0; row < codes.length; row++) if (codes[row]! >= 0) seen[codes[row]!] = 1;
      const found = Array.from(dictionary, (_, code) => code).filter((code) => seen[code]);
      present = {
        sources: found.map((code) => ({ id: dictionary[code]!, label: dictionary[code]! })),
        codes: found,
      };
    }
    this.#seriesPresent = { version: table.version, ...present };
    return present;
  }

  /** One chart's bins, from all of the field's values, counted again when the table changes. */
  #binsIn(zone: TimeZone): Binned {
    const { table } = this;
    const cached = this.#binned.get(zone);
    if (cached?.table === table && cached.version === table.version) return cached;
    const values = table.numbers(this.#field as never);
    const edges = this.#edges(finiteRange(values, undefined, RANGE), zone);
    const binned = { edges, centers: centersOf(edges), counted: this.#countSources(edges) };
    this.#binned.set(zone, { ...binned, table, version: table.version });
    return binned;
  }

  /**
   * A facet split's bins and counts: each binned axis group's bins from the values of
   * its panels' rows, and each panel's rows counted in its group's bins.
   * Kept while the table, the panels' rows, their scale groups, and the zone are
   * the same, so redrawing and hiding series count nothing again.
   */
  #panelCounts(rows: readonly Uint32Array[], groupOf: readonly number[], zone: TimeZone) {
    const { table } = this;
    const groups = groupOf.join();
    const key = rows[0]!;
    const cached = this.#panels.get(key);
    if (
      cached?.version === table.version &&
      cached.zone === zone &&
      cached.groups === groups &&
      cached.rows.length === rows.length &&
      cached.rows.every((r, p) => r === rows[p])
    )
      return cached;
    const values = table.numbers(this.#field as never);
    const ranges: { min: number; max: number; finite: number }[] = [];
    rows.forEach((panel, p) => {
      const g = groupOf[p]!;
      ranges[g] = finiteRange(
        values,
        panel,
        ranges[g] ?? { min: Infinity, max: -Infinity, finite: 0 },
      );
    });
    const bins = Array.from(ranges, (range) => {
      const edges = range ? this.#edges(range, zone) : NO_BINS;
      return { edges, centers: centersOf(edges) };
    });
    // Each series code's place among those a panel counts, -1 until it has
    // one: one array for every panel, which each leaves as it found it.
    const field = this.spec.series;
    const slots = new Int32Array(
      field === undefined ? 1 : table.categories(field as never).dictionary.length,
    ).fill(-1);
    const counts: PanelCounts = {
      version: table.version,
      zone,
      rows,
      groups,
      bins,
      counted: rows.map((panel, p) => this.#countRows(bins[groupOf[p]!]!.edges, panel, slots)),
    };
    this.#panels.set(key, counts);
    return counts;
  }

  /** What each series source counted in the bins of `edges`, over its rows. */
  #countSources(edges: Float64Array): Counted[] {
    const values = this.table.numbers(this.#field as never);
    const bins = Math.max(0, edges.length - 1);
    const step = bins > 0 ? (edges[bins]! - edges[0]!) / bins : 0;
    const even = !this.#explicit && evenlySpaced(edges, step);
    // A loop, not a callback: values a callback reads from outside it cost
    // the counting loop about a tenth more time.
    const weights = this.#weights();
    const counted: Counted[] = [];
    for (const { rows } of this.#split.sources()) {
      const counts = new Float64Array(bins);
      let total = 0;
      let finite = 0;
      let inBins = 0;
      const length = rows?.length ?? values.length;
      for (let k = 0; k < length; k++) {
        const row = rows ? rows[k]! : k;
        const value = values[row]!;
        // A row counts as its weight; one without a usable weight not at all.
        const weight = weights ? weights[row]! : 1;
        if (!(weight >= 0 && weight < Infinity)) continue;
        if (Number.isFinite(value)) finite += weight;
        const at = even ? evenBinOf(edges, step, value) : binOf(edges, value);
        if (at < 0) continue;
        counts[at]! += weight;
        total += weight;
        inBins++;
      }
      counted.push({ counts, total, size: length, inBins, finite });
    }
    return counted;
  }

  /**
   * What each series code counted at a panel's `rows` in the bins of
   * `edges`, in one pass: rows without a series value are not counted.
   * `slots` holds -1 for every code, as it does again after.
   */
  #countRows(edges: Float64Array, rows: Uint32Array, slots: Int32Array): Map<number, Counted> {
    const values = this.table.numbers(this.#field as never);
    const field = this.spec.series;
    const categories = field === undefined ? undefined : this.table.categories(field as never);
    const codes = categories?.codes;
    const bins = Math.max(0, edges.length - 1);
    const step = bins > 0 ? (edges[bins]! - edges[0]!) / bins : 0;
    const even = !this.#explicit && evenlySpaced(edges, step);
    const weights = this.#weights();
    // Per code found, in one buffer: row size, in-bin total, finite total,
    // rows in bins, then bin counts.
    const width = bins + 4;
    const found: number[] = [];
    let buffer = new Float64Array(4 * width);
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      const code = codes ? codes[row]! : 0;
      if (code < 0) continue;
      let slot = slots[code]!;
      if (slot < 0) {
        slot = found.length;
        slots[code] = slot;
        found.push(code);
        if (found.length * width > buffer.length) {
          const grown = new Float64Array(buffer.length * 2);
          grown.set(buffer);
          buffer = grown;
        }
      }
      const base = slot * width;
      buffer[base]!++;
      const weight = weights ? weights[row]! : 1;
      if (!(weight >= 0 && weight < Infinity)) continue;
      const value = values[row]!;
      if (Number.isFinite(value)) buffer[base + 2]! += weight;
      const at = even ? evenBinOf(edges, step, value) : binOf(edges, value);
      if (at < 0) continue;
      buffer[base + 1]! += weight;
      buffer[base + 3]!++;
      buffer[base + 4 + at]! += weight;
    }
    for (const code of found) slots[code] = -1;
    return new Map(
      found.map((code, slot) => {
        const base = slot * width;
        const counts = buffer.subarray(base + 4, base + width);
        return [
          code,
          {
            counts,
            total: buffer[base + 1]!,
            size: buffer[base]!,
            finite: buffer[base + 2]!,
            inBins: buffer[base + 3]!,
          },
        ];
      }),
    );
  }

  /**
   * Bin edges covering the `range` of values (from the start, with an
   * explicit one): round values, or calendar boundaries in `zone` for
   * times; evenly spaced edges when round ones cannot be represented. None
   * for no values.
   */
  #edges({ min, max, finite }: { min: number; max: number; finite: number }, zone: TimeZone) {
    if (this.#explicit) return this.#explicit;
    if (finite === 0) return NO_BINS;
    const { bins } = this.spec;
    const time = this.table.kind(this.#field as never) === "time";
    if (typeof bins === "object" && !Array.isArray(bins))
      return Float64Array.from(fixedEdges(min, max, bins as { step: number; start?: number }));
    // One value, or values all alike: one bin around them.
    if (min === max) return Float64Array.from(around(min, time ? 1_800_000 : 0.5));
    // Sturges' rule unless a count is given; coarser when round edges overflow the limit.
    const target = Math.min(
      MAX_BINS,
      (typeof bins === "number" ? bins : undefined) ??
        Math.min(50, Math.ceil(Math.log2(finite)) + 1),
    );
    for (let count = target; count >= 1; count = Math.floor(count / 2)) {
      const edges = time ? calendarEdges(min, max, count, zone) : roundEdges(min, max, count);
      if (valid(edges, min, max)) return Float64Array.from(edges);
    }
    return Float64Array.from(evenEdges(min, max, target));
  }
}

/** A range of no values, to start from. */
const RANGE = { min: Infinity, max: -Infinity, finite: 0 } as const;

/** A series of no bars (yet), with its own empty values, which name its bins. */
function withoutBins(key: string, label: string, color: string): Series {
  const values = new Float64Array(0);
  return {
    key,
    label,
    color,
    x: NO_BINS,
    y: values,
    y0: undefined,
    values,
    field: undefined,
    range: false,
    rows: undefined,
    length: 0,
    sorted: true,
  };
}

/** The center of each bin; halves first, so centers of edges near the number range's ends stay finite. */
function centersOf(edges: Float64Array): Float64Array {
  const bins = Math.max(0, edges.length - 1);
  const centers = new Float64Array(bins);
  for (let i = 0; i < bins; i++) centers[i] = edges[i]! / 2 + edges[i + 1]! / 2;
  return centers;
}

/**
 * Whether `edges` are `step` apart (all but calendar bins), so that a
 * value's bin is found by division, not search. Counting loops call the two
 * lookups directly rather than through a closure choosing one, which costs
 * them about a tenth more time.
 */
function evenlySpaced(edges: Float64Array, step: number): boolean {
  return (
    edges.length > 1 &&
    edges.every((edge, i) => Math.abs(edge - (edges[0]! + i * step)) <= step * 1e-9)
  );
}

/**
 * `range` widened by the finite values at `rows` (every row without them):
 * the least, the greatest, and how many there are.
 */
function finiteRange(
  values: NumericArray,
  rows: Uint32Array | undefined,
  range: { readonly min: number; readonly max: number; readonly finite: number },
): { min: number; max: number; finite: number } {
  let { min, max, finite } = range;
  // A whole column, the one chart's case, in a loop of its own.
  if (!rows) {
    for (let row = 0; row < values.length; row++) {
      const value = values[row]!;
      if (!Number.isFinite(value)) continue;
      finite++;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { min, max, finite };
  }
  for (let k = 0; k < rows.length; k++) {
    const value = values[rows[k]!]!;
    if (!Number.isFinite(value)) continue;
    finite++;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max, finite };
}

/** Calendar boundaries in `zone`, about `count` bins covering [min, max]. */
function calendarEdges(min: number, max: number, count: number, zone: TimeZone): number[] {
  const [lo, hi] = niceTimeDomain(min, max, count, zone);
  const edges = timeTicks(lo, hi, chooseInterval(hi - lo, count), zone);
  if (edges[0] !== lo) edges.unshift(lo);
  if (edges[edges.length - 1] !== hi) edges.push(hi);
  return edges;
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
): ChartMark<Frozen<HistogramSpec>> {
  const spec = {
    type: "histogram",
    ...definedFields(options, [
      "x",
      "y",
      "bins",
      "series",
      "weight",
      "normalize",
      "stack",
      "commonNorm",
      "cumulative",
      "dodge",
      "element",
      "fill",
      "fillOpacity",
      "label",
      "legendGroup",
      "axis",
      "facet",
      "panel",
      "id",
    ]),
  } as unknown as HistogramSpec;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HistogramMark(spec, table as unknown as Table);
}
