import type { NumericArray } from "../data/column.ts";
import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import type { Breaks } from "../lod/m4.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { AreaGeometry } from "../scene/scene.ts";
import type { AreaSpec, Curve, Frozen, StackGaps } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
  type Bands,
  buildSeries,
  CATEGORY,
  type ChartMark,
  type Frame,
  frozen,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  seriesKey,
  valueKind,
} from "./mark.ts";
import {
  type LayerEdges,
  lowerPosition,
  rowOf,
  type Series,
  xAt,
  xExtent,
  yExtent,
} from "./series.ts";
import { RowStack } from "./stack.ts";
import {
  curveLayers,
  curveRows,
  IndexUse,
  traceBand,
  traceCurvedLayers,
  tracePath,
  unionExtent,
} from "./trace.ts";
import { type StackLayer, UnionStack } from "./union-stack.ts";

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
  /**
   * Marks naming the same group share series by name: series of the same
   * name share a color, one legend entry, and visibility.
   */
  legendGroup?: string;
  id?: string;
}

export type AreaOptions<S extends Schema> = AreaCommon &
  (
    | {
        x: NumericField<S>;
        /** Filled down to zero, or stacked with `stack: true`. */
        y: NumericField<S> | readonly NumericField<S>[];
        /**
         * Category field: one area per value. Stacked, the areas stack in
         * the order of the legend on every x any of them has.
         */
        series?: CategoryField<S>;
        stack?: boolean;
        /**
         * Stacked with a series field: what a series counts as at an x
         * where it has no row, "zero" (the default) or "interpolate" (the
         * straight line between its rows on either side).
         */
        stackGaps?: StackGaps;
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
        stackGaps?: never;
      }
  );

/**
 * Why an area spec has neither or both of its forms (`y`, or `y1` and
 * `y2`), or `stackGaps` without the stack of a series field it is for, if
 * it does.
 */
export function areaFormError(spec: {
  y?: unknown;
  y1?: unknown;
  y2?: unknown;
  series?: unknown;
  stack?: unknown;
  stackGaps?: unknown;
}): string | undefined {
  if (spec.y1 === undefined && spec.y2 === undefined) {
    if (spec.y === undefined) return "An area needs y, or y1 and y2";
    if (spec.stackGaps !== undefined && !(spec.stack && spec.series !== undefined))
      return "stackGaps is for areas stacked by a series field";
    return undefined;
  }
  if (spec.y1 === undefined || spec.y2 === undefined) return "A band area needs both y1 and y2";
  if (spec.y !== undefined || spec.series !== undefined || spec.stack || spec.stackGaps)
    return "An area takes y (with series or stack), or y1 and y2, not both";
  return undefined;
}

