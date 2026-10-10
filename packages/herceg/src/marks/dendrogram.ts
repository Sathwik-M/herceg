import type { NumberField, Schema, Table } from "../data/table.ts";
import { segmentDrawing } from "../draw/segments.ts";
import { formatNumber } from "../format/format.ts";
import type { SegmentGeometry } from "../scene/scene.ts";
import type { DendrogramSpec, Frozen } from "../spec/spec.ts";
import { checkLinkage } from "./dendrogram-data.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandList,
  type Bands,
  type ChartMark,
  type Frame,
  frozen,
  type MARK,
  type Mark,
  type MarkKey,
  type Palette,
  requireField,
} from "./mark.ts";
import { TableCache } from "./series.ts";

export interface DendrogramOptions<S extends Schema> {
  /** Linkage child cluster ids; leaves are 0 to n-1, merge row k makes n+k. */
  first: NumberField<S>;
  second: NumberField<S>;
  /** Finite, nonnegative merge heights. */
  height: NumberField<S>;
  /** Category label of each leaf id, before dendrogram ordering. */
  leaves: readonly string[];
  /** Plot edge at height zero. Bottom/top band x; left/right band y. */
  side?: "bottom" | "top" | "left" | "right";
  stroke?: string;
  strokeWidth?: number;
  label?: string;
  facet?: "repeat";
  panel?: string;
  id?: string;
}

interface Linkage {
  first: ArrayLike<number>;
  second: ArrayLike<number>;
  height: ArrayLike<number>;
  min: number;
  max: number;
  bands: BandList;
}

