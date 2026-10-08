// The portable chart specification.
//
// Everything here is plain JSON: no functions, DOM objects, typed arrays, or
// class instances. The TypeScript API builds these objects, the Python
// package emits them, and serialized charts store them. Field references are
// column names of a table; constant colors use `stroke` / `fill`. Large
// columns can travel as binary buffers next to the JSON (see `BinaryColumnSpec`).

import type { Expression } from "../data/expression.ts";

export type { Expression, Operator } from "../data/expression.ts";

/**
 * The spec format this herceg writes. It reads version 1 too; version 2
 * adds `resolve`, which a version 1 reader would ignore and draw shared axes.
 */
export const SPEC_VERSION = 2;

/** Column name in a table. */
export type Field = string;

export interface ChartSpec {
  /** Spec format version; defaults to the current version. */
  version?: 1 | 2;
  /** Chart title, also its accessible name. */
  title?: string;
  /** Longer description for assistive technology. */
  description?: string;
  /** CSS pixels. In the browser, omitted sizes follow the container. */
  width?: number;
  height?: number;
  /** Tables referenced by marks, by name. */
  data?: Record<string, DataSpec>;
  marks: MarkSpec[];
  x?: AxisSpec;
  y?: AxisSpec;
  /**
   * A second y axis on the right, for marks with `axis: "right"`, with its
   * own scale and domain. Grid lines follow it only when no mark uses the left axis.
   */
  yRight?: AxisSpec;
  /** Small multiples: the chart drawn once per value of a category field. */
  facet?: FacetSpec;
  /** Which facet panels share a y scale; all of them by default. */
  resolve?: ResolveSpec;
  legend?: boolean;
  tooltip?: boolean | TooltipSpec;
  interaction?: InteractionSpec;
  /** Renderer for marks. "auto" picks per mark by data size. */
  renderer?: RendererName;
  theme?: ThemeName | ThemeSpec;
  /** BCP 47 locale for labels; defaults to the runtime locale. */
  locale?: string;
  /** "local" (default), "UTC", or an IANA zone for time axes and labels. */
  timeZone?: string;
}

/**
 * Panels by the values of category fields, in order of first appearance,
 * sharing their x and y scales: one field's values wrapped into rows of
 * panels, or a grid with a row per value of `row` and a column per value of
 * `column` (either may be left out). Every mark over a table splits its rows
 * by the fields unless it has `facet: "repeat"`; marks without a table repeat.
 */
export type FacetSpec = WrappedFacetSpec | GridFacetSpec;

/**
 * How facet panels share a scale: "shared" by all (the default), each its
 * own ("independent"), or shared by the panels of a row or of a column.
 */
export type ScaleResolution = "shared" | "independent" | "rows" | "columns";

/** Scale sharing between facet panels; needs spec version 2. */
export interface ResolveSpec {
  /** A continuous y axis; category axes are always shared. */
  y?: ScaleResolution;
}

export interface WrappedFacetSpec {
  field: Field;
  /** Panels per row; by default about as many columns as rows. */
  columns?: number;
}

export interface GridFacetSpec {
  row?: Field;
  column?: Field;
}

export type RendererName = "auto" | "svg" | "canvas";
/**
 * A built-in theme. "auto" is "light" or "dark" as the page prefers, and
 * follows changes; it is "light" where there is no page.
 */
export type ThemeName = "light" | "dark" | "high-contrast" | "high-contrast-dark" | "auto";

/** Columnar data: every column has the same length. */
/** A table: its columns, or rows derived from another table of the spec. */
export type DataSpec = ColumnsSpec | DerivedSpec;

export interface ColumnsSpec {
  columns: Record<Field, ColumnSpec>;
}

/**
 * Rows computed from the table `source` by `transform`, in order. Charts
 * built from the spec keep it current as the source changes.
 */
export interface DerivedSpec {
  source: string;
  transform: TransformSpec[];
}

/**
 * One step of a derivation:
 * - `filter`: keeps rows where the expression is true.
 * - `calculate`: adds (or replaces) the field `as` with the expression's value.
 * - `bin`: replaces a number or time field (or adds `as`) with the start of
 *   its bin: `step` wide from `start`, or about `count` round bins.
 * - `aggregate`: one row per group of `groupby` values (one row without),
 *   with the group's fields and each operation's result.
 * - `rolling`: adds each operation over the trailing `size` rows (within
 *   each `groupby` group), in row order.
 * - `sort`: orders rows by a field, stably.
 */