export class AreaMark implements Mark<Frozen<AreaSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<AreaSpec>;
  readonly table: Table<Schema>;
  readonly #split: SeriesSplitter | undefined;
  readonly #stack = new RowStack("sum", { indexed: true });
  /** Indexes of each stacked layer's edges, by series key, for long stacks of fields. */
  #stackIndexes = new Map<string, { top: RangeIndex; bottom: RangeIndex | undefined }>();
  /** Series of a series field stack on the x positions of all of them. */
  readonly #union: UnionStack | undefined;
  /**
   * Each chart's stacks of its panels' layers, by the rows of its first
   * panel part (charts split rows apart), while the table, the panels'
   * rows, and the shown series stay the same.
   */
  readonly #panelStacks = new WeakMap<
    Uint32Array,
    {
      version: number;
      signature: string;
      rows: (Uint32Array | undefined)[];
      tops: Float64Array;
      bases: Float64Array;
      edges: (LayerEdges | undefined)[][];
    }
  >();
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
      const gaps = spec.stackGaps;
      if (gaps !== undefined && gaps !== "zero" && gaps !== "interpolate")
        throw new RangeError(`stackGaps must be "zero" or "interpolate", not ${String(gaps)}`);
      this.#split = new SeriesSplitter(table, spec.x, ys, spec.series, spec.label);
      if (spec.stack && spec.series !== undefined) this.#union = new UnionStack();
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

  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    _bands?: Bands,
    _context?: BandContext,
    split = false,
  ) {
    const { spec, table } = this;
    if (!this.#split) {
      const y2 = table.numbers(spec.y2 as never);
      const id = seriesKey(key, "band");
      const label = spec.label ?? `${spec.y1}–${spec.y2}`;
      const series: Series = {
        key: id,
        label,
        color: spec.fill ?? palette(id, label),
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
    if (this.#union) {
      // Rows facets split into panels stack within their panel
      // (stackPanels), and an empty table has nothing to stack: the stack
      // of the whole table lets go of its buffers.
      if (split || series.length === 0) {
        this.#union.clear();
        return series;
      }
      const stack = this.#union.update(
        table,
        x,
        series[0]!.values,
        layersOf(series, hidden),
        spec.stackGaps ?? "zero",
      );
      placeLayers(series, stack.tops, stack.bases, stack.edges);
    } else if (spec.stack) {
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
      series.flatMap((source) => {
        // A layer of a series field's stack extends as far as its edges, which it is drawn through.
        const s = drawnSeries(source);
        const stacked = source.edges ? source.edges.indexes : this.#stackIndexes.get(s.key);
        const top = stacked?.top ?? this.#indexes.index(this.table, s);
        return [
          yExtent(s, x0, x1, s.y, log, top, curved, breaks),
          s.y0 ? yExtent(s, x0, x1, s.y0, log, stacked?.bottom, curved, breaks) : undefined,
        ];
      }),
    );
  }

  /**
   * Stacks each panel's layers of a series field apart, as `series` stacks
   * a whole table's: panels hold disjoint rows, so all of them fill one
   * pair of table-sized top and base arrays.
   */
  stackPanels(panels: readonly (readonly Series[])[], hidden: ReadonlySet<string>): void {
    if (!this.#union) return;
    const { spec, table } = this;
    const signature = panels[0]?.map((s) => Number(!hidden.has(s.key))).join("") ?? "";
    const rows = panels.flatMap((series) => series.map((s) => s.rows));
    const key = rows[0];
    let stacks = key && this.#panelStacks.get(key);
    const kept =
      stacks &&
      stacks.version === table.version &&
      stacks.signature === signature &&
      stacks.rows.length === rows.length &&
      stacks.rows.every((r, i) => r === rows[i]);
    if (!stacks || !kept) {
      const x = table.numbers(spec.x as never);
      const y = table.numbers(this.#split!.yFields[0] as never);
      const tops = new Float64Array(table.length).fill(Number.NaN);
      const bases = new Float64Array(table.length).fill(Number.NaN);
      const gaps = spec.stackGaps ?? "zero";
      const edges = panels.map((series) =>
        UnionStack.once(x, y, layersOf(series, hidden), gaps, tops, bases),
      );
      stacks = { version: table.version, signature, rows, tops, bases, edges };
      if (key) this.#panelStacks.set(key, stacks);
    }
    for (const [p, series] of panels.entries())
      placeLayers(series, stacks.tops, stacks.bases, stacks.edges[p]!);
  }

  /**
   * Layers of a series field's stack pair their rows at one x by
   * occurrence, in row order: beside the anchor's n-th row there, a layer
   * is read at its own n-th. One with fewer rows there holds its last, but
   * has no row of that occurrence to report, as where it has none at all.
   */
  alongside(s: Series, anchor: Series, position: number): number | undefined {
    if (!s.edges || s.edges.x !== anchor.edges?.x) return undefined;
    const at = anchor.x[rowOf(anchor, position)]!;
    let nth = 0;
    if (anchor.sorted) nth = position - lowerPosition(anchor, at);
    else for (let k = 0; k < position; k++) if (xAt(anchor, k) === at) nth++;
    if (s.sorted) {
      const k = lowerPosition(s, at) + nth;
      return k < s.length && xAt(s, k) === at ? k : -1;
    }
    for (let k = 0; k < s.length; k++) if (xAt(s, k) === at && nth-- === 0) return k;
    return -1;
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
    const log = frame.y.type === "log";
    // On a log axis, stacks stand on its low end, where their zeros are drawn (`atLow`).
    const low = Math.min(frame.y.domain[0], frame.y.domain[1]);
    const zero = log ? (stacked ? frame.y.map(low) : Number.NaN) : frame.y.map(0);
    const bottom = frame.plot.y + frame.plot.height;
    const baseline = Number.isFinite(zero)
      ? Math.min(Math.max(zero, frame.plot.y), bottom)
      : bottom;
    const out: AreaGeometry[] = [];
    const style = { baseline, fillOpacity, outline, strokeWidth };
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    // Layers of a series field's stack are drawn through their edges.
    const drawn = visible.map(drawnSeries);
    // Bands and stacks curve all their boundaries together, so layers share
    // edges and never overlap. When they cannot (log y, or too dense), every
    // layer is straight, so shared edges still match.
    const layered = band || stacked;
    const rows =
      spec.curve === "monotone" && layered && drawn[0] && !log
        ? curveRows(drawn[0], frame)
        : undefined;
    if (rows) {
      const layers = drawn.map((s) => ({ series: s, top: s.y, bottom: s.y0 }));
      const edges = traceCurvedLayers(layers, frame, rows, stacked);
      // Charts that animate changed values curve the layers between two scenes alike.
      const curve = frame.keyed ? curveLayers : undefined;
      return drawn.map((s, i) => ({ ...this.#area(s, edges[i]!, style), curve }));
    }
    const curve = spec.curve === "monotone" && layered ? "linear" : spec.curve;
    const linear = frame.x.type !== "log" && !log;
    for (const [i, s] of drawn.entries()) {
      // Areas filled to zero read their field's index, and long stacks their
      // own; bands scan.
      const edges = visible[i]!.edges;
      const indexes = edges ? edges.indexes : this.#stackIndexes.get(s.key);
      const both = indexes?.bottom && { top: indexes.top, bottom: indexes.bottom };
      // On a log axis, a stack's edges at zero run along the plot's bottom.
      const top = stacked && log ? atLow(s.y, low, frame, s.key, "log-top") : s.y;
      const lower = s.y0 && stacked && log ? atLow(s.y0, low, frame, s.key, "log-bottom") : s.y0;
      const traced = lower
        ? traceBand(s, top, lower, frame, curve, both)
        : {
            upper: tracePath(
              s,
              top,
              frame,
              "upper",
              curve,
              indexes && linear
                ? indexes.top
                : this.#indexes.index(this.table, s, frame.owner, linear),
            ),
            lower: null,
          };
      out.push(this.#area(s, traced, style));
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

/** The layers of a series field's stack, in stacking order: each series' rows, and whether it is shown. */
function layersOf(series: readonly Series[], hidden: ReadonlySet<string>): StackLayer[] {
  return series.map((s) => ({ name: s.key, rows: s.rows!, shown: !hidden.has(s.key) }));
}

/**
 * Gives a series field's stacked layers their rows' tops and bases, and
 * their edges; the bottom shown layer stands on zero.
 */
function placeLayers(
  series: readonly Series[],
  tops: Float64Array,
  bases: Float64Array,
  edges: readonly (LayerEdges | undefined)[],
): void {
  let first = true;
  series.forEach((s, i) => {
    s.edges = edges[i];
    s.y = tops;
    s.y0 = first && s.edges ? undefined : bases;
    if (s.edges) first = false;
  });
}

/**
 * What a series is drawn through: for a layer of a series field's stack,
 * its edges, as a whole sorted series of their own; else the series.
 */
function drawnSeries(s: Series): Series {
  const { edges } = s;
  if (!edges) return s;
  return {
    key: s.key,
    label: s.label,
    color: s.color,
    x: edges.x,
    y: edges.top,
    y0: edges.bottom,
    values: edges.top,
    range: false,
    rows: undefined,
    length: edges.x.length,
    sorted: true,
  };
}

/**
 * A stack's edge on a log y axis with its zeros at `low`, the axis' low
 * end, so layers standing on zero (on nothing below, or on hidden layers)
 * are drawn down to it rather than left out.
 */
function atLow(
  values: NumericArray,
  low: number,
  frame: Frame,
  key: string,
  stage: string,
): NumericArray {
  const out = frame.doubles(key, stage, values.length).subarray(0, values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    out[i] = value === 0 ? low : value;
  }
  return out;
}

/**
 * Filled areas: to zero, stacked, or a band between two fields.
 *
 * ```ts
 * area(usage, { x: "time", y: ["user", "system"], stack: true })
 * area(requests, { x: "minute", y: "count", series: "status", stack: true })
 * area(latency, { x: "time", y1: "p25", y2: "p75" })
 * ```
 */
export function area<S extends Schema>(
  table: Table<S>,
  options: AreaOptions<S>,
): ChartMark<Frozen<AreaSpec>> {
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
      "stackGaps",
      "fill",
      "fillOpacity",
      "line",
      "stroke",
      "strokeWidth",
      "curve",
      "label",
      "legendGroup",
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
