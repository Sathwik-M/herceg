// The scene is the render plan: everything a renderer needs, in CSS pixels,
// with no reference to scales or the DOM. Mark geometry is packed (polylines
// in Float32Arrays) rather than one object per data point, and carries the
// drawing that renders it, so renderers know no geometry kinds. The
// exception to packing is a point cloud, which keeps references to its
// source columns so a GPU painter can upload them once and redraw them as
// the view changes.

import type { NumericArray } from "../data/column.ts";
import type { SymbolName } from "../draw/symbols.ts";
import type { Mapping } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { Theme } from "../theme.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How one kind of geometry is drawn. A mark attaches the drawing to the
 * geometry it emits, so a bundle carries drawing code only for the marks it
 * uses, and custom marks can bring their own. Members are function
 * properties rather than methods so that a drawing only fits geometry of its
 * own type.
 */
export type Drawing<G extends Geometry> = DataDrawing<G> | GuideDrawing<G>;

interface DrawingBase<G extends Geometry> {
  /** Points or cells drawn, for choosing between SVG and Canvas. */
  readonly size: (geometry: G) => number;
  /** SVG markup, for static output and for the live SVG layer without `elements`. */
  readonly svg: (geometry: G, context: SvgContext) => string;
  /**
   * The same output as `svg`, as a few elements whose attributes the live SVG
   * layer updates in place each frame; reparsing markup costs several times
   * more. Drawings of many elements (one circle per point) leave it out.
   */
  readonly elements?: (geometry: G, context: SvgContext) => SvgElement[] | undefined;
}

/** Data, drawn with the other marks in SVG or on a canvas, clipped to the plot. */
export interface DataDrawing<G extends Geometry> extends DrawingBase<G> {
  readonly guide?: false;
  /** Paints onto a canvas in CSS pixels, clipped to the plot. */
  readonly canvas: (context: CanvasRenderingContext2D, geometry: G, options: CanvasOptions) => void;
}

/**
 * Guides (rules, text) are drawn as SVG above the data, even when a canvas
 * draws the data, so they stay crisp and readable. They are not clipped to
 * the plot; their marks leave out what lies outside it.
 */
export interface GuideDrawing<G extends Geometry> extends DrawingBase<G> {
  readonly guide: true;
}

/**
 * A mark's part of the scene: an identity and the drawing that renders it.
 * Each geometry type pairs itself with a drawing of its own type (see
 * `LineGeometry`), which the compiler checks; `Geometry` erases that pairing
 * so renderers can hold any geometry, so build geometry as its own type.
 */
export interface Geometry {
  readonly kind: string;
  /** Unique within the scene. */
  readonly key: string;
  // biome-ignore lint/suspicious/noExplicitAny: the erasure point described above.
  readonly draw: Drawing<any>;
}

/** One SVG element: its tag and attribute values (unescaped). */
export interface SvgElement {
  tag: string;
  attributes: Record<string, string>;
}

export interface SvgContext {
  theme: Theme;
  /** Encodes raster pixels as an image URL; rasters are left out without one. */
  encodeRaster: ((raster: RasterGeometry) => string) | undefined;
}

export interface CanvasOptions {
  plot: Rect;
  pixelRatio: number;
  clouds: CloudOptions;
}

/** How point clouds are painted on a canvas. */
export interface CloudOptions {
  /** GPU painter; without one, or where it declines, points are placed on the CPU. */
  painter?: CloudPainter | undefined;
  /** The chart painting, which owns the painter's uploads. */
  owner?: object;
  /** Leave clouds out, as while the painter is still loading. */
  defer?: boolean;
}

