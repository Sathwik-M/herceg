import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import type { Breaks } from "../lod/m4.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { AreaGeometry } from "../scene/scene.ts";
import type { AreaSpec, Curve, Frozen } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  buildSeries,
  CATEGORY,
  type Frame,
  frozen,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  seriesKey,
  valueKind,
} from "./mark.ts";
import { type Series, xExtent, yExtent } from "./series.ts";
import { RowStack } from "./stack.ts";
import {
  curveRows,
  IndexUse,
  traceBand,
  traceCurvedLayers,
  tracePath,
  unionExtent,
} from "./trace.ts";

interface AreaCommon {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** Constant fill color for every area of the mark. */
  fill?: string;
  fillOpacity?: number;
  /** Outline the top edge; on by default for unstacked areas filled to zero, or with `stroke`. */
  line?: boolean;
  /** Outline color; each area's own color by default. */
  stroke?: string;
  /** Outline width in pixels; the theme's line width by default. */
  strokeWidth?: number;
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
        y1?: never;
        y2?: never;
      }
    | {
        x: NumericField<S>;
        /** Lower edge of a band. */
        y1: NumericField<S>;
        /** Upper edge of a band. */
        y2: NumericField<S>;
        y?: never;
        series?: never;
        stack?: never;
      }
  );

/** Why an area spec has neither or both of its forms (`y`, or `y1` and `y2`), if it does. */
export function areaFormError(spec: {
  y?: unknown;
  y1?: unknown;
  y2?: unknown;
  series?: unknown;
  stack?: unknown;
}): string | undefined {
  if (spec.y1 === undefined && spec.y2 === undefined)
    return spec.y === undefined ? "An area needs y, or y1 and y2" : undefined;
  if (spec.y1 === undefined || spec.y2 === undefined) return "A band area needs both y1 and y2";
  if (spec.y !== undefined || spec.series !== undefined || spec.stack)
    return "An area takes y (with series or stack), or y1 and y2, not both";
  return undefined;
}

export class AreaMark implements Mark<Frozen<AreaSpec>> {
  readonly spec: Frozen<AreaSpec>;
  readonly table: Table<Schema>;
  readonly #split: SeriesSplitter | undefined;
  readonly #stack = new RowStack("sum", { indexed: true });
  /** Indexes of each stacked layer's edges, by series key, for long stacks. */
  #stackIndexes = new Map<string, { top: RangeIndex; bottom: RangeIndex | undefined }>();
  readonly #indexes = new IndexUse();
  readonly zero: "y" | undefined;

