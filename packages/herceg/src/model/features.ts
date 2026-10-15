// What the model asks of the feature compiler, the code for what only some
// charts ask of their marks: channels beyond constants (fields through
// categorical scales, conditions), styles by value, markers, and which
// observations lines and areas connect (`continuity`, `where`). It loads
// with the charts that use it: a live chart imports it before drawing such
// a configuration, and static output brings it with it.

import type { Table } from "../data/table.ts";
import type { Breaks } from "../lod/m4.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { Frame, GlyphKey, Mark, Palette } from "../marks/mark.ts";
import type { Series } from "../marks/series.ts";
import type { TraceFrame } from "../marks/trace.ts";
import type { Geometry } from "../scene/scene.ts";
import type { FormatSpec, SwatchSpec } from "../spec/guides.ts";
import type { Dash } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { GuideKit } from "./guides.ts";
import type { ChartConfig } from "./model.ts";

/**
 * What the feature compiler uses of the chart's own code: the guide
 * compiler's kit (`GUIDE_KIT`), handed to it for the same reason, and how
 * to tell a color from a field's name: the browser's `CSS.supports` on a
 * page, the CSS color reader in static output (a chunk of its own would
 * hold the reader where both the chart and the compiler imported it).
 */
export type FeatureKit = GuideKit & { isColor(value: string): boolean };

/**
 * A series' swatch: one a spec could give, a box whose fill has an opacity
 * of its own under the outline's (`opacity` fades both), or a marker's
 * symbol as SVG path data about its center, `size` pixels across (the
 * guide compiler draws symbols without their shapes' code).
 */
export type SeriesSwatch =
  | Exclude<SwatchSpec, { type: "composite" | "rect" }>
  | (Extract<SwatchSpec, { type: "rect" }> & { fillOpacity?: number })
  | { type: "glyph"; d: string; size: number; fill: string; stroke?: string; opacity?: number }
  | { type: "composite"; parts: readonly SeriesSwatch[] };

/** Checks and compiles a configuration's mark features (marks/features/compile.ts). */
export interface FeatureCompiler {
  /**
   * Throws for what the configuration's marks ask that it refuses, naming
   * where. `previous`, the chart's compilation before, keeps its scales'
   * values in their places. `identities` says what the marks' series stand
   * for, which colors by value follow.
   */
  compile(
    config: ChartConfig,
    marks: readonly Mark[],
    previous: CompiledFeatures | undefined,
    identities: Identities,
  ): CompiledFeatures;
}

/** What the model resolved of what series stand for (see model/identity.ts). */
export interface Identities {
  /**
   * The prefix of each mark's series' identity keys, as the compiler's
   * `marks`: undefined for marks whose series stand for nothing.
   */
  readonly scopes: readonly (string | undefined)[];
  /** Each of the compiler's `marks`' index in the chart's `marks`, which errors name. */
  readonly positions: readonly number[];
  /** The prefix of the identity keys of `field`'s values in `table`. */
  field(table: Table, field: string): string;
}

/** A configuration's mark features, compiled. */
export interface CompiledFeatures {
  /** What `mark` takes from the features; undefined for a mark that uses none. */
  of(mark: Mark): MarkFeatures | undefined;
  /**
   * Before each scene's series: the categorical scales' values, from every
   * mark's rows, and `slot`, the chart's palette slot of an identity key
   * (for colors by value that no declared scale gives).
   */
  update(theme: Theme, slot: (key: string) => number): void;
  /**
   * The prefixes of identity keys the compiler gives series and rows beyond
   * the core's (see marks/features/identity.ts), whose hidden keys stay.
   */
  readonly scopes: ReadonlySet<string>;
  /**
   * With `scales.color` declared, what layout marks' items (a pie's slices)
   * stand for and their colors: its values, through it, as every mark's.
   */
  readonly items?:
    | { readonly prefix: string; color(value: string): string | undefined }
    | undefined;
}

/** One mark's compiled features. */
export interface MarkFeatures {
  /** The mark's series' colors: by value through its color channel, by series through `style.by`. */
  palette(palette: Palette): Palette;
  /** What a series of the mark draws with, set on it as it is resolved. */
  attach(series: Series): void;
  /** How the mark writes values in `format`, a pattern (`{ number }`, `{ time }`) included. */
  format?(format: FormatSpec, locale: string | undefined, path: string): (value: number) => string;
}

/**
 * What the feature compiler gives a series: how its geometry is drawn
 * (its own paint from `style.by` and series-constant channels, its
 * markers), and how its observations are traced and read where
 * `continuity` or `where` decide which it connects.
 */
