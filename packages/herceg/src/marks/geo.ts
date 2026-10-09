// Maps: the layers of a map (`geoshape` regions, `geopoint` points) share a
// chart and its projection. The chart model draws a chart's layout marks
// as one, which for maps is a `GeoMap` that settles the projection, fits
// what every layer draws into the room, and lets each layer draw with the
// same transform. Items are read layer by layer; the pointer finds the
// topmost item, trying layers from the last drawn.

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
import type { LegendEntry } from "../model/legend.ts";
import type { ProjectionName, ProjectionSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import type { ColorRamp, GlyphKey } from "./mark.ts";

/** Plane units a map of a single point spans: about two degrees. */
const POINT_SPAN = (2 * Math.PI) / 180;

/** What a layer draws with: the chart's frame, its own id, and the map's projection and fit. */
export interface MapFrame extends LayoutFrame {
  plan: ProjectionPlan;
  transform: Transform;
}

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
      `A ${marks[0]!.spec.type} mark shares its chart only with geoshape and geopoint marks, not a ${other.spec.type}`,
    );
  const ids = new Set<string>();
  for (const { spec } of marks) {
    if (spec.id === undefined) continue;
    if (ids.has(spec.id)) throw new Error(`Duplicate mark id "${spec.id}"`);
    ids.add(spec.id);
  }
  return new GeoMap(marks as GeoLayer[], projectionSpec(projection));
}

/** The layers of one map, drawn as one layout mark. */
export class GeoMap implements LayoutMark {
  readonly layout = true;
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

  legend(_id: string | number, color: (key: string) => string, theme: Theme): LegendEntry[] {
    return this.layers.flatMap((layer, i) => layer.legend(this.#id(i), color, theme));
  }

  /**
   * Every layer's scales, each with a legend of its own: fields of the same
   * name in different layers may measure different things.
   */
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

  /** The projection with its parameters settled; conic ones read where the data lies. */
  plan(): ProjectionPlan {
    const spec = this.projection;
    const extent = emptyExtent();
    if (spec.type === "conic-equal-area" && !Array.isArray(spec.fit))
      for (const layer of this.layers) layer.extent(extent);
    return planProjection(spec, extent);
  }

  draw(frame: LayoutFrame): LayoutResult {
    const plan = this.plan();
    const { fit } = this.projection;
    let box: ArrayLike<number> | undefined;
    if (fit === "world") box = worldBox(plan);
    else if (Array.isArray(fit)) {
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
    const transform = fitTransform(box, frame.bounds, reach + 1, POINT_SPAN);
    const results = this.layers.map((layer, i) =>
      layer.place({ ...frame, id: this.#id(i), plan, transform }),
    );
    if (results.length === 1) return results[0]!;
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
          if (item) return item;
        }
        return undefined;
      },
      count: starts[results.length]!,
      item(index): LayoutItem {
        const l = layerOf(index);
        return results[l]!.item(index - starts[l]!);
      },
      indexOf(key) {
        for (let l = 0; l < results.length; l++) {
          const at = results[l]!.indexOf(key);
          if (at >= 0) return starts[l]! + at;
        }
        return -1;
      },
      summary: () => results.map((result) => result.summary()).join(" "),
    };
  }
}