/** Draws point clouds on the GPU (render/webgl.ts). */
export interface CloudPainter {
  /**
   * Draws a point geometry that has a cloud into `context`, over `plot`, for
   * the chart `owner`. Returns false when it cannot represent the cloud
   * (sizes or values beyond what the GPU path handles); the caller then
   * places the points on the CPU.
   */
  paint(
    context: CanvasRenderingContext2D,
    mark: PointGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean;
  /** Releases uploads `owner` did not paint since its last call (a frame). */
  endFrame(owner: object): void;
  /** Releases everything `owner` uploaded that no other chart uses. */
  release(owner: object): void;
  /** Bytes of point data currently uploaded. */
  readonly bytes: number;
  /** False once the browser has taken the GPU context away. */
  readonly usable: boolean;
}

export interface LineGeometry extends Geometry {
  kind: "line";
  draw: Drawing<LineGeometry>;
  stroke: string;
  strokeWidth: number;
  dash: readonly number[] | undefined;
  path: Polyline;
}

export interface AreaGeometry extends Geometry {
  kind: "area";
  draw: Drawing<AreaGeometry>;
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

export interface RuleGeometry extends Geometry {
  kind: "rule";
  draw: Drawing<RuleGeometry>;
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
export interface TextGeometry extends Geometry {
  kind: "text";
  draw: Drawing<TextGeometry>;
  fill: string;
  anchor: "start" | "middle" | "end";
  /** Outline each label in the background color, for text drawn over data. */
  halo: boolean;
  coords: Float32Array;
  labels: string[];
  count: number;
}

/** Line segments of one series, such as error bars: x1, y1, x2, y2 per segment. */
export interface SegmentGeometry extends Geometry {
  kind: "segments";
  draw: Drawing<SegmentGeometry>;
  stroke: string;
  strokeWidth: number;
  coords: Float32Array;
  count: number;
}

/** Rectangles of one series, such as bars: x, y, width, height per rectangle. */
export interface RectGeometry extends Geometry {
  kind: "rect";
  draw: Drawing<RectGeometry>;
  fill: string;
  fillOpacity: number;
  rects: Float32Array;
  count: number;
  /**
   * Bars' rounded value ends: a radius, and per rectangle which end is
   * rounded (draw/rect.ts: NONE, TOP, BOTTOM, LEFT, RIGHT).
   */
  rounded?: { radius: number; ends: Uint8ClampedArray } | undefined;
}

/** Circles of one series, such as scatter points: x, y per point. */
export interface PointGeometry extends Geometry {
  kind: "point";
  draw: Drawing<PointGeometry>;
  fill: string;
  fillOpacity: number;
  /**
   * The fill color is opaque and `fillOpacity` is 1, so overlapping points
   * look like one. Other points are drawn one by one so overlaps darken.
   */
  opaque: boolean;
  /** Radius in pixels; with `radii`, the largest. */
  radius: number;
  /** The shape of every point, unless `symbols` gives each its own. */
  symbol: SymbolName;
  /** x, y per point in CSS pixels; empty for a cloud. */
  coords: Float32Array;
  count: number;
  /** Per point, for points encoding fields: radius in pixels. */
  radii?: Float32Array | undefined;
  /** Per point: an index into `palette`, the colors of a continuous scale. */
  colors?: { index: Uint8ClampedArray; palette: readonly string[] } | undefined;
  /** Per point: fill opacity. */
  opacities?: Float32Array | undefined;
  /** Per point: an index into SYMBOLS. */
  symbols?: Uint8ClampedArray | undefined;
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
export interface RasterGeometry extends Geometry {
  kind: "raster";
  draw: Drawing<RasterGeometry>;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** One shape of a custom mark: path data in SVG syntax, with its style. */
export interface PathShape {
  d: string;
  /** Fill color, or "none". */
  fill: string;
  /** Stroke color; undefined for none. */
  stroke: string | undefined;
  /** Positive when there is a stroke. */
  strokeWidth: number;
  /** From 0 to 1, applied to fill and stroke separately. */
  opacity: number;
  dash: readonly number[] | undefined;
}

/** A text shape of a custom mark: vertically centered on `y`. */
export interface TextShape {
  text: string;
  x: number;
  y: number;
  fill: string;
  anchor: "start" | "middle" | "end";
}

/** Paths and text, such as a custom mark's, in drawing order, clipped to the plot. */
export interface ShapesGeometry extends Geometry {
  kind: "shapes";
  draw: Drawing<ShapesGeometry>;
  shapes: (PathShape | TextShape)[];
  /** CSS font of text shapes, and its size in pixels. */
  font: string;
  fontSize: number;
  /** Text shapes are semibold (weight 600), which `font` must say too: SVG and PDF read this. */
  bold?: boolean | undefined;
}

/**
 * Ring sectors, such as pie slices: center x and y, inner and outer radius,
 * and start and end angle (radians, clockwise from +x) per sector.
 */
export interface ArcGeometry extends Geometry {
  kind: "arc";
  draw: Drawing<ArcGeometry>;
  arcs: Float32Array;
  count: number;
  /** The colors sectors are filled with, and each sector's index into them. */
  colors: readonly string[];
  colorIndex: Uint32Array;
  fillOpacity: number;
  /** Space between neighboring sectors, in pixels. */
  gap: number;
}

/** The geometry of the built-in marks, for code that narrows by kind. */
export type MarkGeometry =
  | ArcGeometry
  | LineGeometry
  | AreaGeometry
  | RuleGeometry
  | TextGeometry
  | RectGeometry
  | PointGeometry
  | RasterGeometry
  | ShapesGeometry
  | SegmentGeometry;

export interface AxisTick {
  /** Pixel position along the axis. */
  position: number;
  label: string;
}

export interface AxisGeometry {
  orient: "bottom" | "left" | "right";
  /** The axis line: y for a bottom axis, x for a left or right axis. */
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
  /**
   * The swatch's shape for point series, as SVG path data centered on
   * (0, 0); otherwise the swatch is a rounded square.
   */
  glyph?: string | undefined;
  hidden: boolean;
  x: number;
  y: number;
}

/**
 * Legend of point sizes or shapes: a title, then glyphs in the theme's muted
 * color, each followed by its label. Glyphs are SVG path data centered on
 * (0, 0), drawn at (x, y); other positions are left edges, and `y` is the
 * middle of an item's row.
 */
export interface GlyphLegend {
  title: { text: string; x: number; y: number };
  entries: { glyph: string; x: number; y: number; label: { text: string; x: number } }[];
}

/**
 * Legend for a continuous color scale, on one row: title, low label, color
 * ramp, high label. Positions are left edges; `y` is the row's middle.
 */
export interface ColorLegend {
  stops: readonly string[];
  /**
   * Where the ramp's middle color sits, from 0 to 1, for diverging scales:
   * the midpoint's place between the low and high values. Stops below the
   * middle spread over the ramp up to it, the rest beyond.
   */
  middle?: number | undefined;
  y: number;
  title: { text: string; x: number };
  low: { text: string; x: number };
  high: { text: string; x: number };
  ramp: { x: number; width: number };
}

/**
 * One plotting area: its data, clipped to `plot`, its guides (rules and
 * text, drawn above all data and not clipped), and the grid and axes around it.
 */
export interface Panel {
  /** Unique within a scene and the same from one scene to the next. */
  key: string;
  /** Area inside the axes, where data is clipped. */
  plot: Rect;
  /** Pixel positions of vertical and horizontal grid lines. */
  grid: { x: number[]; y: number[] };
  axes: AxisGeometry[];
  /** Geometry in drawing order; guides among it are drawn above the rest. */
  marks: Geometry[];
  /** The panel's facet value, drawn above its plot, in charts with facets. */
  title?: { text: string; x: number; y: number } | undefined;
}

export interface Scene {
  width: number;
  height: number;
  pixelRatio: number;
  theme: Theme;
  title: { text: string; x: number; y: number } | undefined;
  /** Plotting areas; a chart without facets has one. */
  panels: Panel[];
  legend: LegendItem[];
  /** Legends of continuous color scales, one per distinct scale. */
  colorLegends: ColorLegend[];
  /** Legends of point sizes and shapes encoded by fields. */
  glyphLegends: GlyphLegend[];
  /** Points in all mark geometry after level-of-detail reduction. */
  vertices: number;
}

export const LEGEND_SWATCH = 10;

/** Where each stop of a color legend sits along its ramp, from 0 to 1: evenly, with the middle stop at `middle`. */
export function rampOffsets(legend: ColorLegend): number[] {
  const middle = legend.middle ?? 0.5;
  const last = Math.max(1, legend.stops.length - 1);
  return legend.stops.map((_, i) => {
    const t = i / last;
    return t <= 0.5 ? t * 2 * middle : middle + (t - 0.5) * 2 * (1 - middle);
  });
}