export type TransformSpec =
  | { filter: Expression }
  | { calculate: Expression; as: Field }
  | { bin: Field; as?: Field; step?: number; count?: number; start?: number }
  | { aggregate: AggregateSpec[]; groupby?: Field[] }
  | { rolling: RollingSpec[]; size: number; groupby?: Field[] }
  | { sort: Field; order?: "ascending" | "descending" };

/** An aggregate: its operation, the number field it reads (none for count), and its name. */
export interface AggregateSpec {
  op: AggregateOp;
  field?: Field;
  as: Field;
}

export type AggregateOp =
  | "count"
  | "sum"
  | "mean"
  | "median"
  | "min"
  | "max"
  | "q1"
  | "q3"
  | "stdev"
  | "variance"
  | "distinct"
  | "first"
  | "last";

export interface RollingSpec {
  op: RollingOp;
  field: Field;
  as: Field;
}

export type RollingOp = "count" | "sum" | "mean" | "min" | "max" | "stdev";

/**
 * Column values: a JSON array (numbers with null for missing values, or
 * strings for categories), a time column, or a binary column.
 */
export type ColumnSpec =
  | (number | null)[]
  | (string | null)[]
  | TimeColumnSpec
  | BinaryColumnSpec
  | CategoryColumnSpec;

/** Epoch milliseconds or ISO 8601 strings; null for missing values. */
export interface TimeColumnSpec {
  type: "time";
  values: (number | string | null)[];
}

/** Element types of binary columns, stored little-endian. */
export type BinaryType =
  | "float64"
  | "float32"
  | "int32"
  | "uint32"
  | "int16"
  | "uint16"
  | "int8"
  | "uint8";

/**
 * Numbers or times (epoch milliseconds) read from a binary buffer delivered
 * with the spec: `buffer` indexes the list of buffers that travels next to
 * the JSON. NaN marks missing values in float columns.
 */
export interface BinaryColumnSpec {
  type: "number" | "time";
  dtype: BinaryType;
  buffer: number;
}

/**
 * Dictionary-encoded categories: int32 codes into `dictionary`, -1 for
 * missing values. `codes` is a buffer index or an inline JSON array.
 */
export interface CategoryColumnSpec {
  type: "category";
  codes: number | number[];
  dictionary: string[];
}

/** Scale and axis options for one position channel. */
export interface AxisSpec {
  /** Inferred from the data when omitted: time fields get "time". */
  type?: "linear" | "log" | "time";
  /** Fixed domain. Time domains are epoch milliseconds. */
  domain?: [number, number];
  /**
   * Extend the domain to round tick values. Default true for y, and for x
   * when it measures horizontal bars.
   */
  nice?: boolean;
  /** Include zero in the domain. Default true for the value axis of areas and bars. */
  zero?: boolean;
  /** Axis title. */
  label?: string;
  /** Grid lines across the plot. Default true for y, and for x when it measures horizontal bars. */
  grid?: boolean;
  /** Approximate number of ticks. */
  ticks?: number;
  /** Intl.NumberFormat options, or Intl.DateTimeFormat options for time. */
  format?: Intl.NumberFormatOptions | Intl.DateTimeFormatOptions;
  /** Draw the axis. Default true. */
  axis?: boolean;
}

export interface TooltipSpec {
  /**
   * "nearest-x": every series at the x position nearest the pointer.
   * "nearest-y": every series at the y position nearest the pointer (the
   * default for horizontal bars).
   * "nearest": the single nearest point.
   */
  mode?: "nearest-x" | "nearest-y" | "nearest";
}

export interface InteractionSpec {
  /**
   * Wheel zoom and drag pan along x (`true` or "x"), y, or both ("xy");
   * double-click resets. Category axes do not zoom.
   */
  zoom?: boolean | ZoomSpec;
  /**
   * Drag to select: a range along x or y, a rectangle ("xy"), or a freehand
   * region ("lasso"), reported as a `select` event; a click clears it. With
   * `zoom` on along the brush's axes, a brush zooms to what it covers
   * instead (Shift-drag pans); lassos only select.
   */
  brush?: BrushSpec;
  /** Charts with the same sync name share their cursor, x range, and selection. */
  sync?: string;
}