export interface SeriesFeatures {
  /** What to draw of `geometry`, the mark's for the series: restyled, and with markers. */
  geometry?(geometry: Geometry, series: Series, frame: Frame): Geometry[];
  /**
   * Traces positions [start, end) of an edge of the series into `path` as
   * `tracePath` does, a run of connected observations at a time, each
   * reduced by `reduce`, with the crossings `where` meets between them.
   */
  trace?(
    series: Series,
    y: Series["y"],
    frame: TraceFrame,
    stage: string,
    path: Polyline,
    start: number,
    end: number,
    reduce: (start: number, end: number) => void,
  ): void;
  /**
   * Traces positions [start, end) of a band's edges `top` and `bottom`
   * into `upper` and `lower`, a run at a time (`reduce` reducing an edge's
   * positions into a polyline), with `where`'s crossings at their ends.
   */
  band?(
    series: Series,
    top: Series["y"],
    bottom: Series["y"],
    frame: TraceFrame,
    upper: Polyline,
    lower: Polyline,
    start: number,
    end: number,
    reduce: (edge: Series["y"], start: number, end: number, out: Polyline) => void,
  ): void;
  /** The extent of the series' drawn observations within [x0, x1], as `yExtent` gives it. */
  extent?(
    series: Series,
    x0: number,
    x1: number,
    y: Series["y"],
    log: boolean,
    index: RangeIndex | undefined,
    curved: boolean,
    breaks: Breaks | undefined,
  ): [number, number] | undefined;
  /**
   * For a series running along y (x holds its values): the extent of
   * `values` it draws, of the rows `where` and `defined` keep and the
   * crossings `where` adds.
   */
  across?(series: Series, values: Series["y"], log: boolean): [number, number] | undefined;
  /** Whether a row is drawn: false where `where` or `defined` leave it out. */
  drawn?(row: number): boolean;
  /** The series' drawn observations, as a series of those rows: what text summaries read. */
  shown?(series: Series): Series;
  /** The series' swatch as it draws, for legends that show marks' looks (`swatches: "mark"`). */
  swatch?: ((theme: Theme) => SeriesSwatch) | undefined;
  /**
   * For marks of rows (bars): the looks rows take, from channels and
   * `style.by` per row, and which each row takes (an index into `paints`).
   */
  rows?: { readonly paints: readonly RowPaint[]; of(row: number): number } | undefined;
  /** For points colored by a category field: each value's color through the chart's color scale. */
  categories?: CategoryColors | undefined;
  /** For bars colored by a field other than the series': a key of its values' colors. */
  key?(): GlyphKey | undefined;
}

/** A category field's values' colors through a color scale, for the table's current version. */
export interface CategoryColors {
  readonly field: string;
  readonly dictionary: readonly string[];
  /** Per row: the field's code, -1 for rows without a value. */
  readonly codes: Int32Array;
  /** Per code: an index into `colors`, or -1 for codes no row holds. */
  readonly tones: Int32Array;
  /** At most 255 colors: points index theirs by bytes. */
  readonly colors: readonly string[];
  /** The codes rows hold in the scale's order: the order a key lists them in. */
  readonly order: readonly number[];
}

/** A row's look, over its mark's paint and its series' color. */
export interface RowPaint {
  readonly fill?: string | undefined;
  readonly stroke?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly dash?: Dash | undefined;
  readonly opacity?: number | undefined;
  readonly fillOpacity?: number | undefined;
  readonly strokeOpacity?: number | undefined;
}

/**
 * Whether a mark's spec sets any of `options`, which need the feature
 * compiler, or a `color` other than a color in CSS syntax that names no
 * field of `table` (which the mark draws itself) or the mark's `series`
 * field (whose series the chart colors by value) unless the browser reads
 * that name as a color too.
 */
export function asksFeatures(
  spec: object,
  options: readonly string[],
  table?: Table,
  series?: string,
): boolean {
  const { color } = spec as { color?: string };
  return (
    options.some((key) => (spec as Record<string, unknown>)[key] !== undefined) ||
    (color !== undefined &&
      (color !== series
        ? !!table?.has(color) || !/^(#|rgb|hsl|var\()/.test(color)
        : // A series field named as a color is (the compiler refuses the name).
          !!globalThis.CSS?.supports("color", color)))
  );
}

/**
 * Whether a configuration uses what only the feature compiler draws:
 * categorical scales, or marks whose options need it (`Mark.featured`).
 * Without it, such a configuration draws without its marks' features, so
 * charts load it first and static output brings it.
 */
export function needsFeatures(config: ChartConfig): boolean {
  return (
    Object.keys(config.scales ?? {}).some((name) => !/^(x|y|yRight)$/.test(name)) ||
    config.marks.some((mark) => (mark as Mark).featured)
  );
}
