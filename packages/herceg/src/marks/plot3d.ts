// 3D charts: the layers of one (`point3d` points, `surface` surfaces) share
// a box, its axes, and the camera. The chart model draws a chart's layout
// marks as one, which for 3D charts is a `Plot3D`: it plans each axis over
// every layer's data, lets each layer write its faces into one buffer, and
// draws them in one order, so a point behind a surface is hidden by it.
//
// The order is exact for points alone (back to front) and for one surface
// with any points: a height field over a grid can only hide what lies
// beyond it from the eye, so its cells are drawn row by row and column by
// column from the far side, and each point among the cells at its place,
// before or after its own cell by which side of it the point is on. With
// several surfaces, everything is drawn back to front by the depth of its
// center, which can be wrong where surfaces come close or cross.

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
import type { LegendEntry } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { TIME_UNIT_MS } from "../scale/time.ts";
import type { CloudLayer3D, FaceGeometry, Geometry, PointCloud3D, Rect } from "../scene/scene.ts";
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
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import type { ColorRamp, GlyphKey } from "./mark.ts";

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
}

/** What a layer draws with: the chart's frame, the box's view and axes, and the shared faces. */
export interface Frame3D extends LayoutFrame {
  view: View;
  axes: readonly [PlannedAxis, PlannedAxis, PlannedAxis];
  faces: FaceBuffer;
  /**
   * With one surface in the chart, where its cells' order puts a point at
   * normalized (x, y, z): the key points are sorted by before their depth.
   */
  rank: ((x: number, y: number, z: number) => number) | undefined;
}

/** What a layer drew, read back for tooltips and the keyboard. */
export interface Placed3D {
  /** How many items the keyboard visits, in reading order. */
  count: number;
  item(index: number): LayoutItem;
  /** The place in reading order of the item keyed `key`; -1 if not drawn. */
  indexOf(key: string): number;
  /** The item a face the layer wrote shows, with the pointer at (px, py). */
  itemOfFace(local: number, px: number, py: number): LayoutItem | undefined;
  summary(): string;
}

/** One layer of a 3D chart. */
export interface Layer3D extends LayoutMark {
  /** Tells 3D layers from other layout marks. */
  readonly dimensions: 3;
  /** The layer's data along axis `k`; `log` when the axis is logarithmic. */
  axisData(k: number, log: boolean): AxisData;
  /** Continuous color scales for the legend. */
  scales(theme: Theme, locale: string | undefined): [ColorRamp[], GlyphKey[]];
  /** A surface: what orders the chart's faces when it is the only one (see Frame3D.rank). */
  ranker?(frame: Omit<Frame3D, "rank">): (x: number, y: number, z: number) => number;
  /** Writes the layer's faces into `frame.faces`. */
  place(frame: Frame3D): Placed3D;
  /** Points: their columns and colors for a GPU painter, or undefined when it cannot draw them. */
  cloud?(frame: Frame3D): CloudLayer3D | undefined;
}

export function isLayer3D(mark: LayoutMark): mark is Layer3D {
  return (mark as Partial<Layer3D>).dimensions === 3;
}

/**
 * The 3D chart a chart's layout marks draw, when they are all 3D layers;
 * throws for any other mark among them, repeated ids, and options 3D charts
 * do not take.
 */
export function joinLayers3D(marks: readonly LayoutMark[], config: ChartConfig): Plot3D {
  const other = marks.find((mark) => !isLayer3D(mark));
  if (other)
    throw new Error(
      `A ${marks[0]!.spec.type} mark shares its chart only with point3d and surface marks, not a ${other.spec.type}`,
    );
  const ids = new Set<string>();
  for (const { spec } of marks) {
    if (spec.id === undefined) continue;
    if (ids.has(spec.id)) throw new Error(`Duplicate mark id "${spec.id}"`);
    ids.add(spec.id);
  }
  if (config.camera) checkCamera(config.camera);
  if (config.boxAspect) checkBoxAspect(config.boxAspect);
  const zoom = config.interaction?.zoom;
  if (zoom !== undefined && typeof zoom !== "boolean")
    throw new Error(`3D charts zoom with interaction.zoom true, not "${zoom}"`);
  if (config.yRight) throw new Error("3D charts have no right y axis");
  if (config.x?.breaks) throw new Error("3D charts' x axis leaves out no breaks");
  return new Plot3D(marks as Layer3D[], config);
}

/** A chart's 3D layers, drawn in one box as one layout mark. */
export class Plot3D implements LayoutMark {
  readonly layout = true;
  readonly spec = { type: "plot3d" } as const;
  readonly table = undefined;
  readonly otherTables: readonly Table[];
  readonly measure: string;
  readonly layers: readonly Layer3D[];
  readonly #config: ChartConfig;
  /** This chart's faces, reused from scene to scene. */
  readonly #faces = new FaceBuffer();

  constructor(layers: readonly Layer3D[], config: ChartConfig) {
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
    return this.layers[index]!.spec.id ?? index;
  }

  camera(spec: CameraSpec | undefined, base?: Camera): Camera {
    if (spec) checkCamera(spec);
    return resolveCamera(spec, base);
  }