export type ZoomSpec = "x" | "y" | "xy";
export type BrushSpec = "x" | "y" | "xy" | "lasso";

/**
 * Changes to a built-in theme. Colors and the font may be CSS variables,
 * `var(--name)`: charts in a page read them where the chart is, and follow
 * changes of the page's theme; elsewhere (static export) a variable needs a
 * fallback, `var(--name, #2a78d6)`.
 */
export interface ThemeSpec {
  /** Base theme to extend. */
  extends?: ThemeName;
  /** Chart background; "transparent" inherits the page. */
  background?: string;
  text?: string;
  /** Axis labels and secondary text. */
  muted?: string;
  grid?: string;
  /** Axis lines and baselines. */
  axis?: string;
  font?: string;
  fontSize?: number;
  /** Size of the chart's title, in pixels. */
  titleSize?: number;
  /** Dash pattern of grid lines, in pixels; empty for solid lines. */
  gridDash?: number[];
  /** Width of lines and area outlines that do not set one. */
  lineWidth?: number;
  /** Radius of the corners at the value end of unstacked bars; 0 for square bars. */
  barRadius?: number;
  tooltipBackground?: string;
  tooltipBorder?: string;
  /** Categorical colors in assignment order. */
  palette?: string[];
  /** Ramp for continuous color (heatmaps), from low to high values. */
  sequential?: string[];
  /** Ramp for colors on either side of a midpoint, low to high. */
  diverging?: string[];
  /** Colors of candlesticks that close at or above, and below, their open. */
  rise?: string;
  fall?: string;
}

export type MarkSpec =
  | LineSpec
  | AreaSpec
  | RuleSpec
  | RegionSpec
  | TextSpec
  | BarSpec
  | PointSpec
  | HeatmapSpec
  | ErrorBarSpec
  | CandlestickSpec
  | HistogramSpec
  | PieSpec
  | BoxPlotSpec
  | ViolinSpec
  | TreemapSpec
  | SunburstSpec
  | GaugeSpec
  | FunnelSpec
  | RadarSpec
  | SankeySpec;

interface MarkBase {
  /** Name of the table in `ChartSpec.data`; defaults to the only table. */
  data?: string;
  /** Stable identity, used for legend state and updates. */
  id?: string;
  /**
   * The y axis the mark's values are on: "left" (the default) or "right",
   * the chart's `yRight` axis. Category y values stay on the left.
   */
  axis?: "left" | "right";
  /**
   * With the chart's `facet`, "repeat" draws all of the mark's rows in every
   * panel instead of splitting them by the facet field.
   */
  facet?: "repeat";
}

/**
 * How a line joins its points: straight, in steps, or "monotone", a smooth
 * curve through every point that never passes a point's value between two
 * points.
 */
export type Curve = "linear" | "step" | "step-before" | "step-after" | "monotone";

/** Lines through (x, y). Several y fields or a series field give several lines. */
export interface LineSpec extends MarkBase {
  type: "line";
  x: Field;
  y: Field | Field[];
  /** Category field that splits rows into one line per value. */
  series?: Field;
  /** Constant color; otherwise colors come from the palette per series. */
  stroke?: string;
  strokeWidth?: number;
  /** SVG-style dash pattern in pixels. */
  dash?: number[];
  curve?: Curve;
  /** Legend and tooltip name for a single-field line without `series`. */
  label?: string;
}

/**
 * Filled areas. With `y`, each series is filled down to zero (or stacked on
 * the previous series with `stack`). With `y1` and `y2`, the band between two
 * fields is filled.
 */
export interface AreaSpec extends MarkBase {
  type: "area";
  x: Field;
  y?: Field | Field[];
  y1?: Field;
  y2?: Field;
  series?: Field;
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  /** Outline the top edge. Default true for unstacked single areas. */
  line?: boolean;
  curve?: Curve;
  label?: string;
}

/**
 * A position of an annotation: a number (times in epoch milliseconds), or a
 * number or time field of the mark's table. An annotation with a field draws
 * one item per row; with numbers only, one item.
 */
export type Position = number | Field;

