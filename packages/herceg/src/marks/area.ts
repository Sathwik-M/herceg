import type { NumericArray } from "../data/column.ts";
import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import type { AreaGeometry } from "../scene/scene.ts";
import type { AreaSpec, Curve } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  buildSeries,
  CATEGORY,
  type Frame,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  seriesKey,
} from "./mark.ts";
import { type Series, TableCache, xExtent, yExtent } from "./series.ts";
import { IndexUse, traceBand, tracePath, unionExtent } from "./trace.ts";

interface AreaCommon {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** Constant fill color for every area of the mark. */
  fill?: string;
  fillOpacity?: number;
  /** Outline the top edge. */
  line?: boolean;
  curve?: Curve;
  label?: string;
  id?: string;
}

export type AreaOptions<S extends Schema> = AreaCommon &
  (
    | {
        x: NumericField<S>;
        /** Filled down to zero, or stacked with `stack: true`. */
        y: NumericField<S> | readonly NumericField<S>[];
        /** Category field: one area per value. Not combinable with `stack`. */
        series?: CategoryField<S>;
        stack?: boolean;
      }
    | {
        x: NumericField<S>;
        /** Lower edge of a band. */
        y1: NumericField<S>;
        /** Upper edge of a band. */
        y2: NumericField<S>;
      }
  );

export class AreaMark implements Mark<AreaSpec> {
  readonly spec: AreaSpec;
  readonly table: Table<Schema>;
  readonly #split: SeriesSplitter | undefined;
  readonly #stacks = new TableCache<Map<string, StackLayers>>();
  readonly #indexes = new IndexUse();
  readonly zero: "y" | undefined;

  constructor(spec: AreaSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    requireField(table, spec.x, NUMERIC, "area x");
    const band = spec.y1 !== undefined || spec.y2 !== undefined;
    if (band) {
      if (spec.y1 === undefined || spec.y2 === undefined)
        throw new Error("A band area needs both y1 and y2");
      if (spec.y !== undefined) throw new Error("Use y, or y1 and y2, not both");
      requireField(table, spec.y1, NUMERIC, "area y1");
      requireField(table, spec.y2, NUMERIC, "area y2");
    } else {
      if (spec.y === undefined) throw new Error("An area needs y, or y1 and y2");
      const ys = typeof spec.y === "string" ? [spec.y] : spec.y;
      for (const y of ys) requireField(table, y, NUMERIC, "area y");
      if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "area series");
      if (spec.stack && spec.series !== undefined) {
        throw new Error(
          "Stacked areas need several y fields sharing x; a series field is not supported",
        );
      }
      this.#split = new SeriesSplitter(table, spec.x, ys, spec.series, spec.label);
    }
    this.zero = band ? undefined : "y";
  }

  readonly tooltip = "x";

  channelKind(axis: "x" | "y") {
    return axis === "x" ? this.table.kind(this.spec.x) : "number";
  }

  series(key: MarkKey, palette: Palette, hidden: ReadonlySet<string>) {
    const { spec, table } = this;
    if (!this.#split) {
      const y2 = table.numbers(spec.y2 as never);
      const id = seriesKey(key, "band");
      const series: Series = {
        key: id,
        label: spec.label ?? `${spec.y1}–${spec.y2}`,
        color: spec.fill ?? palette(id),
        x: table.numbers(spec.x as never),
        y: y2,
        y0: table.numbers(spec.y1 as never),
        values: y2,
        range: true,
        rows: undefined,
        length: table.length,
        sorted: table.isSorted(spec.x as never),
      };
      return [series];
    }
    const x = table.numbers(spec.x as never);
    const series = buildSeries(table, this.#split.sources(), x, key, palette, spec.fill);
    if (spec.stack) {
      // Hidden layers drop out of the stack, so the layers above settle down.
      const shown = series.map((s) => !hidden.has(s.key));
      const byVisibility = this.#stacks.get(table, () => new Map());
      const signature = shown.map(Number).join("");
      let layers = byVisibility.get(signature);
      if (!layers) {
        layers = stackLayers(series.map((s, i) => (shown[i] ? s.values : undefined)));
        if (byVisibility.size >= 4) byVisibility.clear();
        byVisibility.set(signature, layers);
      }
      series.forEach((s, i) => {
        s.y = layers.tops[i]!;
        s.y0 = layers.bases[i];
      });
    }
    return series;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    return unionExtent(
      series.flatMap((s) => [
        yExtent(s, x0, x1, s.y, log, this.#indexes.index(this.table, s)),
        s.y0 ? yExtent(s, x0, x1, s.y0, log) : undefined,
      ]),
    );
  }

  geometry(series: readonly Series[], frame: Frame): AreaGeometry[] {
    const { spec } = this;
    const stacked = spec.stack === true;
    const band = this.#split === undefined;
    const fillOpacity = spec.fillOpacity ?? (stacked ? 0.85 : band ? 0.2 : 0.25);
    const outline = spec.line ?? (!stacked && !band);
    const zero = frame.y.type === "log" ? Number.NaN : frame.y.map(0);
    const bottom = frame.plot.y + frame.plot.height;
    const baseline = Number.isFinite(zero)
      ? Math.min(Math.max(zero, frame.plot.y), bottom)
      : bottom;
    const out: AreaGeometry[] = [];
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      // Areas filled to zero read their field's index; bands and stacks scan.
      const edges = s.y0
        ? traceBand(s, s.y, s.y0, frame, spec.curve)
        : {
            upper: tracePath(
              s,
              s.y,
              frame,
              "upper",
              spec.curve,
              this.#indexes.index(
                this.table,
                s,
                frame.owner,
                frame.x.type !== "log" && frame.y.type !== "log",
              ),
            ),
            lower: null,
          };
      out.push({
        kind: "area",
        draw: areaDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity,
        upper: edges.upper,
        lower: edges.lower,
        baseline,
        stroke: outline ? s.color : null,
        strokeWidth: 1.5,
      });
    }
    return out;
  }
}

