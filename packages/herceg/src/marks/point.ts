import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { GridIndex } from "../lod/grid-index.ts";
import { isOpaqueColor } from "../scale/color.ts";
import { CLOUD_POINTS, type PointGeometry } from "../scene/scene.ts";
import type { PointSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  buildSeries,
  CATEGORY,
  type Frame,
  type Hit,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
} from "./mark.ts";
import { rowOf, type Series, visibleRange, xExtent, yExtent } from "./series.ts";
import { unionExtent } from "./trace.ts";

export interface PointOptions<S extends Schema> {
  x: NumericField<S>;
  y: NumericField<S>;
  /** Category field: one colored point series per value. */
  series?: CategoryField<S>;
  /** Radius in pixels. */
  r?: number;
  fill?: string;
  fillOpacity?: number;
  /**
   * "pixel": draw opaque points whose centers share a device pixel once.
   * Faster for dense scatters; edges can differ by a fraction of a pixel.
   */
  sampling?: "none" | "pixel";
  label?: string;
  id?: string;
}

const DEFAULT_RADIUS = 2.5;
const NO_COORDS = new Float32Array(0);

export class PointMark implements Mark<PointSpec> {
  readonly spec: PointSpec;
  readonly table: Table<Schema>;
  readonly tooltip = "point";
  readonly inset: { x: number; y: number };
  readonly #split: SeriesSplitter;
  /** Pick indexes per frame (charts sharing this mark have separate frames), per series key. */
  readonly #indexes = new WeakMap<Frame, Map<string, GridIndex>>();

  constructor(spec: PointSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    requireField(table, spec.x, NUMERIC, "point x");
    requireField(table, spec.y, NUMERIC, "point y");
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "point series");
    this.#split = new SeriesSplitter(table, spec.x, [spec.y], spec.series, spec.label);
    const radius = spec.r ?? DEFAULT_RADIUS;
    this.inset = { x: radius, y: radius };
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind(axis === "x" ? this.spec.x : this.spec.y);
  }

  series(key: MarkKey, palette: Palette) {
    return buildSeries(
      this.table,
      this.#split.sources(),
      this.table.numbers(this.spec.x as never),
      key,
      palette,
      this.spec.fill,
    );
  }

  xExtent(series: readonly Series[], log: boolean) {
    return unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    return unionExtent(series.map((s) => yExtent(s, x0, x1, s.y, log)));
  }

  geometry(series: readonly Series[], frame: Frame): PointGeometry[] {
    const radius = this.spec.r ?? DEFAULT_RADIUS;
    const opacity = this.spec.fillOpacity ?? 1;
    const { plot, pixelRatio } = frame;
    const out: PointGeometry[] = [];
    const columns = Math.ceil(plot.width * pixelRatio) + 1;
    const rows = Math.ceil(plot.height * pixelRatio) + 1;
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const opaque = opacity >= 1 && isOpaqueColor(s.color);
      // Device-pixel occupancy for sampling; only opaque points qualify, since
      // overlapping translucent points look different from one point.
      const sample = this.spec.sampling === "pixel" && opaque;
      const [start, end] = visibleRange(s, frame.x.domain[0], frame.x.domain[1]);
      if (frame.clouds && !sample && end - start >= CLOUD_POINTS) {
        out.push({
          kind: "point",
          draw: pointDrawing,
          key: s.key,
          fill: s.color,
          fillOpacity: opacity,
          opaque,
          radius,
          coords: NO_COORDS,
          count: end - start,
          cloud: {
            x: s.x,
            y: s.y,
            rows: s.rows,
            start,
            end,
            xMap: frame.x.mapping(),
            yMap: frame.y.mapping(),
            version: this.table.version,
          },
        });
        continue;
      }
      const coords = frame.floats(s.key, "point", (end - start) * 2);
      const occupied = sample ? frame.bytes(s.key, "occupied", columns * rows) : undefined;
      occupied?.fill(0);
      let count = 0;
      for (let k = start; k < end; k++) {
        const placed = place(s, rowOf(s, k), frame, radius);
        if (!placed) continue;
        const [px, py] = placed;
        if (occupied) {
          const cell =
            Math.floor((py - plot.y) * pixelRatio) * columns +
            Math.floor((px - plot.x) * pixelRatio);
          if (cell >= 0 && cell < occupied.length) {
            if (occupied[cell]) continue;
            occupied[cell] = 1;
          }
        }
        coords[count * 2] = px;
        coords[count * 2 + 1] = py;
        count++;
      }
      out.push({
        kind: "point",
        draw: pointDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: opacity,
        opaque,
        radius,
        coords,
        count,
      });
    }
    return out;
  }

  /**
   * Nearest drawn point to a pixel position, through a grid index per series.
   * The index covers every visible point (not only those kept by sampling),
   * so the tooltip reports a real row.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    let indexes = this.#indexes.get(frame);
    if (!indexes) {
      indexes = new Map();
      this.#indexes.set(frame, indexes);
    }
    const radius = this.spec.r ?? DEFAULT_RADIUS;
    let best: Hit | undefined;
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      let index = indexes.get(s.key);
      if (!index) {
        index = buildIndex(s, frame, radius);
        indexes.set(s.key, index);
      }
      const found = index.nearest(px, py, best?.distance ?? Infinity);
      if (found && found.distance < (best?.distance ?? Infinity))
        best = { series: s, position: found.id, distance: found.distance };
    }
    return best;
  }
}

/** Pixel position of a row, or undefined when the point is not drawn (missing or outside the plot). */
function place(s: Series, row: number, frame: Frame, radius: number): [number, number] | undefined {
  const px = frame.x.map(s.x[row]!);
  const py = frame.y.map(s.y[row]!);
  if (!(Number.isFinite(px) && Number.isFinite(py))) return undefined;
  const { plot } = frame;
  if (px < plot.x - radius || px > plot.x + plot.width + radius) return undefined;
  if (py < plot.y - radius || py > plot.y + plot.height + radius) return undefined;
  return [px, py];
}

function buildIndex(s: Series, frame: Frame, radius: number): GridIndex {
  const [start, end] = visibleRange(s, frame.x.domain[0], frame.x.domain[1]);
  const coords = new Float32Array((end - start) * 2);
  const ids = new Uint32Array(end - start);
  let count = 0;
  for (let k = start; k < end; k++) {
    const placed = place(s, rowOf(s, k), frame, radius);
    if (!placed) continue;
    coords[count * 2] = placed[0];
    coords[count * 2 + 1] = placed[1];
    ids[count] = k;
    count++;
  }
  return new GridIndex(coords, ids, count, frame.plot);
}

/**
 * Points at (x, y): scatter plots.
 *
 * ```ts
 * point(cars, { x: "weight", y: "mpg", series: "origin" })
 * ```
 */
export function point<S extends Schema>(table: Table<S>, options: PointOptions<S>): PointMark {
  const spec: PointSpec = {
    type: "point",
    x: options.x,
    y: options.y,
    ...definedFields(options, ["series", "r", "fill", "fillOpacity", "sampling", "label", "id"]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new PointMark(spec, table as unknown as Table);
}
