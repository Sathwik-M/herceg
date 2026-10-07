// The scene is the render plan: everything a renderer needs, in CSS pixels,
// with no reference to data, scales, or the DOM. Mark geometry is packed
// (polylines in Float32Arrays) rather than one object per data point.

import type { Polyline } from "../lod/polyline.ts";
import type { Theme } from "../theme.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineGeometry {
  kind: "line";
  /** Series key, unique within the scene. */
  key: string;
  stroke: string;
  strokeWidth: number;
  dash: readonly number[] | undefined;
  path: Polyline;
}

export interface AreaGeometry {
  kind: "area";
  key: string;
  fill: string;
  fillOpacity: number;
  /** Top edge, left to right. */
  upper: Polyline;
  /** Bottom edge, left to right; when null the area closes at `baseline`. */
  lower: Polyline | null;
  baseline: number;
  /** Outline color for the top edge, or null for none. */
  stroke: string | null;
  strokeWidth: number;
}

export interface RuleGeometry {
  kind: "rule";
  key: string;
  stroke: string;
  strokeWidth: number;
  dash: readonly number[] | undefined;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string | undefined;
}

export type MarkGeometry = LineGeometry | AreaGeometry | RuleGeometry;

export interface AxisTick {
  /** Pixel position along the axis. */
  position: number;
  label: string;
}

export interface AxisGeometry {
  orient: "bottom" | "left";
  /** The axis line: y for a bottom axis, x for a left axis. */
  offset: number;
  /** Extent along the axis direction. */
  start: number;
  end: number;
  ticks: AxisTick[];
  /** Draw the axis line and tick marks (bottom axes) or only labels (left). */
  line: boolean;
  title: { text: string; x: number; y: number } | undefined;
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  hidden: boolean;
  x: number;
  y: number;
}

export interface Scene {
  width: number;
  height: number;
  pixelRatio: number;
  theme: Theme;
  /** Area inside the axes, where marks are clipped. */
  plot: Rect;
  title: { text: string; x: number; y: number } | undefined;
  /** Pixel positions of vertical and horizontal grid lines. */
  grid: { x: number[]; y: number[] };
  axes: AxisGeometry[];
  legend: LegendItem[];
  marks: MarkGeometry[];
  /** Points in all mark geometry after level-of-detail reduction. */
  vertices: number;
}

export const LEGEND_SWATCH = 10;
