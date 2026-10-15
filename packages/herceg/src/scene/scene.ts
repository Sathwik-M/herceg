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
import type { Clip } from "../spec/spec.ts";
import type { PlotPaint, ResolvedHalo, StrokePaint, TextPaint } from "../style/style.ts";
import type { Theme } from "../theme.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A plot's area in CSS pixels, as applications read it (in a custom mark's
 * `draw`, and in a chart's panels): read-only, since the chart draws with it.
 */
export interface PlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  /**
   * For a drawing of the geometry's own drawing faded or clipped (a
   * highlight's): the fraction of its opacity it is drawn at, and the
   * rectangles (x, y, width, height each) it is drawn within, for
   * renderers that draw geometry from its fields (PDF).
   */
  readonly opacity?: number | undefined;
  readonly clip?: readonly number[] | undefined;
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
  /** What the drawing is cut to, as its mark's `clip` says; see `clipOf`. */
  readonly clip?: Clip | undefined;
  /** For geometry of a series with a key of its own (a line's markers), the series' key. */
  readonly of?: string | undefined;
}

/**
 * What a geometry is cut to: its mark's `clip`, or by default data to its
 * panel's plot and guides to nothing. Data not cut to the plot is drawn
 * above the data that is, guides above both.
 */
export function clipOf(geometry: Geometry): Clip {
  return geometry.clip ?? (geometry.draw.guide ? false : "plot");
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
  /**
   * Draws a 3D chart (a faces geometry with `batches`) with a depth test,
   * as `paint` draws 2D clouds; false when it cannot.
   */
  paint3d?(
    context: CanvasRenderingContext2D,
    mark: FaceGeometry,
    plot: Rect,
    pixelRatio: number,
    owner: object,
  ): boolean;
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
  /** The outline's opacity, from 0 to 1; 1 when absent. */
  strokeOpacity?: number | undefined;
  /**
   * For layers of a monotone band or stack in scenes of charts that animate
   * changed values: how the mark curves their shared edges together, which
   * frames between two scenes do again (marks/trace.ts `curveLayers`).
   */
  curve?: CurveLayers | undefined;
}

/** Curves layers' edges through x positions and their boundaries' positions (see `curveLayers`). */
export type CurveLayers = (
  xs: Float64Array,
  positions: readonly Float64Array[],
  tangents: readonly Float64Array[],
  curves: Float64Array,
  edges: readonly { upper: Polyline; lower: Polyline }[],
  drawn: (layer: number, i: number) => boolean,
) => void;

export interface RuleGeometry extends Geometry {
  kind: "rule";
  draw: Drawing<RuleGeometry>;
  stroke: string;
  strokeWidth: number;
  dash: readonly number[] | undefined;
  /** The stroke's opacity, from 0 to 1; 1 when absent. */
  opacity?: number | undefined;
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
  /** The outline drawn under each label, for text over data; none when undefined. */
  halo: ResolvedHalo | undefined;
  coords: Float32Array;
  labels: string[];
  count: number;
}

/**
 * Labels in styles of their own (fonts, sizes, boxes behind them), placed:
 * text items as guides draw them, which renderers draw as they are.
 */
export interface LabelsGeometry extends Geometry {
  kind: "labels";
  draw: Drawing<LabelsGeometry>;
  items: readonly TextItem[];
}

/** Line segments of one series, such as error bars: x1, y1, x2, y2 per segment. */
export interface SegmentGeometry extends Geometry {
  kind: "segments";
  draw: Drawing<SegmentGeometry>;
  stroke: string;
  strokeWidth: number;
  /** Dash pattern in CSS pixels; absent or empty for solid segments. */
  dash?: readonly number[];
  /** From 0 to 1; 1 when absent. */
  opacity?: number | undefined;
  coords: Float32Array;
  count: number;
}

/** Rectangles of one series, such as bars: x, y, width, height per rectangle. */
export interface RectGeometry extends Geometry {
  kind: "rect";
  draw: Drawing<RectGeometry>;
  fill: string;
  fillOpacity: number;
  /** An outline of every rectangle (bars' edges): its color, width, opacity, and dash. */
  edge?: { stroke: string; width: number; opacity: number; dash: readonly number[] | undefined };
  rects: Float32Array;
  count: number;
  /**
   * Bars' rounded value ends: a radius, and per rectangle which end is
   * rounded (draw/rect.ts: NONE, TOP, BOTTOM, LEFT, RIGHT).
   */
  rounded?: { radius: number; ends: Uint8ClampedArray } | undefined;
  /** Bars in scenes of charts that animate changed values: what identifies each and where it ends. */
  bars?: BarItems | undefined;
}

