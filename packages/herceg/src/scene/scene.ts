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

/** Rectangles of one series, such as bars: x, y, width, height per rectangle. */
export interface RectGeometry {
  kind: "rect";
  key: string;
  fill: string;
  fillOpacity: number;
  rects: Float32Array;
  count: number;
}

/** Circles of one series, such as scatter points: x, y per point. */
export interface PointGeometry {
  kind: "point";
  key: string;
  fill: string;
  fillOpacity: number;
  /**
   * The fill color is opaque and `fillOpacity` is 1, so overlapping points
   * look like one. Other points are drawn one by one so overlaps darken.
   */
  opaque: boolean;
  radius: number;
  coords: Float32Array;
  count: number;
}

/**
 * A grid of colored cells drawn as an image: `columns x rows` RGBA pixels,
 * row 0 at the top, stretched over the destination rectangle.
 */
export interface RasterGeometry {
  kind: "raster";
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export type MarkGeometry =
  | LineGeometry
  | AreaGeometry
  | RuleGeometry
  | RectGeometry
  | PointGeometry
  | RasterGeometry;

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

/**
 * Legend for a continuous color scale, on one row: title, low label, color
 * ramp, high label. Positions are left edges; `y` is the row's middle.
 */
export interface ColorLegend {
  stops: readonly string[];
  y: number;
  title: { text: string; x: number };
  low: { text: string; x: number };
  high: { text: string; x: number };
  ramp: { x: number; width: number };
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
  colorLegend: ColorLegend | undefined;
  marks: MarkGeometry[];
  /** Points in all mark geometry after level-of-detail reduction. */
  vertices: number;
}

export const LEGEND_SWATCH = 10;
