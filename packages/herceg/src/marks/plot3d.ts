// 3D charts: the layers of one (`point3d` points, `line3d` lines, and
// `surface` surfaces) share a box, its axes, and the camera. The chart model
// draws a chart's layout marks as one, which for 3D charts is a `Plot3D`: it
// plans each axis over every layer's data and draws the layers together,
// either through a GPU painter, which draws them all with one depth test
// (large charts whose every layer it can draw: see GPU_FACES_3D), or as
// faces written into one buffer and drawn in one order, so a point behind a
// surface is hidden by it.
//
// The order of faces is exact for points alone (back to front) and for one
// surface with any points: a height field over a grid can only hide what
// lies beyond it from the eye, so its cells are drawn row by row and column
// by column from the far side, and each point among the cells at its place,
// before or after its own cell by which side of it the point is on. With
// several surfaces, everything is drawn back to front by the depth of its
// center, which can be wrong where surfaces come close or cross; lines are
// approximate too (see marks/line3d.ts).
//
// The keyboard, screen readers, and the pointer on a GPU painter's charts
// read the layers' data, never their faces.

import type { Table } from "../data/table.ts";
import { facesDrawing } from "../draw/faces.ts";
import { type Formatter, formatNumber, timeValueFormatter } from "../format/format.ts";
import type { Mapping } from "../lod/m4.ts";
import {
  type AxisContext,
  type AxisType,
  niceAxisDomain,
  planAxis,
  usableDomain,
  valueFormatter,
} from "../model/axis.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry, LegendPart } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { TIME_UNIT_MS } from "../scale/time.ts";
import type { Batch3D, Batches3D, FaceGeometry, Geometry, Rect } from "../scene/scene.ts";
import type { AxisSpec, CameraSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { type Axis3D, boxGeometry, boxMargin } from "../three/axes.ts";
import {
  type Camera,
  checkBoxAspect,
  checkCamera,
  DEFAULT_CAMERA,
  resolveCamera,
  View,
} from "../three/camera.ts";
import { FaceBuffer, FaceIndex } from "../three/faces.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
} from "./layout-mark.ts";
import { legendParts } from "./legend-parts.ts";
import type { ColorRamp, GlyphKey, MARK } from "./mark.ts";

export const AXES = ["x", "y", "z"] as const;
export type AxisName = (typeof AXES)[number];

/** What a layer's data is along one axis. */
export interface AxisData {
  field: string;
  kind: "number" | "time" | "category";
  /** For numbers and times: the extent of the finite values (positive ones on log axes). */
  extent: readonly [number, number] | undefined;
  /** For categories: those the rows hold, in dictionary order. */
  categories?: readonly string[];
}

/** A planned axis of a 3D chart: the box's view of it and how values read. */
export interface PlannedAxis extends Axis3D {
  name: AxisName;
  type: AxisType;
  /** Formats one value, as tooltips show it. */
  format: Formatter;
  /** For category axes: each category's index along the axis. */
  categories?: ReadonlyMap<string, number>;
  /** How values map onto -1 to 1, for numbers and times; GPU painters place points with it. */
  mapping?: Mapping;
  /** Equal for axes that place every value alike, so layers keep what they found for one. */
  key: string;
}

/** What a layer reads in a scene: the chart's frame, the box's view and axes, and the shared faces. */
export interface Frame3D extends LayoutFrame {
  view: View;
  axes: readonly [PlannedAxis, PlannedAxis, PlannedAxis];
  faces: FaceBuffer;
}

/** What a layer writes its faces with. */
export interface FaceFrame3D extends Frame3D {
  /** With one surface in the chart, the order of its cells, which places everything else. */
  rank: Ranker | undefined;
  /**
   * Whether the faces stand in for a GPU painter that lost its context:
   * layers too large for the CPU leave theirs out, rather than fail, until a
   * fresh painter draws them.
   */
  lost: boolean;
}

/** With one surface in a chart, the order of its cells that places everything else among them. */
export interface Ranker {
  /** The key of a point at normalized (x, y, z): faces are sorted by key, then by depth. */
  key(x: number, y: number, z: number): number;
  /** The surface's columns and rows, normalized: lines are cut at them, so each piece lies over one cell. */
  columns: Float64Array;
  rows: Float64Array;
}

/**
 * What a layer shows, read from its data rather than from faces, so the
 * keyboard, screen readers, and summaries cost no projecting or sorting.
 */
