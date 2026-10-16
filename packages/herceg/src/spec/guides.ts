// Portable guide types: the position scales a chart names (`scales`), the
// guides that explain scales (`guides`: axes, legends, colorbars), and how
// ticks are chosen and written. The chart's `x`, `y`, `yRight`, and
// `legend` options are their short forms (see docs/architecture.md,
// "Scales and guides").

import type { OrdinalScaleSpec } from "./encoding.ts";
import type { Place, Side } from "./place.ts";
import type { ScaleScope } from "./spec.ts";
import type { AxisStyles, LegendStyles, TextStyle } from "./style.ts";

/** A calendar unit of time, as time axes step through it in their time zone. */
export type TimeUnit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

/**
 * The time between ticks on a time axis: calendar steps in the scale's time
 * zone, written as a unit ("day"), a count and a unit ("6 hours"), or
 * `{ unit, step }`; or elapsed time, `{ milliseconds }`, which keeps the
 * same length across daylight saving changes.
 */
export type TimeInterval = string | { unit: TimeUnit; step?: number } | { milliseconds: number };

/**
 * Which ticks an axis draws: about `count` round values (a number alone is
 * the same); one every `every` (a number on number axes, from `anchor`, 0 by
 * default; a time interval on time axes; on category axes, every n-th
 * category); or exactly `values` (numbers, epoch milliseconds on time axes,
 * or categories), those inside the axis' domain.
 */
export type TicksSpec =
  | number
  | { count: number }
  | { every: number; anchor?: number }
  | { every: TimeInterval; anchor?: number }
  | { values: readonly (number | string)[] };

/**
 * How values are written: Intl.NumberFormat options (number axes) or
 * Intl.DateTimeFormat options (time axes); `{ number }`, a d3-format pattern
 * such as ",.2f" or ".1%"; or `{ time }`, a strftime pattern such as
 * "%b %d %H:%M", in the scale's time zone.
 */
export type FormatSpec =
  | Intl.NumberFormatOptions
  | Intl.DateTimeFormatOptions
  | { number: string }
  | { time: string };

/**
 * Tick marks: out from the plot (the default), in over it, or across the
 * axis line ("cross", half each way); `length` in pixels (for "cross", the
 * whole length).
 */
export interface TickMarkSpec {
  direction?: "out" | "in" | "cross";
  length?: number;
}

/**
 * What a row of tick labels does where labels would overlap: "show" draws
 * them all; "hide" leaves out labels until the rest fit, those of higher
 * `priority` last; "stagger" moves every other one to a second row; "wrap"
 * breaks labels into lines.
 */
export type Collision = "show" | "hide" | "stagger" | "wrap";

/** How a layer's tick labels are written and placed. */
export interface TickLabelsSpec {
  /**
   * Degrees clockwise, from -90 (reading up) to 90 (reading down); or
   * angles tried in order, the first at which the labels fit.
   */
  rotation?: number | { candidates: readonly number[] };
  /** Overlapping labels: drawn all ("show"), the default for number and time axes, or as `Collision` says. */
  collision?: Collision;
  /** The row of labels, 0 by the axis line and 1 beyond it. */
  row?: number;
  /** Which labels stay where labels collide, the higher; 0 by default. */
  priority?: number;
  /** Labels that repeat one before them: left out ("hide", the default) or drawn ("show"). */
  duplicates?: "hide" | "show";
}

/**
 * A layer of an axis' ticks: its own ticks, format, tick marks, and labels,
 * such as minor ticks or a row of day boundaries under hourly labels.
 * `false` leaves out its tick marks or labels.
 */
export interface TickLayerSpec {
  /** Unique among the axis' layers; "major" names the axis' own ticks. */
  id: string;
  ticks?: TicksSpec;
  format?: FormatSpec;
  tick?: TickMarkSpec | false;
  labels?: TickLabelsSpec | false;
  /** How its tick marks and labels look, over the axis'. */
  style?: Pick<AxisStyles, "tick" | "tickLabel">;
}

/**
 * A position scale's settings: the short forms `x`, `y`, and `yRight` hold
 * these with their axes' settings.
 */
export interface ScaleSpec {
  /** Inferred from the data when omitted: time fields get "time". */
  type?: "linear" | "log" | "time";
  /** Fixed domain. Time domains are epoch milliseconds. */
  domain?: readonly [number, number];
  /** Extend the domain to round values (see the short forms). */
  nice?: boolean;
  /** Include zero in the domain. */
  zero?: boolean;
  /** Which panels share one instance of the scale. */
  scope?: ScaleScope;
  /** How tooltips, the keyboard, and crosshair labels write one value; the axis' format by default. */
  tooltipFormat?: FormatSpec;
}

/**
 * The chart's scales by name: the position scales x, the left y, and the
 * right y, and scales of categories ("color", which color fields read
 * unless they name another, "symbol", "dash", or names marks give).
 */
export interface ScalesSpec {
  x?: ScaleSpec;
  y?: ScaleSpec;
  yRight?: ScaleSpec;
  readonly [name: string]: ScaleSpec | OrdinalScaleSpec | undefined;
}