  constructor(input: AreaSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    requireField(table, spec.x, NUMERIC, "area x");
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth >= 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(`area strokeWidth must be 0 or more pixels, not ${spec.strokeWidth}`);
    const problem = areaFormError(spec);
    if (problem) throw new Error(problem);
    const band = spec.y === undefined;
    if (band) {
      requireField(table, spec.y1, NUMERIC, "area y1");
      requireField(table, spec.y2, NUMERIC, "area y2");
    } else {
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
    const { spec, table } = this;
    if (axis === "x") return table.kind(spec.x);
    const ys = typeof spec.y === "string" ? [spec.y] : (spec.y ?? [spec.y1!, spec.y2!]);
    return valueKind(table, ys);
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
      const layers = this.#stack.update(
        table,
        series.map((s, i) => (shown[i] ? s.values : undefined)),
        shown.map(Number).join(""),
      );
      this.#stackIndexes.clear();
      series.forEach((s, i) => {
        s.y = layers.tops[i]!;
        s.y0 = layers.bases[i];
        const indexes = layers.indexes?.[i];
        if (indexes) this.#stackIndexes.set(s.key, indexes);
      });
    }
    return series;
  }

  xExtent(series: readonly Series[], log: boolean) {
    return unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    const curved = this.spec.curve === "monotone";
    return unionExtent(
      series.flatMap((s) => {
        const stacked = this.#stackIndexes.get(s.key);
        const top = stacked?.top ?? this.#indexes.index(this.table, s);
        return [
          yExtent(s, x0, x1, s.y, log, top, curved, breaks),
          s.y0 ? yExtent(s, x0, x1, s.y0, log, stacked?.bottom, curved, breaks) : undefined,
        ];
      }),
    );
  }

  geometry(series: readonly Series[], frame: Frame): AreaGeometry[] {
    const { spec } = this;
    const stacked = spec.stack === true;
    const band = this.#split === undefined;
    const fillOpacity = spec.fillOpacity ?? (stacked ? 0.85 : band ? 0.2 : 0.25);
    const strokeWidth = spec.strokeWidth ?? frame.theme.lineWidth;
    const outline =
      strokeWidth > 0 &&
      (spec.line ??
        (spec.stroke !== undefined || spec.strokeWidth !== undefined || (!stacked && !band)));
    const zero = frame.y.type === "log" ? Number.NaN : frame.y.map(0);
    const bottom = frame.plot.y + frame.plot.height;
    const baseline = Number.isFinite(zero)
      ? Math.min(Math.max(zero, frame.plot.y), bottom)
      : bottom;
    const out: AreaGeometry[] = [];
    const style = { baseline, fillOpacity, outline, strokeWidth };
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    // Bands and stacks curve all their boundaries together, so layers share
    // edges and never overlap. When they cannot (log y, or too dense), every
    // layer is straight, so shared edges still match.
    const layered = band || stacked;
    const rows =
      spec.curve === "monotone" && layered && series[0] && frame.y.type !== "log"
        ? curveRows(series[0], frame)
        : undefined;
    if (rows) {
      const visible = series.filter((s) => !frame.hidden.has(s.key));
      const layers = visible.map((s) => ({ series: s, top: s.y, bottom: s.y0 }));
      const edges = traceCurvedLayers(layers, frame, rows, stacked);
      return visible.map((s, i) => this.#area(s, edges[i]!, style));
    }
    const curve = spec.curve === "monotone" && layered ? "linear" : spec.curve;
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      // Areas filled to zero read their field's index, and long stacks their
      // own; bands scan.
      const stacked = this.#stackIndexes.get(s.key);
      const both = stacked?.bottom && { top: stacked.top, bottom: stacked.bottom };
      const edges = s.y0
        ? traceBand(s, s.y, s.y0, frame, curve, both)
        : {
            upper: tracePath(
              s,
              s.y,
              frame,
              "upper",
              curve,
              stacked && frame.x.type !== "log" && frame.y.type !== "log"
                ? stacked.top
                : this.#indexes.index(
                    this.table,
                    s,
                    frame.owner,
                    frame.x.type !== "log" && frame.y.type !== "log",
                  ),
            ),
            lower: null,
          };
      out.push(this.#area(s, edges, style));
    }
    return out;
  }

  #area(
    s: Series,
    edges: { upper: Polyline; lower: Polyline | null },
    style: { baseline: number; fillOpacity: number; outline: boolean; strokeWidth: number },
  ): AreaGeometry {
    const { baseline, fillOpacity, outline, strokeWidth } = style;
    return {
      kind: "area",
      draw: areaDrawing,
      key: s.key,
      fill: s.color,
      fillOpacity,
      upper: edges.upper,
      lower: edges.lower,
      baseline,
      stroke: outline ? (this.spec.stroke ?? s.color) : null,
      strokeWidth,
    };
  }
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
  const { y } = options;
  // Every option is kept, so the mark refuses forms mixed by casts or JavaScript.
  const spec = {
    type: "area",
    ...definedFields(options, [
      "x",
      "y1",
      "y2",
      "series",
      "stack",
      "fill",
      "fillOpacity",
      "line",
      "stroke",
      "strokeWidth",
      "curve",
      "label",
      "id",
      "axis",
      "facet",
      "panel",
    ]),
    ...(y !== undefined && { y: typeof y === "string" ? y : [...y] }),
  } as unknown as AreaSpec;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new AreaMark(spec, table as unknown as Table);
}