export interface Items3D {
  /** How many items the keyboard visits, in reading order. */
  count: number;
  /** An item, placed on screen for the frame's view. */
  item(index: number): LayoutItem;
  /** The place in reading order of the item keyed `key`; -1 if not drawn. */
  indexOf(key: string): number;
  summary(): string;
}

/** What a layer's faces show, read back for the pointer. */
export interface Placed3D {
  /** The item a face the layer wrote shows, with the pointer at (px, py). */
  itemOfFace(local: number, px: number, py: number): LayoutItem | undefined;
}

/** One layer of a 3D chart. */
export interface Layer3D extends LayoutMark {
  /** Tells 3D layers from other layout marks. */
  readonly dimensions: 3;
  /** The layer's data along axis `k`; `log` when the axis is logarithmic. */
  axisData(k: number, log: boolean): AxisData;
  /** Continuous color scales for the legend. */
  scales(theme: Theme, locale: string | undefined): [ColorRamp[], GlyphKey[]];
  /** A surface: what orders the chart's faces when it is the only one (see FaceFrame3D.rank). */
  ranker?(frame: Frame3D): Ranker;
  /**
   * The layer's items for the frame's view, from caches kept per chart and
   * per planned axes (stable while the data is), so turning the camera
   * rebuilds nothing.
   */
  items(frame: Frame3D): Items3D;
  /** Writes the layer's faces into `frame.faces`. */
  place(frame: FaceFrame3D): Placed3D;
  /** What a GPU painter draws of the layer; undefined when it cannot, and the chart is drawn on the CPU. */
  batch?(frame: Frame3D): Batch3D | undefined;
  /** The item a GPU painter shows at (px, py), or within reach of it, nearest the eye. */
  pick?(frame: Frame3D, px: number, py: number): Hit3D | undefined;
}

/** An item the pointer is on, and its depth there (larger is nearer). */
export interface Hit3D {
  item: LayoutItem;
  depth: number;
  /** Steps of the depth buffer a GPU painter draws it back by (a surface's, so marks on it show). */
  behind?: number;
}

export function isLayer3D(mark: LayoutMark): mark is Layer3D {
  return (mark as Partial<Layer3D>).dimensions === 3;
}

/**
 * The 3D chart a chart's layout marks draw, when they are all 3D layers;
 * throws for any other mark among them, repeated ids, and options 3D charts
 * do not take.
 */
export function joinLayers3D(
  marks: readonly LayoutMark[],
  config: ChartConfig,
  indices?: readonly number[],
  panel?: string,
): Plot3D {
  const other = marks.find((mark) => !isLayer3D(mark));
  if (other)
    throw new Error(
      `${marks[0]!.spec.type}: a 3D chart holds only point3d, line3d, and surface marks; draw "${other.spec.type}" marks in a chart of their own`,
    );
  const ids = new Set<string>();
  for (const { spec } of marks) {
    if (spec.id === undefined) continue;
    if (ids.has(spec.id)) throw new Error(`id: "${spec.id}" names two marks`);
    ids.add(spec.id);
  }
  if (config.camera) checkCamera(config.camera);
  const configured = config.panels?.list.find(({ id }) => id === panel)?.camera;
  if (configured) checkCamera(configured);
  if (config.boxAspect) checkBoxAspect(config.boxAspect);
  const zoom = config.interaction?.zoom;
  if (!config.panels && zoom !== undefined && typeof zoom !== "boolean")
    throw new Error(
      `chart interaction.zoom: expected true or false in a 3D chart; received ${JSON.stringify(zoom)}`,
    );
  if (!config.panels && config.yRight)
    throw new Error("chart yRight: 3D charts have no right y axis; drop it");
  if (!config.panels && config.x?.breaks)
    throw new Error("chart x.breaks: 3D axes have no breaks; drop them");
  return new Plot3D(marks as Layer3D[], config, indices, panel);
}

/** Dragging turns a 3D chart unless `interaction.rotate` is false, which its controls follow. */
const ORBIT: LayoutControls = {
  kind: "orbit",
  hint: "Shift with the arrow keys turns it, and plus and minus zoom.",
};