/**
 * What a value transition (`animation.values`) needs of a series' bars,
 * which marks give only in scenes of charts that ask for it. Per rectangle:
 * the position it stands at, which identifies it in its series (a band
 * index on a category axis, else the value), and where it starts and ends
 * along the value axis, which its rectangle does not say: root (its base)
 * and tip (its value), in pixels.
 */
export interface BarItems {
  /** Positions on y, lengths along x. */
  horizontal: boolean;
  at: Float64Array;
  /** Root and tip per rectangle. */
  span: Float32Array;
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
  /**
   * Per point: an index into `palette`, the colors of a continuous scale, or
   * with `categorical`, the colors of a category field's values.
   */
  colors?: { index: Uint8ClampedArray; palette: readonly string[]; categorical?: true } | undefined;
  /** Per point: fill opacity. */
  opacities?: Float32Array | undefined;
  /** Per point: an index into SYMBOLS. */
  symbols?: Uint8ClampedArray | undefined;
  /**
   * A ring around each point, such as a map's points over its regions:
   * points with one are drawn one by one, each ring over its point, so
   * rings keep overlapping points apart.
   */
  ring?: { color: string; width: number; opacity?: number } | undefined;
  /** Set when the series is left to a GPU painter instead of `coords`. */
  cloud?: PointCloud;
  /** Points in scenes that animate changed values: their row identities or explicit keys. */
  items?: PointItems | undefined;
}

/**
 * Animation identity captured with positions, only in scenes that animate:
 * rows until a reset, or explicit key values that survive resets. Category
 * labels are string references, independent of later dictionary changes.
 */
export type PointItems = {
  table: object;
  generation: number;
} & (
  | { ids: Float64Array; key?: undefined }
  | { ids: Float64Array; key: { field: string; kind: "number" | "time" } }
  | { ids: readonly (string | undefined)[]; key: { field: string; kind: "category" } }
);

/** Point series with at least this many points may be drawn as clouds. */
export const CLOUD_POINTS = 100_000;

/**
 * In scenes of charts that animate changed values, series of more bars or
 * points than these say nothing of them (no BarItems or PointItems): value
 * transitions move no more than these in a chart (dom/value-transition.ts).
 */
export const MOVING_BARS = 2000;
export const MOVING_POINTS = 10_000;

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
  /**
   * For whole columns of a table, or a series' rows as their group follows
   * the table: one object per table and field pair (or group), how many
   * points have left the front (the columns' `rowOffset`, or the rows the
   * group dropped), and the table's `modifiedVersion`. Uploaded copies then
   * take appended points and drop the first ones as the table streams,
   * instead of being uploaded again.
   */
  stream?: { key: object; offset: number; modified: number } | undefined;
}

/**
 * A grid of colored cells drawn as an image: `columns x rows` RGBA pixels,
 * row 0 at the top, stretched over the destination rectangle. A pixel is
 * one cell, or for grids larger than the plot's pixels, a block of cells.
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
  /**
   * For sectors that are parts of others along their radius (a selection's
   * share of a slice): each one's whole's outer radius, which its gap is
   * resolved at, so that the parts keep the whole's sides.
   */
  rims?: Float32Array | undefined;
  /** A pie's slices in scenes of charts that animate changed values. */
  slices?: PieSlices | undefined;
}

/** One slice of a pie: its key (the item's), its category, and the value it sums. */
export interface PieSlice {
  key: string;
  label: string;
  value: number;
}

/**
 * What a value transition (`animation.values`) needs of a pie, which it
 * gives only in scenes of charts that ask for it: its slices in order, where
 * each ends, its size, and how it draws other slices, so that frames between
 * two scenes draw sectors, leaders, and labels as the pie does.
 */
export interface PieSlices {
  items: readonly PieSlice[];
  /** Each slice's end, as a fraction of the turn clockwise from the top. */
  ends: Float64Array;
  cx: number;
  cy: number;
  /** Outer radius, in pixels. */
  r: number;
  /** Whether labels are drawn beside the slices. */
  labeled: boolean;
  /** The pie's sectors, leaders, and labels with `items` ending at `ends`, out to radius `r`. */
  draw(items: readonly PieSlice[], ends: Float64Array, r: number, labeled: boolean): Geometry[];
}