/**
 * A scale a mark owns, by the mark's `id` and the channel: its series
 * colors ("series"), a color field's ramp or colors ("color"), its sizes
 * ("size"), or its symbols ("symbol").
 */
export interface ScaleRef {
  mark: string;
  channel: "series" | "color" | "size" | "symbol";
}

/**
 * An axis showing a position scale along a side of the plots: its ticks
 * (the "major" layer) and more `layers`, its title, and how it looks.
 * Unset settings take the short form's (`x`, `y`, or `yRight`).
 */
export interface AxisGuideSpec {
  type: "axis";
  /** Unique among the chart's guides. */
  id?: string;
  scale: "x" | "y" | "yRight";
  /** Below the plots (x) or left of them (y) by default; x above, y on the right. */
  place?: { side: Side };
  title?: string;
  ticks?: TicksSpec;
  format?: FormatSpec;
  tick?: TickMarkSpec | false;
  labels?: TickLabelsSpec | false;
  /** The axis' line along the plot: x axes draw it, y axes do not, by default. */
  line?: boolean;
  /** Grid lines at its major ticks across the plot; the scale's default axis draws them by default. */
  grid?: boolean;
  layers?: readonly TickLayerSpec[];
  /** Draw the axis; true by default. */
  show?: boolean;
  /**
   * Where panels sharing the scale label it: on the outer edge of panels
   * lined up with each other ("outer", the default), or on every panel ("all").
   */
  repeat?: "outer" | "all";
  style?: AxisStyles;
}

/**
 * A sample drawn for a legend entry: a line, a filled box, or a circle
 * (`size` pixels across), outlined by a 1-pixel `stroke`, or several over
 * each other. An entry shows another symbol by its `sample` of a mark that
 * draws it.
 */
export type SwatchSpec =
  | {
      type: "line";
      stroke: string;
      strokeWidth?: number;
      dash?: readonly number[] | string;
      opacity?: number;
    }
  | { type: "rect"; fill: string; stroke?: string; opacity?: number }
  | { type: "circle"; fill: string; stroke?: string; size?: number; opacity?: number }
  | { type: "composite"; parts: readonly SwatchSpec[] };

/**
 * A legend entry of your own: its label, and either a swatch or a sample
 * drawn as mark `sample.mark` draws its entries; with `targets`, clicking
 * it hides and shows those marks.
 */
export interface LegendEntrySpec {
  key: string;
  label: string;
  swatch?: SwatchSpec;
  sample?: { mark: string };
  targets?: readonly { mark: string }[];
}

/** A legend's title: its text, or its text and how it looks. */
export type LegendTitleSpec = string | { text: string; style?: TextStyle };

/** How a legend lays out and draws its entries, as the short form `legend` and legend guides take it. */
export interface LegendOptionsSpec {
  /**
   * Outside on a side (above the plots by default; on the left or right in a
   * column), or inside a plot at a corner, over what it draws.
   */
  place?: Place;
  /** Entries in this many columns, filled row by row (or as `order` says). */
  columns?: number;
  /** Entries in this many rows. */
  rows?: number;
  /** Fill the grid row by row ("row", the default with `columns`) or down each column ("column", the default with `rows`). */
  order?: "row" | "column";
  title?: LegendTitleSpec;
  /** Entries in place of those the chart's scales give. */
  entries?: readonly LegendEntrySpec[];
  /** Swatches that look like the marks: a dashed line for a dashed line, a symbol for points. */
  swatches?: "mark";
  style?: LegendStyles;
}

/** A legend: the entries of the scales it names (all the chart's by default), laid out as its options say. */
export interface LegendGuideSpec extends LegendOptionsSpec {
  type: "legend";
  id?: string;
  /** The scales whose entries it lists; every one a legend shows by default. */
  scales?: readonly ScaleRef[];
  /**
   * The id of the subplot (or inset) whose marks it lists: it goes above
   * that panel by default, and its entries hide and show them there only.
   * The chart's own legend then lists what no panel's legend does.
   */
  panel?: string;
  show?: boolean;
}

/**
 * A continuous color scale's legend: a bar of its colors along its values,
 * with ticks as an axis has them. Beside the plots it stands vertically,
 * low values at the bottom; above or below them, across, low values at the
 * left.
 */
export interface ColorbarSpec {
  type: "colorbar";
  id?: string;
  /** The scale it shows; the chart's only color ramp when left out. */
  scale?: ScaleRef;
  /** On the right of the plots by default. */
  place?: Place;
  title?: LegendTitleSpec;
  ticks?: TicksSpec;
  format?: FormatSpec;
  tick?: TickMarkSpec | false;
  labels?: TickLabelsSpec | false;
  /** More layers of ticks along the bar, as axes take them. */
  layers?: readonly TickLayerSpec[];
  /** Pixels along its values; the plots' height (or width) by default, up to 240. */
  length?: number;
  /** Pixels across; 12 by default. */
  thickness?: number;
  show?: boolean;
  style?: Pick<AxisStyles, "tick" | "tickLabel"> & Pick<LegendStyles, "legendTitle">;
}

/** A guide: an axis, a legend, or a colorbar. */
export type GuideSpec = AxisGuideSpec | LegendGuideSpec | ColorbarSpec;
