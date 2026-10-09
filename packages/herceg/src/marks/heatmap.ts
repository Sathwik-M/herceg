import type { NumericArray } from "../data/column.ts";
import {
  type NumericField,
  type PositionField,
  type Schema,
  scanExtent,
  type Table,
} from "../data/table.ts";
import { rasterDrawing } from "../draw/raster.ts";
import { CellIndex } from "../lod/cell-index.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { RasterGeometry } from "../scene/scene.ts";
import type { Frozen, HeatmapSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  type ColorRamp,
  type Frame,
  fieldBands,
  frozen,
  type Hit,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import { type Series, TableCache } from "./series.ts";

export interface HeatmapOptions<S extends Schema> {
  /**
   * Column field. Category fields give one column per category; number and
   * time fields give one column per distinct value, in ascending order.
   */
  x: PositionField<S>;
  /** Row field, like `x`. Categories run top to bottom, numbers and times bottom to top. */
  y: PositionField<S>;
  /** Cell value, mapped to color. */
  value: NumericField<S>;
  /**
   * Color ramp from low to high values, such as an imported scheme
   * (`viridis`, `rdbu`, ...). Defaults to the theme's sequential ramp, or its
   * diverging one with a midpoint.
   */
  colors?: readonly string[];
  /** The values at the ends of the ramp; the values' extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /**
   * How a pixel showing several cells colors them, for grids with more
   * columns or rows than the plot has device pixels: by the "mean" (the
   * default), "max", or "min" of their values.
   */
  reduce?: "mean" | "max" | "min";
  label?: string;
  /** With the chart's `facet`, draw all cells in every panel; heatmaps cannot be split yet. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

const ANY: readonly ["number", "time", "category"] = ["number", "time", "category"];
const REDUCERS: readonly string[] = ["mean", "max", "min"];

/** What a raster's pixels were last painted from; unchanged inputs skip repainting. */
interface Painted {
  /** The mark that painted them: charts reuse a series' buffer for the next mark in its place. */
  mark: HeatmapMark;
  version: number;
  x: NumericArray;
  y: NumericArray;
  theme: Theme;
  columns: number;
  rows: number;
  across: number;
  down: number;
  /** Band 0 is the bottom row (bands of numbers), not the top. */
  upward: boolean;
}

export class HeatmapMark implements Mark<Frozen<HeatmapSpec>> {
  readonly spec: Frozen<HeatmapSpec>;
  readonly table: Table<Schema>;
  readonly tooltip = "cell";
  readonly bandPadding = 0;
  /** Cell lookups for tooltips, keyed by the column-index array they were built from. */
  readonly #cells = new WeakMap<NumericArray, CellIndex>();
  readonly #extent = new TableCache<readonly [number, number] | null>();

  constructor(input: HeatmapSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    requireField(table, spec.x, ANY, "heatmap x");
    requireField(table, spec.y, ANY, "heatmap y");
    requireField(table, spec.value, NUMERIC, "heatmap value");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "heatmap colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Heatmap");
    if (spec.reduce !== undefined && !REDUCERS.includes(spec.reduce)) {
      throw new TypeError(
        `Heatmap reduce must be "mean", "max", or "min", not ${JSON.stringify(spec.reduce)}`,
      );
    }
  }

  /** Both axes are banded, whatever the field kind. */
  channelKind(): "category" {
    return "category";
  }

  bands(axis: "x" | "y", context: BandContext): BandList {
    return fieldBands(this.table, axis === "x" ? this.spec.x : this.spec.y, context);
  }

  series(
    key: MarkKey,
    _palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { spec, table } = this;
    const values = table.numbers(spec.value as never);
    const ramp = spec.colors ?? context.theme.sequential;
    return [
      {
        key: seriesKey(key, "cells"),
        label: spec.label ?? spec.value,
        color: ramp[ramp.length - 1]!,
        x: bandIndices(table, spec.x, bands.x?.keys ?? [], context),
        y: bandIndices(table, spec.y, bands.y?.keys ?? [], context),
        y0: undefined,
        values,
        range: false,
        rows: undefined,
        length: table.length,
        sorted: false,
      },
    ];
  }

  xExtent() {
    return undefined;
  }

  yExtent() {
    return undefined;
  }

  stepCell(
    series: Series,
    position: number,
    columns: number,
    rows: number,
    frame: { x: PositionScale; y: PositionScale },
  ): number | undefined {
    const index = this.#cellIndex(
      series,
      frame.x.categories?.length ?? 0,
      frame.y.categories?.length ?? 0,
    );
    // Rows of categories run down the plot, rows of numbers up it.
    const up = frame.y.map(1) < frame.y.map(0) ? 1 : -1;
    // The best cell so far, by a rank compared key by key (lowest first).
    let best = -1;
    let [ra, rb, rc] = [Number.POSITIVE_INFINITY, 0, 0];
    const consider = (row: number, a: number, b = 0, c = 0) => {
      if (a < ra || (a === ra && (b < rb || (b === rb && c < rc)))) {
        best = row;
        [ra, rb, rc] = [a, b, c];
      }
    };
    if (position < 0) {
      // Entering the grid: its top left cell.
      index.forEachCell((c, r, row) => consider(row, -r * up, c));
      return best < 0 ? undefined : best;
    }
    const along = columns !== 0;
    const steps = Math.abs(along ? columns : rows);
    const direction = Math.sign(along ? columns : rows * up);
    // Heatmaps repeat in facet panels rather than split, so positions are table rows.
    const [column, line] = [series.x[position]!, series.y[position]!];
    index.forEachCell((c, r, row) => {
      const offset = (along ? c - column : r - line) * direction;
      if (offset <= 0) return;
      const across = Math.abs(along ? r - line : c - column);
      // The next cell in the same row (or column), else the nearest ahead in
      // another, so no cell is out of reach; the furthest for jumps.
      if (steps === Number.POSITIVE_INFINITY) {
        if (across === 0) consider(row, -offset);
      } else consider(row, across === 0 ? 0 : 1, offset, across);
    });
    return best < 0 ? undefined : best;
  }

  /** How many cells are drawn in how many columns and rows, and the lowest and highest. */
  summarize(parts: readonly Series[], name: string, { format }: SummaryContext): string {
    const s = parts[0];
    if (!s) return `${name}: no values`;
    let columns = 0;
    let rows = 0;
    for (let row = 0; row < s.length; row++) {
      columns = Math.max(columns, s.x[row]! + 1);
      rows = Math.max(rows, s.y[row]! + 1);
    }
    const used = new Uint8Array(columns);
    let [cells, columnCount, rowCount, lastRow] = [0, 0, 0, -1];
    let low = -1;
    let high = -1;
    this.#cellIndex(s, columns, rows).forEachCell((c, r, row) => {
      cells++;
      if (!used[c]) [used[c], columnCount] = [1, columnCount + 1];
      if (r !== lastRow) [lastRow, rowCount] = [r, rowCount + 1];
      const value = s.values[row]!;
      if (low < 0 || value < s.values[low]!) low = row;
      if (high < 0 || value > s.values[high]!) high = row;
    });
    if (cells === 0) return `${name}: no values`;
    const at = (row: number) =>
      `${format.value(s.values[row]!)} at ${format.x(s.x[row]!)}, ${format.y(s.y[row]!)}`;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return (
      `${name}: ${plural(cells, "cell")} in ${plural(columnCount, "column")} and ` +
      `${plural(rowCount, "row")}, lowest ${at(low)}, highest ${at(high)}`
    );
  }

  /** Cells are colored by value, so the legend shows the ramp instead of series. */
  legendEntry(): false {
    return false;
  }

  colorRamp(series: readonly Series[], theme: Theme): ColorRamp | undefined {
    const scale = this.#colorScale(theme);
    if (!scale || series.length === 0) return undefined;
    const title = this.spec.label ?? this.spec.value;
    return { stops: scale.legendStops(), domain: scale.domain, title, midpoint: scale.midpoint };
  }

  /** The scale coloring cells: over `colorDomain` or the values' extent. */
  #colorScale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    const domain = spec.colorDomain ?? this.#valueExtent();
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  #valueExtent(): readonly [number, number] | undefined {
    const values = this.table.numbers(this.spec.value as never);
    const extent = this.#extent.get(this.table, () => scanExtent(values, 0, values.length) ?? null);
    return extent ?? undefined;
  }

  geometry(series: readonly Series[], frame: Frame): RasterGeometry[] {
    const s = series[0];
    const colors = this.#colorScale(frame.theme);
    if (!s || frame.hidden.has(s.key) || !colors) return [];
    const columns = frame.x.categories?.length ?? 0;
    const rows = frame.y.categories?.length ?? 0;
    if (columns === 0 || rows === 0) return [];
    const left = frame.x.start!(0);
    const right = frame.x.start!(columns - 1) + frame.x.bandwidth!;
    const first = frame.y.start!(0);
    const last = frame.y.start!(rows - 1) + frame.y.bandwidth!;
    const width = Math.abs(right - left);
    const height = Math.abs(last - first);
    // At most one pixel per device pixel: past that, each pixel shows a
    // block of cells, so the raster's size follows the plot, not the grid.
    // Rounding down keeps every pixel at least a device pixel wide, so
    // drawing it never skips one (and with it a block's only hot cell); a
    // millionth of a pixel of slack keeps float error in the band edges
    // from costing a pixel when the grid fits exactly.
    const pixelsAcross = Math.floor(width * frame.rasterRatio + 1e-6);
    const pixelsDown = Math.floor(height * frame.rasterRatio + 1e-6);
    const across = Math.min(columns, Math.max(1, pixelsAcross));
    const down = Math.min(rows, Math.max(1, pixelsDown));
    const length = across * down * 4;
    const pixels = frame.bytes(s.key, "raster", length);
    const inputs: Painted = {
      mark: this,
      version: this.table.version,
      x: s.x,
      y: s.y,
      theme: frame.theme,
      columns,
      rows,
      across,
      down,
      // Raster row 0 is the top. Bands of numbers rise from the bottom, so
      // their band 0 is the last raster row; category bands start at the top.
      upward: frame.y.bandwidth! < 0,
    };
    if (!samePainting(painted.get(pixels.buffer), inputs)) {
      if (across === columns && down === rows) paintCells(s, colors, pixels, inputs);
      else this.#paintBlocks(s, colors, pixels, inputs, frame);
      painted.set(pixels.buffer, inputs);
    }
    return [
      {
        kind: "raster",
        draw: rasterDrawing,
        key: s.key,
        x: Math.min(left, right),
        y: Math.min(first, last),
        width,
        height,
        columns: across,
        rows: down,
        pixels: pixels.subarray(0, length),
      },
    ];
  }

  /**
   * Paints a raster smaller than the grid: each cell falls in the pixel its
   * start edge lies in, and each pixel is colored by the mean (or the
   * greatest or least) of its rows' finite values, accumulated in one pass
   * over the rows (and a second for sums that overflow). Pixels without
   * values stay transparent.
   */
  #paintBlocks(
    s: Series,
    colors: SequentialScale,
    pixels: Uint8ClampedArray,
    { columns, rows, across, down, upward }: Painted,
    frame: Frame,
  ): void {
    const count = across * down;
    const reduce = this.spec.reduce ?? "mean";
    // Sums for means, otherwise the greatest or least value so far (NaN for none yet).
    const totals = frame.doubles(s.key, "blocks", count);
    totals.fill(reduce === "mean" ? 0 : Number.NaN, 0, count);
    pixels.fill(0, 0, count * 4);
    // Until it is colored, each pixel's four bytes count its block's values.
    const counts = new Uint32Array(pixels.buffer, pixels.byteOffset, count);
    const { x, y, values } = s;
    const pixelOf = (c: number, r: number) =>
      Math.floor(((upward ? rows - 1 - r : r) * down) / rows) * across +
      Math.floor((c * across) / columns);
    for (let row = 0; row < s.length; row++) {
      const c = x[row]!;
      const r = y[row]!;
      const value = values[row]!;
      if (c < 0 || r < 0 || !Number.isFinite(value)) continue;
      const at = pixelOf(c, r);
      if (reduce === "mean") {
        totals[at]! += value;
        counts[at]!++;
      } else if (reduce === "max" ? !(totals[at]! >= value) : !(totals[at]! <= value)) {
        totals[at] = value;
      }
    }
    if (reduce !== "mean") {
      for (let i = 0; i < count; i++) {
        if (!Number.isNaN(totals[i]!)) colors.write(totals[i]!, pixels, i * 4);
      }
      return;
    }
    // Sums of values near the largest doubles can overflow. Those blocks are
    // summed again with every value divided by 2^64, which leaves room for
    // 2^32 rows; only values under about 1e-288 lose precision that way.
    const overflowed = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (counts[i]! > 0 && !Number.isFinite(totals[i]!)) overflowed.add(i);
    }
    if (overflowed.size > 0) {
      for (const i of overflowed) totals[i] = 0;
      for (let row = 0; row < s.length; row++) {
        const c = x[row]!;
        const r = y[row]!;
        const value = values[row]!;
        if (c < 0 || r < 0 || !Number.isFinite(value)) continue;
        const at = pixelOf(c, r);
        if (overflowed.has(at)) totals[at]! += value / 2 ** 64;
      }
    }
    for (let i = 0; i < count; i++) {
      // Read the count before the color takes its bytes; empty blocks stay transparent.
      const n = counts[i]!;
      if (n === 0) continue;
      const mean =
        overflowed.size > 0 && overflowed.has(i) ? (totals[i]! / n) * 2 ** 64 : totals[i]! / n;
      colors.write(mean, pixels, i * 4);
    }
  }

  /** The cell under the pointer, found in an index of the rows by cell. */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const s = series[0];
    if (!s || frame.hidden.has(s.key)) return undefined;
    const columns = frame.x.categories?.length ?? 0;
    const rows = frame.y.categories?.length ?? 0;
    // The band under the pointer, whether or not its cell has a pixel of its own.
    const c = Math.round(frame.x.invert(px));
    const r = Math.round(frame.y.invert(py));
    if (c < 0 || r < 0 || c >= columns || r >= rows) return undefined;
    const position = this.#cellIndex(s, columns, rows).find(c, r);
    return position < 0 ? undefined : { series: s, position, distance: 0 };
  }

  /** The index of `s`'s rows by cell, for a grid of `columns` x `rows`. */
  #cellIndex(s: Series, columns: number, rows: number): CellIndex {
    // Index arrays are rebuilt whenever the table or the band order changes,
    // so their identity tells whether an index is current.
    // An index of a larger grid holds every cell of a smaller one.
    const cached = this.#cells.get(s.x);
    if (cached && cached.y === s.y && cached.columns >= columns && cached.rows >= rows) {
      return cached;
    }
    const index = new CellIndex(s.x, s.y, s.values, columns, rows);
    this.#cells.set(s.x, index);
    return index;
  }
}

