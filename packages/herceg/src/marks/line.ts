import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import type { LineGeometry } from "../scene/scene.ts";
import type { Curve, LineSpec } from "../spec/spec.ts";
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
} from "./mark.ts";
import { type Series, xExtent, yExtent } from "./series.ts";
import { IndexUse, tracePath, unionExtent } from "./trace.ts";

export interface LineOptions<S extends Schema> {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  x: NumericField<S>;
  /** One field, or several fields drawn as separate lines sharing x. */
  y: NumericField<S> | readonly NumericField<S>[];
  /** Category field: one line per value. */
  series?: CategoryField<S>;
  /** Constant color for every line of the mark. */
  stroke?: string;
  strokeWidth?: number;
  dash?: number[];
  curve?: Curve;
  /** Name of a single line in legends and tooltips. Defaults to the y field. */
  label?: string;
  id?: string;
}

const DEFAULT_WIDTH = 1.5;

export class LineMark implements Mark<LineSpec> {
  readonly spec: LineSpec;
  readonly table: Table<Schema>;
  readonly tooltip = "x";
  readonly #split: SeriesSplitter;
  readonly #indexes = new IndexUse();

  constructor(spec: LineSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    const ys = typeof spec.y === "string" ? [spec.y] : spec.y;
    requireField(table, spec.x, NUMERIC, "line x");
    for (const y of ys) requireField(table, y, NUMERIC, "line y");
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "line series");
    this.#split = new SeriesSplitter(table, spec.x, ys, spec.series, spec.label);
  }

  channelKind(axis: "x" | "y") {
    return axis === "x" ? this.table.kind(this.spec.x) : "number";
  }

  series(key: MarkKey, palette: Palette) {
    const x = this.table.numbers(this.spec.x as never);
    return buildSeries(this.table, this.#split.sources(), x, key, palette, this.spec.stroke);
  }

  xExtent(series: readonly Series[], log: boolean) {
    return unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    // Curves at the view's edges are measured where they are drawn.
    const curved = this.spec.curve === "monotone";
    return unionExtent(
      series.map((s) => yExtent(s, x0, x1, s.y, log, this.#indexes.index(this.table, s), curved)),
    );
  }

  geometry(series: readonly Series[], frame: Frame): LineGeometry[] {
    const out: LineGeometry[] = [];
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      out.push({
        kind: "line",
        draw: lineDrawing,
        key: s.key,
        stroke: s.color,
        strokeWidth: this.spec.strokeWidth ?? DEFAULT_WIDTH,
        dash: this.spec.dash,
        path: tracePath(
          s,
          s.y,
          frame,
          "line",
          this.spec.curve,
          this.#indexes.index(
            this.table,
            s,
            frame.owner,
            frame.x.type !== "log" && frame.y.type !== "log",
          ),
        ),
      });
    }
    return out;
  }
}

/**
 * Lines through x and y fields of a table.
 *
 * ```ts
 * line(metrics, { x: "time", y: ["p50", "p99"] })
 * line(metrics, { x: "time", y: "latency", series: "service" })
 * ```
 */
export function line<S extends Schema>(table: Table<S>, options: LineOptions<S>): LineMark {
  const spec: LineSpec = {
    type: "line",
    x: options.x,
    y: typeof options.y === "string" ? options.y : [...options.y],
    ...definedFields(options, [
      "series",
      "stroke",
      "strokeWidth",
      "dash",
      "curve",
      "label",
      "id",
      "axis",
      "facet",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new LineMark(spec, table as unknown as Table);
}

/** Copies only the options that are set, so specs stay free of undefined. */
export function definedFields<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