export class DendrogramMark implements Mark<Frozen<DendrogramSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<DendrogramSpec>;
  readonly table: Table;
  readonly tooltip = "x";
  readonly #cache = new TableCache<Linkage>();
  // Scales retain these label lists; keys distinguish categories from numeric
  // bands with the same display label, across charts and panel resolutions.
  readonly #bandKeys = new WeakMap<readonly string[], readonly string[]>();

  constructor(input: DendrogramSpec, table: Table) {
    this.spec = frozen(input);
    this.table = table;
    const { spec } = this;
    for (const channel of ["first", "second", "height"] as const)
      requireField(table, spec[channel], ["number"], `dendrogram ${channel}`);
    if (spec.side !== undefined && !["bottom", "top", "left", "right"].includes(spec.side))
      throw new TypeError(
        `dendrogram side: expected "bottom", "top", "left", or "right"; received ${JSON.stringify(spec.side)}`,
      );
    if (
      spec.strokeWidth !== undefined &&
      !(Number.isFinite(spec.strokeWidth) && spec.strokeWidth >= 0)
    )
      throw new RangeError(
        `dendrogram strokeWidth: expected 0 or more pixels; received ${spec.strokeWidth}`,
      );
    this.#linkage();
  }

  #leafAxis(): "x" | "y" {
    return this.spec.side === "left" || this.spec.side === "right" ? "y" : "x";
  }

  #linkage(): Linkage {
    return this.#cache.get(this.table, () => {
      const { spec, table } = this;
      const fields = [spec.first, spec.second, spec.height] as const;
      const first = table.numbers(spec.first as never);
      const second = table.numbers(spec.second as never);
      const height = table.numbers(spec.height as never);
      const columns = [first, second, height];
      checkLinkage(table.length, spec.leaves, fields, (column, row) => columns[column]![row]!);
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < table.length; i++) {
        min = Math.min(min, height[i]!);
        max = Math.max(max, height[i]!);
      }
      // Depth-first, first child before second, without recursion for deep trees.
      const n = spec.leaves.length;
      const pending = [n + table.length - 1];
      const labels: string[] = [];
      while (pending.length) {
        const cluster = pending.pop()!;
        if (cluster < n) labels.push(spec.leaves[cluster]!);
        else pending.push(second[cluster - n]!, first[cluster - n]!);
      }
      return {
        first,
        second,
        height,
        min,
        max,
        bands: { keys: labels.map((label) => `c:${label}`), labels },
      };
    });
  }

  channelKind(axis: "x" | "y"): "category" | undefined {
    return axis === this.#leafAxis() ? "category" : undefined;
  }

  bands(axis: "x" | "y"): BandList | undefined {
    return axis === this.#leafAxis() ? this.#linkage().bands : undefined;
  }

  resolveBands(bands: Bands): void {
    const own = bands[this.#leafAxis()];
    if (own) this.#bandKeys.set(own.labels, own.keys);
  }

  series(_key: MarkKey, _palette: Palette, _hidden: ReadonlySet<string>, bands: Bands) {
    this.resolveBands(bands);
    return [];
  }
  xExtent() {
    return undefined;
  }
  yExtent() {
    return undefined;
  }

  describe(format: AxisFormat, locale: string | undefined): string {
    const { min, max } = this.#linkage();
    const n = this.spec.leaves.length;
    const rows = this.table.length;
    const range = rows ? ` Merge heights ${format.value(min)} to ${format.value(max)}.` : "";
    return `${this.spec.label ?? "Dendrogram"}: ${formatNumber(n, locale)} ${n === 1 ? "leaf" : "leaves"}, ${formatNumber(rows, locale)} ${rows === 1 ? "merge" : "merges"}.${range}`;
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey): SegmentGeometry[] {
    const { first, second, height, max } = this.#linkage();
    const { spec, table } = this;
    if (table.length === 0 || spec.strokeWidth === 0) return [];
    const horizontal = this.#leafAxis() === "x";
    const scale = horizontal ? frame.x : frame.y;
    if (scale.type !== "band") throw new Error("dendrogram leaves: expected a category axis");
    const keys =
      this.#bandKeys.get(scale.categories!) ?? scale.categories!.map((label) => `c:${label}`);
    const positions = new Map(keys.map((key, i) => [key, scale.map(i)]));
    const n = spec.leaves.length;
    const centers = frame.doubles(JSON.stringify(key), "dendrogram-centers", n + table.length);
    for (let leaf = 0; leaf < n; leaf++)
      centers[leaf] = positions.get(`c:${spec.leaves[leaf]!}`) ?? NaN;
    const { x, y, width, height: size } = frame.plot;
    const side = spec.side ?? "bottom";
    const edge =
      side === "bottom" ? y + size : side === "top" ? y : side === "left" ? x : x + width;
    const span = (horizontal ? size : width) * (side === "bottom" || side === "right" ? -1 : 1);
    const atHeight = (h: number) => edge + (max > 0 ? h / max : 0) * span;
    const childHeight = (cluster: number) => atHeight(cluster < n ? 0 : height[cluster - n]!);
    const coords = frame.floats(JSON.stringify(key), "dendrogram-segments", table.length * 12);
    let count = 0;
    const segment = (a: number, ha: number, b: number, hb: number) => {
      const offset = count++ * 4;
      coords[offset] = horizontal ? a : ha;
      coords[offset + 1] = horizontal ? ha : a;
      coords[offset + 2] = horizontal ? b : hb;
      coords[offset + 3] = horizontal ? hb : b;
    };
    for (let row = 0; row < table.length; row++) {
      const a = first[row]!;
      const b = second[row]!;
      const pa = centers[a]!;
      const pb = centers[b]!;
      centers[n + row] = (pa + pb) / 2;
      // Missing a leaf suppresses its entire ancestral branch, without
      // moving surviving leaves or drawing a partial merge.
      if (!Number.isFinite(pa) || !Number.isFinite(pb)) continue;
      const h = atHeight(height[row]!);
      segment(pa, childHeight(a), pa, h);
      segment(pa, h, pb, h);
      segment(pb, h, pb, childHeight(b));
    }
    return [
      {
        kind: "segments",
        draw: segmentDrawing,
        key: JSON.stringify([key, "dendrogram"]),
        coords,
        count,
        stroke: spec.stroke ?? frame.theme.muted,
        strokeWidth: spec.strokeWidth ?? 1,
      },
    ];
  }
}

/** A dendrogram over category bands from a SciPy-layout linkage table. */
export function dendrogram<S extends Schema>(
  table: Table<S>,
  options: DendrogramOptions<S>,
): ChartMark<Frozen<DendrogramSpec>> {
  const spec = {
    type: "dendrogram",
    ...definedFields(options, [
      "first",
      "second",
      "height",
      "leaves",
      "side",
      "stroke",
      "strokeWidth",
      "label",
      "facet",
      "panel",
      "id",
    ]),
  } as unknown as DendrogramSpec;
  if (table.name !== undefined) spec.data = table.name;
  return new DendrogramMark(spec, table as unknown as Table);
}
