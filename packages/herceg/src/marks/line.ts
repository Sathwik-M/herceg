import type { CategoryField, NumericField, PositionField, Schema, Table } from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import type { Breaks } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import { asksFeatures } from "../model/features.ts";
import type { Geometry, LineGeometry } from "../scene/scene.ts";
import type { Clip, Curve, Dash, Frozen, LineSpec, SymbolName } from "../spec/spec.ts";
import { dashPattern } from "../style/style.ts";
import { BandShares, STILL } from "./dodge.ts";
import type { Condition, Continuity, CssColor, Encodings, MarkStyle } from "./encoding.ts";
import {
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
  type Palette,
  requireField,
  SeriesSplitter,
  valueKind,
} from "./mark.ts";
import {
  bandOrder,
  positionsExtent,
  type Roles,
  rolesOf,
  traceFrame,
  traceSeries,
  untranspose,
} from "./orient.ts";
import { type Series, xExtent, yExtent } from "./series.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";
import { IndexUse, tracePath, unionExtent } from "./trace.ts";

interface LineStyle<S extends Schema> {
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** With the chart's `panel`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** Category field: one line per value. */
  series?: CategoryField<S>;
  /**
   * On a category position axis, with `series`: each series' line through
   * its share of the bands, as grouped bars and dodged points stand.
   */
  dodge?: boolean;
  /** Constant color for every line of the mark. */
  stroke?: string;
  strokeWidth?: number;
  /** Pixel dash array, or a matplotlib style scaled by the stroke width. */
  dash?: Dash;
  /** From 0 to 1: the whole mark's, markers included. */
  opacity?: number;
  /** From 0 to 1: the lines' strokes'. */
  strokeOpacity?: number;
  /**
   * The lines' color: a category field (constant within each series)
   * through the chart's "color" scale, or a color. The short form of
   * `encode.color`; `stroke` wins over it.
   */
  color?: CategoryField<S> | CssColor;
  /** Channels, each constant within a series: color, stroke, dash, strokeWidth, opacity. */
  encode?: Pick<Encodings<S>, "color" | "stroke" | "dash" | "strokeWidth" | "opacity">;
  /** Looks by series (`by`), and the markers' look. */
  style?: Pick<MarkStyle<S>, "by" | "marker">;
  /** A marker at each observation drawn: a circle (`true`) or the shape named. */
  markers?: boolean | SymbolName;
  /**
   * Which observations the lines connect: not where `defined` fails, across
   * more than `maxGap` along the positions, or across a `breakBy` boundary.
   */
  continuity?: Continuity<S>;
  /** Rows to leave out, as gaps: the lines draw only where it holds. */
  where?: Condition;
  curve?: Curve;
  /** Name of a single line in legends and tooltips. Defaults to the value field. */
  label?: string;
  /**
   * Marks naming the same group share series by name: series of the same
   * name share a color, one legend entry, and visibility.
   */
  legendGroup?: string;
  /** `false` leaves the mark out of the chart's legends. */
  legend?: false;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  id?: string;
}

/**
 * Lines along x (positions on x, values on y), or along y with
 * `orient: "y"` or a category y (positions on y, values on x), as bars lie
 * along a category y. Category positions place points at their bands'
 * centers, in band order.
 */
export type LineOptions<S extends Schema> = LineStyle<S> &
  (
    | {
        orient?: "x";
        /** Positions: a number or time field, or a category field. */
        x: PositionField<S>;
        /** One field, or several fields drawn as separate lines sharing x. */
        y: NumericField<S> | readonly NumericField<S>[];
        /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
        axis?: "left" | "right";
      }
    | {
        /** Positions along y, values along x: depth profiles, densities of y. */
        orient: "y";
        y: PositionField<S>;
        /** One field, or several fields drawn as separate lines sharing y. */
        x: NumericField<S> | readonly NumericField<S>[];
        /** Lines along y use the left axis, as horizontal bars do. */
        axis?: "left";
      }
    | {
        orient?: "y";
        /** A category y lays the line along y. */
        y: CategoryField<S>;
        x: NumericField<S> | readonly NumericField<S>[];
        axis?: "left";
      }
  );

/** Options only the feature compiler draws (see model/features.ts). */
const FEATURES = [
  "opacity",
  "strokeOpacity",
  "encode",
  "style",
  "markers",
  "continuity",
  "where",
] as const;