/** One shape of a polygons geometry: rings of points, filled together. */
export interface PolygonShape {
  /** x, y per point in CSS pixels. */
  coords: Float32Array;
  /** Where each ring starts, in points, and where the last one ends. */
  rings: Uint32Array;
  /** SVG path data of the rings, kept once made: the same shape is drawn again as colors change. */
  path: string | undefined;
}

/**
 * Filled polygons, such as a map's regions: each shape's rings filled
 * together with the even-odd rule (so holes stay empty), then bordered.
 */
export interface PolygonGeometry extends Geometry {
  kind: "polygons";
  draw: Drawing<PolygonGeometry>;
  shapes: readonly PolygonShape[];
  /** The colors shapes are filled with, and each shape's index into them. */
  colors: readonly string[];
  colorIndex: Uint32Array;
  fillOpacity: number;
  stroke: string;
  /** 0 for no border. */
  strokeWidth: number;
  /**
   * Where the shapes' points are drawn when not where they are (a map
   * zoomed or panned, which reuses shapes projected at a nearby scale):
   * x + k * a point's x, y + k * its y. Borders keep their width.
   */
  transform?: ShapeTransform | undefined;
}

/** A uniform scale and a move: a point (px, py) lands at (x + k px, y + k py). */
export interface ShapeTransform {
  k: number;
  x: number;
  y: number;
}

/** How faces of one style are drawn. */
export interface FaceStyle {
  fill: string;
  /** From 0 to 1. */
  opacity: number;
  /** The radius of the style's discs, in pixels. */
  radius: number;
  /** Polygons' outline color, or undefined for none. */
  stroke: string | undefined;
  strokeWidth: number;
}

/**
 * Polygons and discs over shared vertices, drawn in order: a 3D chart's
 * surface cells and points, back to front. A face of one corner is a disc;
 * a polygon is filled as a fan of triangles from its first corner, each
 * turned the same way, so a cell folded edge-on covers what its triangles
 * do, and its outline is stroked after.
 */
export interface FaceGeometry extends Geometry {
  /** Optional owner of a panel's latest CPU raster, reused per Canvas target. */
  rasterOwner?: object;
  kind: "faces";
  draw: Drawing<FaceGeometry>;
  /** x, y per vertex in CSS pixels. */
  vertices: Float32Array;
  /** Vertex indices of every face's corners, face after face in drawing order. */
  corners: Uint32Array;
  /** Where each face's corners start in `corners`; entry `count` ends the last face. */
  starts: Uint32Array;
  count: number;
  /** Each face's index into `styles`. */
  style: Uint16Array;
  styles: readonly FaceStyle[];
  /** Set when a GPU painter draws the chart instead of these faces (see Batches3D). */
  batches?: Batches3D | undefined;
}

/** One layer of a 3D chart for a GPU painter (render/webgl3d.ts). */
export type Batch3D = PointBatch3D | LineBatch3D | TriangleBatch3D;

/** Points: the layer's source columns, placed by the axes' mappings, and each row's color. */
export interface PointBatch3D {
  kind: "points";
  /** Values per row, as the table holds them. */
  x: NumericArray;
  y: NumericArray;
  z: NumericArray;
  /** Table version of the columns: with their identity, it tells whether uploaded copies are current. */
  version: number;
  /** Per row: an index into `palette`, or 255 for rows not drawn. */
  style: Uint8Array;
  /** CSS colors, opaque. */
  palette: readonly string[];
  radius: number;
}

/**
 * Paths drawn as ribbons a constant width on screen: runs of points in the
 * box, each one's style saying how the segment to the next is drawn.
 */
export interface LineBatch3D {
  kind: "lines";
  /** The same object while `arrays()` gives the same arrays. */
  key: object;
  /** Segments drawn: what drawing them on the CPU would cost. */
  segments: number;
  /** CSS colors, opaque. */
  palette: readonly string[];
  /** In CSS pixels. */
  width: number;
  arrays(): LineArrays;
}

export interface LineArrays {
  /**
   * x, y, z per point in the box's normalized coordinates, inside it:
   * segments reaching past the box are cut at its walls, in float64.
   */
  positions: Float32Array;
  /** Per point: the index into `palette` of the segment to the next; 255 for none. */
  style: Uint8Array;
}