  legend(_id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    return this.layers.flatMap((layer, i) => layer.legend(this.#id(i), color, theme));
  }

  /** Every layer's scales, each with a legend of its own. */
  scales(theme: Theme, locale: string | undefined): [ColorRamp[], GlyphKey[]] {
    const ramps: ColorRamp[] = [];
    const keys: GlyphKey[] = [];
    for (const layer of this.layers) {
      const [r, k] = layer.scales(theme, locale);
      ramps.push(...r);
      keys.push(...k);
    }
    return [ramps, keys];
  }

  /** The chart's x, y, and z axes, planned over every layer's data. */
  axes(): [PlannedAxis, PlannedAxis, PlannedAxis] {
    const config = this.#config;
    return AXES.map((name, k) => planAxis3D(name, k, this.layers, config[name], config)) as [
      PlannedAxis,
      PlannedAxis,
      PlannedAxis,
    ];
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { theme, measure, bounds } = frame;
    const axes = this.axes();
    const view = new View(
      frame.camera ?? DEFAULT_CAMERA,
      boxRoom(bounds, theme),
      this.#config.boxAspect,
    );
    const base = { ...frame, view, axes, faces: this.#faces };
    const box = boxGeometry(view, axes, theme, measure, bounds);
    const cloud = frame.clouds ? this.#cloud(base) : undefined;
    // A GPU painter draws large point clouds; their faces are made only
    // when something reads them (the pointer, the keyboard, the summary, or
    // a canvas the painter cannot draw on).
    let placed: Placed | undefined;
    const place = () => {
      placed ??= this.#place(base);
      return placed;
    };
    const drawn: FaceGeometry = cloud
      ? { ...EMPTY, cloud: { ...cloud, faces: () => place().drawn } }
      : place().drawn;
    const geometry: Geometry[] = [...box.lines, drawn, ...box.labels];
    return {
      geometry,
      itemAt: (px, py) => place().itemAt(px, py),
      get count() {
        return place().count;
      },
      item: (i) => place().item(i),
      indexOf: (key) => place().indexOf(key),
      summary: () => {
        const parts = place().summaries();
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
  }

  /**
   * The chart's points for a GPU painter: when every layer gives a cloud (its
   * points are opaque) and they hold at least CLOUD_POINTS_3D rows.
   */
  #cloud(frame: Omit<Frame3D, "rank" | "id">): Omit<PointCloud3D, "faces"> | undefined {
    const mappings = frame.axes.map((axis) => axis.mapping);
    if (!mappings.every((m) => m !== undefined)) return undefined;
    const layers: CloudLayer3D[] = [];
    let rows = 0;
    for (const [i, layer] of this.layers.entries()) {
      const cloud = layer.cloud?.({ ...frame, id: this.#id(i), rank: undefined });
      if (!cloud) return undefined;
      layers.push(cloud);
      rows += cloud.x.length;
    }
    if (rows < CLOUD_POINTS_3D) return undefined;
    const { view } = frame;
    return {
      layers,
      axes: mappings as [Mapping, Mapping, Mapping],
      view: view.matrix,
      cx: view.cx,
      cy: view.cy,
      scale: view.scale,
      distance: view.distance,
    };
  }

  /** Every layer's faces, drawn in one order, and what reads them back. */
  #place(base: Omit<Frame3D, "rank" | "id">): Placed {
    const { faces, bounds } = base;
    faces.reset();
    const surfaces = this.layers.flatMap((layer, i) => (layer.ranker ? [i] : []));
    // With one surface, its cells' order places everything.
    const surface = surfaces.length === 1 ? surfaces[0]! : -1;
    const rank =
      surface < 0 ? undefined : this.layers[surface]!.ranker!({ ...base, id: this.#id(surface) });
    const ranges: number[] = [0];
    const results = this.layers.map((layer, i) => {
      const result = layer.place({ ...base, id: this.#id(i), rank });
      ranges.push(faces.count);
      return result;
    });
    const drawn = faces.geometry("faces", rank !== undefined, bounds);
    const layerOf = (face: number) => {
      let l = 0;
      while (face >= ranges[l + 1]!) l++;
      return l;
    };
    const starts = [0];
    for (const result of results) starts.push(starts[starts.length - 1]! + result.count);
    const itemLayer = (index: number) => {
      let l = 0;
      while (index >= starts[l + 1]!) l++;
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
      count: starts[results.length]!,
      item(i) {
        const l = itemLayer(i);
        return { ...results[l]!.item(i - starts[l]!), layer: l };
      },
      indexOf(key) {
        for (let l = 0; l < results.length; l++) {
          const at = results[l]!.indexOf(key);
          if (at >= 0) return starts[l]! + at;
        }
        return -1;
      },
      summaries: () => results.map((result) => result.summary()),
    };
  }
}

/** Points in a 3D chart from which a GPU painter draws them, where one is loaded. */
export const CLOUD_POINTS_3D = 20_000;

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
  count: number;
  item(index: number): LayoutItem;
  indexOf(key: string): number;
  summaries(): string[];
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
      `The ${name} axis of a 3D chart is one kind of field; its marks give ${[...kinds].join(" and ")} fields`,
    );
  const kind = data[0]?.kind ?? "number";
  const fields = [...new Set(data.map((d) => d.field))];
  const title = spec?.label ?? fields.join(", ");
  const shown = spec?.axis ?? true;
  const grid = spec?.grid ?? true;
  if (kind === "category") {
    if (spec?.type !== undefined)
      throw new Error(`The ${name} axis shows categories; its type cannot be "${spec.type}"`);
    if (spec?.domain !== undefined)
      throw new Error(`The ${name} axis shows categories; it takes no domain`);
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
    };
  }
  const type: AxisType = spec?.type ?? (kind === "time" ? "time" : "linear");
  if (type === "time" && kind === "number" && spec?.type === undefined)
    throw new Error(`The ${name} axis is a time axis; its fields must be times`);
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
  const fallback: Formatter =
    type === "time"
      ? timeValueFormatter(timeUnit(domain), context.zone, config.locale)
      : (value) => formatNumber(value, config.locale);
  return {
    name,
    type,
    place: (value) => scale.map(value),
    mapping: scale.mapping(),
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