export class LineMark implements Mark<Frozen<LineSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<LineSpec>;
  readonly table: Table<Schema>;
  readonly tooltip: "x" | "y";
  readonly featured: boolean;
  readonly #roles: Roles;
  readonly #split: SeriesSplitter;
  readonly #indexes = new IndexUse();
  /** With `dodge`, each series' slot in the bands, as last drawn. */
  readonly #shares: BandShares | undefined;

  constructor(input: LineSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "line");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    this.featured = asksFeatures(spec, FEATURES, table);
    const roles = rolesOf(table, "line", spec.x, spec.y, spec.orient, spec.series);
    this.#roles = roles;
    this.tooltip = roles.orient;
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "line series");
    if (spec.dodge) {
      if (!roles.banded)
        throw new Error(
          `line dodge: places series side by side in the bands of a category ${roles.orient}; give a category field as ${roles.orient}, or drop dodge`,
        );
      if (spec.series === undefined)
        throw new Error("line dodge: places series side by side; give a series field");
      this.#shares = new BandShares();
    }
    // Lines over categories run in band order, which their series sort by.
    const position = roles.banded ? undefined : roles.position;
    this.#split = new SeriesSplitter(table, position, roles.values, spec.series, spec.label);
  }

  channelKind(axis: "x" | "y") {
    const { orient, position, values } = this.#roles;
    return axis === orient ? this.table.kind(position) : valueKind(this.table, values);
  }

  bands(axis: "x" | "y") {
    const { orient, position, banded } = this.#roles;
    return banded && axis === orient ? categoryBands(this.table, position) : undefined;
  }

  series(key: MarkKey, palette: Palette, _hidden?: ReadonlySet<string>, bands: Bands = {}) {
    const { table } = this;
    const { orient, position, banded } = this.#roles;
    // A category position is each row's band index on the chart's axis.
    const positions = banded
      ? categoryIndices(table, position, bands[orient]?.keys ?? [])
      : table.numbers(position as never);
    const series = buildSeries(
      table,
      this.#split.sources(),
      positions,
      key,
      palette,
      // A color in CSS syntax the mark draws itself; the feature compiler, others.
      this.spec.stroke ?? (this.featured ? undefined : this.spec.color),
    );
    for (const s of series) {
      if (banded) {
        s.rows = bandOrder(positions, s.rows, s.length);
        s.length = s.rows?.length ?? table.length;
        // Reordered rows no longer stream as their group does.
        s.stream = undefined;
        s.sorted = true;
      }
      // Series hold the chart's x and y; lines along y are sorted, if at all, in y.
      if (orient === "y") {
        [s.x, s.y, s.ySorted, s.sorted] = [s.y, s.x, s.sorted, false];
      }
    }
    return series;
  }

  xExtent(series: readonly Series[], log: boolean) {
    // Along y, x holds values: those its features draw (see
    // model/features.ts). Positions span all rows, so that a streaming
    // window's domain does not jump with its last rows' values.
    const along = this.#roles.orient === "y";
    return unionExtent(
      series.map((s) =>
        along && s.features?.across ? s.features.across(s, s.x, log) : xExtent(s, log),
      ),
    );
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    if (this.#roles.orient === "y") return unionExtent(series.map((s) => positionsExtent(s, log)));
    // Curves at the view's edges are measured where they are drawn.
    const curved = this.spec.curve === "monotone";
    return unionExtent(
      series.map((s) =>
        yExtent(s, x0, x1, s.y, log, this.#indexes.index(this.table, s), curved, breaks),
      ),
    );
  }

  geometry(series: readonly Series[], frame: Frame): Geometry[] {
    const { spec } = this;
    const out: Geometry[] = [];
    this.#indexes.drew(frame.owner, frame.scene, this.table);
    // Parts of series (a highlight's selected rows) stand in their wholes' slots.
    if (!series.every((s) => s.whole)) this.#shares?.split(series, frame, spec.legendGroup, true);
    const strokeWidth = spec.strokeWidth ?? frame.theme.style.line.strokeWidth;
    const dash = dashPattern(spec.dash, strokeWidth);
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const line: LineGeometry = {
        kind: "line",
        draw: lineDrawing,
        key: s.key,
        stroke: s.color,
        strokeWidth,
        dash,
        path: this.#trace(s, frame),
      };
      // The feature compiler restyles a series' line and adds its markers.
      out.push(...(s.features?.geometry?.(line, s, frame) ?? [line]));
    }
    return out;
  }

  /**
   * A series' polyline: traced along its positions' axis, as lines along x
   * are, on a frame with x and y swapped for lines along y.
   */
  #trace(s: Series, frame: Frame): Polyline {
    const { orient, banded } = this.#roles;
    const shift = this.#shares ? this.#shift(s, frame) : 0;
    const view = traceFrame(frame, orient, shift);
    // Rows over categories are in band order.
    const sorted = banded || (orient === "x" ? s.sorted : (s.ySorted ?? false));
    const traced = traceSeries(s, frame, orient, sorted);
    const linear = view.x.type !== "log" && view.y.type !== "log";
    const index = this.#indexes.index(this.table, traced, frame.owner, linear);
    const path = tracePath(traced, traced.y, view, "line", this.spec.curve, index);
    if (orient === "y") {
      untranspose(path);
      // Value transitions move lines along y only.
      path.whole = false;
    }
    return path;
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
}

/**
 * Lines through x and y fields of a table.
 *
 * ```ts
 * line(metrics, { x: "time", y: ["p50", "p99"] })
 * line(metrics, { x: "time", y: "latency", series: "service" })
 * line(sales, { x: "month", y: "revenue" }) // a category x, at its bands' centers
 * line(casts, { x: "temperature", y: "depth", orient: "y" })
 * ```
 */
export function line<S extends Schema>(
  table: Table<S>,
  options: LineOptions<S>,
): ChartMark<Frozen<LineSpec>> {
  const spec: LineSpec = {
    type: "line",
    ...definedFields(options, [
      "x",
      "y",
      "tooltip",
      "orient",
      "series",
      "dodge",
      "stroke",
      "strokeWidth",
      "dash",
      "curve",
      "label",
      "legendGroup",
      "legend",
      "id",
      "axis",
      "facet",
      "panel",
      "clip",
      "color",
      ...FEATURES,
    ]),
  } as LineSpec;
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
