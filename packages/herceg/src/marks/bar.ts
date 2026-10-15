import type { NumericArray } from "../data/column.ts";
import type { CategoryField, NumericField, PositionField, Schema, Table } from "../data/table.ts";
import { labelHalo } from "../draw/label-halo.ts";
import { BOTTOM, LEFT, RIGHT, rectDrawing, TOP } from "../draw/rect.ts";
import { labelsDrawing, textDrawing } from "../draw/text.ts";
import { type Formatter, numberFormatter } from "../format/format.ts";
import { estimateText, textItem } from "../layout/text.ts";
import type { Breaks } from "../lod/m4.ts";
import { headroomDomain } from "../model/axis.ts";
import { asksFeatures, type RowPaint } from "../model/features.ts";
import type { LegendPart } from "../model/legend.ts";
import { contrastingText } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import {
  type Geometry,
  type LabelsGeometry,
  MOVING_BARS,
  type RectGeometry,
  type TextGeometry,
} from "../scene/scene.ts";
import type { BarLabelPlaceSpec } from "../spec/encoding.ts";
import type { BarLabelsSpec, BarSpec, BarStack, Clip, Dash, Frozen } from "../spec/spec.ts";
import type { Halo, TextStyle } from "../spec/style.ts";
import { dashPattern, type TextPaint, textPaint } from "../style/style.ts";
import { surface, type Theme } from "../theme.ts";
import { BandShares, STILL } from "./dodge.ts";
import type { BarLabels, CssColor, Encodings, MarkStyle } from "./encoding.ts";
import { keyLegend } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  buildSeries,
  CATEGORY,
  type ChartMark,
  type Frame,
  fieldBands,
  frozen,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
} from "./mark.ts";
import { PositionStack } from "./position-stack.ts";
import { rowOf, type Series, TableCache, visibleRange, xExtent, yExtent } from "./series.ts";
import { Slots } from "./slots.ts";
import { RowStack, type StackedLayers } from "./stack.ts";
import {
  fillLayers,
  requireContribution,
  stackError,
  stackPointText,
  stackShare,
} from "./stack-offset.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";
import { unionExtent } from "./trace.ts";

interface BarStyle<S extends Schema> {
  /** The outline that keeps text readable: "auto" (the default), false for none, or a color of its own. */
  halo?: Halo;
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** Category field: one bar series per value. */
  series?: CategoryField<S>;
  /** Pile series up at each position. */
  stack?: BarStack;
  /**
   * Place series side by side in each position, as grouped bars: true by
   * default for series that do not stack; false overlaps them.
   */
  dodge?: boolean;
  fill?: string;
  fillOpacity?: number;
  /** Edges: an outline of every bar in this color (`strokeWidth` 1 by default). */
  stroke?: string;
  /** Edges' width in pixels: with `stroke`, 1 by default; alone, in the background's color. */
  strokeWidth?: number;
  strokeOpacity?: number;
  /** Edges' dash: a pixel dash array, or a matplotlib style scaled by their width. */
  dash?: Dash;
  /** From 0 to 1: the bars', fill and edges. */
  opacity?: number;
  /**
   * The bars' fill: a category field (each bar its value's color through the
   * chart's "color" scale, without placing bars apart) or a color. The short
   * form of `encode.color`; `fill` wins over it.
   */
  color?: CategoryField<S> | CssColor;
  /** Channels per bar: color, fill, stroke, strokeWidth, opacity. */
  encode?: Pick<Encodings<S>, "color" | "fill" | "stroke" | "strokeWidth" | "opacity">;
  /** Looks by value: by series, or with `field`, by each bar's value. */
  style?: Pick<MarkStyle<S>, "by">;
  label?: string;
  /**
   * Write each bar's value at its end (or, stacked, inside each segment):
   * `true`, or how (`format`, `style`, `minLength`, or a `field` to write).
   * Labels that do not fit are left out.
   */
  labels?: boolean | BarLabels<S>;
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

/** Vertical bars: positions on x, lengths on y. */
export interface VerticalBarOptions<S extends Schema> extends BarStyle<S> {
  /** Category field (one band per value) or a numeric or time field. */
  x: PositionField<S>;
  /** Bar lengths: one field, or several fields drawn side by side or stacked. */
  y: NumericField<S> | readonly NumericField<S>[];
}

/** Horizontal bars: one band per category of y, lengths on x. */
export interface HorizontalBarOptions<S extends Schema> extends BarStyle<S> {
  /** Bar lengths: one field, or several fields drawn side by side or stacked. */
  x: NumericField<S> | readonly NumericField<S>[];
  y: CategoryField<S>;
  /** Positions along y are on the left axis; only vertical bars use the right one. */
  axis?: "left";
}

/** A category `y` makes bars horizontal; otherwise they are vertical. */
export type BarOptions<S extends Schema> = VerticalBarOptions<S> | HorizontalBarOptions<S>;

/** Gap between grouped bars, as a fraction of each bar's slot. */
const GROUP_GAP = 0.1;

/** Where a bar is drawn: its position, its center along the position axis, and its tip and root across, in pixels. */
export interface BarEnds {
  at: number;
  center: number;
  tip: number;
  root: number;
}

/** What `BarMark.ends` returns, reused rather than allocated per bar. */
const placed: BarEnds = { at: 0, center: 0, tip: 0, root: 0 };

/** How bars fill their positions' slots (see `BarMark.placement`). */
export interface BarPlacement {
  slot: number;
  share: number;
  /** Each bar's thickness, in pixels. */
  width: number;
  /** How many bars share a slot side by side. */
  groups: number;
  /** Pixels from a position's center to the near edge of a shown series' bars. */
  offset(series: Series): number;
}

interface Stack {
  totals?: Float64Array | undefined;
  tops: Float64Array[];
  bases: Float64Array[];
}

/** Options only the feature compiler draws (see model/features.ts). */
const FEATURES = ["encode", "style"];

/** What value labels are asked for: `labels`' settings, and whether their format is a pattern. */
type LabelOptions = Frozen<BarLabelsSpec> & { pattern: boolean };

export class BarMark implements Mark<Frozen<BarSpec>> {
  declare readonly [MARK]: true;
  readonly headroomDomain = headroomDomain;
  readonly spec: Frozen<BarSpec>;
  readonly table: Table<Schema>;
  readonly zero: "x" | "y";
  readonly tooltip: "x" | "y";
  readonly pointText?: (s: Series, row: number, format: AxisFormat) => string;
  readonly bandPadding = 0.2;
  readonly featured: boolean;
  /**
   * Series stand side by side: unless `dodge: false` or a stack piles them,
   * or the series field is the position field (one series a position).
   */
  readonly #dodges: boolean;
  /** The value labels' settings, when the bars have labels. */
  readonly #labelOptions: LabelOptions;
  /** Categories on y, lengths on x. */
  readonly #horizontal: boolean;
  /** The field bars are placed by: x for vertical bars, y for horizontal ones. */
  readonly #position: string;
  readonly #categorical: boolean;
  readonly #split: SeriesSplitter;
  /** Each grouped series' slot in its positions, as geometry last placed it. */
  readonly #shares = new BandShares();
  #stacks = new TableCache<Map<string, Stack>>();
  /** Stacks of fields over positions that never repeat, kept current as rows stream. */
  readonly #rowStack: RowStack;
  /** Stacks of series split by a field, kept current as rows stream. */
  readonly #positionStack: PositionStack;
  readonly #increasing = new IncreasingRows();
  /**
   * Each chart's stacks of its panels' bars, by the rows of its first panel
   * part (charts split rows apart), while the table, the panels' rows, and
   * the shown series stay the same.
   */
  readonly #panelStacks = new WeakMap<
    Uint32Array,
    {
      version: number;
      signature: string;
      rows: (Uint32Array | undefined)[];
      stacks: Map<string, readonly [Float64Array, Float64Array]>;
      totals: Float64Array | undefined;
    }
  >();
  /** Slots of bars on a number or time position axis. */
  #slots: Slots | undefined;
  #formatter:
    | { locale: string | undefined; features: Frame["features"]; format: Formatter }
    | undefined;

