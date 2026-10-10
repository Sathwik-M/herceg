import type { NumericArray } from "../data/column.ts";
import type { CategoryField, NumericField, PositionField, Schema, Table } from "../data/table.ts";
import { areaDrawing } from "../draw/area.ts";
import type { Breaks } from "../lod/m4.ts";
import type { RangeIndex } from "../lod/minmax-index.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { AreaGeometry } from "../scene/scene.ts";
import type { AreaSpec, AreaStack, Curve, Frozen, StackGaps, StackOrder } from "../spec/spec.ts";
import { BandShares, STILL } from "./dodge.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandContext,
  type Bands,
  buildSeries,
  CATEGORY,
  type ChartMark,
  categoryBands,
  categoryIndices,
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
  bandOrder,
  copiesPoints,
  POSITION,
  positionsExtent,
  type Roles,
  rolesOf,
  traceFrame,
  traceSeries,
  untranspose,
  withBands,
} from "./orient.ts";
import { type LayerEdges, lowerPosition, rowOf, type Series, xExtent, yExtent } from "./series.ts";
import { RowStack } from "./stack.ts";
import { offsetLayers, stackError, stackPointText } from "./stack-offset.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";
import {
  curveLayers,
  curveRows,
  IndexUse,
  type TraceFrame,
  traceBand,
  traceCurvedLayers,
  tracePath,
  unionExtent,
} from "./trace.ts";
import { type StackLayer, UnionStack } from "./union-stack.ts";

