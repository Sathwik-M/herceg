// Maps: the layers of a map (`geoshape` regions, `geopoint` points) share a
// chart and its projection. The chart model draws a chart's layout marks
// as one, which for maps is a `GeoMap` that settles the projection, fits
// what every layer draws into the room, and lets each layer draw with the
// same transform. Items are read layer by layer; the pointer finds the
// topmost item, trying layers from the last drawn. A chart's viewport, in
// the plane's units, zooms and pans the map: wheel, drags, and keys move it
// through map-controls.ts.

import type { Table } from "../data/table.ts";
import {
  degreeBox,
  emptyExtent,
  fitTransform,
  type GeoExtent,
  type ProjectionPlan,
  planProjection,
  projectionSpec,
  type Transform,
  worldBox,
} from "../geo/project.ts";
import { zoomedTransform } from "../geo/shapes.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry, LegendPart } from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import { LinearScale } from "../scale/scale.ts";
import type { Rect } from "../scene/scene.ts";
import type { ProjectionName, ProjectionSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
  Viewport,
} from "./layout-mark.ts";
import { legendParts } from "./legend-parts.ts";
import type { ColorRamp, GlyphKey, MARK } from "./mark.ts";

/** Plane units a map of a single point spans: about two degrees. */
const POINT_SPAN = (2 * Math.PI) / 180;

/** What a layer draws with: the chart's frame, its own id, and the map's projection and fit. */
export interface MapFrame extends LayoutFrame {
  plan: ProjectionPlan;
  /** Plane to pixels, as the map is shown. */
  transform: Transform;
  /**
   * For a map zoomed or panned, what its shapes are projected with (see
   * `zoomedTransform`), to be drawn moved and scaled to `transform`.
   */
  projected?: Transform | undefined;
}

/** Wheel, drags, keys, and buttons pan and zoom maps; lassos select their rows. */
const PAN_ZOOM: LayoutControls = {
  kind: "map",
  hint: "Shift with the arrow keys pans it, plus and minus zoom, and 0 shows the whole map.",
};
const LASSO: LayoutControls = { kind: "map", hint: "" };

/** One layer of a map. */
export interface GeoLayer extends LayoutMark {
  readonly geo: true;
  /** Marks where the layer's data lies, for projections that place themselves by it. */
  extent(into: GeoExtent): void;
  /** The plane box of what the layer draws, for fitting; undefined when it draws nothing. */
  box(plan: ProjectionPlan): Float64Array | undefined;
  /** Pixels the layer draws past its positions (points' radii), kept inside the room. */
  readonly reach: number;
  /** Draws the layer; `frame.id` is the layer's identity among the map's layers. */
  place(frame: MapFrame): LayoutResult;
  /** The layer's continuous color scales and size keys for the legend. */
  scales(theme: Theme, locale: string | undefined): [ColorRamp[], GlyphKey[]];
}

export function isGeoLayer(mark: LayoutMark): mark is GeoLayer {
  return (mark as Partial<GeoLayer>).geo === true;
}

/**
 * The map a chart's layout marks draw with the chart's projection, when
 * they are all layers of maps; throws for any other mark among them or for
 * repeated ids.
 */
export function joinLayers(
  marks: readonly LayoutMark[],
  projection: ProjectionName | ProjectionSpec | undefined,
): GeoMap {
  const other = marks.find((mark) => !isGeoLayer(mark));
  if (other)
    throw new Error(
      `${marks[0]!.spec.type}: a map holds only geoshape and geopoint marks; draw "${other.spec.type}" marks in a chart of their own`,
    );
  const ids = new Set<string>();
  for (const { spec } of marks) {
    if (spec.id === undefined) continue;
    if (ids.has(spec.id)) throw new Error(`id: "${spec.id}" names two marks`);
    ids.add(spec.id);
  }
  return new GeoMap(marks as GeoLayer[], projectionSpec(projection));
}

