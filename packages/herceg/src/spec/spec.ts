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
 * The spec format this herceg writes; it reads the earlier ones too. Each
 * version adds what an older reader would ignore and draw differently:
 * version 2 `resolve.y`, `panels`, and `grid`, version 3 `resolve.x`,
 * panels' own `x`, and the x axis' `breaks`.
 */
export const SPEC_VERSION = 3;

/** Column name in a table. */
export type Field = string;

/**
 * A spec as marks hold it: readonly all the way down, and frozen at run
 * time, since a mark's caches depend on it. Change a chart by giving it new
 * marks (`chart.update({ marks })`), not by editing a mark's spec.
 */
export type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

export interface ChartSpec {
  /**
   * Spec format version; 1 when omitted. Specs using `resolve`, `panels`, or
   * `grid` must give 2 or later, and those using `resolve.x`, a panel's `x`,
   * or x axis `breaks` 3, so that older readers refuse them rather than draw
   * them differently.
   */
  version?: 1 | 2 | 3;
  /** Chart title, also its accessible name. */
  title?: string;
  /** Longer description for assistive technology. */
  description?: string;
  /** CSS pixels. In the browser, omitted sizes follow the container. */
  width?: number;
  height?: number;
  /** Tables referenced by marks, by name. */
  data?: Record<string, DataSpec>;
  marks: readonly MarkSpec[];
  x?: XAxisSpec;
  y?: AxisSpec;
  /**
   * A second y axis on the right, for marks with `axis: "right"`, with its
   * own scale and domain. Grid lines follow it only when no mark uses the left axis.
   */
  yRight?: AxisSpec;
  /** Small multiples: the chart drawn once per value of a category field. */
  facet?: FacetSpec;
  /**
   * Which panels share an x or y scale: all panels share x by default, and
   * y in facets; each of the `panels` has a y scale of its own by default.
   */
  resolve?: ResolveSpec;
  /**
   * Subplots: panels in a grid, each drawing the marks that name it in their
   * `panel`. Needs spec version 2; not with `facet`.
   */
  panels?: readonly PanelSpec[];
  /** How `panels` are placed: in rows of `columns` (1 by default), in order. */
  grid?: GridSpec;
  legend?: boolean;
  tooltip?: boolean | TooltipSpec;
  interaction?: InteractionSpec;
  /**
   * Moves the axes gradually to a view asked for: `setViewport`, zooming
   * to a brush, and double-click reset. Off by
   * default; `true` takes 250 ms. Never for wheel zoom, panning, streaming,
   * linked charts, panels, or slow frames, nor where the page prefers
   * reduced motion.
   */
  animation?: boolean | AnimationSpec;
  /** Renderer for marks. "auto" picks per mark by data size. */
  renderer?: RendererName;
  theme?: ThemeName | ThemeSpec;
  /** BCP 47 locale for labels; defaults to the runtime locale. */
  locale?: string;
  /** "local" (default), "UTC", or an IANA zone for time axes and labels. */
  timeZone?: string;
  /**
   * How maps (`geoshape` and `geopoint` marks) are projected: a projection's
   * name, or one with parameters. Equal Earth by default.
   */
  projection?: ProjectionName | ProjectionSpec;
  /**
   * The vertical axis of 3D charts (`point3d` and `surface` marks), whose
   * `x` and `y` are the floor's. Only for 3D charts.
   */
  z?: AxisSpec;
  /** Where a 3D chart is seen from at first; the pointer and keyboard turn it. Only for 3D charts. */
  camera?: CameraSpec;
  /**
   * The relative lengths of a 3D chart's x, y, and z sides: [1, 1, 1], a
   * cube, by default. Only for 3D charts.
   */
  boxAspect?: readonly [number, number, number];
}

/**
 * The view of a 3D chart: the eye's direction from the box's center, and
 * how the box is drawn. Angles are in degrees.
 */