/** A chart's 3D layers, drawn in one box as one layout mark. */
export class Plot3D implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: { type: "plot3d"; panel?: string };
  readonly indices: readonly number[];
  readonly table = undefined;
  readonly otherTables: readonly Table[];
  readonly measure: string;
  readonly layers: readonly Layer3D[];
  readonly #config: ChartConfig;
  /** This chart's faces, reused from scene to scene. */
  readonly #faces = new FaceBuffer();
  /** The axes, and the table versions they were planned for. */
  #axes: { key: string; axes: readonly [PlannedAxis, PlannedAxis, PlannedAxis] } | undefined;

  constructor(
    layers: readonly Layer3D[],
    config: ChartConfig,
    indices?: readonly number[],
    panel?: string,
  ) {
    this.spec = { type: "plot3d", ...(panel !== undefined && { panel }) };
    this.indices = indices ?? layers.map((_, i) => i);
    this.layers = layers;
    this.#config = config;
    this.otherTables = layers.flatMap((layer) => [
      ...(layer.table ? [layer.table] : []),
      ...(layer.otherTables ?? []),
    ]);
    this.measure = layers[0]?.measure ?? "";
  }

  /** A layer's identity: its `id`, or its place among the layers. */
  #id(index: number): string | number {
    return this.layers[index]!.spec.id ?? this.indices[index]!;
  }

  /** The wheel magnifies the camera, which dragging turns. */
  readonly interactions = ["zoom"] as const;

  controls(): LayoutControls {
    return ORBIT;
  }

  camera(spec: CameraSpec | undefined, base?: Camera): Camera {
    if (spec) checkCamera(spec);
    return resolveCamera(spec, base);
  }

  legend(_id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    return this.layers.flatMap((layer, i) => layer.legend(this.#id(i), color, theme));
  }

  /** Every layer's scales, each with a legend of its own. */
  legends(theme: Theme, locale: string | undefined): LegendPart[] {
    return this.layers.flatMap((layer) => legendParts(...layer.scales(theme, locale)));
  }

  /**
   * The chart's x, y, and z axes, planned over every layer's data once per
   * version of their tables, so layers can key what they keep by them.
   */
  axes(): readonly [PlannedAxis, PlannedAxis, PlannedAxis] {
    const key = this.otherTables.map((table) => table.version).join();
    if (this.#axes?.key === key) return this.#axes.axes;
    const config = this.#config;
    const axes = AXES.map((name, k) => planAxis3D(name, k, this.layers, config[name], config)) as [
      PlannedAxis,
      PlannedAxis,
      PlannedAxis,
    ];
    this.#axes = { key, axes };
    return axes;
  }

  /** Only the latest subplot view is retained; standalone GPU scenes keep their existing path. */
  #drawn: { key: string; measure: LayoutFrame["measure"]; result: LayoutResult } | undefined;

  draw(frame: LayoutFrame): LayoutResult {
    const { theme, measure, bounds } = frame;
    const key = frame.inPanel
      ? JSON.stringify([
          this.otherTables.map((table) => table.version),
          frame.camera,
          bounds,
          theme,
          frame.locale,
          [...frame.hidden],
        ])
      : "";
    if (frame.inPanel && this.#drawn?.key === key && this.#drawn.measure === measure)
      return this.#drawn.result;
    const axes = this.axes();
    const view = new View(
      frame.camera ?? DEFAULT_CAMERA,
      boxRoom(bounds, theme),
      this.#config.boxAspect,
    );
    const base = { ...frame, view, axes, faces: this.#faces };
    const box = boxGeometry(view, axes, theme, measure, bounds);
    const batches = frame.clouds && !frame.inPanel ? this.#batches(base) : undefined;
    // A GPU painter draws large charts; their faces are made only for a
    // canvas the painter cannot draw on. The keyboard and summaries read the
    // layers' data, and the pointer finds what the painter drew from it too.
    let placed: { lost: boolean; placed: Placed } | undefined;
    const place = (lost = false) => {
      if (placed?.lost !== lost) placed = { lost, placed: this.#place(base, lost) };
      return placed.placed;
    };
    let reading: Reading | undefined;
    const read = () => {
      reading ??= this.#read(base);
      return reading;
    };
    let onCpu = batches === undefined;
    const faces = (lost = false) => {
      onCpu = true;
      return place(lost).drawn;
    };
    const drawn: FaceGeometry = batches ? { ...EMPTY, batches: { ...batches, faces } } : faces();
    if (frame.inPanel) drawn.rasterOwner = this.#faces;
    const geometry: Geometry[] = [...box.lines, drawn, ...box.labels];
    const result: LayoutResult = {
      geometry,
      // The pointer reads what drew the scene: the faces as they were placed, or the GPU's data.
      itemAt: (px, py) =>
        onCpu ? place(placed?.lost ?? false).itemAt(px, py) : this.#pick(base, px, py),
      get count() {
        return read().count;
      },
      item: (i) => read().item(i),
      indexOf: (key) => read().indexOf(key),
      summary: () => {
        const parts = read().layers.map((layer) => layer.summary());
        const ranges = axes
          .filter((axis) => axis.ticks.length > 0)
          .map(
            (axis) =>
              `${axis.title || axis.name} from ${axis.labels[0]} to ${axis.labels[axis.labels.length - 1]}`,
          );
        const { azimuth, elevation } = view.camera;
        parts.push(
          `Axes: ${ranges.join("; ")}. Seen from azimuth ${Math.round(azimuth)}°, elevation ${Math.round(elevation)}°.`,
        );
        return parts.join(" ");
      },
    };
    if (frame.inPanel) this.#drawn = { key, measure, result };
    return result;
  }

  /** Every layer's items, one layer after another, in reading order. */
  #read(base: Omit<Frame3D, "id">): Reading {
    const layers = this.layers.map((layer, i) => layer.items({ ...base, id: this.#id(i) }));
    const starts = [0];
    for (const layer of layers) starts.push(starts[starts.length - 1]! + layer.count);
    const layerOf = (index: number) => {
      let l = 0;
      while (index >= starts[l + 1]!) l++;
      return l;
    };
    return {
      layers,
      count: starts[layers.length]!,
      item(i) {
        const l = layerOf(i);
        return { ...layers[l]!.item(i - starts[l]!), layer: l };
      },
      indexOf(key) {
        for (let l = 0; l < layers.length; l++) {
          const at = layers[l]!.indexOf(key);
          if (at >= 0) return starts[l]! + at;
        }
        return -1;
      },
    };
  }

  /**
   * The chart for a GPU painter: when every layer gives a batch (it is
   * opaque, and of what the painter draws) and drawing them all on the CPU
   * would cost at least GPU_FACES_3D faces.
   */
  #batches(frame: Omit<Frame3D, "id">): Omit<Batches3D, "faces"> | undefined {
    const batches: Batch3D[] = [];
    let cost = 0;
    for (const [i, layer] of this.layers.entries()) {
      const batch = layer.batch?.({ ...frame, id: this.#id(i) });
      if (!batch) return undefined;
      batches.push(batch);
      cost +=
        batch.kind === "points"
          ? batch.x.length
          : batch.kind === "lines"
            ? batch.segments
            : CELL_COST * batch.cells;
    }
    if (cost < GPU_FACES_3D) return undefined;
    const mappings = frame.axes.map((axis) => axis.mapping);
    const axes = mappings.every((m) => m !== undefined)
      ? (mappings as [Mapping, Mapping, Mapping])
      : undefined;
    // Points are placed by the axes' mappings.
    if (!axes && batches.some((batch) => batch.kind === "points")) return undefined;
    const { view } = frame;
    return {
      batches,
      axes,
      view: view.matrix,
      cx: view.cx,
      cy: view.cy,
      scale: view.scale,
      distance: view.distance,
      light: view.light,
    };
  }

  /** What a GPU painter shows at (px, py): of the layers' items there, the nearest the eye. */
  #pick(base: Omit<Frame3D, "id">, px: number, py: number): LayoutItem | undefined {
    let best: Hit3D | undefined;
    let layer = -1;
    for (const [i, each] of this.layers.entries()) {
      const hit = each.pick?.({ ...base, id: this.#id(i) }, px, py);
      // At one depth the later layer shows, as the painter draws it.
      if (hit && (!best || ahead(hit, best, base.view.distance))) {
        best = hit;
        layer = i;
      }
    }
    return best && { ...best.item, layer };
  }

  /** Every layer's faces, drawn in one order, and what the pointer is on. */
  #place(base: Omit<Frame3D, "id">, lost: boolean): Placed {
    const { faces, bounds } = base;
    faces.reset();
    const surfaces = this.layers.flatMap((layer, i) => (layer.ranker ? [i] : []));
    // With one surface, its cells' order places everything.
    const surface = surfaces.length === 1 ? surfaces[0]! : -1;
    const rank =
      surface < 0 ? undefined : this.layers[surface]!.ranker!({ ...base, id: this.#id(surface) });
    const ranges: number[] = [0];
    const results = this.layers.map((layer, i) => {
      const result = layer.place({ ...base, id: this.#id(i), rank, lost });
      ranges.push(faces.count);
      return result;
    });
    const drawn = faces.geometry("faces", rank !== undefined, bounds, base.view.distance);
    const layerOf = (face: number) => {
      let l = 0;
      while (face >= ranges[l + 1]!) l++;
      return l;
    };
    let index: FaceIndex | undefined;
    const written = faces.drawn;
    const local = faces.local;
    return {
      drawn,
      itemAt(px, py) {
        index ??= new FaceIndex(drawn, bounds);
        const at = index.find(px, py);
        if (at < 0) return undefined;
        const face = written[at]!;
        const l = layerOf(face);
        const item = results[l]!.itemOfFace(local[face]!, px, py);
        return item && { ...item, layer: l };
      },
    };
  }
}

/**
 * What layers keep per chart (by its faces: each chart has its own) and per
 * layer identity there, so charts sharing a mark, and a mark twice in one
 * chart, keep theirs apart.
 */
export class PerChart<T> {
  readonly #store = new WeakMap<FaceBuffer, Map<string | number, T>>();

  get(frame: { faces: FaceBuffer; id: string | number }): T | undefined {
    return this.#store.get(frame.faces)?.get(frame.id);
  }

  set(frame: { faces: FaceBuffer; id: string | number }, value: T): T {
    let byLayer = this.#store.get(frame.faces);
    if (!byLayer) {
      byLayer = new Map();
      this.#store.set(frame.faces, byLayer);
    }
    byLayer.set(frame.id, value);
    return value;
  }
}

/**
 * What a 3D chart would cost to draw on the CPU, in faces, from which a GPU
 * painter draws it, where one is loaded: 20,000 points, say, or 10,000 of a
 * surface's cells, which cost more each.
 */
export const GPU_FACES_3D = 20_000;
const CELL_COST = 2;

/** A geometry of no faces, which a cloud fills. */
const EMPTY: FaceGeometry = {
  kind: "faces",
  draw: facesDrawing,
  key: "faces",
  vertices: new Float32Array(0),
  corners: new Uint32Array(0),
  starts: new Uint32Array(1),
  count: 0,
  style: new Uint16Array(0),
  styles: [],
};

/** What the faces of one scene drew, read back. */
interface Placed {
  drawn: FaceGeometry;
  itemAt(px: number, py: number): LayoutItem | undefined;
}

/** The items of every layer of one scene. */
interface Reading {
  layers: Items3D[];
  count: number;
  item(index: number): LayoutItem;
  indexOf(key: string): number;
}

/** Where a 3D chart's box is fitted in its room: inside room for the labels around it. */
export function boxRoom(bounds: Rect, theme: Theme): Rect {
  const margin = boxMargin(theme);
  return {
    x: bounds.x + margin,
    y: bounds.y + margin / 2,
    width: Math.max(0, bounds.width - 2 * margin),
    height: Math.max(0, bounds.height - 1.5 * margin),
  };
}

/**
 * Where a depth (larger nearer) lands in a GPU painter's 24-bit depth
 * buffer, as render/webgl3d.ts's projection puts it there (lower nearer),
 * for the eye `distance` away (Infinity orthographically).
 */
function depthStep(depth: number, distance: number): number {
  const z =
    distance === Number.POSITIVE_INFINITY
      ? -0.5 * depth
      : 1.5 - (1.5 * distance) / (distance - depth);
  return Math.round((z * 0.5 + 0.5) * 0xffffff);
}

/** Whether a later layer's hit shows over an earlier one's, drawn back as far as each says. */
function ahead(hit: Hit3D, than: Hit3D, distance: number): boolean {
  return (
    depthStep(hit.depth, distance) + (hit.behind ?? 0) <=
    depthStep(than.depth, distance) + (than.behind ?? 0)
  );
}

/**
 * Whether something at `depth` shows over what is at `than`, as a GPU
 * painter draws them: when its depth buffer holds it nearer, or as near and
 * drawn `later` (the depth test lets the later of two at one depth show).
 */
export function inFront(depth: number, later: boolean, than: number, distance: number): boolean {
  const [a, b] = [depthStep(depth, distance), depthStep(than, distance)];
  return a < b || (later && a === b);
}

/** What the chart's axes place values by: equal for axes that place every value alike. */
export function axesKey(axes: Frame3D["axes"]): string {
  return `${axes[0].key}|${axes[1].key}|${axes[2].key}`;
}

/** Whether a point at normalized (u, v, w) lies inside the box (NaN does not). */
export function inBox(u: number, v: number, w: number): boolean {
  return Math.abs(u) <= 1 + 1e-9 && Math.abs(v) <= 1 + 1e-9 && Math.abs(w) <= 1 + 1e-9;
}

/** The row identity in an item key of layer `id`, or undefined. */
export function identityIn(key: string, id: string | number): number | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== id) return undefined;
  return typeof parts[1] === "number" ? parts[1] : undefined;
}

/** Where `row` is among the first `count` of ascending `rows`, or -1. */
export function findRow(rows: Uint32Array, count: number, row: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]! < row) lo = mid + 1;
    else hi = mid;
  }
  return lo < count && rows[lo] === row ? lo : -1;
}

/** The extent of the positive finite values, for log axes. */
export function positiveExtent(values: ArrayLike<number>): [number, number] | undefined {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v > 0 && v < Number.POSITIVE_INFINITY) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return hi > 0 ? [lo, hi] : undefined;
}

/** Plans axis `name` (index `k`) of a 3D chart over its layers' data. */
function planAxis3D(
  name: AxisName,
  k: number,
  layers: readonly Layer3D[],
  spec: AxisSpec | undefined,
  config: ChartConfig,
): PlannedAxis {
  const log = spec?.type === "log";
  const data = layers.map((layer) => layer.axisData(k, log));
  const kinds = new Set(data.map((d) => d.kind));
  if (kinds.size > 1)
    throw new Error(
      `chart ${name}: a 3D axis takes one kind of field; its marks give ${[...kinds].join(" and ")} fields`,
    );
  const kind = data[0]?.kind ?? "number";
  const fields = [...new Set(data.map((d) => d.field))];
  const title = spec?.title ?? fields.join(", ");
  const shown = spec?.show ?? true;
  const grid = spec?.grid ?? true;
  if (kind === "category") {
    if (spec?.type !== undefined)
      throw new Error(`chart ${name}.type: the axis shows categories; drop "${spec.type}"`);
    if (spec?.domain !== undefined)
      throw new Error(`chart ${name}.domain: the axis shows categories; drop domain`);
    const index = new Map<string, number>();
    for (const d of data)
      for (const c of d.categories ?? []) if (!index.has(c)) index.set(c, index.size);
    const labels = [...index.keys()];
    const last = Math.max(1, labels.length - 1);
    return {
      name,
      type: "band",
      place: (i) => (labels.length === 1 ? 0 : -1 + (2 * i) / last),
      ticks: labels.map((_, i) => i),
      labels,
      title,
      grid,
      shown,
      format: (i) => labels[Math.round(i)] ?? "",
      categories: index,
      key: JSON.stringify(labels),
    };
  }
  const type: AxisType = spec?.type ?? (kind === "time" ? "time" : "linear");
  if (type === "time" && kind === "number" && spec?.type === undefined)
    throw new Error(`chart ${name}.type: a time axis needs time fields`);
  const context: AxisContext = {
    type,
    spec,
    zone: config.timeZone ?? "local",
    locale: config.locale,
  };
  let extent: [number, number] | undefined;
  for (const d of data) {
    if (!d.extent) continue;
    extent = extent
      ? [Math.min(extent[0], d.extent[0]), Math.max(extent[1], d.extent[1])]
      : [d.extent[0], d.extent[1]];
  }
  if (extent && spec?.zero && type !== "log")
    extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
  const count = spec?.ticks ?? 5;
  const domain = spec?.domain
    ? usableDomain(spec.domain, type)
    : niceAxisDomain(usableDomain(extent, type), context, count, spec?.nice ?? true);
  const plan = planAxis(context, domain, [-1, 1], count);
  const scale = plan.scale;
  const mapping = scale.mapping();
  const fallback: Formatter =
    type === "time"
      ? timeValueFormatter(timeUnit(domain), context.zone, config.locale)
      : (value) => formatNumber(value, config.locale);
  return {
    name,
    type,
    place: (value) => scale.map(value),
    mapping,
    key: `${mapping.origin},${mapping.offset},${mapping.factor},${mapping.log}`,
    ticks: plan.ticks,
    labels: plan.labels,
    title,
    grid,
    shown,
    format: valueFormatter(context, fallback),
  };
}

/** Precision for times in tooltips: finer the shorter the axis' span. */
function timeUnit(domain: readonly [number, number]) {
  const span = Math.abs(domain[1] - domain[0]) / 500;
  if (span < TIME_UNIT_MS.second) return "millisecond" as const;
  if (span < TIME_UNIT_MS.minute) return "second" as const;
  if (span < TIME_UNIT_MS.day) return "minute" as const;
  return "day" as const;
}
