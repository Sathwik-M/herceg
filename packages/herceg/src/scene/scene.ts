// The scene is the render plan: everything a renderer needs, in CSS pixels,
// with no reference to scales or the DOM. Mark geometry is packed (polylines
// in Float32Arrays) rather than one object per data point. The exception is
// a point cloud, which keeps references to its source columns so a GPU
// painter can upload them once and redraw them as the view changes.

import type { NumericArray } from "../data/column.ts";
import type { Mapping } from "../lod/m4.ts";
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

/**
 * Text labels of one mark, each centered on (or starting or ending at) its
 * point, vertically centered: x, y per label.
 */
export interface TextGeometry {
  kind: "text";
  key: string;
  fill: string;
  anchor: "start" | "middle" | "end";
  coords: Float32Array;
  labels: string[];
  count: number;
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
  /** x, y per point in CSS pixels; empty for a cloud. */
  coords: Float32Array;
  count: number;
  /** Set when the series is left to a GPU painter instead of `coords`. */
  cloud?: PointCloud;
}

/** Point series with at least this many points may be drawn as clouds. */
export const CLOUD_POINTS = 100_000;

/**
 * A large point series for a GPU painter: its source columns and how they
 * map to pixels. Positions [start, end) are drawn; values a scale cannot
 * place are skipped.
 */
export interface PointCloud {
  x: NumericArray;
  y: NumericArray;
  /** Rows of a long-format series; undefined when the series is whole columns. */
  rows: Uint32Array | undefined;
  start: number;
  end: number;
  xMap: Mapping;
  yMap: Mapping;
  /** Table version of the columns: with their identity, it tells whether uploaded copies are current. */
  version: number;
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
  | TextGeometry
  | RectGeometry
  | PointGeometry
  | RasterGeometry;

/**
 * Guides (rules and text) are drawn as SVG above the data, even when a canvas
 * draws the data, so they stay crisp and readable. They are not clipped to
 * the plot; their marks leave out what lies outside it.
 */
export function isGuide(mark: MarkGeometry): mark is RuleGeometry | TextGeometry {
  return mark.kind === "rule" || mark.kind === "text";
}

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