export interface CameraSpec {
  /** About the vertical z axis, counterclockwise from +x seen from above; -60 by default. */
  azimuth?: number;
  /** Above the x-y plane, from -90 (from below) to 90 (from above); 25 by default. */
  elevation?: number;
  /** Magnification from 0.5 to 10; 1, the default, fits the box in the chart. */
  zoom?: number;
  /** Perspective, nearer things larger, rather than orthographic projection (the default). */
  perspective?: boolean;
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

/** Scale sharing between panels; needs spec version 2 (3 for `x`). Category axes are always shared. */
export interface ResolveSpec {
  /** A continuous x axis; shared by default. */
  x?: ScaleResolution;
  /** A continuous y axis; shared by default in facets, independent in subplots. */
  y?: ScaleResolution;
}

/** One of a chart's `panels`. */
export interface PanelSpec {
  /** Unique among the panels; marks name it in their `panel`. */
  id: string;
  /** Drawn above the panel. */
  title?: string;
  /**
   * The panel's x axis: the chart's `x`, with these settings in place of
   * its own (`format` replaces the chart's whole). Panels sharing an x
   * scale take their first panel's.
   */
  x?: AxisSpec;
  /**
   * The panel's y axis: the chart's `y`, with these settings in place of
   * its own (`format` replaces the chart's whole).
   */
  y?: AxisSpec;
}

export interface GridSpec {
  columns?: number;
  /** The rows' heights relative to each other, one per row; equal by default. */
  rowHeights?: readonly number[];
  /** The columns' widths relative to each other, one per column; equal by default. */
  columnWidths?: readonly number[];
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
 * A map projection: "equal-earth" (equal-area, for world maps),
 * "natural-earth" (a compromise for world maps), "mercator" (conformal,
 * cut at 85.05 degrees of latitude), "equirectangular" (longitude and
 * latitude as they are), or "conic-equal-area" (Albers' equal-area conic,
 * for countries and continents).
 */
export type ProjectionName =
  | "equal-earth"
  | "natural-earth"
  | "mercator"
  | "equirectangular"
  | "conic-equal-area";

export interface ProjectionSpec {
  type: ProjectionName;
  /**
   * The longitude at the map's center, in degrees east: 0 by default; for
   * "conic-equal-area", the middle of the data (or of `fit`).
   */
  centralMeridian?: number;
  /**
   * The two standard parallels of "conic-equal-area", in degrees: by
   * default a sixth of the data's span of latitudes in from either end.
   */
  parallels?: readonly [number, number];
  /**
   * What the map fits into its plot: the data's shapes and points ("data",
   * the default), the whole "world", or a box of longitudes and latitudes,
   * `[[west, south], [east, north]]`, whose west may lie east of its east
   * to cross the antimeridian.
   */
  fit?: "data" | "world" | readonly [readonly [number, number], readonly [number, number]];
}
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
  transform: readonly TransformSpec[];
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
  | { aggregate: readonly AggregateSpec[]; groupby?: readonly Field[] }
  | { rolling: readonly RollingSpec[]; size: number; groupby?: readonly Field[] }
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
  | readonly (number | null)[]
  | readonly (string | null)[]
  | TimeColumnSpec
  | BinaryColumnSpec
  | CategoryColumnSpec
  | GeometryColumnSpec;

/** Epoch milliseconds or ISO 8601 strings; null for missing values. */
export interface TimeColumnSpec {
  type: "time";
  values: readonly (number | string | null)[];
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
  codes: number | readonly number[];
  dictionary: readonly string[];
}

/**
 * Polygons and multipolygons in longitude and latitude (degrees, WGS 84),
 * packed as GeoArrow nests multipolygons. Each array is a buffer index or
 * an inline JSON array: `coordinates` float64 longitude, latitude pairs;
 * `ringOffsets` int32 offsets into coordinate pairs; `polygonOffsets` int32
 * offsets into rings (each polygon's exterior first, then its holes); and
 * `geometryOffsets` int32 offsets into polygons, each array one longer
 * than the things it divides. Row i holds geometry `codes[i]` (int32, -1
 * for none), or geometry i without `codes`. Edges are straight in
 * longitude and latitude, as GeoJSON defines them.
 */
export interface GeometryColumnSpec {
  type: "geometry";
  coordinates: number | readonly number[];
  ringOffsets: number | readonly number[];
  polygonOffsets: number | readonly number[];
  geometryOffsets: number | readonly number[];
  codes?: number | readonly number[];
}

/** Scale and axis options for one position channel. */
export interface AxisSpec {
  /** Inferred from the data when omitted: time fields get "time". */
  type?: "linear" | "log" | "time";
  /** Fixed domain. Time domains are epoch milliseconds. */
  domain?: readonly [number, number];
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

/** The x axis: an axis whose time may leave out spans of time. */
export interface XAxisSpec extends AxisSpec {
  /**
   * Time the axis leaves out, so that what is left is drawn without gaps:
   * weekends, hours outside trading sessions, holidays. Needs a time axis
   * and spec version 3. Data inside a break is not drawn; lines and areas
   * join the points on either side.
   */
  breaks?: readonly TimeBreakSpec[];
}

/** A day of the week, by its first three letters in English. */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Time a time axis leaves out, in the chart's `timeZone`. Each break is one
 * of: days of the week (`{ weekdays: ["sat", "sun"] }`), a daily span of
 * wall-clock time (`{ hours: ["16:00", "09:30"] }`, wrapping past midnight
 * when it ends earlier than it starts), whole calendar days
 * (`{ dates: ["2025-12-25"] }`), or a span of instants (`{ from, to }`,
 * epoch milliseconds). Starts are included, ends are not. Across a clock
 * change, `hours` leaves out the instants whose wall-clock time is in the
 * span, so a span inside a repeated hour is left out twice.
 */
export type TimeBreakSpec =
  | { weekdays: readonly Weekday[] }
  | { hours: readonly [string, string] }
  | { dates: readonly string[] }
  | { from: number; to: number };

export interface TooltipSpec {
  /**
   * "nearest-x": every series at the x position nearest the pointer.
   * "nearest-y": every series at the y position nearest the pointer (the
   * default for horizontal bars).
   * "nearest": the single nearest point.
   */
  mode?: "nearest-x" | "nearest-y" | "nearest";
  /**
   * Label the crosshair on the axes, as financial charts do: the inspected
   * value on the axis the crosshair follows, and the pointer's position on
   * the other axes, across the plot at a dashed line. Off by default.
   */
  axisLabels?: boolean;
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
  /**
   * Dragging turns 3D charts; true by default. Their `zoom` is `true` or
   * false: the wheel magnifies them.
   */
  rotate?: boolean;
}

export interface AnimationSpec {
  /** Milliseconds a view change takes; 0 shows it at once. */
  duration?: number;
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
  gridDash?: readonly number[];
  /** Width of lines and area outlines that do not set one. */
  lineWidth?: number;
  /** Radius of the corners at the value end of unstacked bars; 0 for square bars. */
  barRadius?: number;
  tooltipBackground?: string;
  tooltipBorder?: string;
  /** Categorical colors in assignment order. */
  palette?: readonly string[];
  /** Ramp for continuous color (heatmaps), from low to high values. */
  sequential?: readonly string[];
  /** Ramp for colors on either side of a midpoint, low to high. */
  diverging?: readonly string[];
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
  | SankeySpec
  | GraphSpec
  | GeoShapeSpec
  | GeoPointSpec
  | Point3DSpec
  | SurfaceSpec;

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
  /** With the chart's `panels`, the id of the panel the mark draws in, or "*" for every panel. */
  panel?: string;
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
  y: Field | readonly Field[];
  /** Category field that splits rows into one line per value. */
  series?: Field;
  /** Constant color; otherwise colors come from the palette per series. */
  stroke?: string;
  strokeWidth?: number;
  /** SVG-style dash pattern in pixels. */
  dash?: readonly number[];
  curve?: Curve;
  /** Legend and tooltip name for a single-field line without `series`. */
  label?: string;
}

interface AreaStyle extends MarkBase {
  type: "area";
  x: Field;
  fill?: string;
  fillOpacity?: number;
  /** Outline the top edge. Default true for unstacked single areas, and with `stroke`. */
  line?: boolean;
  /** Outline color; each area's own color by default. */
  stroke?: string;
  /** Outline width in pixels; the theme's line width by default. */
  strokeWidth?: number;
  curve?: Curve;
  label?: string;
}

/**
 * Filled areas. With `y`, each series is filled down to zero (or stacked on
 * the previous series with `stack`). With `y1` and `y2`, the band between two
 * fields is filled.
 */
export type AreaSpec = AreaStyle &
  (
    | { y: Field | readonly Field[]; series?: Field; stack?: boolean; y1?: never; y2?: never }
    | { y1: Field; y2: Field; y?: never; series?: never; stack?: never }
  );

/**
 * A position of an annotation: a number (times in epoch milliseconds), or a
 * number or time field of the mark's table. An annotation with a field draws
 * one item per row; with numbers only, one item.
 */
export type Position = number | Field;

/** Where rules stand: at `x` (vertical) or at `y` (horizontal). */
export type RulePosition<P> = { x: P; y?: never } | { y: P; x?: never };

/** Horizontal (y) or vertical (x) reference lines. */
export type RuleSpec = RuleStyle & RulePosition<Position>;

interface RuleStyle extends MarkBase {
  type: "rule";
  stroke?: string;
  strokeWidth?: number;
  dash?: readonly number[];
  /** Text drawn by every rule. */
  label?: string;
  /** Category or number field with each rule's text, for rules from data. */
  text?: Field;
}

/** The ranges a region spans: along x, along y, or both. */
export type RegionRange<P> =
  | { x1: P; x2: P; y1?: never; y2?: never }
  | { y1: P; y2: P; x1?: never; x2?: never }
  | { x1: P; x2: P; y1: P; y2: P };

/**
 * Shaded regions: from `x1` to `x2` across the plot's height, from `y1` to
 * `y2` across its width, or rectangles with both. Drawn in mark order, so
 * list them before the marks they highlight to draw them underneath.
 */
export type RegionSpec = RegionStyle & RegionRange<Position>;

interface RegionStyle extends MarkBase {
  type: "region";
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
  /**
   * Labels that would cover an earlier one of this mark: drawn anyway
   * ("show", the default), left out ("hide"), or, where their place is taken
   * or outside the plot, tried around their point and left out when nothing
   * fits ("move").
   */
  overlap?: "show" | "hide" | "move";
}

/**
 * Bars. Vertical by default: a category `x` gives one band per category, a
 * number or time `x` centers bars on its values, and `y` holds bar lengths.
 * A category `y` makes them horizontal, with lengths in `x`. Several length
 * fields are drawn side by side or stacked.
 */
export interface BarSpec extends MarkBase {
  type: "bar";
  x: Field | readonly Field[];
  y: Field | readonly Field[];
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
export type ErrorBarSpec = ErrorBarStyle &
  (
    | {
        x: Field;
        y1: Field;
        y2: Field;
        y?: never;
        yError?: never;
        x1?: never;
        x2?: never;
        xError?: never;
      }
    | {
        x: Field;
        y: Field;
        yError: Field;
        y1?: never;
        y2?: never;
        x1?: never;
        x2?: never;
        xError?: never;
      }
    | {
        y: Field;
        x1: Field;
        x2: Field;
        x?: never;
        xError?: never;
        y1?: never;
        y2?: never;
        yError?: never;
      }
    | {
        y: Field;
        x: Field;
        xError: Field;
        x1?: never;
        x2?: never;
        y1?: never;
        y2?: never;
        yError?: never;
      }
  );

interface ErrorBarStyle extends MarkBase {
  type: "errorbar";
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
  /**
   * "candlestick" (the default): bodies from open to close. "ohlc": bars,
   * a line from low to high with the open ticked to its left and the close
   * to its right.
   */
  variant?: "candlestick" | "ohlc";
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
  /** Constant color for every shape; colors come from the palette otherwise. */
  fill?: string;
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
  /** Constant color for every shape; colors come from the palette otherwise. */
  fill?: string;
  /** Opacity of the violins' fill; 0.25 by default. */
  fillOpacity?: number;
  label?: string;
}

/**
 * How a spec names a tree: a path of category fields from the outermost
 * group in, or a field naming each row's node and one naming its parent's.
 */
export type TreeShape =
  | { path: readonly string[]; node?: never; parent?: never }
  | { node: string; parent: string; path?: never };

/**
 * A treemap: nested rectangles for a tree whose leaves' areas are their
 * share of `value` (or of the rows), as the portable spec describes it.
 */
export type TreemapSpec = TreemapStyle & TreeShape;

interface TreemapStyle {
  type: "treemap";
  data?: string;
  id?: string;
  value?: string;
  /** Names inside the rectangles that have room for them; true by default. */
  labels?: boolean;
}

/**
 * A sunburst: a tree as rings around a center, each node's angle its share
 * of its parent's, deeper levels further out.
 */
export type SunburstSpec = SunburstStyle & TreeShape;

interface SunburstStyle {
  type: "sunburst";
  data?: string;
  id?: string;
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
  bands?: readonly GaugeBand[];
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
  fields?: readonly Field[];
  /** Category field: a polygon per value. Without it, every row belongs to one polygon. */
  series?: Field;
  /** Values at the center and at the rim; from 0 (or the smallest value) to a round number above the largest by default. */
  domain?: readonly [number, number];
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
 * A network of nodes joined by links, laid out by a force simulation, from
 * a table with a row per link. Nodes are the names in `source` and `target`
 * and, with `nodes`, the rows of a table of nodes; links are undirected, as
 * thick as the sum of `value` over their rows when there is one. Rows
 * without a positive, finite value and links from a node to itself are left
 * out. A network draws at most 5,000 nodes and 20,000 links.
 */
export interface GraphSpec {
  type: "graph";
  data?: string;
  id?: string;
  /** Category field naming one end of each row's link. */
  source: Field;
  /** Category field naming the other end; a name in both fields is one node. */
  target: Field;
  /** Number field summed per pair of nodes, setting links' widths; without it, links are alike. */
  value?: Field;
  /** Name of a table in `ChartSpec.data` with a row per node; needs `node`. */
  nodes?: string;
  /** Category field of `nodes` naming each row's node, as `source` and `target` do. */
  node?: Field;
  /** Category field of `nodes`: nodes are colored by it, with a legend. */
  group?: Field;
  /** Number field of `nodes` sizing nodes by area. */
  size?: Field;
  /** Names beside the most connected (or largest) nodes that have room; true by default. */
  labels?: boolean;
}

/**
 * Regions of a map: each row's shape from a geometry field, filled by
 * `color` (a number field on a continuous scale, or a category field with
 * a color per value) or with `fill`. Maps project every geo mark of a chart
 * with the chart's `projection`.
 */
export interface GeoShapeSpec {
  type: "geoshape";
  data?: string;
  id?: string;
  /** The geometry field; the table's only one by default. */
  geometry?: Field;
  /** Category field naming each region, for tooltips, keyboard reading, and the summary. */
  name?: Field;
  /** A number field colored on a continuous scale, or a category field with a palette color per value. */
  color?: Field;
  /** Colors for a number `color`, low to high, or a scheme name such as "viridis". */
  colors?: readonly string[] | string;
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging schemes such as "rdbu". */
  colorMidpoint?: number;
  /** The fill without `color`, and of regions without a value. */
  fill?: string;
  /** Default 1. */
  fillOpacity?: number;
  /** Border color; the chart's background by default. */
  stroke?: string;
  /** Border width in pixels; default 0.75, 0 for none. */
  strokeWidth?: number;
  /** What the regions are, in the legend and tooltips without `color`. */
  label?: string;
}

/**
 * Points of a map at `longitude` and `latitude` (number fields, degrees),
 * sized, colored, and split into series as `point` marks are.
 */
export interface GeoPointSpec {
  type: "geopoint";
  data?: string;
  id?: string;
  longitude: Field;
  latitude: Field;
  /** Category field naming each point, for tooltips, keyboard reading, and the summary. */
  name?: Field;
  /** Category field: one colored set of points per value, with a legend. */
  series?: Field;
  /** Radius in pixels, or a number field sized by area within `rRange` (bubbles). */
  r?: number | Field;
  /** Radii of the smallest and largest values of an `r` field. Default [2, 16]. */
  rRange?: readonly [number, number];
  /** A number field colored on a continuous scale. */
  color?: Field;
  colors?: readonly string[] | string;
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  fill?: string;
  /** Default 0.8, so overlapping points and the regions under them show. */
  fillOpacity?: number;
  /** Color of the ring around each point; the chart's background by default. */
  stroke?: string;
  /** Width of the ring in pixels; default 1, 0 for none. */
  strokeWidth?: number;
  /** Legend and tooltip name of points without `series`. */
  label?: string;
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
  rRange?: readonly [number, number];
  /** Outline color of every point; the chart's background with only `strokeWidth`. */
  stroke?: string;
  /** Outline width in pixels: 1 with only `stroke`, none by default. */
  strokeWidth?: number;
  fill?: string;
  /** Opacity from 0 to 1, or a number field mapped from 0.15 to 1. */
  fillOpacity?: number | Field;
  /** A number field colored on a continuous scale (see `colors`). */
  color?: Field;
  /** Colors for `color`, low to high, or a scheme name such as "viridis". */
  colors?: readonly string[] | string;
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging schemes such as "rdbu". */
  colorMidpoint?: number;
  /**
   * A shape's name ("circle", "square", "triangle", ...), or a category
   * field with a shape per value. A name that is both is refused.
   */
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
  colors?: readonly string[] | string;
  /** The values at the ends of the ramp; the values' extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging schemes such as "rdbu". */
  colorMidpoint?: number;
  /**
   * How a pixel showing several cells (a grid with more columns or rows than
   * the plot has device pixels) colors them: by the "mean" of their values
   * (the default), the "max", or the "min".
   */
  reduce?: "mean" | "max" | "min";
  label?: string;
}

/**
 * Points at (x, y, z) in a 3D chart: number or time fields, z vertical.
 * Points share the chart's box with the chart's other 3D marks.
 */
export interface Point3DSpec {
  type: "point3d";
  data?: string;
  id?: string;
  x: Field;
  y: Field;
  z: Field;
  /** Category field: one colored set of points per value, with a legend. */
  series?: Field;
  /** Category field naming each point, for tooltips and keyboard reading. */
  name?: Field;
  /** Radius in pixels; default 3.5. */
  r?: number;
  /** A number field colored on a continuous scale, with a color legend. */
  color?: Field;
  /** Colors for `color`, low to high, or a scheme name such as "viridis". */
  colors?: readonly string[] | string;
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  fill?: string;
  /** Default 1. */
  fillOpacity?: number;
  /** Legend and tooltip name of points without `series`. */
  label?: string;
}

/**
 * A surface over a grid in a 3D chart: each row is a grid point, at the
 * distinct values of `x` and `y` (numbers or times in order, categories
 * evenly spaced in dictionary order), at the height of `z`. Cells between
 * four grid points with values are drawn; points without a value leave holes.
 */
export interface SurfaceSpec {
  type: "surface";
  data?: string;
  id?: string;
  x: Field;
  y: Field;
  /** Number field: the height at each grid point. */
  z: Field;
  /** A number field coloring the surface in place of `z`. */
  color?: Field;
  /** Colors from low to high values, or a scheme name; the theme's ramp by default. */
  colors?: readonly string[] | string;
  colorDomain?: readonly [number, number];
  colorMidpoint?: number;
  /** Default 1. */
  fillOpacity?: number;
  /**
   * Shades cells by how they face a light above and behind the viewer; true
   * by default. Without shading, colors read exactly as the legend shows.
   */
  shading?: boolean;
  /** Draws the grid's lines over the surface; false by default. */
  wireframe?: boolean;
  /** What the surface is, in tooltips. */
  label?: string;
}