interface AreaCommon {
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /**
   * On a category position axis, with `series` and no stack: each series'
   * area through its share of the bands, as grouped bars stand.
   */
  dodge?: boolean;
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

/** Areas of values filled to zero or stacked: their series and stacking. */
interface Filled<S extends Schema> {
  /**
   * Category field: one area per value. Stacked, the areas stack in the
   * order of the legend on every position any of them has.
   */
  series?: CategoryField<S>;
  stack?: AreaStack;
  stackOrder?: StackOrder;
  /**
   * Stacked with a series field: what a series counts as at a position
   * where it has no row, "zero" (the default) or "interpolate" (the
   * straight line between its rows on either side).
   */
  stackGaps?: StackGaps;
  y1?: never;
  y2?: never;
  x1?: never;
  x2?: never;
}

/** A band between two fields: no series or stack. */
interface Banded {
  series?: never;
  stack?: never;
  stackOrder?: never;
  stackGaps?: never;
}

/**
 * Areas along x (positions on x, values on y), or along y with
 * `orient: "y"`, a category y, or a band between `x1` and `x2`. Category
 * positions place points at their bands' centers, in band order.
 */
export type AreaOptions<S extends Schema> = AreaCommon & {
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
} & (
    | (Filled<S> & {
        orient?: "x";
        /** Positions: a number or time field, or a category field. */
        x: PositionField<S>;
        /** Filled down to zero, or stacked with `stack: true`. */
        y: NumericField<S> | readonly NumericField<S>[];
        /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
        axis?: "left" | "right";
      })
    | (Banded & {
        orient?: "x";
        x: PositionField<S>;
        axis?: "left" | "right";
        /** Lower edge of a band. */
        y1: NumericField<S>;
        /** Upper edge of a band. */
        y2: NumericField<S>;
        y?: never;
        x1?: never;
        x2?: never;
      })
    | (Filled<S> & {
        /** Positions along y, values along x, filled to zero along x. */
        orient: "y";
        y: PositionField<S>;
        x: NumericField<S> | readonly NumericField<S>[];
        /** Areas along y use the left axis, as horizontal bars do. */
        axis?: "left";
      })
    | (Filled<S> & {
        orient?: "y";
        /** A category y lays the area along y. */
        y: CategoryField<S>;
        x: NumericField<S> | readonly NumericField<S>[];
        axis?: "left";
      })
    | (Banded & {
        orient?: "y";
        y: PositionField<S>;
        axis?: "left";
        /** Left edge of a band along y. */
        x1: NumericField<S>;
        /** Right edge of a band along y. */
        x2: NumericField<S>;
        x?: never;
        y1?: never;
        y2?: never;
      })
  );

/**
 * Why an area spec has none or more than one of its forms (`x` and `y`;
 * `x`, `y1`, and `y2`; or `y`, `x1`, and `x2`), or options its form does
 * not take (`stackGaps` without a stack of a series field, `dodge` without
 * series, or stacked), if it does.
 */
export function areaFormError(spec: {
  x?: unknown;
  y?: unknown;
  y1?: unknown;
  y2?: unknown;
  x1?: unknown;
  x2?: unknown;
  orient?: unknown;
  series?: unknown;
  stack?: unknown;
  stackOrder?: unknown;
  stackGaps?: unknown;
  dodge?: unknown;
}): string | undefined {
  const stackProblem = stackError(spec.stack, true);
  if (stackProblem) return stackProblem;
  if (spec.stackOrder !== undefined) {
    if (spec.stackOrder !== "input" && spec.stackOrder !== "inside-out")
      return 'area stackOrder: expected "input" or "inside-out"; choose a supported order';
    if (!spec.stack || (spec.stackOrder === "inside-out" && typeof spec.stack !== "string"))
      return 'area stackOrder: needs a nonnegative stack for inside-out order; give stack: "fill", "center", or "wiggle", or drop stackOrder';
  }
  const along = spec.y1 !== undefined || spec.y2 !== undefined;
  const across = spec.x1 !== undefined || spec.x2 !== undefined;
  if (along && across) return "area: a band along x (y1, y2) or along y (x1, x2), not both";
  if (along || across) {
    const [low, high, other, orient] = along ? ["y1", "y2", "y", "x"] : ["x1", "x2", "x", "y"];
    const edges = spec as Record<string, unknown>;
    if (edges[low] === undefined || edges[high] === undefined)
      return `area: a band needs both ${low} and ${high}`;
    if (edges[orient] === undefined)
      return `area ${orient}: a band between ${low} and ${high} runs along ${orient}; give ${orient === "x" ? "an" : "a"} ${orient} field`;
    if (typeof edges[orient] !== "string")
      return `area ${orient}: a band runs along one ${orient} field; give one field`;
    if (edges[other] !== undefined || spec.series !== undefined || spec.stack || spec.stackGaps)
      return `area: ${other} (with series or stack) or ${low} and ${high}, not both; drop one`;
    if (spec.orient !== undefined && spec.orient !== orient)
      return `area orient: a band between ${low} and ${high} runs along ${orient}; drop orient`;
    if (spec.dodge)
      return "area dodge: places the series of a series field side by side; a band has none";
    return undefined;
  }
  if (spec.x === undefined || spec.y === undefined)
    return "area: needs x and y, or a band: y1 and y2 along x, or x1 and x2 along y";
  if (spec.stackGaps !== undefined && !(spec.stack && spec.series !== undefined))
    return "area stackGaps: for stacks by a series field; give stack and series, or drop it";
  if (spec.dodge && spec.series === undefined)
    return "area dodge: places series side by side; give a series field";
  if (spec.dodge && spec.stack)
    return "area dodge: a stack's layers stand on each other; drop dodge or stack";
  return undefined;
}

export class AreaMark implements Mark<Frozen<AreaSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<AreaSpec>;
  readonly table: Table<Schema>;
  readonly tooltip: "x" | "y";
  readonly pointText?: (s: Series, row: number, format: AxisFormat) => string;
  readonly #roles: Roles;
  /** Undefined for a band between two fields. */
  readonly #split: SeriesSplitter | undefined;
  readonly #stack: RowStack;
  /** Indexes of each stacked layer's edges, by series key, for long stacks of fields. */
  #stackIndexes = new Map<string, { top: RangeIndex; bottom: RangeIndex | undefined }>();
  /** Series of a series field stack on the positions of all of them. */
  readonly #union: UnionStack | undefined;
  /** Owned panel buffers, keyed by the chart's facet planner. */
  readonly #panelStacks = new WeakMap<
    object,
    {
      version: number;
      signature: string;
      rows: (Uint32Array | undefined)[];
      positions: NumericArray | undefined;
      tops: Float64Array[];
      bases: Float64Array[];
      totals: Float64Array | undefined;
      edges: (LayerEdges | undefined)[][];
      orders: number[][];
    }
  >();
  readonly #indexes = new IndexUse();
  /** With `dodge`, each series' slot in the bands, as last drawn. */
  readonly #shares: BandShares | undefined;
  readonly zero: "x" | "y" | undefined;

