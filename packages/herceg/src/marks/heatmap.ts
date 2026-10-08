import type { NumericArray } from "../data/column.ts";
import {
  type FieldName,
  type NumericField,
  type Schema,
  scanExtent,
  type Table,
} from "../data/table.ts";
import { rasterDrawing } from "../draw/raster.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { RasterGeometry } from "../scene/scene.ts";
import type { HeatmapSpec } from "../spec/spec.ts";
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
  type Hit,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  seriesKey,
} from "./mark.ts";
import { type Series, TableCache } from "./series.ts";

export interface HeatmapOptions<S extends Schema> {
  /**
   * Column field. Category fields give one column per category; number and
   * time fields give one column per distinct value, in ascending order.
   */
  x: FieldName<S>;
  /** Row field, like `x`. Categories run top to bottom, numbers and times bottom to top. */
  y: FieldName<S>;
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
  label?: string;
  /** With the chart's `facet`, draw all cells in every panel; heatmaps cannot be split yet. */
  facet?: "repeat";
  id?: string;
}

const ANY: readonly ["number", "time", "category"] = ["number", "time", "category"];

/**
 * Most cells a heatmap draws: 16 MB of pixels plus 16 MB of cell lookup.
 * Larger grids, often sparse data with many distinct values, need binning.
 */
export const MAX_CELLS = 4_194_304;

interface CellLookup {
  x: NumericArray;
  y: NumericArray;
  columns: number;
  rows: number;
  rowOf: Int32Array;
}

export class HeatmapMark implements Mark<HeatmapSpec> {
  readonly spec: HeatmapSpec;
  readonly table: Table<Schema>;
  readonly tooltip = "cell";
  readonly bandPadding = 0;
  /** Cell-to-row lookups, keyed by the column-index array they were built from. */
  readonly #cells = new WeakMap<NumericArray, CellLookup>();
  readonly #extent = new TableCache<readonly [number, number] | null>();

  constructor(spec: HeatmapSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    requireField(table, spec.x, ANY, "heatmap x");
    requireField(table, spec.y, ANY, "heatmap y");
    requireField(table, spec.value, NUMERIC, "heatmap value");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "heatmap colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Heatmap");
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
    checkGrid(columns, rows);
    const pixels = frame.bytes(s.key, "raster", columns * rows * 4);
    pixels.fill(0);
    // Raster row 0 is the top. Bands of numbers rise from the bottom, so
    // their band 0 is the last raster row; category bands start at the top.
    const upward = frame.y.bandwidth! < 0;
    // Missing values leave their cell transparent rather than erasing an
    // earlier value for the same cell; the cell lookup agrees.
    for (let row = 0; row < s.length; row++) {
      const c = s.x[row]!;
      const r = s.y[row]!;
      const value = s.values[row]!;
      if (c < 0 || r < 0 || !Number.isFinite(value)) continue;
      colors.write(value, pixels, ((upward ? rows - 1 - r : r) * columns + c) * 4);
    }
    const left = frame.x.start!(0);
    const right = frame.x.start!(columns - 1) + frame.x.bandwidth!;
    const first = frame.y.start!(0);
    const last = frame.y.start!(rows - 1) + frame.y.bandwidth!;
    return [
      {
        kind: "raster",
        draw: rasterDrawing,
        key: s.key,
        x: Math.min(left, right),
        y: Math.min(first, last),
        width: Math.abs(right - left),
        height: Math.abs(last - first),
        columns,
        rows,
        pixels: pixels.subarray(0, columns * rows * 4),
      },
    ];
  }

  /** The cell under the pointer, through a cell-to-row lookup table. */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const s = series[0];
    if (!s || frame.hidden.has(s.key)) return undefined;
    const columns = frame.x.categories?.length ?? 0;
    const rows = frame.y.categories?.length ?? 0;
    const c = Math.round(frame.x.invert(px));
    const r = Math.round(frame.y.invert(py));
    if (c < 0 || r < 0 || c >= columns || r >= rows) return undefined;
    const position = this.#cellRows(s, columns, rows)[r * columns + c]!;
    return position < 0 ? undefined : { series: s, position, distance: 0 };
  }

  #cellRows(s: Series, columns: number, rows: number): Int32Array {
    const { x, y, values } = s;
    // Index arrays are rebuilt whenever the table or the band order changes,
    // so their identity tells whether a lookup is current.
    const cached = this.#cells.get(x);
    if (cached && cached.y === y && cached.columns === columns && cached.rows === rows) {
      return cached.rowOf;
    }
    checkGrid(columns, rows);
    const rowOf = new Int32Array(columns * rows).fill(-1);
    for (let row = 0; row < x.length; row++) {
      const c = x[row]!;
      const r = y[row]!;
      if (c < 0 || r < 0 || c >= columns || r >= rows || !Number.isFinite(values[row]!)) continue;
      rowOf[r * columns + c] = row;
    }
    this.#cells.set(x, { x, y, columns, rows, rowOf });
    return rowOf;
  }
}

function checkGrid(columns: number, rows: number): void {
  if (columns * rows > MAX_CELLS) {
    throw new RangeError(
      `A heatmap of ${columns} × ${rows} cells exceeds the limit of ${MAX_CELLS} cells; ` +
        "bin x or y into fewer distinct values",
    );
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
    ...definedFields(options, ["label", "id", "facet", "colorMidpoint"]),
  };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [...options.colorDomain];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HeatmapMark(spec, table as unknown as Table);
}