/** The layers of one map, drawn as one layout mark. */
export class GeoMap implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec = { type: "map" } as const;
  readonly table = undefined;
  readonly otherTables: readonly Table[];
  readonly measure: string;
  readonly layers: readonly GeoLayer[];
  readonly projection: ProjectionSpec;

  constructor(layers: readonly GeoLayer[], projection: ProjectionSpec) {
    this.layers = layers;
    this.projection = projection;
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

  /** Charts pan and zoom maps with `interaction.zoom` (true or "xy"), and lasso them with a "lasso" brush. */
  readonly interactions = ["plane", "lasso"] as const;
  readonly selects = true;

  controls(config: ChartConfig): LayoutControls | undefined {
    const { zoom, brush } = config.interaction ?? {};
    return zoom ? PAN_ZOOM : brush ? LASSO : undefined;
  }

  legend(_id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    return this.layers.flatMap((layer, i) => layer.legend(this.#id(i), color, theme));
  }

  /**
   * Every layer's scales, each with a legend of its own: fields of the same
   * name in different layers may measure different things.
   */
  legends(theme: Theme, locale: string | undefined): LegendPart[] {
    return this.layers.flatMap((layer) => legendParts(...layer.scales(theme, locale)));
  }

  /** The projection with its parameters settled; conic ones read where the data lies. */
  plan(): ProjectionPlan {
    const spec = this.projection;
    const extent = emptyExtent();
    if (spec.type === "conic-equal-area" && typeof spec.fit !== "object")
      for (const layer of this.layers) layer.extent(extent);
    return planProjection(spec, extent);
  }

  draw(frame: LayoutFrame): LayoutResult {
    const plan = this.plan();
    const { fit } = this.projection;
    let box: ArrayLike<number> | undefined;
    if (fit === "world") box = worldBox(plan);
    else if (typeof fit === "object") {
      box = degreeBox(plan, fit);
      // A box beyond the projection's latitudes (Mercator's) shows the world.
      if (!(box[0]! <= box[2]!)) box = worldBox(plan);
    } else {
      const union = [Infinity, Infinity, -Infinity, -Infinity];
      for (const layer of this.layers) {
        const b = layer.box(plan);
        if (!b) continue;
        union[0] = Math.min(union[0]!, b[0]!);
        union[1] = Math.min(union[1]!, b[1]!);
        union[2] = Math.max(union[2]!, b[2]!);
        union[3] = Math.max(union[3]!, b[3]!);
      }
      // A map of nothing shows the world.
      box = union[0]! <= union[2]! ? union : worldBox(plan);
    }
    let reach = 0;
    for (const layer of this.layers) reach = Math.max(reach, layer.reach);
    const { bounds } = frame;
    const fitted = fitTransform(box, bounds, reach + 1, POINT_SPAN);
    const transform = viewed(fitted, bounds, frame.viewport);
    // The fitted map projects exactly; a zoomed one at a level near its scale.
    const projected = transform === fitted ? undefined : zoomedTransform(transform, bounds);
    const results = this.layers.map((layer, i) =>
      layer.place({ ...frame, id: this.#id(i), plan, transform, projected }),
    );
    /** The plane's ranges across the room, drawn with `t`. */
    const across = (t: Transform) =>
      ({
        x: [(bounds.x - t.x0) / t.k, (bounds.x + bounds.width - t.x0) / t.k],
        y: [(t.y0 - bounds.y - bounds.height) / t.k, (t.y0 - bounds.y) / t.k],
      }) as const;
    const shown = across(transform);
    const plane = {
      x: new LinearScale(shown.x, [bounds.x, bounds.x + bounds.width]),
      y: new LinearScale(shown.y, [bounds.y + bounds.height, bounds.y]),
      zoom: transform.k / fitted.k,
      // What the controls change: the view earlier commands asked for, though not drawn yet.
      view(viewport: Viewport | undefined) {
        const t = viewed(fitted, bounds, viewport);
        return { ...across(t), zoom: t.k / fitted.k };
      },
    };
    if (results.length === 1) return { ...results[0]!, plane };
    // Item positions: each layer's start, then the end of the last.
    const starts = [0];
    for (const result of results) starts.push(starts[starts.length - 1]! + result.count);
    const layerOf = (index: number) => {
      let l = 0;
      while (index >= starts[l + 1]!) l++;
      return l;
    };
    return {
      geometry: results.flatMap((result) => result.geometry),
      itemAt(px, py) {
        for (let l = results.length - 1; l >= 0; l--) {
          const item = results[l]!.itemAt(px, py);
          if (item) return { ...item, layer: l };
        }
        return undefined;
      },
      count: starts[results.length]!,
      item(index): LayoutItem {
        const l = layerOf(index);
        return { ...results[l]!.item(index - starts[l]!), layer: l };
      },
      indexOf(key) {
        for (let l = 0; l < results.length; l++) {
          const at = results[l]!.indexOf(key);
          if (at >= 0) return starts[l]! + at;
        }
        return -1;
      },
      summary: () => results.map((result) => result.summary()).join(" "),
      rowsOf(key, table) {
        for (const result of results) {
          if (result.indexOf(key) >= 0) return result.rowsOf?.(key, table);
        }
        return undefined;
      },
      lassoed(polygon, table) {
        // Layers of one table select together.
        let rows: number[] | undefined;
        for (const result of results) {
          const found = result.lassoed?.(polygon, table);
          if (found) rows = rows ? rows.concat(found) : found;
        }
        return rows;
      },
      plane,
    };
  }
}

/**
 * The transform showing `view` (plane ranges) in `room`: the scale at which
 * the ranges given fit, uniform, centered on them, and on the fitted map's
 * center along an axis without a range; the fitted transform without either.
 */
function viewed(fitted: Transform, room: Rect, viewport: Viewport | undefined): Transform {
  const { x, y } = viewport ?? {};
  if (!x && !y) return fitted;
  const cx = room.x + room.width / 2;
  const cy = room.y + room.height / 2;
  const k = Math.min(
    x ? room.width / (x[1] - x[0]) : Number.POSITIVE_INFINITY,
    y ? room.height / (y[1] - y[0]) : Number.POSITIVE_INFINITY,
  );
  if (!(k > 0 && Number.isFinite(k))) return fitted;
  const centerX = x ? (x[0] + x[1]) / 2 : (cx - fitted.x0) / fitted.k;
  const centerY = y ? (y[0] + y[1]) / 2 : (fitted.y0 - cy) / fitted.k;
  const x0 = cx - k * centerX;
  const y0 = cy + k * centerY;
  return { k, x0, y0, key: `${k} ${x0} ${y0}` };
}