/** Horizontal (y) or vertical (x) reference lines. */
export interface RuleSpec extends MarkBase {
  type: "rule";
  x?: Position;
  y?: Position;
  stroke?: string;
  strokeWidth?: number;
  dash?: number[];
  /** Text drawn by every rule. */
  label?: string;
  /** Category or number field with each rule's text, for rules from data. */
  text?: Field;
}

/**
 * Shaded regions: from `x1` to `x2` across the plot's height, from `y1` to
 * `y2` across its width, or rectangles with both. Drawn in mark order, so
 * list them before the marks they highlight to draw them underneath.
 */
export interface RegionSpec extends MarkBase {
  type: "region";
  x1?: Position;
  x2?: Position;
  y1?: Position;
  y2?: Position;
  /** Defaults to the theme's muted color. */
  fill?: string;
  /** Default 0.15. */
  fillOpacity?: number;
  /** Text drawn in the top left corner of every region. */
  label?: string;
  /** Category or number field with each region's text. */
  text?: Field;
}

/**
 * Text at (x, y): `label` for one constant text, or `text` for a field with
 * each row's text. Labels are drawn above the data and left out when their
 * point is outside the plot.
 */
export interface TextSpec extends MarkBase {
  type: "text";
  x: Position;
  y: Position;
  label?: string;
  /** Category or number field with each label's text. */
  text?: Field;
  /** Defaults to the theme's text color. */
  fill?: string;
  /** Which end of the text is at the point. Default "middle". */
  anchor?: "start" | "middle" | "end";
  /** Pixel offsets from the point; positive dy moves down. */
  dx?: number;
  dy?: number;
}

/**
 * Bars. Vertical by default: a category `x` gives one band per category, a
 * number or time `x` centers bars on its values, and `y` holds bar lengths.
 * A category `y` makes them horizontal, with lengths in `x`. Several length
 * fields are drawn side by side or stacked.
 */
export interface BarSpec extends MarkBase {
  type: "bar";
  x: Field | Field[];
  y: Field | Field[];
  series?: Field;
  /** Stack series instead of placing them side by side. */
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  label?: string;
  /**
   * Write each bar's value at its end (or, stacked, inside each segment), as
   * a number or with these Intl.NumberFormat options. Labels that do not fit
   * are left out.
   */
  labels?: boolean | Intl.NumberFormatOptions;
}

/**
 * Error bars: vertical intervals at each `x`, from `y1` to `y2` or from
 * `y - yError` to `y + yError`; or horizontal intervals at each `y`, from
 * `x1` to `x2` or `x ± xError`. Positions may be category, number, or time
 * fields; ends, centers, and errors are number or time fields.
 */
export interface ErrorBarSpec extends MarkBase {
  type: "errorbar";
  x?: Field;
  y?: Field;
  x1?: Field;
  x2?: Field;
  y1?: Field;
  y2?: Field;
  /** Symmetric error around the center `y`, for vertical intervals. */
  yError?: Field;
  /** Symmetric error around the center `x`, for horizontal intervals. */
  xError?: Field;
  series?: Field;
  stroke?: string;
  strokeWidth?: number;
  /** Width of the caps at each end in pixels; 0 for none. Default 8. */
  cap?: number;
  label?: string;
}

/**
 * Candles at each `x` from open to close, with wicks from low to high.
 * Candles that close at or above their open are drawn hollow in the rise
 * color, others filled in the fall color, so direction never rests on color alone.
 */
export interface CandlestickSpec extends MarkBase {
  type: "candlestick";
  x: Field;
  open: Field;
  high: Field;
  low: Field;
  close: Field;
  /** Color of candles closing at or above their open; the theme's `rise` by default. */
  rise?: string;
  /** Color of candles closing below their open; the theme's `fall` by default. */
  fall?: string;
  label?: string;
}

/**
 * A pie or donut: a slice per category, its angle in proportion to the sum
 * of `value` over the category's rows (or their count). Slices hidden
 * through the legend leave the rest to fill the circle.
 */
export interface PieSpec {
  type: "pie";
  /** Name of the table in `ChartSpec.data`; defaults to the only table. */
  data?: string;
  /** Stable identity, used for legend state and updates. */
  id?: string;
  /** Category field: a slice per value. */
  category: Field;
  /** Number field summed per category; without it, slices count rows. */
  value?: Field;
  /** The hole's radius as a fraction of the pie's: 0 (the default) for a pie, about 0.6 for a donut. */
  innerRadius?: number;
  /** "value" (the default) orders slices largest first, clockwise from the top; "input" keeps the categories' order. */
  sort?: "value" | "input";
  /** Labels beside the slices, joined to them by lines; true by default. */
  labels?: boolean;
}

