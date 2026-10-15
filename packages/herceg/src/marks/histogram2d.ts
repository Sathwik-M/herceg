// 2D histograms: cells counting the rows whose x and y both fall in a bin of
// each, colored by what they measure. Bins come from `bins` (the same
// definitions as bars' and the `bin` transform's, along both axes or each)
// over the rows whose x and y are both values; the cells are painted into
// one image, as a heatmap's are, through the same raster code.

import {
  type BinRange,
  binEdges,
  binOf,
  centersOf,
  checkBins,
  evenBinOf,
  evenStep,
  NO_BINS,
  NO_RANGE,
} from "../data/bins.ts";
import type { NumericArray } from "../data/column.ts";
import type { NumberField, NumericField, Schema, Table } from "../data/table.ts";
import { rasterDrawing } from "../draw/raster.ts";
import { formatNumber } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import { CellIndex } from "../lod/cell-index.ts";
import type { LegendPart } from "../model/legend.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import { chooseInterval, niceTimeDomain, timeTicks } from "../scale/time.ts";
import type { Geometry, RasterGeometry } from "../scene/scene.ts";
import type { BinSpec, Clip, Frozen, Histogram2DSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { AxisCells, stepCell } from "./heatmap-cells.ts";
import { paint, rasterAxes } from "./heatmap-raster.ts";
import { histogramFormError, perAxisBins } from "./histogram-input.ts";
import { rampLegend } from "./legend-parts.ts";
import {
  type AxisFormat,
  type BandContext,
  type Frame,
  frozen,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  type SelectionDrawing,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import type { Series } from "./series.ts";

/** A histogram of x and y both: cells counting pairs of values. */
export interface Histogram2DOptions<S extends Schema> {
  /** Number or time field binned along x. */
  x: NumericField<S>;
  /** Number or time field binned along y. */
  y: NumericField<S>;
  /**
   * Bins along both axes (a count, `{ step, start }`, or edges), or along
   * each, `{ x, y }`; by default about log2(n) + 1 round bins.
   */
  bins?: BinSpec | { x?: BinSpec; y?: BinSpec };
  /** A number field each row counts as, in place of 1; rows missing a weight, or with a negative one, are not counted. */
  weight?: NumberField<S>;
  /**
   * Counts (default), frequency (counts per unit of bin area),
   * probability, percent, or density (probability per unit of bin area).
   */
  normalize?: "count" | "frequency" | "probability" | "percent" | "density";
  /** Color ramp from low to high, such as an imported scheme; the theme's by default. */
  colors?: readonly string[];
  /** The values at the ends of the ramp; from 0 to the fullest cell's by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /** What cells measure, in the legend and tooltips; the measure's name by default. */
  label?: string;
  /** `false` leaves the mark out of the chart's legends. */
  legend?: false;
  /** Draw all rows in every facet panel instead of counting that panel's rows. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** The subplot to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
  series?: never;
  stack?: never;
  dodge?: never;
  cumulative?: never;
  element?: never;
  commonNorm?: never;
  fill?: never;
  fillOpacity?: never;
  axis?: never;
}

/** What cells measure, as legends and tooltips name it. */
const MEASURES = {
  count: "Count",
  frequency: "Frequency",
  probability: "Probability",
  percent: "Percent",
  density: "Density",
} as const;

/** Bins along both axes, and the cells a series' rows filled. */
interface Cells {
  xEdges: Float64Array;
  yEdges: Float64Array;
  xCells: AxisCells;
  yCells: AxisCells;
  /** Each drawn cell's column and row of bins, in cell order: by row, then column. */
  columns: Int32Array;
  rows: Int32Array;
  /** Each drawn cell's count (sum of weights). */
  counts: Float64Array;
  /** What the cells counted: weights in bins, rows, and rows in bins. */
  total: number;
  size: number;
  inBins: number;
  /** The rows counted, ascending (a facet panel's); every row when undefined. */
  of: Uint32Array | undefined;
  /** The cells by column and row, for lookups under the pointer and the keyboard. */
  index: CellIndex;
  /** The fullest cell's measure over every panel counted with these cells: the color scale's top. */
  scale: { max: number };
}

/** What a selection holds of each cell: its selected rows' count and weight, and the cell's rows. */
interface Picked {
  rows: Float64Array;
  weights: Float64Array;
  all: Float64Array;
  /** The cells' values where they hold selected rows, missing elsewhere, for an image of them. */
  values: Float64Array;
}

/** What selections hold of each series' cells, by membership, then by the cells. */
const picks = new WeakMap<Uint8Array, WeakMap<Cells, Picked>>();

/** One chart's cells: bins and counts over the whole table, as of its version and zone. */
interface Binned {
  version: number;
  zone: TimeZone;
  series: Series;
}

/** A facet split's cells, as of what they were counted from. */
interface PanelCounts {
  version: number;
  zone: TimeZone;
  rows: readonly Uint32Array[];
  groups: string;
  series: Series[];
}

/** What each raster buffer holds, keyed by the buffer, whichever 2D histogram painted it. */
const painted = new WeakMap<
  ArrayBuffer,
  { inputs: readonly unknown[]; image: readonly number[] }
>();

/**
 * A 2D histogram. Bins are computed from the rows whose x and y are both
 * values (with facets, from the rows of the panels sharing each axis'
 * scale); each row counts as 1 or its weight in the cell of its bins, the
 * last bin along each axis holding its right edge. Cells holding nothing are
 * not drawn and have no tooltip, as Seaborn leaves them; tooltips name a
 * cell's two bins and what it measures, and clicks select its rows.
 */
export class Histogram2DMark implements Mark<Frozen<Histogram2DSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<Histogram2DSpec>;
  readonly table: Table<Schema>;
  readonly tooltip = "cell";
  readonly summarizes = true;
  readonly bandPadding = 0;
  /** Automatic y domains end at the bins' edges rather than at round values. */
  readonly tight = true;
  /** Explicit edges per axis, used as given. */
  readonly #explicit: { x: Float64Array | undefined; y: Float64Array | undefined };
  readonly #binned = new Map<TimeZone, Binned>();
  readonly #panels = new WeakMap<Uint32Array, PanelCounts>();
  /** Each series' cells, by its values, which only it holds. */
  readonly #cells = new WeakMap<NumericArray, Cells>();
  /** The panels' series counted for a split chart's roster series, which legends read. */
  readonly #rosters = new WeakMap<Series, Series[]>();
  /** What the selection drawn with each series holds of its cells, for tooltips. */
  readonly #selected = new WeakMap<Series, Picked>();

  constructor(input: Histogram2DSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    const spec = this.spec;
    this.table = table;
    const problem = histogramFormError(spec as Record<string, unknown>);
    if (problem) throw new TypeError(problem);
    requireField(table, spec.x, NUMERIC, "histogram x");
    requireField(table, spec.y, NUMERIC, "histogram y");
    if (spec.weight !== undefined) requireField(table, spec.weight, ["number"], "histogram weight");
    const bins = (axis: "x" | "y"): BinSpec | undefined =>
      perAxisBins(spec.bins)
        ? (spec.bins as { x?: BinSpec; y?: BinSpec })[axis]
        : (spec.bins as BinSpec | undefined);
    for (const axis of ["x", "y"] as const) {
      const given = bins(axis);
      if (given !== undefined)
        checkBins(given, perAxisBins(spec.bins) ? `histogram bins.${axis}` : "histogram bins");
    }
    const explicit = (axis: "x" | "y") => {
      const given = bins(axis);
      return Array.isArray(given) ? Float64Array.from(given as readonly number[]) : undefined;
    };
    this.#explicit = { x: explicit("x"), y: explicit("y") };
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "histogram colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "histogram");
  }

  /** The bin definition along an axis. */
  #bins(axis: "x" | "y"): BinSpec | undefined {
    const { bins } = this.spec;
    return perAxisBins(bins)
      ? (bins as { x?: BinSpec; y?: BinSpec })[axis]
      : (bins as BinSpec | undefined);
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind(this.spec[axis]);
  }

  series(
    key: MarkKey,
    _palette: Palette,
    _hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
    split = false,
  ): Series[] {
    const id = seriesKey(key, "cells");
    if (split) return [this.#empty(id, context.theme)];
    const { table } = this;
    const zone = context.zone;
    const cached = this.#binned.get(zone);
    if (cached?.version === table.version && cached.series.key === id) return [cached.series];
    const [xs, ys] = [this.#numbers("x"), this.#numbers("y")];
    const [rx, ry] = jointRanges(xs, ys, undefined, NO_RANGE, NO_RANGE);
    const xEdges = this.#edges("x", rx, zone);
    const yEdges = this.#edges("y", ry, zone);
    const scale = { max: 0 };
    const s = this.#count(id, context.theme, xEdges, yEdges, undefined, scale);
    this.#binned.set(zone, { version: table.version, zone, series: s });
    return [s];
  }

  /**
   * Each panel's cells: its rows counted in the bins of its x scale's
   * panels along x and of its y scale's along y. Every panel's cells share
   * one color scale, to the fullest cell of any.
   */
  summarizePanels(
    roster: readonly Series[],
    rows: readonly Uint32Array[],
    xGroupOf: readonly number[],
    _hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
    yGroupOf: readonly number[] = xGroupOf,
  ): Series[][] {
    const { table } = this;
    const zone = context.zone;
    const groups = `${xGroupOf.join()}|${yGroupOf.join()}`;
    const key = rows[0]!;
    const cached = this.#panels.get(key);
    const id = roster[0]!.key;
    if (
      cached?.version === table.version &&
      cached.zone === zone &&
      cached.groups === groups &&
      cached.rows.length === rows.length &&
      cached.rows.every((r, p) => r === rows[p]) &&
      cached.series[0]?.key === id
    ) {
      this.#rosters.set(roster[0]!, cached.series);
      return cached.series.map((s) => [s]);
    }
    const [xs, ys] = [this.#numbers("x"), this.#numbers("y")];
    const xRanges: BinRange[] = [];
    const yRanges: BinRange[] = [];
    rows.forEach((panel, p) => {
      const [gx, gy] = [xGroupOf[p]!, yGroupOf[p]!];
      [xRanges[gx], yRanges[gy]] = jointRanges(
        xs,
        ys,
        panel,
        xRanges[gx] ?? NO_RANGE,
        yRanges[gy] ?? NO_RANGE,
      );
    });
    const xEdges = xRanges.map((range) => (range ? this.#edges("x", range, zone) : NO_BINS));
    const yEdges = yRanges.map((range) => (range ? this.#edges("y", range, zone) : NO_BINS));
    const scale = { max: 0 };
    const series = rows.map((panel, p) =>
      this.#count(id, context.theme, xEdges[xGroupOf[p]!]!, yEdges[yGroupOf[p]!]!, panel, scale),
    );
    this.#panels.set(key, { version: table.version, zone, rows, groups, series });
    this.#rosters.set(roster[0]!, series);
    return series.map((s) => [s]);
  }

  #numbers(axis: "x" | "y"): NumericArray {
    return this.table.numbers(this.spec[axis] as never);
  }

  /** Bin edges along an axis covering `range`: given, or round, or calendar ones for times. */
  #edges(axis: "x" | "y", range: BinRange, zone: TimeZone): Float64Array {
    const explicit = this.#explicit[axis];
    if (explicit) return explicit;
    const time = this.table.kind(this.spec[axis]) === "time";
    const calendar = time
      ? (min: number, max: number, count: number) => calendarEdges(min, max, count, zone)
      : undefined;
    return binEdges(this.#bins(axis), range, sturges(range.finite), calendar);
  }

  /**
   * The series of the cells `rows` (every row without them) fill in the
   * bins of `xEdges` by `yEdges`, its measures raising `scale.max`.
   */
  #count(
    key: string,
    theme: Theme,
    xEdges: Float64Array,
    yEdges: Float64Array,
    rows: Uint32Array | undefined,
    scale: { max: number },
  ): Series {
    const xs = this.#numbers("x");
    const ys = this.#numbers("y");
    const weights =
      this.spec.weight === undefined ? undefined : this.table.numbers(this.spec.weight as never);
    const nx = Math.max(0, xEdges.length - 1);
    const ny = Math.max(0, yEdges.length - 1);
    const grid = new Float64Array(nx * ny);
    const xStep = this.#explicit.x ? 0 : evenStep(xEdges);
    const yStep = this.#explicit.y ? 0 : evenStep(yEdges);
    let [total, inBins, filled] = [0, 0, 0];
    const size = rows ? rows.length : xs.length;
    if (nx > 0 && ny > 0) {
      for (let k = 0; k < size; k++) {
        const row = rows ? rows[k]! : k;
        const weight = weights ? weights[row]! : 1;
        // A row counts as its weight; one without a usable weight not at all.
        if (!(weight >= 0 && weight < Infinity)) continue;
        const x = xs[row]!;
        const y = ys[row]!;
        const c = xStep > 0 ? evenBinOf(xEdges, xStep, x) : binOf(xEdges, x);
        if (c < 0) continue;
        const r = yStep > 0 ? evenBinOf(yEdges, yStep, y) : binOf(yEdges, y);
        if (r < 0) continue;
        const at = r * nx + c;
        if (grid[at] === 0 && weight > 0) filled++;
        grid[at]! += weight;
        total += weight;
        inBins++;
      }
    }
    // The cells holding something, in cell order.
    const columns = new Int32Array(filled);
    const lines = new Int32Array(filled);
    const counts = new Float64Array(filled);
    const centers = { x: centersOf(xEdges), y: centersOf(yEdges) };
    const x = new Float64Array(filled);
    const y = new Float64Array(filled);
    for (let at = 0, k = 0; at < grid.length; at++) {
      if (!(grid[at]! > 0)) continue;
      const [c, r] = [at % nx, Math.floor(at / nx)];
      [columns[k], lines[k], counts[k]] = [c, r, grid[at]!];
      [x[k], y[k]] = [centers.x[c]!, centers.y[r]!];
      k++;
    }
    const values = this.#measure(counts, columns, lines, xEdges, yEdges, total);
    for (const value of values) if (value > scale.max) scale.max = value;
    const cells: Cells = {
      xEdges,
      yEdges,
      xCells: binCells(xEdges, centers.x),
      yCells: binCells(yEdges, centers.y),
      columns,
      rows: lines,
      counts,
      total,
      size,
      inBins,
      of: rows,
      index: new CellIndex(columns, lines, values, nx, ny),
      scale,
    };
    const s: Series = {
      key,
      label: this.#label(),
      color: this.#ramp(theme).at(-1)!,
      x,
      y,
      y0: undefined,
      values,
      range: false,
      rows: undefined,
      length: filled,
      sorted: false,
    };
    this.#cells.set(values, cells);
    return s;
  }

  /** What cells measure, from their counts, as `normalize` says. */
  #measure(
    counts: Float64Array,
    columns: Int32Array,
    rows: Int32Array,
    xEdges: Float64Array,
    yEdges: Float64Array,
    total: number,
  ): Float64Array {
    const normalize = this.spec.normalize ?? "count";
    if (normalize === "count") return counts;
    const share = normalize !== "frequency";
    const perArea = normalize === "frequency" || normalize === "density";
    return Float64Array.from(counts, (count, k) => {
      let value = share ? (total === 0 ? 0 : count / total) : count;
      if (normalize === "percent") value *= 100;
      if (perArea) {
        const c = columns[k]!;
        const r = rows[k]!;
        value /= (xEdges[c + 1]! - xEdges[c]!) * (yEdges[r + 1]! - yEdges[r]!);
      }
      return value;
    });
  }

  #label(): string {
    return this.spec.label ?? MEASURES[this.spec.normalize ?? "count"];
  }

  #ramp(theme: Theme): readonly string[] {
    const fallback = this.spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return rampOf(this.spec.colors, fallback);
  }

  /** A series of no cells (yet), with its own empty values, for split charts' rosters. */
  #empty(key: string, theme: Theme): Series {
    const values = new Float64Array(0);
    return {
      key,
      label: this.#label(),
      color: this.#ramp(theme).at(-1)!,
      x: NO_BINS,
      y: values,
      y0: undefined,
      values,
      range: false,
      rows: undefined,
      length: 0,
      sorted: false,
    };
  }

  /** The cells a series of this mark counted. */
  #cellsOf(s: Series): Cells | undefined {
    return this.#cells.get(s.values);
  }

  /**
   * How many of each cell's rows `selected` holds, and their weight, and
   * how many rows each cell has: one pass over the rows the cells counted,
   * kept while the selection and the cells are the same.
   */
  #picked(cells: Cells, selected: Uint8Array, values: NumericArray): Picked {
    let byCells = picks.get(selected);
    if (!byCells) {
      byCells = new WeakMap();
      picks.set(selected, byCells);
    }
    const known = byCells.get(cells);
    if (known) return known;
    const { xEdges, yEdges, of: rows } = cells;
    const count = cells.counts.length;
    const nx = Math.max(0, xEdges.length - 1);
    const ny = Math.max(0, yEdges.length - 1);
    // Each bin pair's cell, -1 for those holding nothing.
    const cellAt = new Int32Array(nx * ny).fill(-1);
    for (let k = 0; k < count; k++) cellAt[cells.rows[k]! * nx + cells.columns[k]!] = k;
    const picked = {
      rows: new Float64Array(count),
      weights: new Float64Array(count),
      all: new Float64Array(count),
      values: new Float64Array(count).fill(Number.NaN),
    };
    const xs = this.#numbers("x");
    const ys = this.#numbers("y");
    const weights =
      this.spec.weight === undefined ? undefined : this.table.numbers(this.spec.weight as never);
    const xStep = this.#explicit.x ? 0 : evenStep(xEdges);
    const yStep = this.#explicit.y ? 0 : evenStep(yEdges);
    const length = rows ? rows.length : xs.length;
    for (let k = 0; k < length && count > 0; k++) {
      const row = rows ? rows[k]! : k;
      // As counted: rows without a usable weight are in no cell.
      const weight = weights ? weights[row]! : 1;
      if (!(weight >= 0 && weight < Infinity)) continue;
      const c = xStep > 0 ? evenBinOf(xEdges, xStep, xs[row]!) : binOf(xEdges, xs[row]!);
      if (c < 0) continue;
      const r = yStep > 0 ? evenBinOf(yEdges, yStep, ys[row]!) : binOf(yEdges, ys[row]!);
      const at = r < 0 ? -1 : cellAt[r * nx + c]!;
      if (at < 0) continue;
      picked.all[at]!++;
      if (selected[row] !== 1) continue;
      picked.rows[at]!++;
      picked.weights[at]! += weight;
      picked.values[at] = values[at]!;
    }
    byCells.set(cells, picked);
    return picked;
  }

  /**
   * The cells with a selection's rows in them: the image dimmed, and in
   * each cell holding selected rows a square of its color covering the
   * share of its weight they are (see cell-selection.ts).
   */
  selectedGeometry(series: readonly Series[], frame: Frame, drawing: SelectionDrawing): Geometry[] {
    const s = series[0];
    const cells = s && this.#cellsOf(s);
    if (!s || !cells || s.length === 0 || frame.hidden.has(s.key)) return [];
    const colors = this.#colorScale(cells, frame.theme);
    if (!colors) return [];
    const whole = this.geometry(series, frame).flatMap(drawing.dim);
    const picked = this.#picked(cells, drawing.selected, s.values);
    this.#selected.set(s, picked);
    // Cells whose measure overflowed are left out of the image, and so of the selection's squares.
    const shown = (k: number) => picked.rows[k]! > 0 && Number.isFinite(s.values[k]!);
    let held = 0;
    for (let k = 0; k < s.length; k++) held += shown(k) ? 1 : 0;
    // An image of no cell draws nothing.
    if (held === 0) return whole;
    const { x, y } = frame;
    const { xEdges, yEdges, columns, rows } = cells;
    // The narrowest bins along each axis, in pixels.
    const smallest = (edges: Float64Array, scale: PositionScale) => {
      let least = Infinity;
      for (let i = 0; i + 1 < edges.length; i++)
        least = Math.min(least, Math.abs(scale.map(edges[i + 1]!) - scale.map(edges[i]!)));
      return least;
    };
    const key = `${s.key}|selected`;
    const squares = drawing.squares(
      {
        count: s.length,
        held,
        size: [smallest(xEdges, x), smallest(yEdges, y)],
        box: (k) => [
          x.map(xEdges[columns[k]!]!),
          y.map(yEdges[rows[k]!]!),
          x.map(xEdges[columns[k]! + 1]!),
          y.map(yEdges[rows[k]! + 1]!),
        ],
        share: (k) => (shown(k) ? picked.weights[k]! / cells.counts[k]! : 0),
        color: (k) => colors.color(s.values[k]!),
      },
      key,
    );
    return [...whole, ...(squares ?? this.#image(s, frame, cells, colors, picked.values, key))];
  }

  /** The scale coloring cells: over `colorDomain`, or from 0 to the fullest cell. */
  #colorScale(cells: Cells | undefined, theme: Theme): SequentialScale | undefined {
    const domain =
      this.spec.colorDomain ?? (cells && cells.scale.max > 0 ? [0, cells.scale.max] : undefined);
    if (!domain) return undefined;
    return new SequentialScale(domain, this.#ramp(theme), this.spec.colorMidpoint);
  }

  /**
   * The cells' legend. Panels share one scale, whose top the panels'
   * counts set; a split chart's roster names it through the cells of the
   * panels it was counted with.
   */
  legends(series: readonly Series[], theme: Theme): LegendPart[] {
    const s = series[0];
    if (!s) return [];
    const cells = this.#cellsOf(s) ?? this.#rosterCells(s);
    const scale = this.#colorScale(cells, theme);
    if (!scale) return [];
    const { domain, midpoint } = scale;
    return [rampLegend({ stops: scale.legendStops(), domain, title: this.#label(), midpoint })];
  }

  /** For a split chart's roster series, the cells of the first panel counted for it. */
  #rosterCells(roster: Series): Cells | undefined {
    const panels = this.#rosters.get(roster);
    return panels?.[0] && this.#cellsOf(panels[0]);
  }

  /** Cells are colored by what they measure, so the legend shows the ramp instead of series. */
  legendEntry(): false {
    return false;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return this.#edgeExtent(series, "x", log);
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.#edgeExtent(series, "y", log);
  }

  /** The outer edges of the bins of every panel's cells along an axis. */
  #edgeExtent(
    series: readonly Series[],
    axis: "x" | "y",
    log: boolean,
  ): readonly [number, number] | undefined {
    if (log)
      throw new Error(
        `histogram ${axis}: cells cannot go on a log ${axis} axis yet; use a linear one`,
      );
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      const cells = this.#cellsOf(s);
      if (!cells || s.length === 0) continue;
      const edges = axis === "x" ? cells.xEdges : cells.yEdges;
      lo = Math.min(lo, edges[0]!);
      hi = Math.max(hi, edges[edges.length - 1]!);
    }
    return lo <= hi ? ([lo, hi] as const) : undefined;
  }

  geometry(series: readonly Series[], frame: Frame): RasterGeometry[] {
    const s = series[0];
    // Series are kept between scenes: drawn so, no selection is drawn with it.
    if (s) this.#selected.delete(s);
    const cells = s && this.#cellsOf(s);
    if (!s || !cells || s.length === 0 || frame.hidden.has(s.key)) return [];
    const colors = this.#colorScale(cells, frame.theme);
    if (!colors) return [];
    return this.#image(s, frame, cells, colors, s.values, s.key);
  }

  /**
   * The image of the cells of `s`, each colored by its value in `values`
   * (missing values leave a cell out), keyed `key`, as its buffers are.
   */
  #image(
    s: Series,
    frame: Frame,
    cells: Cells,
    colors: SequentialScale,
    values: NumericArray,
    key: string,
  ): RasterGeometry[] {
    const { x, y, plot } = frame;
    if (x.breaks)
      throw new Error("histogram x: 2D histograms cannot leave out time breaks yet; drop x.breaks");
    const inputs = [
      values,
      colors.domain[0],
      colors.domain[1],
      frame.theme,
      ...x.domain,
      ...x.range,
      ...y.domain,
      ...y.range,
      plot.x,
      plot.y,
      plot.width,
      plot.height,
      frame.rasterRatio,
    ];
    // An unchanged frame draws the image last painted into the series'
    // buffer again, without placing a cell.
    let pixels = frame.bytes(key, "raster", 0);
    const last = painted.get(pixels.buffer);
    let image =
      last && last.inputs.length === inputs.length && last.inputs.every((v, i) => v === inputs[i])
        ? last.image
        : undefined;
    if (!image) {
      const buffer = (stage: string, length: number) => frame.doubles(key, stage, length);
      const nx = cells.xEdges.length - 1;
      const ny = cells.yEdges.length - 1;
      const axes = rasterAxes(
        { scale: x, cells: cells.xCells, places: undefined, count: nx },
        { scale: y, cells: cells.yCells, places: undefined, count: ny },
        plot,
        frame.rasterRatio,
        buffer,
      );
      if (!axes) return [];
      const [across, down] = axes;
      const count = across.size * down.size;
      pixels = frame.bytes(key, "raster", count * 4);
      const source = {
        x: cells.columns,
        y: cells.rows,
        values,
        rows: undefined,
        length: s.length,
        // The cells' own index, or of those `values` keeps.
        index: () =>
          values === s.values
            ? cells.index
            : new CellIndex(
                cells.columns,
                cells.rows,
                values,
                cells.xEdges.length - 1,
                cells.yEdges.length - 1,
              ),
      };
      paint(source, across, down, colors, "mean", pixels, (stage) => buffer(stage, count));
      image = [across.from, across.to, across.size, down.from, down.to, down.size];
      painted.set(pixels.buffer, { inputs, image });
    }
    const [x0, x1, columns, y0, y1, rows] = image as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return [
      {
        kind: "raster",
        draw: rasterDrawing,
        key,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        columns,
        rows,
        pixels: pixels.subarray(0, columns * rows * 4),
      },
    ];
  }

  /** The cell under a pixel: in the bins its x and y fall in, if it holds something. */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const s = series[0];
    if (!s || frame.hidden.has(s.key)) return undefined;
    const position = this.binAt(s, px, py, frame);
    return position < 0 ? undefined : { series: s, position, distance: 0 };
  }

  /** The position of the cell of `s` drawn under a pixel, or -1. Clicks read it. */
  binAt(s: Series, px: number, py: number, frame: Pick<Frame, "x" | "y">): number {
    const cells = this.#cellsOf(s);
    if (!cells) return -1;
    const c = cells.xCells.find(frame.x.invert(px));
    const r = cells.yCells.find(frame.y.invert(py));
    return c < 0 || r < 0 ? -1 : cells.index.find(c, r);
  }

  /** A cell's center, where its marker sits and lassos find it. */
  pointAnchor(s: Series, row: number, frame: Frame): readonly [number, number] | undefined {
    const px = frame.x.map(s.x[row]!);
    const py = frame.y.map(s.y[row]!);
    return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : undefined;
  }

  /** The color a cell is drawn in. */
  pointColor(s: Series, row: number, theme: Theme): string {
    return this.#colorScale(this.#cellsOf(s), theme)?.color(s.values[row]!) ?? s.color;
  }

  /** A cell's bins, by field. */
  pointLabel(s: Series, row: number, format: AxisFormat): string {
    const cells = this.#cellsOf(s)!;
    const [c, r] = [cells.columns[row]!, cells.rows[row]!];
    const { x, y } = this.spec;
    return (
      `${x} ${format.x(cells.xEdges[c]!)} – ${format.x(cells.xEdges[c + 1]!)}, ` +
      `${y} ${format.y(cells.yEdges[r]!)} – ${format.y(cells.yEdges[r + 1]!)}`
    );
  }

  /** What a cell measures; while a selection is drawn, how much of it is selected. */
  pointText(s: Series, row: number, format: AxisFormat): string {
    const text = format.value(s.values[row]!);
    const picked = this.#selected.get(s);
    if (!picked) return text;
    const f = format.value;
    const all = picked.all[row]!;
    const weight = this.spec.weight;
    return `${text}; ${f(picked.rows[row]!)} of ${f(all)} ${all === 1 ? "row" : "rows"} selected${weight === undefined ? "" : `, ${weight} ${f(picked.weights[row]!)} of ${f(this.#cellsOf(s)!.counts[row]!)}`}`;
  }

  stepCell(
    s: Series,
    position: number,
    columns: number,
    rows: number,
    frame: { x: PositionScale; y: PositionScale },
  ): number | undefined {
    const cells = this.#cellsOf(s);
    return cells && stepCell(cells.index, position, columns, rows, frame);
  }

  /** Whether a row is counted in the cell at `position`: its x and y in the cell's bins, and a usable weight. */
  summarized(s: Series, position: number): (row: number) => boolean {
    const cells = this.#cellsOf(s)!;
    const [c, r] = [cells.columns[position]!, cells.rows[position]!];
    const xs = this.#numbers("x");
    const ys = this.#numbers("y");
    const weights =
      this.spec.weight === undefined ? undefined : this.table.numbers(this.spec.weight as never);
    const inBin = (edges: Float64Array, bin: number, value: number) =>
      value >= edges[bin]! &&
      (bin === edges.length - 2 ? value <= edges[bin + 1]! : value < edges[bin + 1]!);
    return (row) => {
      const weight = weights ? weights[row]! : 1;
      return (
        weight >= 0 &&
        weight < Infinity &&
        inBin(cells.xEdges, c, xs[row]!) &&
        inBin(cells.yEdges, r, ys[row]!)
      );
    };
  }

  /**
   * How many values the cells counted, in how many bins over what ranges,
   * and the fullest cell, over every panel.
   */
  summarize(parts: readonly Series[], name: string, { format, locale }: SummaryContext): string {
    const f = (value: number) => formatNumber(value, locale);
    let [values, outside, cellCount] = [0, 0, 0];
    let grid: { nx: number; ny: number; x: [number, number]; y: [number, number] } | undefined;
    let shared = true;
    let fullest: { cells: Cells; k: number; count: number } | undefined;
    for (const part of parts) {
      const cells = this.#cellsOf(part);
      if (!cells) continue;
      values += cells.inBins;
      outside += cells.size - cells.inBins;
      cellCount += part.length;
      const { xEdges, yEdges } = cells;
      if (xEdges.length < 2 || yEdges.length < 2) continue;
      const own = {
        nx: xEdges.length - 1,
        ny: yEdges.length - 1,
        x: [xEdges[0]!, xEdges[xEdges.length - 1]!] as [number, number],
        y: [yEdges[0]!, yEdges[yEdges.length - 1]!] as [number, number],
      };
      if (grid && (grid.nx !== own.nx || grid.ny !== own.ny || grid.x[0] !== own.x[0]))
        shared = false;
      grid ??= own;
      for (let k = 0; k < part.length; k++)
        if (!fullest || cells.counts[k]! > fullest.count)
          fullest = { cells, k, count: cells.counts[k]! };
    }
    const weight = this.spec.weight;
    const left =
      outside > 0
        ? `; ${f(outside)} missing ${this.spec.x} or ${this.spec.y}${weight === undefined ? "" : ` or ${weight}`}, or outside the bins`
        : "";
    if (values === 0 || !fullest || !grid) return `${name}: no values in bins${left}`;
    const { cells, k, count } = fullest;
    const [c, r] = [cells.columns[k]!, cells.rows[k]!];
    const where = shared
      ? `${grid.nx} by ${grid.ny} bins of ${this.spec.x} from ${format.x(grid.x[0])} to ${format.x(grid.x[1])} and ${this.spec.y} from ${format.y(grid.y[0])} to ${format.y(grid.y[1])}`
      : "the bins of each panel";
    return (
      `${name}: ${f(values)} ${values === 1 ? "value" : "values"} in ${f(cellCount)} ` +
      `${cellCount === 1 ? "cell" : "cells"} of ${where}; the fullest, ${this.spec.x} ` +
      `${format.x(cells.xEdges[c]!)} – ${format.x(cells.xEdges[c + 1]!)} and ${this.spec.y} ` +
      `${format.y(cells.yEdges[r]!)} – ${format.y(cells.yEdges[r + 1]!)}, holds ` +
      `${weight === undefined ? "" : `${weight} `}${f(count)}${left}`
    );
  }
}

/** Sturges' rule for `count` values, at most 50 bins. */
function sturges(count: number): number {
  return Math.min(50, Math.ceil(Math.log2(Math.max(1, count))) + 1);
}

/** Calendar boundaries in `zone`, about `count` bins covering [min, max]. */
function calendarEdges(min: number, max: number, count: number, zone: TimeZone): number[] {
  const [lo, hi] = niceTimeDomain(min, max, count, zone);
  const edges = timeTicks(lo, hi, chooseInterval(hi - lo, count), zone);
  if (edges[0] !== lo) edges.unshift(lo);
  if (edges[edges.length - 1] !== hi) edges.push(hi);
  return edges;
}

/** `x` and `y` ranges widened by the rows (every row without them) where both are values. */
function jointRanges(
  xs: NumericArray,
  ys: NumericArray,
  rows: Uint32Array | undefined,
  x: BinRange,
  y: BinRange,
): [BinRange, BinRange] {
  let [xMin, xMax, yMin, yMax] = [x.min, x.max, y.min, y.max];
  let pairs = 0;
  const length = rows ? rows.length : xs.length;
  for (let k = 0; k < length; k++) {
    const row = rows ? rows[k]! : k;
    const a = xs[row]!;
    const b = ys[row]!;
    if (!(Number.isFinite(a) && Number.isFinite(b))) continue;
    pairs++;
    if (a < xMin) xMin = a;
    if (a > xMax) xMax = a;
    if (b < yMin) yMin = b;
    if (b > yMax) yMax = b;
  }
  return [
    { min: xMin, max: xMax, finite: x.finite + pairs },
    { min: yMin, max: yMax, finite: y.finite + pairs },
  ];
}

/** Bins along an axis as cells: from each edge to the next, on a lattice when evenly spaced. */
function binCells(edges: Float64Array, centers: Float64Array): AxisCells {
  const n = centers.length;
  const lower = edges.subarray(0, n);
  const upper = edges.subarray(1, n + 1);
  const step = evenStep(edges);
  const lattice =
    step > 0 ? { start: edges[0]!, width: step, slots: undefined, size: n } : undefined;
  return new AxisCells(centers, lower, upper, new Int32Array(0), lattice);
}