/**
 * Triangles of flat colors, lit as a whole cell is: a surface's cells. Each
 * triangle takes its color and normal from its last vertex, as WebGL's flat
 * attributes do.
 */
export interface TriangleBatch3D {
  kind: "triangles";
  /** The same object while `arrays()` gives the same arrays. */
  key: object;
  /** Cells drawn: what drawing them on the CPU would cost. */
  cells: number;
  /**
   * RGBA bytes of the colors cells take: 256 per shading level, `levels`
   * levels (1 for unshaded surfaces), from facing the light least to most.
   */
  shades: Uint8Array;
  levels: number;
  /** Steps of the depth buffer the triangles are drawn back by, so points and lines lying on them show. */
  behind: number;
  arrays(): TriangleArrays;
}

export interface TriangleArrays {
  /** x, y, z per vertex, in the box's normalized coordinates. */
  positions: Float32Array;
  /** Per vertex: the unit normal (in the box's units) of the triangles ending at it; zero where degenerate. */
  normals: Float32Array;
  /** Per vertex: the color (an index into a level of `shades`) of the triangles ending at it. */
  colors: Uint8Array;
  /** Three vertices per triangle. */
  indices: Uint16Array | Uint32Array;
}

/**
 * A 3D chart for a GPU painter, which draws every layer with one depth
 * test rather than in order: the layers, how each axis maps values into the
 * box (as a scale's mapping onto -1 to 1) for points, the view, and the light.
 */
export interface Batches3D {
  batches: readonly Batch3D[];
  /** The axes' mappings, where every axis has one (category axes do not); point layers need them. */
  axes: readonly [Mapping, Mapping, Mapping] | undefined;
  /** Screen x and y, and depth, per normalized coordinate: right x, y; up x, y, z; eye x, y, z. */
  view: Float64Array;
  cx: number;
  cy: number;
  scale: number;
  /** The eye's distance in perspective; Infinity when orthographic. */
  distance: number;
  /** Toward the light, a unit vector in the box's units. */
  light: readonly [number, number, number];
  /**
   * The same chart as faces in drawing order, made when a canvas draws it
   * without a GPU. `lost` when the painter lost its context: marks too large
   * for the CPU leave theirs out until a fresh painter draws them.
   */
  faces(lost?: boolean): FaceGeometry;
}

/** The geometry of the built-in marks, for code that narrows by kind. */
export type MarkGeometry =
  | ArcGeometry
  | LineGeometry
  | AreaGeometry
  | RuleGeometry
  | TextGeometry
  | LabelsGeometry
  | RectGeometry
  | PointGeometry
  | RasterGeometry
  | ShapesGeometry
  | SegmentGeometry
  | PolygonGeometry
  | FaceGeometry;

export interface AxisTick {
  /** Pixel position along the axis. */
  position: number;
  label: string;
}

/**
 * Text at its final place, as every renderer draws it: anchored at (x, y)
 * by its start, middle, or end and its baseline, turned `angle` degrees
 * clockwise about that point.
 */
export interface TextItem {
  readonly type: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: "start" | "middle" | "end";
  readonly baseline: "middle" | "hanging" | "alphabetic";
  readonly angle: number;
  readonly paint: TextPaint;
  /** Drawn at this share of the paint's opacity, as a hidden series' legend entry is. */
  readonly opacity?: number | undefined;
  /** The outline drawn under the text, resolved against what it is drawn on. */
  readonly halo?: ResolvedHalo | undefined;
  /** The paint's background box, padded around the text, before any turn. */
  readonly box?: Rect | undefined;
}

/** Straight lines in one stroke: x1, y1, x2, y2 per segment. */
export interface SegmentsItem {
  readonly type: "segments";
  readonly coords: readonly number[];
  readonly paint: StrokePaint;
}

/** A shape in SVG path data drawn about `at`, such as a legend's glyph. */
export interface ShapeItem {
  readonly type: "shape";
  readonly d: string;
  readonly at: readonly [number, number];
  readonly fill: string;
  readonly fillOpacity?: number | undefined;
  /** An outline 1 pixel wide, with round joins. */
  readonly stroke?: string | undefined;
  readonly opacity?: number | undefined;
}

/** A rectangle, rounded by `radius`. */
export interface RectItem {
  readonly type: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly fill: string;
  readonly opacity?: number | undefined;
}

/**
 * A rectangle filled with a color ramp from left to right: each stop at its
 * offset, from 0 to 1.
 */
