// Portable placement types: where titles, legends, and other chart furniture
// go (`Place`), and where a point is (`Position`, a `Coordinate` on each
// axis). Pixels are CSS pixels.

/** A side of the chart or of a panel's plot. */
export type Side = "top" | "right" | "bottom" | "left";

/** A corner or the middle of an edge of a plot or of the chart, inside it. */
export type Inside =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

/**
 * Outside the plots, on a side: in a track of its own, the room it takes
 * kept from the plots. With `scope: "chart"` (the default) it is beside the
 * whole figure, every panel included; with `scope: "panel"` beside the plot
 * of panel `panel` (the first one by default).
 */
export interface SidePlace {
  side: Side;
  /** Where along the side: its start (left or top), center, or end. */
  align?: "start" | "center" | "end";
  /** Pixels between it and what it is beside, more than the usual gap. */
  offset?: number;
  scope?: "chart" | "panel";
  /** With `scope: "panel"`, the key of the panel (a subplot's id, a facet's value). */
  panel?: string;
}

/**
 * Inside a plot, over what it draws, taking no room from it: at a corner or
 * the middle of an edge, `inset` pixels in (8 by default). With `scope:
 * "panel"` (the default) inside the plot of panel `panel` (the first one by
 * default); with `scope: "chart"`, inside the area every panel shares.
 */
export interface InsidePlace {
  inside: Inside;
  inset?: number;
  scope?: "chart" | "panel";
  /** With `scope: "panel"`, the key of the panel (a subplot's id, a facet's value). */
  panel?: string;
}

/** Where a guide goes: outside on a side, or inside a plot. */
export type Place = SidePlace | InsidePlace;

/**
 * A place along one axis. `data` is a value on a scale (a number, a time in
 * epoch milliseconds, or a category's value); `field` reads each row's
 * value; `fraction` is a share of a frame, 0 at its left or bottom and 1 at
 * its right or top, as in plots; `px` counts pixels from a frame's left or
 * top edge, down for y, as on screens. `scale` names the scale of `data` and
 * `field` ("x", "y", "yRight"; by default the axis' own), and `frame` the
 * box of `fraction` and `px` ("plot" by default). `offset` moves the result
 * by that many pixels, right for x and down for y. Only `data` and `field`
 * count toward a scale's domain.
 */
export type Coordinate =
  | { data: number | string; scale?: string; offset?: number }
  | { field: string; scale?: string; offset?: number }
  | { fraction: number; frame?: Frame; offset?: number }
  | { px: number; frame?: Frame; offset?: number };

/** The boxes `fraction` and `px` coordinates are measured in: a panel's plot, or the whole chart. */
export type Frame = "plot" | "chart";

/** A point: a coordinate on each axis, which may mix kinds (a data y at a fraction of the plot's width). */
export interface Position {
  x: Coordinate;
  y: Coordinate;
}
