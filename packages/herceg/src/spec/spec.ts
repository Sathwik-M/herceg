// The portable chart specification.
//
// Everything here is plain JSON: no functions, DOM objects, typed arrays, or
// class instances. The TypeScript API builds these objects, the Python
// package emits them, and serialized charts store them. Field references are
// column names of a table; constant colors use `stroke` / `fill`.

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

/** Inline columnar data. */
export interface DataSpec {
  columns: Record<Field, ColumnSpec>;
}

/**
 * Column values. Numbers may be null for missing values. A `time` column holds
 * epoch milliseconds or ISO 8601 strings.
 */
export type ColumnSpec = (number | null)[] | (string | null)[] | TimeColumnSpec;

export interface TimeColumnSpec {
  type: "time";
  values: (number | string | null)[];
}

/** Scale and axis options for one position channel. */
export interface AxisSpec {
  /** Inferred from the data when omitted: time fields get "time". */
  type?: "linear" | "log" | "time";
  /** Fixed domain. Time domains are epoch milliseconds. */
  domain?: [number, number];
  /** Extend the domain to round tick values. Default true for y. */
  nice?: boolean;
  /** Include zero in the domain. Default true for areas. */
  zero?: boolean;
  /** Axis title. */
  label?: string;
  /** Grid lines across the plot. Default true for y. */
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
   * "nearest": the single nearest point.
   */
  mode?: "nearest-x" | "nearest";
}

export interface InteractionSpec {
  /** Wheel zoom and drag pan along x. */
  zoom?: boolean;
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
}

export type MarkSpec = LineSpec | AreaSpec | RuleSpec;

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

/** A horizontal (y) or vertical (x) reference line at a constant value. */
export interface RuleSpec {
  type: "rule";
  id?: string;
  x?: number;
  y?: number;
  stroke?: string;
  strokeWidth?: number;
  dash?: number[];
  label?: string;
}