export interface RampItem {
  readonly type: "ramp";
  /** Ramps up from the bottom, as a vertical colorbar does, rather than left to right. */
  readonly vertical?: boolean | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly stops: readonly string[];
  readonly offsets: readonly number[];
}

/** What guides are drawn of: placed text, lines, shapes, rectangles, and ramps. */
export type GuideItem = TextItem | SegmentsItem | ShapeItem | RectItem | RampItem;

/**
 * Chart furniture at its final place: what renderers draw (`items`, in
 * order) and, by kind, what the runtime and tests read of it. Renderers
 * draw the items and compute no positions of their own.
 */
export interface GuideBase {
  /** Unique within the scene and the same from one scene to the next. */
  readonly key: string;
  readonly items: readonly GuideItem[];
}

/**
 * Where an axis is drawn and how it looks, everything its items are made
 * from: other ticks are placed the same way (`axisItems`), as a change of
 * view playing places the ticks between two scenes.
 */
export interface AxisPlacement {
  /**
   * Below the plot, an x axis, which draws its line and tick marks; beside
   * it, a y axis, which draws neither; axes the guides list on any side.
   */
  readonly side: "top" | "bottom" | "left" | "right";
  /** The axis' line: y for an axis below the plot, x for one beside it. */
  readonly edge: number;
  /** Its extent along its direction, from the plot's start to its end. */
  readonly start: number;
  readonly end: number;
  readonly tickLength: number;
  /** Pixels from the line to the near edge of the labels. */
  readonly gap: number;
  /** What the labels and title are drawn on, for their halos: the chart's background. */
  readonly surface: string;
  readonly paints: {
    readonly line: StrokePaint;
    readonly tick: StrokePaint;
    readonly label: TextPaint;
    readonly title: TextPaint;
  };
}

/** An axis of a panel: its scale's ticks along one side of the plot, and its title. */
export interface AxisGuide extends GuideBase, AxisPlacement {
  readonly kind: "axis";
  /**
   * The ids of the tick layers an axis the guides list draws ("major"
   * first); such axes keep their items while a change of values plays.
   */
  readonly layers?: readonly string[] | undefined;
  /** The scale it shows: "x", "y", or "yRight". */
  readonly scale: string;
  readonly ticks: readonly AxisTick[];
  /** Its title: at (x, y), the side of the text `anchor` says (its middle by default). */
  readonly title:
    | { text: string; x: number; y: number; anchor?: TextItem["anchor"] | undefined }
    | undefined;
}