/**
 * Box plots: per category, a box from the lower to the upper quartile of a
 * number field's values, a line at the median, whiskers to the most extreme
 * values within 1.5 interquartile ranges of the box, and points beyond them.
 * One of `x` and `y` is a category field, the other the values.
 */
export interface BoxPlotSpec extends MarkBase {
  type: "boxplot";
  x: Field;
  y: Field;
  /** Category field: a box per value in each category, side by side. */
  series?: Field;
  /** Opacity of the boxes' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
}

/**
 * Violins: per category, the Gaussian kernel density of a number field's
 * values mirrored about the category's center, each as wide as the others
 * at its densest, reaching two bandwidths past the extreme values. Inside
 * each, a line between the box plot's whisker ends, a narrow box from the
 * lower to the upper quartile, and a dot at the median. One of `x` and `y`
 * is a category field, the other the values.
 */
export interface ViolinSpec extends MarkBase {
  type: "violin";
  x: Field;
  y: Field;
  /** Category field: a violin per value in each category, side by side. */
  series?: Field;
  /**
   * The kernel's standard deviation in data units, the same for every
   * violin; by default each violin's by Silverman's rule of thumb.
   */
  bandwidth?: number;
  /** Opacity of the violins' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
}

/**
 * A treemap: nested rectangles for a tree whose leaves' areas are their
 * share of `value` (or of the rows), as the portable spec describes it.
 */
export interface TreemapSpec {
  type: "treemap";
  data?: string;
  id?: string;
  /** Category fields from the outermost group in; or `node` and `parent`. */
  path?: string[];
  /** Category field naming each row's node, with `parent` naming its parent's. */
  node?: string;
  parent?: string;
  value?: string;
  /** Names inside the rectangles that have room for them; true by default. */
  labels?: boolean;
}

/**
 * A sunburst: a tree as rings around a center, each node's angle its share
 * of its parent's, deeper levels further out.
 */
export interface SunburstSpec {
  type: "sunburst";
  data?: string;
  id?: string;
  /** Category fields from the outermost group in; or `node` and `parent`. */
  path?: string[];
  /** Category field naming each row's node, with `parent` naming its parent's. */
  node?: string;
  parent?: string;
  value?: string;
  /** Names inside the sectors that have room for them; true by default. */
  labels?: boolean;
}

/** A colored range of a gauge's dial: from the previous band's end, or `min`, up to `to`. */
export interface GaugeBand {
  to: number;
  /** The band's color; the theme's palette, in order, by default. */
  color?: string;
}

/**
 * A gauge: the last finite value of a number field on a dial from `min` to
 * `max`, so appending rows moves it. The dial is a 240-degree arc open at
 * the bottom; bands color ranges of it.
 */
export interface GaugeSpec {
  type: "gauge";
  data?: string;
  id?: string;
  /** Number field whose last finite value the gauge shows. */
  value: Field;
  /** The ends of the dial; 0 and 100 by default. */
  min?: number;
  max?: number;
  /** Colored ranges, by ascending ends above `min` and at most `max`. */
  bands?: GaugeBand[];
  /** Text under the value; the field's name by default. */
  label?: string;
  /** Intl.NumberFormat options for the value and the dial's ends. */
  format?: Intl.NumberFormatOptions;
}

/**
 * A funnel: a centered bar per category, top to bottom, its width in
 * proportion to the sum of `value` over the category's rows (or their
 * count), with faint connectors between neighboring bars.
 */
export interface FunnelSpec {
  type: "funnel";
  data?: string;
  id?: string;
  /** Category field: a stage per value. */
  category: Field;
  /** Number field summed per stage; without it, stages count rows. */
  value?: Field;
  /** "input" (the default) keeps the categories' order; "value" puts the largest stage first. */
  sort?: "input" | "value";
  /** Stage names beside the bars and values on them; true by default. */
  labels?: boolean;
}

/**
 * A radar: spokes from a center, evenly spaced clockwise from the top, and a
 * polygon per series joining its value on each spoke. Spokes are the values
 * of `category` (with `value` the number on each) or the number `fields`;
 * one of the two forms, with 3 to 100 spokes. Every spoke shares one linear
 * scale from the center.
 */
export interface RadarSpec {
  type: "radar";
  data?: string;
  id?: string;
  /** Category field: a spoke per value, with `value` the number on it. */
  category?: Field;
  value?: Field;
  /** Distinct number fields, a spoke each, in order; each series' last row is its polygon. */
  fields?: Field[];
  /** Category field: a polygon per value. Without it, every row belongs to one polygon. */
  series?: Field;
  /** Values at the center and at the rim; from 0 (or the smallest value) to a round number above the largest by default. */
  domain?: [number, number];
  /** Opacity of the polygons' fill; 0.15 by default. */
  fillOpacity?: number;
  /** A dot at each value; true by default. */
  points?: boolean;
  /** Name of the polygon of a radar without `series`, and of its values in tooltips. */
  label?: string;
}

/**
 * A Sankey diagram of flows between nodes, from a table with a row per
 * flow. Nodes are the names in `source` and `target`; a link joins each
 * source and target, as thick as the sum of `value` over their rows (or
 * their count). Rows without a positive, finite value, links from a node to
 * itself, and links that would close a cycle are left out.
 */
export interface SankeySpec {
  type: "sankey";
  data?: string;
  id?: string;
  /** Category field naming where each row's flow comes from. */
  source: Field;
  /** Category field naming where it goes; a name in both fields is one node. */
  target: Field;
  /** Number field summed per source and target; without it, links count rows. */
  value?: Field;
  /** Names and values beside the nodes that have room for them; true by default. */
  labels?: boolean;
  /** Width of the node bars in pixels; 12 by default. */
  nodeWidth?: number;
  /**
   * Order of the nodes in each column: by default, the order that keeps
   * links short and crossings few; "input" keeps the order in which nodes
   * first appear in the table, "value" puts the largest first.
   */
  sort?: "input" | "value";
}

/**
 * Bars counting how many values of `x` fall in each bin. Bins are shared by
 * every series: round edges covering the field's values.
 */
export interface HistogramSpec extends MarkBase {
  type: "histogram";
  x: Field;
  /** About how many bins, or a bin width and where bins start; by default from the data size. */
  bins?: number | { step: number; start?: number };
  /** Category field: one histogram per value, overlaid or stacked. */
  series?: Field;
  /** What bars measure: "count" (default), "percent" of the series' values, or "density". */
  normalize?: "count" | "percent" | "density";
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  label?: string;
}

/** Points at (x, y): scatter plots. */
export interface PointSpec extends MarkBase {
  type: "point";
  x: Field;
  y: Field;
  series?: Field;
  /** Radius in pixels, or a number field sized by area within `rRange`. */
  r?: number | Field;
  /** Radii of the smallest and largest values of an `r` field. Default [2, 12]. */
  rRange?: [number, number];
  fill?: string;
  /** Opacity from 0 to 1, or a number field mapped from 0.15 to 1. */
  fillOpacity?: number | Field;
  /** A number field colored on a continuous scale (see `colors`). */
  color?: Field;
  /** Colors for `color`, low to high, or a scheme name such as "viridis". */
  colors?: string[] | string;
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: [number, number];
  /** The value at the ramp's middle, for diverging schemes such as "rdbu". */
  colorMidpoint?: number;
  /** A symbol name ("circle", "square", "triangle", ...), or a category field with a symbol per value. */
  symbol?: string;
  /** "pixel" draws opaque points sharing a device pixel once. Default "none". */
  sampling?: "none" | "pixel";
  label?: string;
}

/**
 * A grid of cells colored by `value`. Category fields give one column (or
 * row) per category; number and time fields one per distinct value.
 */
export interface HeatmapSpec extends MarkBase {
  type: "heatmap";
  x: Field;
  y: Field;
  value: Field;
  /** Color ramp from low to high values, or a scheme name; defaults to the theme's. */
  colors?: string[] | string;
  /** The values at the ends of the ramp; the values' extent by default. */
  colorDomain?: [number, number];
  /** The value at the ramp's middle, for diverging schemes such as "rdbu". */
  colorMidpoint?: number;
  label?: string;
}
