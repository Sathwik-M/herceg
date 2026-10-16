// Portable layout types: where a chart's `panels` go. A layout is a grid of
// tracks whose cells hold panels or grids of their own, so that columns of
// relative widths, rows of relative heights, spans, and nesting are one
// mechanism. Insets are panels drawn over another panel's plot. Pixels are
// CSS pixels.

import type { Coordinate, Inside } from "./place.ts";
import type { StrokeStyle } from "./style.ts";

/**
 * The size of a row or column of a grid, as the plots of the panels on it
 * take it (their titles, axes, and legends take room beside them): a
 * weight relative to the other flexible tracks (a number, or `{ weight }`
 * with a least size `min` in pixels), or a fixed size (`{ px }`). Fixed
 * tracks keep their size; flexible ones share what is left by weight.
 */
export type TrackSpec = number | { weight: number; min?: number } | { px: number };

/** A layout: a grid of cells, or one panel. */
export type LayoutSpec = GridLayoutSpec | PanelLayoutSpec;

/**
 * Rows and columns of tracks, and the cells placed on them. Cells hold a
 * panel or another grid; a cell may span several tracks, may not overlap
 * another, and tracks may have no cell. Without `cells`, the chart's panels
 * not placed elsewhere fill the grid row by row, in order, with as many
 * rows (of weight 1) as they need.
 */
export interface GridLayoutSpec {
  type: "grid";
  /** Unique among the layout's grids; scale scopes name it (`{ layout, by }`). */
  id?: string;
  /** The rows, top to bottom; one row of weight 1 by default. */
  rows?: readonly TrackSpec[];
  /** The columns, left to right; one column of weight 1 by default. */
  columns?: readonly TrackSpec[];
  cells?: readonly LayoutCellSpec[];
  /** Pixels between rows and between columns: one for both, or each its own. 12 by default. */
  gap?: number | { row?: number; column?: number };
}

/** A cell of a grid: where it starts (from 0), how many tracks it spans (1 by default), and what it holds. */
export interface LayoutCellSpec {
  row: number;
  column: number;
  rowSpan?: number;
  columnSpan?: number;
  content: LayoutSpec;
}

/** A place for one of the chart's panels, named by its id, with the panels drawn over its plot. */
export interface PanelLayoutSpec {
  type: "panel";
  panel: string;
  insets?: readonly InsetSpec[];
}

/** A length of an inset: a fraction of its parent's plot, or pixels. */
export type InsetSize = { fraction: number } | { px: number };

/** The corner or middle of an inset placed at a position. */
export type InsetAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

/**
 * Where an inset goes on its parent's plot: at a corner or the middle of an
 * edge, `inset` pixels in (8 by default); or with its `anchor` (its
 * top-left corner by default) at a position given as fractions of the
 * parent's plot or of the chart, or pixels.
 */
export type InsetPlace =
  | { inside: Inside; inset?: number }
  | { at: InsetPosition; anchor?: InsetAnchor };

/** Where an inset's anchor goes: fractions of the parent's plot or the chart, or pixels, not data. */
export interface InsetPosition {
  x: Extract<Coordinate, { fraction: number } | { px: number }>;
  y: Extract<Coordinate, { fraction: number } | { px: number }>;
}

/**
 * A panel drawn over its parent's plot, its axes inside its own box (and
 * its titles, but for what of a long one runs past it), with scales of its
 * own unless a scope names it (insets are not part of a scale's "chart"
 * scope). It takes no room from the layout and does not widen its parent's
 * domains.
 */
export interface InsetSpec {
  /** The id of one of the chart's panels, placed nowhere else. */
  panel: string;
  /** At the parent plot's top right, 8 pixels in, by default. */
  place?: InsetPlace;
  /** 35% of the parent's plot by default. */
  width?: InsetSize;
  height?: InsetSize;
  /**
   * A box on the parent's plot around the inset's x and y ranges, with
   * lines to the inset's corners: `true`, or how it looks. Needs number or
   * time axes of the same kind in both.
   */
  indicator?: boolean | InsetIndicatorSpec;
  /** Panels drawn over this inset's plot. */
  insets?: readonly InsetSpec[];
}

/** How an inset's indicator looks: its box's line and whether lines join it to the inset. */
export interface InsetIndicatorSpec {
  /** Lines from the box to the inset's nearest corners; true by default. */
  connectors?: boolean;
  style?: StrokeStyle;
}