/** The chart's title. */
export interface TitleGuide extends GuideBase {
  readonly kind: "title";
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/**
 * A panel's title or a facet panel's header (a grid's column and row
 * values too): centered vertically on `y`, starting at, centered on, or
 * ending at `x`, and turned `angle` degrees clockwise about that point.
 */
export interface HeaderGuide extends GuideBase {
  readonly kind: "header";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: "start" | "middle" | "end";
  readonly angle: 0 | 90;
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
  /** The glyph's outline color, drawn 1 pixel wide, for outlined points. */
  stroke?: string | undefined;
  /** The series keys the entry hides and shows, when not its own key. */
  targets?: readonly string[] | undefined;
  /**
   * A swatch drawn as the marks look (a dashed line, a symbol), in place
   * of the square or glyph: its items, centered vertically on 0 and
   * starting at 0, and the room it takes, the same for a legend's entries.
   */
  sample?:
    | { readonly width: number; readonly height: number; readonly items: readonly GuideItem[] }
    | undefined;
  hidden: boolean;
  x: number;
  y: number;
}

/**
 * The series legend: an entry per series, each a swatch then its label, at
 * (x, y), its left edge and middle. The browser draws it as buttons from
 * `entries`, in the label's style; static output draws `items`.
 */
export interface LegendGuide extends GuideBase {
  readonly kind: "legend";
  readonly entries: readonly LegendItem[];
  readonly label: TextPaint;
  /** The labels' halo over what the legend is drawn on. */
  readonly halo: ResolvedHalo | undefined;
}

/**
 * The legend of a continuous color scale, on one row: title, low label,
 * color ramp, high label. Positions are left edges; `y` is the row's middle.
 */
export interface RampGuide extends GuideBase {
  readonly kind: "ramp";
  readonly stops: readonly string[];
  /**
   * Where the ramp's middle color sits, from 0 to 1, for diverging scales:
   * the midpoint's place between the low and high values. Stops below the
   * middle spread over the ramp up to it, the rest beyond.
   */
  readonly middle: number | undefined;
  readonly y: number;
  readonly title: { text: string; x: number };
  readonly low: { text: string; x: number };
  readonly high: { text: string; x: number };
  readonly ramp: { x: number; width: number };
  /**
   * SVG markup of its ramp item, which the shared writer leaves to the
   * marks with color ramps (see marks/legend-parts.ts) so other charts do
   * not carry it; `id` is unique in the document, for the gradient.
   */
  readonly rampMarkup: (item: RampItem, id: string) => string;
}

/**
 * A legend of point sizes, shapes, or category colors: a title, then glyphs
 * in their `fill` (or the theme's muted color), each followed by its label.
 * Glyphs are SVG path data centered on (0, 0), drawn at (x, y); other
 * positions are left edges, and `y` is the middle of an item's row.
 */
export interface KeyGuide extends GuideBase {
  readonly kind: "key";
  readonly title: { text: string; x: number; y: number };
  readonly entries: readonly {
    glyph: string;
    x: number;
    y: number;
    fill?: string;
    label: { text: string; x: number };
  }[];
}

/**
 * What a legend draws besides its entries that toggle series: its title,
 * and entries that toggle nothing (a shaded region's), drawn as items.
 */
export interface CaptionGuide extends GuideBase {
  readonly kind: "caption";
}

/**
 * A colorbar: a color scale's colors along its values, with ticks, labels,
 * and a title, drawn as items; it carries the SVG markup of its ramp, as a
 * ramp legend does.
 */
export interface ColorbarGuide extends GuideBase {
  readonly kind: "colorbar";
  readonly rampMarkup: (item: RampItem, id: string) => string;
}

/** Chart furniture outside panels' axes, in drawing order. */
export type Guide =
  | TitleGuide
  | HeaderGuide
  | LegendGuide
  | RampGuide
  | KeyGuide
  | CaptionGuide
  | ColorbarGuide;

/**
 * One plotting area: its data, clipped to `plot`, its guides (rules and
 * text, drawn above all data and not clipped), and the grid and axes around it.
 */
export interface Panel {
  /** Unique within a scene and the same from one scene to the next. */
  key: string;
  /** Area inside the axes, where data is clipped. */
  plot: Rect;
  /**
   * The plot's background, drawn under the grid lines, and its border,
   * drawn over the data; undefined when it has neither.
   */
  frame?: PlotPaint | undefined;
  /** Pixel positions of vertical and horizontal grid lines, and how each kind is drawn. */
  grid: {
    x: number[];
    y: number[];
    xPaint?: StrokePaint | undefined;
    yPaint?: StrokePaint | undefined;
  };
  axes: AxisGuide[];
  /** Geometry in drawing order; guides among it are drawn above the rest. */
  marks: Geometry[];
}

export interface Scene {
  width: number;
  height: number;
  pixelRatio: number;
  theme: Theme;
  /** Plotting areas; a chart without facets has one. */
  panels: Panel[];
  /** The title, panels' titles and headers, and legends, in drawing order. */
  guides: Guide[];
  /** Points in all mark geometry after level-of-detail reduction. */
  vertices: number;
}

export const LEGEND_SWATCH = 10;

/**
 * Pixels from an axis line to its tick labels' near edge. Larger text sits
 * further out, so that the lowest y label, centered on the bottom of the
 * plot, clears the x labels hanging below it.
 */
export function tickLabelGap(fontSize: number): number {
  return Math.max(8, Math.round(fontSize * 0.65));
}

/** Where each of `stops` sits along a ramp, from 0 to 1: evenly, with the middle stop at `middle`. */
export function rampOffsets(stops: readonly string[], middle = 0.5): number[] {
  const last = Math.max(1, stops.length - 1);
  return stops.map((_, i) => {
    const t = i / last;
    return t <= 0.5 ? t * 2 * middle : middle + (t - 0.5) * 2 * (1 - middle);
  });
}

/** A scene's guides of one kind, in drawing order. */
export function guidesOf<K extends Guide["kind"]>(
  scene: Pick<Scene, "guides">,
  kind: K,
): Extract<Guide, { kind: K }>[] {
  return scene.guides.filter((guide): guide is Extract<Guide, { kind: K }> => guide.kind === kind);
}
