// Portable style types: how text and shapes look, by visual role. Styles
// cascade from the theme to the chart's guides, then to a panel's, each
// level giving only the properties it changes (see docs/architecture.md,
// "Styles"). Colors are CSS colors, or CSS variables with a fallback for
// static output (`var(--ink, #1c2333)`).

import type { Dash } from "./spec.ts";

/** Space around or inside a box, in CSS pixels: the same on every side, or each side's own. */
export type Insets =
  | number
  | {
      readonly top?: number;
      readonly right?: number;
      readonly bottom?: number;
      readonly left?: number;
    };

/**
 * An outline drawn around text to keep it readable over lines and fills:
 * "auto" (the default for text over data) takes the surface under the text
 * where the text contrasts with it at 3:1 or more, else black or white;
 * `false` draws none; or a color of its own, 3 pixels wide by default.
 */
export type Halo = "auto" | false | { color: string; width?: number; opacity?: number };

/** A box drawn behind text. */
export interface TextBox {
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** Corner radius in pixels. */
  radius?: number;
}

/**
 * How text looks. Every property is optional: what a level of the cascade
 * leaves out it inherits. Text takes its color from `color`, never `fill`.
 */
export interface TextStyle {
  /** A CSS font family list. */
  font?: string;
  /** In CSS pixels. */
  fontSize?: number;
  /** 100 to 900; 400 is normal, 600 semibold, 700 bold. */
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  color?: string;
  /** From 0 to 1. */
  opacity?: number;
  /** The distance between lines of text, as a multiple of `fontSize`; 1.25 by default. */
  lineHeight?: number;
  /**
   * Where text sits in the span it is placed in: the chart's width for its
   * title, the plot's for a panel's title, an axis' length for its title.
   * Each text has a natural alignment when this is left out (a chart's
   * title starts at the left, an axis title is centered).
   */
  align?: "start" | "center" | "end";
  halo?: Halo;
  /** A box behind the text; `false` for none. */
  background?: TextBox | false;
  /** Room between the text and its box, in pixels. */
  padding?: Insets;
}

/** How a line looks: its color, width in pixels, dash pattern, and opacity. */
export interface StrokeStyle {
  stroke?: string;
  strokeWidth?: number;
  dash?: Dash;
  /** From 0 to 1. */
  opacity?: number;
}

/** How a filled shape looks: a fill and an outline. */
export interface PaintStyle extends StrokeStyle {
  fill?: string;
  fillOpacity?: number;
  strokeOpacity?: number;
}

/** A plot's area: a background under its grid lines and a border around it. */
export interface PlotStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Styles by visual role. A theme gives every role its defaults; a guide or
 * panel gives the roles it draws. Text roles start from `text`.
 */
export interface StyleRoles {
  /** Every text's base: the font and size most of all. */
  text?: TextStyle;
  /** The chart's title. */
  title?: TextStyle;
  /** Subplots' titles and facet panels' headers. */
  panelTitle?: TextStyle;
  axisTitle?: TextStyle;
  /** The labels of an axis' ticks, and the values a legend of a color ramp or a key writes. */
  tickLabel?: TextStyle;
  /** A legend's entries. */
  legendLabel?: TextStyle;
  /** The titles of a legend's color ramps and keys. */
  legendTitle?: TextStyle;
  /** Each panel's plot area. */
  plot?: PlotStyle;
  /** Grid lines across a plot. */
  grid?: StrokeStyle;
  /** An axis' line along the plot. */
  axisLine?: StrokeStyle;
  /** An axis' tick marks. */
  tick?: StrokeStyle;
  /** Lines, area outlines, and contour lines that do not set their own width. */
  line?: { strokeWidth?: number };
  /** Bars: the radius of the corners at the value end of unstacked bars; 0 for square bars. */
  bar?: { radius?: number };
  /** The tooltip's box; its text is the theme's text color. */
  tooltip?: { fill?: string; stroke?: string };
}

/** The roles an axis draws: its line, ticks, tick labels, title, and grid lines. */
export type AxisStyles = Pick<StyleRoles, "axisLine" | "tick" | "tickLabel" | "axisTitle" | "grid">;

/** The roles a legend draws. */
export type LegendStyles = Pick<StyleRoles, "legendLabel" | "legendTitle" | "tickLabel">;

/** The roles a panel's own style gives everything it draws. */
export type PanelStyles = Pick<
  StyleRoles,
  "plot" | "panelTitle" | "axisLine" | "tick" | "tickLabel" | "axisTitle" | "grid"
>;

/**
 * A theme's tokens: the colors its role styles are made from. Changing a
 * token changes every role that uses it (`muted` the tick labels, `axis` the
 * axis lines and ticks), unless a role sets its own.
 */
export interface ThemeTokens {
  /** The chart's background; "transparent" shows the page (or, in exports, what they are shown on). */
  background?: string;
  /** Titles and labels. */
  text?: string;
  /** Tick labels and secondary text. */
  muted?: string;
  /** Grid lines. */
  grid?: string;
  /** Axis lines and ticks. */
  axis?: string;
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