  constructor(input: AreaSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "area");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    this.#stack = new RowStack("sum", {
      indexed: true,
      ...(typeof spec.stack === "string" && {
        offset: {
          fill: spec.stack === "fill",
          global: spec.stack === "wiggle" || spec.stackOrder === "inside-out",
          resolve: (tops, bases, positions, totals) =>
            offsetLayers(tops, bases, spec.stack!, spec.stackOrder, positions, totals),
        },
      }),
    });
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth >= 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(
        `area strokeWidth: expected 0 or more pixels; received ${spec.strokeWidth}`,
      );
    const problem = areaFormError(spec);
    if (problem) throw new Error(problem);
    const edges =
      spec.y1 !== undefined
        ? (["y1", "y2"] as const)
        : spec.x1 !== undefined
          ? (["x1", "x2"] as const)
          : undefined;
    if (edges) {
      // A band's edges are values across the axis it runs along.
      const orient = edges[0] === "y1" ? "x" : "y";
      const position = (orient === "x" ? spec.x : spec.y) as string;
      requireField(table, position, POSITION, `area ${orient}`);
      for (const edge of edges) requireField(table, spec[edge]!, NUMERIC, `area ${edge}`);
      this.#roles = {
        orient,
        position,
        values: [spec[edges[0]]!, spec[edges[1]]!],
        banded: table.kind(position) === "category",
      };
    } else {
      const roles = rolesOf(table, "area", spec.x!, spec.y!, spec.orient, spec.series);
      this.#roles = roles;
      if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "area series");
      const gaps = spec.stackGaps;
      if (gaps !== undefined && gaps !== "zero" && gaps !== "interpolate")
        throw new RangeError(
          `area stackGaps: expected "zero" or "interpolate"; received ${JSON.stringify(gaps)}`,
        );
      // Areas over categories run in band order, which their series sort by.
      const position = roles.banded ? undefined : roles.position;
      this.#split = new SeriesSplitter(table, position, roles.values, spec.series, spec.label);
      if (spec.stack && spec.series !== undefined)
        this.#union = new UnionStack(spec.stack, spec.stackOrder);
    }
    const { orient, banded } = this.#roles;
    if (spec.dodge) {
      if (!banded)
        throw new Error(
          `area dodge: places series side by side in the bands of a category ${orient}; give a category field as ${orient}, or drop dodge`,
        );
      this.#shares = new BandShares();
    }
    this.tooltip = orient;
    if (spec.stack === "fill")
      this.pointText = (s, row, format) => stackPointText(s, row, orient, format);
    this.zero = edges ? undefined : orient === "x" ? "y" : "x";
  }

  channelKind(axis: "x" | "y") {
    const { orient, position, values } = this.#roles;
    return axis === orient ? this.table.kind(position) : valueKind(this.table, values);
  }

  bands(axis: "x" | "y") {
    const { orient, position, banded } = this.#roles;
    return banded && axis === orient ? categoryBands(this.table, position) : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    bands: Bands = {},
    _context?: BandContext,
    split = false,
  ) {
    const { spec, table } = this;
    const { orient, position, values, banded } = this.#roles;
    // A category position is each row's band index on the chart's axis.
    const positions = banded
      ? categoryIndices(table, position, bands[orient]?.keys ?? [])
      : table.numbers(position as never);
    let series: Series[];
    if (!this.#split) {
      const [low, high] = values as [string, string];
      const top = table.numbers(high as never);
      const id = seriesKey(key, "band");
      const label = spec.label ?? `${low}–${high}`;
      const color = palette(id, label, spec.fill);
      series = [
        {
          key: id,
          label,
          color: spec.fill ?? color,
          x: positions,
          y: top,
          y0: table.numbers(low as never),
          values: top,
          range: true,
          rows: undefined,
          length: table.length,
          sorted: !banded && table.isSorted(position as never),
        },
      ];
    } else {
      series = buildSeries(table, this.#split.sources(), positions, key, palette, spec.fill);
    }
    for (const s of series) {
      // Rows without a category are not drawn; stacks take the others in their order.
      if (banded) {
        s.rows = withBands(positions, s.rows, s.length);
        s.length = s.rows?.length ?? table.length;
        s.stream = undefined;
      }
      // Series hold the chart's x and y; areas along y are sorted, if at all, in y.
      if (orient === "y")
        [s.x, s.y, s.x0, s.y0, s.ySorted, s.sorted] = [s.y, s.x, s.y0, undefined, s.sorted, false];
    }
    if (this.#split) this.#stackSeries(series, positions, hidden, split, bands[orient]?.keys);
    // Areas over categories run through their rows in band order.
    if (banded) {
      for (const s of series) {
        s.rows = bandOrder(positions, s.rows, s.length);
        s.length = s.rows?.length ?? table.length;
        if (orient === "x") s.sorted = true;
        else s.ySorted = true;
      }
    }
    return series;
  }

  /** Stacks the series of a series field, or of several fields row by row, as `stack` says. */
  #stackSeries(
    series: Series[],
    positions: NumericArray,
    hidden: ReadonlySet<string>,
    split: boolean,
    places?: object,
  ): void {
    if (this.#union) {
      // Rows facets split into panels stack within their panel
      // (stackPanels), and an empty table has nothing to stack: the stack
      // of the whole table lets go of its buffers.
      if (split || series.length === 0) {
        this.#union.clear();
        return;
      }
      const stack = this.#union.update(
        this.table,
        positions,
        series[0]!.values,
        layersOf(series, hidden),
        this.spec.stackGaps ?? "zero",
        places,
      );
      for (const s of series) s.stackTotals = stack.totals;
      this.#place(series, stack.tops, stack.bases, stack.edges);
    } else if (this.spec.stack) {
      if (split && typeof this.spec.stack === "string") return;
      // Hidden layers drop out of the stack, so the layers above settle down.
      const shown = series.map((s) => !hidden.has(s.key));
      const layers = this.#stack.update(
        this.table,
        series.map((s, i) => (shown[i] ? s.values : undefined)),
        shown.map(Number).join(""),
        this.#roles.banded && typeof this.spec.stack === "string"
          ? Float64Array.from(positions, (p) => (p < 0 ? Number.NaN : p))
          : positions,
        places,
      );
      this.#stackIndexes.clear();
      series.forEach((s, i) => {
        s.stackIndex = layers.order?.indexOf(i) ?? i;
        s.stackTotals = layers.totals;
        this.#stand(s, layers.tops[i]!, layers.bases[i]);
        const indexes = layers.indexes?.[i];
        if (indexes) this.#stackIndexes.set(s.key, indexes);
      });
    }
  }

  /**
   * Gives a series its stacked tops and bases, on the axis of its values;
   * along y, its x no longer ascends as its values may have (facets work
   * `sorted` out from them).
   */
  #stand(s: Series, tops: NumericArray, bases: NumericArray | undefined): void {
    if (this.#roles.orient === "x") [s.y, s.y0] = [tops, bases];
    else [s.x, s.x0, s.sorted] = [tops, bases, false];
  }

  /**
   * Gives a series field's stacked layers their rows' tops and bases, and
   * their edges; the bottom shown layer stands on zero.
   */
  #place(
    series: readonly Series[],
    tops: Float64Array,
    bases: Float64Array,
    edges: readonly (LayerEdges | undefined)[],
  ): void {
    let first = true;
    series.forEach((s, i) => {
      s.edges = edges[i];
      this.#stand(s, tops, first && s.edges && this.spec.stack === true ? undefined : bases);
      if (s.edges) first = false;
    });
  }

  xExtent(series: readonly Series[], log: boolean) {
    if (this.spec.stack === "fill" && this.#roles.orient === "y" && !log)
      return [0, 1] as [number, number];
    if (this.#roles.orient === "x") return unionExtent(series.map((s) => xExtent(s, log)));
    // Areas along y fill across x from their bases (zero, a stack's, or a
    // band's low edge); a stack's layers reach as far as their edges.
    return unionExtent(
      series.flatMap((s) => {
        const ends = s.edges ? [s.edges.top, s.edges.bottom] : [s.x, s.x0];
        return ends.map((values) => values && valuesExtent(values, s.edges ? undefined : s, log));
      }),
    );
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    // Along y, positions span what they span, whatever x shows.
    if (this.#roles.orient === "y")
      return unionExtent(
        series.map((s) =>
          s.edges ? valuesExtent(s.edges.x, undefined, log) : positionsExtent(s, log),
        ),
      );
    if (this.spec.stack === "fill" && !log) return [0, 1] as [number, number];
    const curved = this.spec.curve === "monotone";
    return unionExtent(
      series.flatMap((source) => {
        // A layer of a series field's stack extends as far as its edges, which it is drawn through.
        const s = drawnSeries(source);
        // A row stack's indexes are by row: of series reading every row in
        // order, not rows reordered by band.
        const stacked = source.edges
          ? source.edges.indexes
          : s.rows === undefined
            ? this.#stackIndexes.get(s.key)
            : undefined;
        const top = stacked?.top ?? this.#indexes.index(this.table, s);
        return [
          yExtent(s, x0, x1, s.y, log, top, curved, breaks),
          s.y0 ? yExtent(s, x0, x1, s.y0, log, stacked?.bottom, curved, breaks) : undefined,
        ];
      }),
    );
  }

  /** Stack disjoint panel rows in reusable table-sized boundaries. */
  stackPanels(
    panels: readonly (readonly Series[])[],
    hidden: ReadonlySet<string>,
    scope: object = panels[0]?.[0]?.rows ?? panels,
  ): void {
    const { spec, table } = this;
    if (!this.#union && typeof spec.stack !== "string") return;
    const first = panels.find((series) => series.length > 0)?.[0];
    const positions = first?.[this.#roles.orient];
    const signature = panels
      .map((series) => series.map((s) => Number(!hidden.has(s.key))).join(""))
      .join(";");
    const rows = panels.flatMap((series) => series.map((s) => s.rows));
    let stacks = this.#panelStacks.get(scope);
    const kept =
      stacks &&
      stacks.version === table.version &&
      stacks.signature === signature &&
      stacks.positions === positions &&
      stacks.rows.length === rows.length &&
      stacks.rows.every((r, i) => r === rows[i]);
    if (!kept) {
      // Failed computations must not leave a valid cache over partially written buffers.
      this.#panelStacks.delete(scope);
      const count = this.#union ? 1 : this.#roles.values.length;
      if (!stacks || stacks.tops[0]?.length !== table.length) {
        stacks = {
          version: -1,
          signature,
          rows,
          positions,
          tops: Array.from({ length: count }, () => new Float64Array(table.length)),
          bases: Array.from({ length: count }, () => new Float64Array(table.length)),
          totals: spec.stack === "fill" ? new Float64Array(table.length) : undefined,
          edges: [],
          orders: [],
        };
      }
      for (const top of stacks.tops) top.fill(Number.NaN);
      for (const base of stacks.bases) base.fill(Number.NaN);
      stacks.totals?.fill(Number.NaN);
      if (this.#union) {
        const x = positions ?? table.numbers(this.#roles.position as never);
        const y = table.numbers(this.#split!.yFields[0] as never);
        stacks.edges = panels.map((series) =>
          UnionStack.once(
            x,
            y,
            layersOf(series, hidden),
            spec.stackGaps ?? "zero",
            stacks!.tops[0]!,
            stacks!.bases[0]!,
            spec.stack,
            spec.stackOrder,
            stacks!.totals,
          ),
        );
      } else {
        for (const [p, series] of panels.entries()) {
          const source = series[0];
          if (!source) continue;
          for (const [l, s] of series.entries()) {
            const shown = !hidden.has(s.key);
            for (let i = 0; i < source.length; i++) {
              const row = rowOf(source, i);
              stacks.tops[l]![row] = shown ? s.values[row]! : 0;
            }
          }
          stacks.orders[p] = offsetLayers(
            stacks.tops,
            stacks.bases,
            spec.stack!,
            spec.stackOrder,
            source[this.#roles.orient],
            stacks.totals,
            "area stack",
            source.rows,
          );
        }
      }
      Object.assign(stacks, { version: table.version, signature, rows, positions });
      this.#panelStacks.set(scope, stacks);
    }
    panels.forEach((series, p) => {
      for (const s of series) s.stackTotals = stacks!.totals;
      if (this.#union) this.#place(series, stacks!.tops[0]!, stacks!.bases[0]!, stacks!.edges[p]!);
      else
        series.forEach((s, l) => {
          s.stackIndex = stacks!.orders[p]!.indexOf(l);
          this.#stand(s, stacks!.tops[l]!, stacks!.bases[l]);
        });
    });
  }

  /**
   * Layers of a series field's stack pair their rows at one position by
   * occurrence, in row order: beside the anchor's n-th row there, a layer
   * is read at its own n-th. One with fewer rows there holds its last, but
   * has no row of that occurrence to report, as where it has none at all.
   */
  alongside(s: Series, anchor: Series, position: number): number | undefined {
    if (!s.edges || s.edges.x !== anchor.edges?.x) return undefined;
    const along = this.#roles.orient;
    const sorted = (t: Series) => (along === "x" ? t.sorted : (t.ySorted ?? false));
    const at = anchor[along][rowOf(anchor, position)]!;
    const atOf = (t: Series, k: number) => t[along][rowOf(t, k)]!;
    let nth = 0;
    if (sorted(anchor)) nth = position - lowerPosition(anchor, at, along);
    else for (let k = 0; k < position; k++) if (atOf(anchor, k) === at) nth++;
    if (sorted(s)) {
      const k = lowerPosition(s, at, along) + nth;
      return k < s.length && atOf(s, k) === at ? k : -1;
    }
    for (let k = 0; k < s.length; k++) if (atOf(s, k) === at && nth-- === 0) return k;
    return -1;
  }

  geometry(series: readonly Series[], frame: Frame): AreaGeometry[] {
    const { spec } = this;
    const { orient } = this.#roles;
    const stacked = Boolean(spec.stack);
    const band = this.#split === undefined;
    const fillOpacity = spec.fillOpacity ?? (stacked ? 0.85 : band ? 0.2 : 0.25);
    const strokeWidth = spec.strokeWidth ?? frame.theme.lineWidth;
    const outline =
      strokeWidth > 0 &&
      (spec.line ??
        (spec.stroke !== undefined || spec.strokeWidth !== undefined || (!stacked && !band)));
    // Areas are traced along their positions, as areas along x: on a frame
    // with x and y swapped for areas along y.
    const view = traceFrame(frame, orient, 0);
    const log = view.y.type === "log";
    if (log && (spec.stack === "center" || spec.stack === "wiggle"))
      throw new Error(
        `area stack ${JSON.stringify(spec.stack)}: stream baselines need a linear value axis; set ${orient === "x" ? "y" : "x"}.type to "linear"`,
      );
    // On a log axis, stacks stand on its low end, where their zeros are drawn (`atLow`).
    const low = Math.min(view.y.domain[0], view.y.domain[1]);
    const zero = log ? (stacked ? view.y.map(low) : Number.NaN) : view.y.map(0);
    // Without a zero, areas close at the plot's edge: its bottom, or the low end of x.
    const edge = orient === "x" ? view.plot.y + view.plot.height : view.y.map(low);
    const baseline = Number.isFinite(zero)
      ? Math.min(Math.max(zero, view.plot.y), view.plot.y + view.plot.height)
      : edge;
    const out: AreaGeometry[] = [];
    const style = { baseline, fillOpacity, outline, strokeWidth };
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    // Parts of series (a highlight's selected rows) stand in their wholes' slots.
    if (!series.every((s) => s.whole)) this.#shares?.split(series, frame, spec.legendGroup, true);
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    if (spec.stackOrder === "inside-out")
      visible.sort(
        (a, b) => (a.edges?.order ?? a.stackIndex ?? 0) - (b.edges?.order ?? b.stackIndex ?? 0),
      );
    // Layers of a series field's stack are drawn through their edges. Layers
    // keep values a break hides along y, at its seam, so their edges stay shared.
    const layered = band || stacked;
    const drawn = visible.map((s) => this.#traced(s, frame, !layered));
    // Bands and stacks curve all their boundaries together, so layers share
    // edges and never overlap. When they cannot (log y, or too dense), every
    // layer is straight, so shared edges still match.
    const rows =
      spec.curve === "monotone" && layered && drawn[0] && !log
        ? curveRows(drawn[0], view)
        : undefined;
    if (rows) {
      const layers = drawn.map((s) => ({ series: s, top: s.y, bottom: s.y0 }));
      const edges = traceCurvedLayers(layers, view, rows, stacked);
      // Charts that animate changed values curve the layers between two scenes alike.
      const curve = frame.keyed ? curveLayers : undefined;
      return drawn.map((s, i) => ({ ...this.#area(s, edges[i]!, style, frame), curve }));
    }
    const curve = spec.curve === "monotone" && layered ? "linear" : spec.curve;
    const linear = view.x.type !== "log" && !log;
    for (const [i, s] of drawn.entries()) {
      // A dodged series stands at its share of the bands.
      const at = this.#shares ? traceFrame(frame, orient, this.#shift(visible[i]!, frame)) : view;
      // Areas filled to zero read their field's index, and long stacks their
      // own; bands scan, as do a panel's copies of its points, renumbered.
      const { edges } = visible[i]!;
      const copied = copiesPoints(visible[i]!, frame, orient, !layered);
      const indexes = copied ? undefined : edges ? edges.indexes : this.#stackIndexes.get(s.key);
      const both = indexes?.bottom && { top: indexes.top, bottom: indexes.bottom };
      // On a log axis, a stack's edges at zero run along the plot's bottom.
      const top = stacked && log ? atLow(s.y, low, at, s.key, "log-top") : s.y;
      const lower = s.y0 && stacked && log ? atLow(s.y0, low, at, s.key, "log-bottom") : s.y0;
      const traced = lower
        ? traceBand(s, top, lower, at, curve, both)
        : {
            upper: tracePath(
              s,
              top,
              at,
              "upper",
              curve,
              indexes && linear
                ? indexes.top
                : this.#indexes.index(this.table, s, frame.owner, linear),
            ),
            lower: null,
          };
      out.push(this.#area(s, traced, style, frame));
    }
    return out;
  }

  /**
   * A series as traced on `traceFrame`'s frame, positions as x: its rows,
   * or for a layer of a series field's stack, its edges; along y, without
   * the rows a break hides when `hides` says.
   */
  #traced(s: Series, frame: Frame, hides: boolean): Series {
    const { orient, banded } = this.#roles;
    if (s.edges) return traceSeries(edgeSeries(s, s.edges, orient), frame, orient, true, hides);
    // Rows over categories are in band order.
    const sorted = banded || (orient === "x" ? s.sorted : (s.ySorted ?? false));
    return traceSeries(s, frame, orient, sorted, hides);
  }

  /** How far a dodged series stands from its bands' centers, in pixels. */
  #shift(s: Series, frame: Frame): number {
    const scale = this.#roles.orient === "x" ? frame.x : frame.y;
    return this.#shares!.of(s, scale.bandwidth ?? 0).center;
  }

  /** Where a dodged series' points are drawn, from their bands' centers. */
  displace(s: Series, _row: number, frame: Frame): readonly [number, number] {
    if (!this.#shares) return STILL;
    const shift = this.#shift(s, frame);
    return this.#roles.orient === "x" ? [shift, 0] : [0, shift];
  }

  /** Dodged series stand within their bands: at most half a band off along x. */
  maxDisplacement(_s: Series, frame: Frame): number {
    return this.#shares && this.#roles.orient === "x" ? Math.abs(frame.x.bandwidth ?? 0) / 2 : 0;
  }

  /**
   * An area's geometry from its traced edges, in the chart's coordinates:
   * an area along y, traced with x and y swapped, swaps back, and closes
   * along its baseline (across x) through a lower edge of its own.
   */
  #area(
    s: Series,
    edges: { upper: Polyline; lower: Polyline | null },
    style: { baseline: number; fillOpacity: number; outline: boolean; strokeWidth: number },
    frame: Frame,
  ): AreaGeometry {
    const { baseline, fillOpacity, outline, strokeWidth } = style;
    let { upper, lower } = edges;
    // Inside-out order can change after a value update. Showing it at once
    // avoids interpolating layers through one another.
    if (this.spec.stackOrder === "inside-out") {
      upper.whole = false;
      if (lower) lower.whole = false;
    }
    if (this.#roles.orient === "y") {
      if (!lower) {
        lower = frame.polyline(s.key, "baseline");
        lower.reset();
        for (let run = 0; run < upper.starts.length; run++) {
          const start = upper.starts[run]!;
          const end = upper.runEnd(run);
          lower.break();
          lower.push(upper.coords[start * 2]!, baseline);
          lower.push(upper.coords[(end - 1) * 2]!, baseline);
        }
        untranspose(lower);
      } else {
        untranspose(lower);
        lower.whole = false;
      }
      untranspose(upper);
      // Value transitions move areas along y only.
      upper.whole = false;
    }
    return {
      kind: "area",
      draw: areaDrawing,
      key: s.key,
      fill: s.color,
      fillOpacity,
      upper,
      lower,
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

/** [min, max] of values a scale can place (`log`: positive ones), at a series' rows or all of them. */
function valuesExtent(
  values: NumericArray,
  s: Series | undefined,
  log: boolean,
): [number, number] | undefined {
  const view = { x: values, rows: s?.rows, length: s?.length ?? values.length, sorted: false };
  return xExtent(view as Series, log);
}

/**
 * What a series is drawn through: for a layer of a series field's stack,
 * its edges, as a whole sorted series of their own; else the series.
 */
function drawnSeries(s: Series): Series {
  return s.edges ? edgeSeries(s, s.edges, "x") : s;
}

/**
 * A layer of a series field's stack as a series of its edges (positions
 * ascending, on the axis the area runs along), in the chart's coordinates,
 * placed through the layer's band places.
 */
function edgeSeries(s: Series, edges: LayerEdges, orient: "x" | "y"): Series {
  const along = orient === "x";
  return {
    key: s.key,
    label: s.label,
    color: s.color,
    x: along ? edges.x : edges.top,
    y: along ? edges.top : edges.x,
    y0: along ? edges.bottom : undefined,
    x0: along ? undefined : edges.bottom,
    values: edges.top,
    range: false,
    rows: undefined,
    length: edges.x.length,
    sorted: along,
    ySorted: !along,
    places: s.places,
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
  frame: TraceFrame,
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
 * area(profile, { x: "density", y: "depth", orient: "y" })
 * ```
 */
export function area<S extends Schema>(
  table: Table<S>,
  options: AreaOptions<S>,
): ChartMark<Frozen<AreaSpec>> {
  const { x, y } = options;
  // Every option is kept, so the mark refuses forms mixed by casts or JavaScript.
  const spec = {
    type: "area",
    ...definedFields(options, [
      "tooltip",
      "orient",
      "y1",
      "y2",
      "x1",
      "x2",
      "series",
      "dodge",
      "stack",
      "stackGaps",
      "stackOrder",
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
    ...(x !== undefined && { x: typeof x === "string" ? x : [...x] }),
    ...(y !== undefined && { y: typeof y === "string" ? y : [...y] }),
  } as unknown as AreaSpec;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new AreaMark(spec, table as unknown as Table);
}