  constructor(input: BarSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "bar");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    const problem = stackError(spec.stack, false);
    if (problem) throw new Error(problem);
    if (spec.dodge && spec.stack)
      throw new Error("bar dodge: stacked bars pile up in one slot; drop dodge or stack");
    for (const [name, value] of [
      ["strokeWidth", spec.strokeWidth],
      ["strokeOpacity", spec.strokeOpacity],
      ["opacity", spec.opacity],
    ] as const)
      if (
        value !== undefined &&
        !(value >= 0 && (name === "strokeWidth" ? Number.isFinite(value) : value <= 1))
      )
        throw new RangeError(
          `bar ${name}: expected ${name === "strokeWidth" ? "0 or more pixels" : "a number from 0 to 1"}; received ${value}`,
        );
    const labels = typeof spec.labels === "object" ? spec.labels : {};
    if (labels.minLength !== undefined && !(labels.minLength >= 0))
      throw new RangeError(
        `bar labels.minLength: expected 0 or more pixels; received ${labels.minLength}`,
      );
    if (labels.style !== undefined && (typeof labels.style !== "object" || labels.style === null))
      throw new TypeError(
        `bar labels.style: expected a text style such as { fontSize: 12 }; received ${JSON.stringify(labels.style)}; number formats go in labels.format`,
      );
    if (labels.field !== undefined)
      requireField(table, labels.field, ["category", "number"], "bar labels.field");
    if (spec.stack && labels.place?.outside)
      throw new Error(
        "bar labels.place.outside: stacked bars' labels go inside their segments; drop outside",
      );
    const format = labels.format as { number?: unknown; time?: unknown } | undefined;
    this.#labelOptions = {
      ...labels,
      pattern: format?.number !== undefined || format?.time !== undefined,
    };
    this.featured = asksFeatures(spec, FEATURES, table) || this.#labelOptions.pattern;
    this.#rowStack = new RowStack(
      "signed",
      spec.stack === "fill" ? { offset: { resolve: fillLayers, fill: true } } : {},
    );
    this.#positionStack = new PositionStack(spec.stack === "fill");
    const xs = typeof spec.x === "string" ? [spec.x] : spec.x;
    const ys = typeof spec.y === "string" ? [spec.y] : spec.y;
    this.#horizontal = ys.length === 1 && table.has(ys[0]!) && table.kind(ys[0]!) === "category";
    let lengths: readonly string[];
    if (this.#horizontal) {
      for (const x of xs) requireField(table, x, NUMERIC, "horizontal bar x");
      this.#position = ys[0]!;
      lengths = xs;
    } else {
      if (xs.length !== 1) {
        throw new Error("bar x: several fields make bars horizontal; give one category field as y");
      }
      requireField(table, xs[0]!, [...NUMERIC, ...CATEGORY], "bar x");
      for (const y of ys) requireField(table, y, NUMERIC, "bar y");
      this.#position = xs[0]!;
      lengths = ys;
    }
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "bar series");
    this.zero = this.#horizontal ? "x" : "y";
    this.tooltip = this.#horizontal ? "y" : "x";
    if (spec.stack === "fill")
      this.pointText = (s, row, format) => stackPointText(s, row, this.tooltip, format);
    this.#categorical = table.kind(this.#position) === "category";
    this.#split = new SeriesSplitter(
      table,
      this.#categorical ? undefined : this.#position,
      lengths,
      spec.series,
      spec.label,
    );
    this.#dodges = (spec.dodge ?? !spec.stack) && spec.series !== this.#position;
  }

  channelKind(axis: "x" | "y") {
    return (axis === "y") === this.#horizontal ? this.table.kind(this.#position) : "number";
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return (axis === "y") === this.#horizontal && this.#categorical
      ? fieldBands(this.table, this.#position, context)
      : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
    split = false,
  ): Series[] {
    const { spec, table } = this;
    // Categorical positions: each row's band index is its position.
    const positions = this.#categorical
      ? bandIndices(
          table,
          this.#position,
          (this.#horizontal ? bands.y : bands.x)?.keys ?? [],
          context,
        )
      : table.numbers(this.#position as never);
    // A color in CSS syntax the mark draws itself; the feature compiler, others.
    const fill = spec.fill ?? (this.featured ? undefined : spec.color);
    const series = buildSeries(table, this.#split.sources(), positions, key, palette, fill);
    // Rows facets split into panels stack within their panel (stackPanels):
    // the whole table's stacks let go of their buffers.
    if (spec.stack && split) {
      this.#stacks = new TableCache();
      this.#rowStack.clear();
      this.#positionStack.clear();
    }
    if (spec.stack && !split) {
      const shown = series.map((s) => !hidden.has(s.key));
      const signature = shown.map(Number).join("");
      // Fields sharing rows whose positions never repeat stack row by row,
      // and series of a series field position by position, both of which
      // stream; otherwise bars stack by position from scratch.
      const rowWise =
        series.every((s) => s.rows === undefined) &&
        this.#increasing.check(table, positions, !this.#categorical);
      let stack: Pick<StackedLayers, "tops" | "bases" | "totals">;
      // Only the stack in use keeps its buffers.
      if (rowWise) {
        this.#stacks = new TableCache();
        this.#positionStack.clear();
        stack = this.#rowStack.update(
          table,
          series.map((s, i) => (shown[i] ? s.values : undefined)),
          signature,
        );
      } else if (spec.series !== undefined) {
        this.#stacks = new TableCache();
        this.#rowStack.clear();
        const { tops, bases, totals } = this.#positionStack.update(
          table,
          positions,
          table.numbers(this.#split.yFields[0] as never),
          series.map((s, i) => ({ name: s.key, rows: s.rows!, shown: shown[i]! })),
          this.#categorical,
          this.#categorical ? (this.#horizontal ? bands.y : bands.x)?.keys : undefined,
        );
        stack = { tops: series.map(() => tops), bases: series.map(() => bases), totals };
      } else {
        this.#rowStack.clear();
        this.#positionStack.clear();
        const cache = this.#stacks.get(table, () => new Map());
        let byPosition = cache.get(signature);
        if (!byPosition || byPosition.tops[0]?.length !== positions.length) {
          byPosition = stackBars(series, shown, spec.stack === "fill");
          if (cache.size >= 4) cache.clear();
          cache.set(signature, byPosition);
        }
        stack = byPosition;
      }
      series.forEach((s, i) => {
        s.stackTotals = stack.totals;
        s.y = stack.tops[i]!;
        s.y0 = stack.bases[i];
      });
    }
    // Series are built with positions on x; horizontal bars swap them onto y.
    if (this.#horizontal) {
      for (const s of series) {
        [s.x, s.y, s.x0, s.y0] = [s.y, s.x, s.y0, undefined];
      }
    }
    return series;
  }

  /**
   * Stacks each panel's bars apart, as `series` stacks a whole table's:
   * panels hold disjoint rows, and series of one field disjoint rows too, so
   * each field's tops and bases fill one pair of table-sized arrays.
   */
  stackPanels(panels: readonly (readonly Series[])[], hidden: ReadonlySet<string>): void {
    if (!this.spec.stack) return;
    const { table } = this;
    const horizontal = this.#horizontal;
    const signature = panels[0]?.map((s) => Number(!hidden.has(s.key))).join("") ?? "";
    const rows = panels.flatMap((series) => series.map((s) => s.rows));
    const key = rows[0];
    const cached = key && this.#panelStacks.get(key);
    const kept =
      cached?.version === table.version &&
      cached.signature === signature &&
      cached.rows.length === rows.length &&
      cached.rows.every((r, i) => r === rows[i]);
    const stacks = kept ? cached.stacks : new Map<string, readonly [Float64Array, Float64Array]>();
    const rowTotals = kept
      ? cached.totals
      : this.spec.stack === "fill"
        ? new Float64Array(table.length)
        : undefined;
    for (const series of panels) {
      const totals =
        this.spec.stack === "fill" && !kept
          ? positionTotals(
              series,
              series.map((s) => !hidden.has(s.key)),
              horizontal,
            )
          : undefined;
      // Positive values stack up and negative ones down, per panel and position.
      const positive = new Map<number, number>();
      const negative = new Map<number, number>();
      for (const s of series) {
        s.stackTotals = rowTotals;
        const field = s.field ?? s.key;
        let stack = stacks.get(field);
        if (!stack) {
          stack = [nans(s.values.length), nans(s.values.length)];
          stacks.set(field, stack);
        }
        const [top, base] = stack;
        if (!kept) {
          const shown = !hidden.has(s.key);
          for (let k = 0; k < s.length; k++) {
            const row = rowOf(s, k);
            const raw = shown ? s.values[row]! : 0;
            const at = (horizontal ? s.y : s.x)[row]!;
            if (rowTotals) rowTotals[row] = totals?.get(at) ?? 0;
            const value =
              totals && Number.isFinite(raw)
                ? totals.get(at)! > 0
                  ? raw / totals.get(at)!
                  : 0
                : raw;
            if (!Number.isFinite(value)) continue;
            const sums = value >= 0 ? positive : negative;
            const below = sums.get(at) ?? 0;
            base[row] = below;
            top[row] = below + value;
            sums.set(at, below + value);
          }
        }
        // Horizontal stack ends on x no longer ascend as the lengths may have.
        if (horizontal) [s.x, s.x0, s.sorted] = [top, base, false];
        else [s.y, s.y0] = [top, base];
      }
    }
    if (key && !kept)
      this.#panelStacks.set(key, {
        version: table.version,
        signature,
        rows,
        stacks,
        totals: rowTotals,
      });
  }

  xExtent(series: readonly Series[], log: boolean, breaks?: Breaks) {
    if (this.#horizontal && this.spec.stack === "fill" && !log) return [0, 1] as [number, number];
    if (this.#horizontal) {
      return unionExtent(
        series.flatMap((s) => [
          lengthExtent(s, s.x, log),
          s.x0 ? lengthExtent(s, s.x0, log) : undefined,
        ]),
      );
    }
    if (this.#categorical) return undefined;
    const extent = unionExtent(series.map((s) => xExtent(s, log)));
    // Leave half a bar slot of room at each end.
    return extent && this.#slotsOf().pad(extent, log, breaks);
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    // Horizontal bars put bands on y, which take their categories instead.
    if (this.#horizontal) return undefined;
    if (this.spec.stack === "fill" && !log) return [0, 1] as [number, number];
    // Rows without a band (missing categories, index -1) are not drawn.
    const lo = this.#categorical ? 0 : x0;
    const hi = this.#categorical ? Number.POSITIVE_INFINITY : x1;
    return unionExtent(
      series.flatMap((s) => [
        yExtent(s, lo, hi, s.y, log, undefined, false, breaks),
        s.y0 ? yExtent(s, lo, hi, s.y0, log, undefined, false, breaks) : undefined,
      ]),
    );
  }

  geometry(series: readonly Series[], frame: Frame): Geometry[] {
    const { spec } = this;
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    const horizontal = this.#horizontal;
    // `along` places bars; `across` measures their lengths.
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    // Dodged series take their slots (a legend group's marks by the group's
    // series), which picking, inspection, and selections read back.
    this.#shares.split(series, frame, spec.legendGroup, this.#dodges);
    const { share, width, groups, offset: offsetOf } = this.placement(visible, along);
    const out: Geometry[] = [];
    const labels = spec.labels
      ? new ValueLabels(
          this.#format(frame),
          frame,
          horizontal,
          !!spec.stack,
          spec.halo,
          this.#labelOptions,
          this.table,
        )
      : undefined;
    // The closest neighboring bar centers: within a group, a share apart;
    // with one series, a position step apart.
    const spacing = !labels
      ? 0
      : groups > 1
        ? share
        : this.#categorical
          ? Math.abs(along.map(1) - along.map(0))
          : this.#slotsOf().pixelGap(along);
    const opacity = (spec.fillOpacity ?? 1) * (spec.opacity ?? 1);
    // A look's opacities replace the mark's.
    const fillOpacityOf = (look: RowPaint) =>
      (look.fillOpacity ?? spec.fillOpacity ?? 1) * (look.opacity ?? spec.opacity ?? 1);
    const edge = this.#edge(frame.theme);
    const radius = frame.theme.style.bar.radius;
    // Charts that animate changed values learn where each bar stands and
    // ends; stacks, labeled bars, bars of several looks, and log axes show
    // their new values at once.
    const keyed = frame.keyed && !spec.stack && !labels && across.type !== "log";
    // Labels past the bars' ends, or inside them where their place says.
    const place = this.#labelOptions.place;
    const inside = !!spec.stack || place?.outside === false;
    visible.forEach((s) => {
      const labeled = labels?.fits(width, spacing, inside) ? labels : undefined;
      const offset = offsetOf(s);
      const [start, end] = this.range(s, frame);
      // Bars of looks of their own (channels per row) draw a geometry per look.
      const looks = s.features?.rows;
      const parts = (looks?.paints.length ?? 1) > 1 ? looks!.paints.length : 1;
      const keyOf = (part: number) => (part === 0 ? s.key : `${s.key}|${part}`);
      // Each look's buffer holds its own rows in view, never every look's.
      const sizes = new Uint32Array(parts);
      if (parts > 1) for (let k = start; k < end; k++) sizes[looks!.of(rowOf(s, k))]!++;
      else sizes[0] = end - start;
      const rects = Array.from({ length: parts }, (_, part) =>
        frame.floats(keyOf(part), "rect", sizes[part]! * 4),
      );
      // Unstacked bars round the corners at their value's end. The buffer
      // matches the rectangles' capacity, so it grows only when they do.
      const rounding =
        !spec.stack && radius > 0
          ? rects.map((r, part) => frame.bytes(keyOf(part), "ends", Math.ceil(r.length / 4)))
          : undefined;
      const items = keyed && parts === 1 && end - start <= MOVING_BARS;
      const shown = items ? frame.doubles(s.key, "at", end - start) : undefined;
      const span = items ? frame.floats(s.key, "span", (end - start) * 2) : undefined;
      const counts = new Uint32Array(parts);
      // Bars of one look (the common case) read no arrays of looks per row.
      const one = parts === 1;
      const rects0 = rects[0]!;
      const rounding0 = rounding?.[0];
      let drawn = 0;
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        const ends = this.ends(s, row, along, across);
        if (!ends) continue;
        const { at, center, tip, root } = ends;
        const part = one ? 0 : looks!.of(row);
        const count = one ? drawn++ : counts[part]!++;
        const box = one ? rects0 : rects[part]!;
        const i = count * 4;
        if (horizontal) {
          box[i] = Math.min(tip, root);
          box[i + 1] = center + offset;
          box[i + 2] = Math.abs(root - tip);
          box[i + 3] = width;
        } else {
          box[i] = center + offset;
          box[i + 1] = Math.min(tip, root);
          box[i + 2] = width;
          box[i + 3] = Math.abs(root - tip);
        }
        if (rounding)
          (one ? rounding0! : rounding[part]!)[count] = horizontal
            ? tip > root
              ? RIGHT
              : LEFT
            : tip < root
              ? TOP
              : BOTTOM;
        if (shown) {
          shown[count] = at;
          span![count * 2] = root;
          span![count * 2 + 1] = tip;
        }
        if (labeled) {
          const look = looks?.paints[part];
          const middle = center + offset + width / 2;
          const value = spec.stack === "fill" ? stackShare(s, row) : s.values[row]!;
          const alpha = look ? fillOpacityOf(look) : opacity;
          const cap = rounding ? Math.min(radius, width / 2, Math.abs(root - tip)) : 0;
          labeled.add(
            labeled.text(value, row),
            middle,
            root,
            tip,
            width,
            spacing,
            look?.fill ?? s.color,
            alpha,
            cap,
            place,
          );
        }
      }
      if (one) counts[0] = drawn;
      for (let part = 0; part < parts; part++) {
        const look = looks?.paints[part];
        const lookEdge =
          look?.stroke !== undefined ||
          look?.strokeWidth !== undefined ||
          look?.dash !== undefined ||
          look?.strokeOpacity !== undefined ||
          look?.opacity !== undefined;
        const bars: RectGeometry = {
          kind: "rect",
          draw: rectDrawing,
          key: keyOf(part),
          fill: look?.fill ?? s.color,
          fillOpacity: look ? fillOpacityOf(look) : opacity,
          rects: rects[part]!,
          count: counts[part]!,
          rounded: rounding && { radius, ends: rounding[part]! },
          bars: shown && { horizontal, at: shown, span: span! },
        };
        const outline = lookEdge ? this.#edge(frame.theme, look) : edge;
        if (outline) bars.edge = outline;
        out.push(bars);
      }
      if (labeled) out.push(...labeled.flush(s.key));
    });
    return out;
  }

  /**
   * The bars' edges: their `stroke` (the background's color with only a
   * width) at their width (1 by default), opacity, and dash; `look`, a
   * bar's own, over them. Undefined for bars without edges.
   */
  #edge(theme: Theme, look?: RowPaint): RectGeometry["edge"] {
    const { spec } = this;
    const stroke = look?.stroke ?? spec.stroke;
    const width = look?.strokeWidth ?? spec.strokeWidth;
    if (stroke === undefined && width === undefined) return undefined;
    const strokeWidth = width ?? 1;
    if (strokeWidth <= 0) return undefined;
    return {
      stroke: stroke ?? surface(theme),
      width: strokeWidth,
      // A look's opacity replaces the mark's, and fades its outline too.
      opacity:
        (look?.strokeOpacity ?? spec.strokeOpacity ?? 1) * (look?.opacity ?? spec.opacity ?? 1),
      dash: dashPattern(look?.dash ?? spec.dash, strokeWidth),
    };
  }

  /** Pixels a position's bars share. */
  #slot(along: PositionScale): number {
    return this.#categorical ? Math.abs(along.bandwidth ?? 0) : this.#slotsOf().width(along);
  }

  /** Where a grouped series' bar stands off its position's center, for inspection. */
  displace(s: Series, _row: number, frame: Frame): readonly [number, number] {
    if (!this.#dodges) return STILL;
    const along = this.#horizontal ? frame.y : frame.x;
    const { center } = this.#shares.of(s, this.#slot(along));
    return this.#horizontal ? [0, center] : [center, 0];
  }

  /** Grouped bars stand within their position's slot: at most half of it off. */
  maxDisplacement(_s: Series, frame: Frame): number {
    return !this.#dodges || this.#horizontal ? 0 : this.#slot(frame.x) / 2;
  }

  /**
   * How bars of the `visible` series fill their positions' slots along
   * `along`, as geometry last split them: each position gets a slot, which
   * grouped series split (in a legend group, by the group's series) and
   * stacked ones share. Also what selections read of the bars drawn.
   * With a frame, prepare the visible series' slots before placing them.
   */
  placement(visible: readonly Series[], along: PositionScale, frame?: Frame): BarPlacement {
    if (frame) this.#shares.split(visible, frame, this.spec.legendGroup, this.#dodges);
    const slot = this.#slot(along);
    const stack = this.spec.stack;
    const shares = this.#shares;
    const groups = stack || !visible[0] ? 1 : shares.slotOf(visible[0]).count;
    const share = slot / groups;
    const width = groups > 1 ? share * (1 - GROUP_GAP) : share;
    return {
      slot,
      share,
      width,
      groups,
      offset: (s) =>
        stack ? -slot / 2 : -slot / 2 + share * shares.slotOf(s).index + (share - width) / 2,
    };
  }

  /** The positions of a series to draw: those in view along x for vertical bars. */
  range(s: Series, frame: Frame): readonly [number, number] {
    return this.#horizontal ? [0, s.length] : visibleRange(s, frame.x.domain[0], frame.x.domain[1]);
  }

  /**
   * Where a row's bar is drawn (an object reused by the next call), or
   * undefined when it is not drawn: a missing value or band, or a time an
   * axis break leaves out.
   */
  ends(s: Series, row: number, along: PositionScale, across: PositionScale): BarEnds | undefined {
    const horizontal = this.#horizontal;
    const band = (horizontal ? s.y : s.x)[row]!;
    // On a panel's own categories, chart bands are read through their places (see placeAt).
    const places = s.places?.[horizontal ? "y" : "x"];
    const at = places && band >= 0 ? places.at(band) : band;
    const value = (horizontal ? s.x : s.y)[row]!;
    if (!Number.isFinite(value) || (this.#categorical && at < 0) || along.breaks?.hides(at))
      return undefined;
    // A zero base has no place on a log axis; bars grow from its low end.
    const zero = across.type === "log" ? across.range[0] : across.map(0);
    const base = (horizontal ? s.x0 : s.y0)?.[row] ?? Number.NaN;
    const center = along.map(at);
    const tip = across.map(value);
    let root = Number.isFinite(base) ? across.map(base) : zero;
    if (!Number.isFinite(root)) root = zero;
    if (!(Number.isFinite(center) && Number.isFinite(tip))) return undefined;
    placed.at = at;
    placed.center = center;
    placed.tip = tip;
    placed.root = root;
    return placed;
  }

  /** A key of the colors a field gives the bars' rows (the feature compiler's), as points list theirs. */
  legends(series: readonly Series[]): LegendPart[] {
    const key = series[0]?.features?.key?.();
    return key ? [keyLegend(key)] : [];
  }

  /** Room past the bars' ends for their labels; stacked labels, and those placed inside, sit inside. */
  headroom(series: readonly Series[], context: BandContext): number {
    const inside = this.#labelOptions.place?.outside === false;
    if (!this.spec.labels || this.spec.stack || inside || series.length === 0) return 0;
    const paint = labelPaint(context.theme, this.#labelOptions.style);
    // Labels in boxes take their boxes' room.
    const [top, right, bottom, left] = paint.background ? paint.padding : [0, 0, 0, 0];
    if (!this.#horizontal)
      return (paint.background ? paint.lineHeight + top + bottom : paint.size) + LABEL_GAP + 2;
    // Horizontal labels are as wide as their text: judge by the extremes.
    const extent = this.xExtent(series, false);
    if (!extent) return 0;
    const format = this.#format(context);
    const widest = Math.max(...extent.map((value) => estimateText(format(value), paint.css)));
    return widest + left + right + LABEL_GAP + 2;
  }

  /** The value formatter for labels, kept while the locale and features stay the same. */
  #format(context: Pick<Frame, "locale" | "features">): Formatter {
    const { locale, features } = context;
    let cached = this.#formatter;
    if (!cached || cached.locale !== locale || cached.features !== features) {
      const options = this.#labelOptions;
      // The default formatting of `formatNumber`, without its lookups per value.
      const whole = numberFormatter({ maximumFractionDigits: 2 }, locale);
      const small = numberFormatter({ maximumSignificantDigits: 3 }, locale);
      const format =
        (options.pattern
          ? features?.of(this)?.format?.(options.format!, locale, "bar labels.format")
          : options.format &&
            numberFormatter(options.format as Intl.NumberFormatOptions, locale)) ??
        ((value: number) => (Math.abs(value) >= 1 || value === 0 ? whole(value) : small(value)));
      cached = { locale, features, format };
      this.#formatter = cached;
    }
    return cached.format;
  }

  /** Distinct x values of the table and their spacing, which bar widths follow. */
  #slotsOf(): Slots {
    this.#slots ??= new Slots(this.table, this.#position);
    return this.#slots;
  }
}

/**
 * [min, max] of the usable `values` (stack ends or bases) of horizontal bars;
 * rows without a band (missing categories, index -1) are not drawn.
 */
function lengthExtent(s: Series, values: NumericArray, log: boolean): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < s.length; k++) {
    const row = rowOf(s, k);
    const value = values[row]!;
    if (s.y[row]! < 0 || !Number.isFinite(value) || (log && value <= 0)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

/** Pixels between a bar's end and its label. */
const LABEL_GAP = 4;

/** Value labels' paint: the theme's text, the color of plain text, and the labels' style over them. */
function labelPaint(theme: Theme, style: Frozen<TextStyle> | undefined): TextPaint {
  return textPaint([theme.roles.text, { color: theme.text }, style as TextStyle | undefined]);
}

interface LabelGroup {
  anchor: TextGeometry["anchor"];
  fill: string;
  halo: boolean;
  items: { x: number; y: number; text: string }[];
}

/**
 * Value labels of one bar mark, collected per series: past each bar's end,
 * or inside it when that would leave the plot, or for stacks centered in
 * each segment. Widths are measured as the chart measures text; labels
 * that do not fit, or whose bars are shorter than `minLength`, are left
 * out, and values are only written for bars that could show them. Labels
 * in the theme's text draw as text marks do; in a style of their own, as
 * positioned text (fonts, sizes, boxes).
 */
class ValueLabels {
  readonly #format: Formatter;
  readonly #frame: Frame;
  readonly #horizontal: boolean;
  readonly #stacked: boolean;
  /** The mark's `halo`: what labels that need one get. */
  readonly #halo: Halo | undefined;
  readonly #paint: TextPaint;
  /** The labels' own color, which they keep inside bars too. */
  readonly #color: string | undefined;
  /** Whether the labels draw as plain text (the theme's font and size). */
  readonly #plain: boolean;
  readonly #minLength: number;
  /** Each row's text of a `field`, instead of its value. */
  readonly #field: ((row: number) => string) | undefined;
  readonly #size: number;
  /** Room a label's box adds beside its text. */
  readonly #padding: number;
  /** What text inside a bar contrasts with: the background, or a page of the theme's kind. */
  readonly #backdrop: string;
  #groups = new Map<string, LabelGroup>();

  constructor(
    format: Formatter,
    frame: Frame,
    horizontal: boolean,
    stacked: boolean,
    halo: Halo | undefined,
    options: LabelOptions,
    table: Table,
  ) {
    const { theme } = frame;
    this.#format = format;
    this.#frame = frame;
    this.#horizontal = horizontal;
    this.#stacked = stacked;
    this.#halo = halo;
    const paint = labelPaint(theme, options.style);
    this.#paint = paint;
    this.#color = options.style?.color;
    this.#plain =
      paint.font === theme.font &&
      paint.size === theme.fontSize &&
      paint.weight === 400 &&
      !paint.italic &&
      paint.opacity === 1 &&
      !paint.background;
    this.#minLength = options.minLength ?? 0;
    // Labels in boxes take their boxes' room: their line height and padding.
    const [top, right, bottom, left] = paint.background ? paint.padding : [0, 0, 0, 0];
    this.#size = paint.background ? paint.lineHeight + top + bottom : paint.size;
    this.#padding = left + right;
    this.#backdrop = surface(theme);
    const field = options.field;
    if (field !== undefined) this.#field = (row) => fieldText(table, field, row, format);
  }

  /** A label's text: the value written, or the row's `field`. */
  text(value: number, row: number): string | (() => string) {
    return this.#field ? () => this.#field!(row) : () => this.#format(value);
  }

  /**
   * Whether bars `width` thick, with neighbors `spacing` apart, can carry
   * any label, so series that cannot are skipped without formatting.
   */
  fits(width: number, spacing: number, stacked: boolean): boolean {
    if (this.#horizontal) return width >= this.#size * (stacked ? 1 : 0.9);
    const digit = this.#width("0");
    return stacked ? width >= digit + 2 : spacing >= digit + LABEL_GAP;
  }

  /**
   * A bar's label where `place` puts it: inside stacked bars' segments
   * (centered by default) and bars whose labels go inside, else past the
   * bar's end.
   */
  add(
    label: string | (() => string),
    middle: number,
    root: number,
    tip: number,
    width: number,
    spacing: number,
    fill: string,
    opacity: number,
    cap: number,
    place: Frozen<BarLabelPlaceSpec> | undefined,
  ) {
    if (this.#stacked || place?.outside === false)
      this.inside(
        label,
        middle,
        root,
        tip,
        width,
        fill,
        opacity,
        place?.attachment ?? (this.#stacked ? "center" : "end"),
      );
    else this.outside(label, middle, root, tip, spacing, fill, opacity, width, cap);
  }

  /**
   * A label past the bar's end, or just inside it when past would leave the
   * plot. `middle` is the bar's center across its thickness; `spacing` the
   * distance to the neighboring bars' centers; `cap` the radius of the bar's
   * rounded end, which labels inside keep clear of.
   */
  outside(
    label: string | (() => string),
    middle: number,
    root: number,
    tip: number,
    spacing: number,
    fill: string,
    opacity: number,
    thickness: number,
    cap: number,
  ) {
    if (Math.abs(tip - root) < this.#minLength) return;
    const size = this.#size;
    if (!this.#horizontal) {
      if (!this.#inPlot(middle, tip)) return;
      const text = written(label);
      const width = this.#width(text);
      // Wider labels would run into the neighboring bars' labels.
      if (width + LABEL_GAP > spacing) return;
      const up = tip <= root;
      const past = up ? tip - LABEL_GAP - size / 2 : tip + LABEL_GAP + size / 2;
      if (this.#fits(middle - width / 2, past - size / 2, width, size)) {
        this.#add("middle", this.#color ?? this.#frame.theme.text, true, middle, past, text);
        return;
      }
      // Text wider than the flat part of a rounded end starts below the corners.
      const clear = LABEL_GAP + (width > thickness - 2 * cap ? cap : 0);
      const inside = up ? tip + clear + size / 2 : tip - clear - size / 2;
      if (
        Math.abs(tip - root) >= size + LABEL_GAP + clear &&
        this.#fits(middle - width / 2, inside - size / 2, width, size)
      )
        this.#inside("middle", fill, opacity, middle, inside, text);
      return;
    }
    if (!this.#inPlot(tip, middle)) return;
    const text = written(label);
    const width = this.#width(text);
    const forward = tip >= root;
    const past = forward ? tip + LABEL_GAP : tip - LABEL_GAP;
    const top = middle - size / 2;
    if (this.#fits(forward ? past : past - width, top, width, size)) {
      this.#add(
        forward ? "start" : "end",
        this.#color ?? this.#frame.theme.text,
        true,
        past,
        middle,
        text,
      );
      return;
    }
    const clear = LABEL_GAP + (size > thickness - 2 * cap ? cap : 0);
    const inside = forward ? tip - clear : tip + clear;
    if (
      Math.abs(tip - root) >= width + LABEL_GAP + clear &&
      this.#fits(forward ? inside - width : inside, top, width, size)
    )
      this.#inside(forward ? "end" : "start", fill, opacity, inside, middle, text);
  }

  /**
   * A label inside the visible part of a bar or stacked segment, at its
   * root, middle, or tip (`attachment`), when it has room there.
   */
  inside(
    label: string | (() => string),
    middle: number,
    root: number,
    tip: number,
    width: number,
    fill: string,
    opacity: number,
    attachment: "start" | "center" | "end",
  ) {
    if (Math.abs(tip - root) < this.#minLength) return;
    const { plot } = this.#frame;
    const [min, max] = this.#horizontal
      ? [plot.x, plot.x + plot.width]
      : [plot.y, plot.y + plot.height];
    const a = Math.max(min, Math.min(root, tip));
    const b = Math.min(max, Math.max(root, tip));
    const length = b - a;
    if (length <= 0 || (!this.#horizontal && length < this.#size + 2)) return;
    const text = written(label);
    const textWidth = this.#width(text);
    const room = this.#horizontal ? length - LABEL_GAP : width - 2;
    if (textWidth > room) return;
    // From the visible root or tip, the gap and half the text along the bar.
    const toward = tip >= root ? 1 : -1;
    const inset = LABEL_GAP + (this.#horizontal ? textWidth : this.#size) / 2;
    const along =
      attachment === "center"
        ? (a + b) / 2
        : attachment === "start"
          ? (toward > 0 ? a : b) + toward * inset
          : (toward > 0 ? b : a) - toward * inset;
    const [x, y] = this.#horizontal ? [along, middle] : [middle, along];
    if (this.#fits(x - textWidth / 2, y - this.#size / 2, textWidth, this.#size))
      this.#inside("middle", fill, opacity, x, y, text);
  }

  /** The labels' geometry for the series `key`; starts the next series. */
  flush(key: string): Geometry[] {
    const out: Geometry[] = [];
    const frame = this.#frame;
    for (const [stage, group] of this.#groups) {
      const halo = group.halo ? labelHalo(this.#halo, group.fill, frame) : undefined;
      if (!this.#plain) {
        const paint = { ...this.#paint, color: group.fill };
        const items = group.items.map((item) => {
          const at = {
            x: item.x,
            y: item.y,
            anchor: group.anchor,
            baseline: "middle",
            angle: 0,
          } as const;
          const made = textItem(
            item.text,
            at,
            paint,
            frame.surface ?? frame.theme.background,
            frame.measure,
          );
          return halo ? { ...made, halo } : made;
        });
        const labels: LabelsGeometry = {
          kind: "labels",
          draw: labelsDrawing,
          key: `${key}|${stage}`,
          items,
        };
        out.push(labels);
        continue;
      }
      const coords = frame.floats(key, stage, group.items.length * 2);
      group.items.forEach((item, i) => {
        coords[i * 2] = item.x;
        coords[i * 2 + 1] = item.y;
      });
      const text: TextGeometry = {
        kind: "text",
        draw: textDrawing,
        key: `${key}|${stage}`,
        fill: group.fill,
        anchor: group.anchor,
        halo,
        coords,
        labels: group.items.map((item) => item.text),
        count: group.items.length,
      };
      out.push(text);
    }
    this.#groups = new Map();
    return out;
  }

  #width(text: string): number {
    return this.#frame.measure(text, this.#paint.css) + this.#padding;
  }

  #inPlot(x: number, y: number): boolean {
    const { plot } = this.#frame;
    return x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height;
  }

  /** Whether a label's box lies inside the plot. */
  #fits(x: number, y: number, width: number, height: number): boolean {
    const { plot } = this.#frame;
    return (
      x >= plot.x &&
      x + width <= plot.x + plot.width &&
      y >= plot.y &&
      y + height <= plot.y + plot.height
    );
  }

  /**
   * Text on a bar takes the labels' own color, or else contrasts with the
   * bar's color over the backdrop; colors it cannot read get the theme's
   * text color with a halo.
   */
  #inside(
    anchor: TextGeometry["anchor"],
    fill: string,
    opacity: number,
    x: number,
    y: number,
    text: string,
  ) {
    if (this.#color !== undefined) {
      this.#add(anchor, this.#color, false, x, y, text);
      return;
    }
    const color = contrastingText(fill, opacity, this.#backdrop);
    this.#add(anchor, color ?? this.#frame.theme.text, color === undefined, x, y, text);
  }

  #add(
    anchor: TextGeometry["anchor"],
    fill: string,
    halo: boolean,
    x: number,
    y: number,
    text: string,
  ) {
    halo &&= this.#halo !== false;
    const stage = `labels ${anchor} ${fill} ${halo}`;
    let group = this.#groups.get(stage);
    if (!group) {
      group = { anchor, fill, halo, items: [] };
      this.#groups.set(stage, group);
    }
    group.items.push({ x, y, text });
  }
}

/** A label's text, written only once its bar can show it. */
function written(label: string | (() => string)): string {
  return typeof label === "string" ? label : label();
}

/** A row's value of a category or number field as a label writes it. */
function fieldText(table: Table, field: string, row: number, format: Formatter): string {
  const value = table.value(field as never, row);
  return value === null ? "" : typeof value === "number" ? format(value) : value;
}

/**
 * Whether a table's positions strictly increase (NaN breaks it), checked
 * again only for the rows appended since, while the positions array is the
 * table's own column view of unchanged rows; other arrays (band indices) are
 * checked once each.
 */
class IncreasingRows {
  #positions: ArrayLike<number> | undefined;
  #version = -1;
  #table: Table | undefined;
  #modified = -1;
  /** Row identities checked so far: up to, not including, this one. */
  #end = 0;
  #increasing = false;

  /** `column`: positions are a field's values, so rows keep theirs as rows stream. */
  check(table: Table, positions: ArrayLike<number>, column: boolean): boolean {
    // A replace can change values in an array the table hands out again.
    if (positions === this.#positions && table.version === this.#version) return this.#increasing;
    const end = table.rowOffset + table.length;
    // Rows only added at the end and dropped from the front since: the
    // ones already checked still increase, so only the rest need checking.
    const continues =
      column &&
      this.#table === table &&
      this.#modified === table.modifiedVersion &&
      this.#increasing &&
      this.#end > table.rowOffset &&
      end >= this.#end;
    let from = continues ? this.#end - table.rowOffset : 1;
    let increasing = true;
    for (from = Math.max(1, from); from < positions.length; from++) {
      if (!(positions[from]! > positions[from - 1]!)) {
        increasing = false;
        break;
      }
    }
    this.#positions = positions;
    this.#version = table.version;
    this.#table = table;
    this.#modified = table.modifiedVersion;
    this.#end = end;
    this.#increasing = increasing;
    return increasing;
  }
}

/**
 * Stacks bars that share a position (x, before horizontal bars swap axes).
 * Positive values stack away from zero in one direction and negative values
 * in the other, each series on top of the previous ones.
 */
function positionTotals(
  series: readonly Series[],
  shown: readonly boolean[],
  horizontal = false,
): Map<number, number> {
  const totals = new Map<number, number>();
  series.forEach((s, l) => {
    if (!shown[l]) return;
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const at = (horizontal ? s.y : s.x)[row]!;
      const raw = s.values[row]!;
      requireContribution(raw, `bar stack "fill" row ${row}`);
      if (Number.isFinite(raw)) {
        const total = (totals.get(at) ?? 0) + raw;
        if (!Number.isFinite(total))
          throw new RangeError(
            'bar stack "fill": total exceeds finite numeric range; rescale the values',
          );
        totals.set(at, total);
      }
    }
  });
  return totals;
}

function stackBars(series: readonly Series[], shown: readonly boolean[], fill = false): Stack {
  const totals = fill ? positionTotals(series, shown) : undefined;
  const positive = new Map<number, number>();
  const negative = new Map<number, number>();
  const tops: Float64Array[] = [];
  const bases: Float64Array[] = [];
  const allocate = (length: number) => [nans(length), nans(length)] as const;
  // Series split by a category field cover disjoint rows of one field, so
  // they share table-sized arrays; series of different fields need their own.
  let shared: readonly [Float64Array, Float64Array] | undefined;
  series.forEach((s, i) => {
    if (s.rows && !shared) shared = allocate(s.values.length);
    const [top, base] = s.rows && shared ? shared : allocate(s.values.length);
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const raw = shown[i] ? s.values[row]! : 0;
      const value =
        totals && Number.isFinite(raw)
          ? totals.get(s.x[row]!)! > 0
            ? raw / totals.get(s.x[row]!)!
            : 0
          : raw;
      if (!Number.isFinite(value)) continue;
      const at = s.x[row]!;
      const sums = value >= 0 ? positive : negative;
      const below = sums.get(at) ?? 0;
      base[row] = below;
      top[row] = below + value;
      sums.set(at, below + value);
    }
    tops.push(top);
    bases.push(base);
  });
  return {
    tops,
    bases,
    totals: totals && Float64Array.from(series[0]?.x ?? [], (at) => totals.get(at) ?? 0),
  };
}

/** An array of `length` NaNs: stack ends of rows not stacked are not drawn. */
function nans(length: number): Float64Array {
  return new Float64Array(length).fill(Number.NaN);
}

/**
 * Bars. With a category x, each value gets a band; with numeric or time x,
 * bars are centered on their x values. A category y makes bars horizontal.
 *
 * ```ts
 * bar(sales, { x: "region", y: ["2025", "2026"] })
 * bar(sales, { x: "revenue", y: "region" })
 * bar(requests, { x: "minute", y: "count", series: "status", stack: true })
 * ```
 */
export function bar<S extends Schema>(
  table: Table<S>,
  options: BarOptions<S>,
): ChartMark<Frozen<BarSpec>> {
  const fields = (value: string | readonly string[]) =>
    typeof value === "string" ? value : [...value];
  const spec: BarSpec = {
    type: "bar",
    x: fields(options.x),
    y: fields(options.y),
    ...definedFields(options, [
      "tooltip",
      "series",
      "stack",
      "dodge",
      "fill",
      "fillOpacity",
      "stroke",
      "strokeWidth",
      "strokeOpacity",
      "dash",
      "opacity",
      "label",
      "legendGroup",
      "legend",
      "labels",
      "halo",
      "id",
      "axis",
      "facet",
      "panel",
      "clip",
      "color",
      "encode",
      "style",
    ]),
  } as BarSpec;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BarMark(spec, table as unknown as Table);
}