/** What each raster buffer holds, keyed by the buffer, whichever heatmap painted it. */
const painted = new WeakMap<ArrayBuffer, Painted>();

function samePainting(a: Painted | undefined, b: Painted): boolean {
  return (
    a !== undefined &&
    a.mark === b.mark &&
    a.version === b.version &&
    a.x === b.x &&
    a.y === b.y &&
    a.theme === b.theme &&
    a.columns === b.columns &&
    a.rows === b.rows &&
    a.across === b.across &&
    a.down === b.down &&
    a.upward === b.upward
  );
}

/**
 * One pixel per cell. Missing values leave their cell transparent rather
 * than erasing an earlier value for the same cell; the cell index agrees.
 */
function paintCells(
  s: Series,
  colors: SequentialScale,
  pixels: Uint8ClampedArray,
  { columns, rows, upward }: Painted,
): void {
  pixels.fill(0, 0, columns * rows * 4);
  for (let row = 0; row < s.length; row++) {
    const c = s.x[row]!;
    const r = s.y[row]!;
    const value = s.values[row]!;
    if (c < 0 || r < 0 || !Number.isFinite(value)) continue;
    colors.write(value, pixels, ((upward ? rows - 1 - r : r) * columns + c) * 4);
  }
}

/**
 * A grid of colored cells: heatmaps and matrices.
 *
 * ```ts
 * heatmap(load, { x: "hour", y: "host", value: "cpu" })
 * ```
 */
export function heatmap<S extends Schema>(
  table: Table<S>,
  options: HeatmapOptions<S>,
): HeatmapMark {
  const spec: HeatmapSpec = {
    type: "heatmap",
    x: options.x,
    y: options.y,
    value: options.value,
    ...definedFields(options, ["label", "id", "facet", "panel", "colorMidpoint", "reduce"]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [...options.colorDomain];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HeatmapMark(spec, table as unknown as Table);
}