interface StackLayers {
  /** Top of each layer; NaN where the layer's own value is missing. */
  tops: Float64Array[];
  /** Bottom of each layer (undefined for the first, which starts at zero); always finite. */
  bases: (Float64Array | undefined)[];
}

/**
 * Cumulative stack layers. A missing value leaves a gap in its own layer
 * only: it counts as zero for the layers above, which keep a finite base. An
 * undefined (hidden) layer has zero height.
 */
function stackLayers(layers: readonly (NumericArray | undefined)[]): StackLayers {
  const length = layers.find((layer) => layer)?.length ?? 0;
  const running = new Float64Array(length);
  const tops: Float64Array[] = [];
  const bases: (Float64Array | undefined)[] = [];
  layers.forEach((values, index) => {
    bases.push(index === 0 ? undefined : running.slice());
    const top = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      const value = values ? values[i]! : 0;
      if (Number.isFinite(value)) {
        running[i]! += value;
        top[i] = running[i]!;
      } else {
        top[i] = Number.NaN;
      }
    }
    tops.push(top);
  });
  return { tops, bases };
}

/**
 * Filled areas: to zero, stacked, or a band between two fields.
 *
 * ```ts
 * area(usage, { x: "time", y: ["user", "system"], stack: true })
 * area(latency, { x: "time", y1: "p25", y2: "p75" })
 * ```
 */
export function area<S extends Schema>(table: Table<S>, options: AreaOptions<S>): AreaMark {
  const spec: AreaSpec = {
    type: "area",
    x: options.x,
    ...definedFields(options as AreaCommon, [
      "fill",
      "fillOpacity",
      "line",
      "curve",
      "label",
      "id",
      "axis",
      "facet",
    ]),
  };
  if ("y1" in options) {
    spec.y1 = options.y1;
    spec.y2 = options.y2;
  } else {
    spec.y = typeof options.y === "string" ? options.y : [...options.y];
    if (options.series !== undefined) spec.series = options.series;
    if (options.stack !== undefined) spec.stack = options.stack;
  }
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new AreaMark(spec, table as unknown as Table);
}
