// The portable chart specification.
//
// Everything here is plain JSON: no functions, DOM objects, typed arrays, or
// class instances. The TypeScript API builds these objects, the Python
// package emits them, and serialized charts store them. Field references are
// column names of a table; constant colors use `stroke` / `fill`. Large
// columns can travel as binary buffers next to the JSON (see `BinaryColumnSpec`).

export const SPEC_VERSION = 1;

/** Column name in a table. */
export type Field = string;

export interface ChartSpec {
  /** Spec format version; defaults to the current version. */
  version?: 1;
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

export type RendererName = "auto" | "svg" | "canvas";
export type ThemeName = "light" | "dark";

/** Columnar data: every column has the same length. */
export interface DataSpec {
  columns: Record<Field, ColumnSpec>;
}

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
  /** Wheel zoom and drag pan along x; double-click resets. */
  zoom?: boolean;
  /**
   * Drag along x to select a range, shown as a band and reported as a
   * `select` event; a click clears it. With `zoom` on too, a brush zooms to
   * its range instead (Shift-drag pans).
   */
  brush?: "x";
  /** Charts with the same sync name share their cursor and x range. */
  sync?: string;
}

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
  /** Categorical colors in assignment order. */
  palette?: string[];
  /** Ramp for continuous color (heatmaps), from low to high values. */
  sequential?: string[];
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
  | ErrorBarSpec;

interface MarkBase {
  /** Name of the table in `ChartSpec.data`; defaults to the only table. */
  data?: string;
  /** Stable identity, used for legend state and updates. */
  id?: string;
}

export type Curve = "linear" | "step" | "step-before" | "step-after";

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

/** Points at (x, y): scatter plots. */
export interface PointSpec extends MarkBase {
  type: "point";
  x: Field;
  y: Field;
  series?: Field;
  /** Radius in pixels. */
  r?: number;
  fill?: string;
  fillOpacity?: number;
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
  /** Color ramp from low to high values; defaults to the theme's. */
  colors?: string[];
  label?: string;
}
