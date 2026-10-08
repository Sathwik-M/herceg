import type { NumericArray } from "../data/column.ts";
import type { CategoryField, FieldName, NumericField, Schema, Table } from "../data/table.ts";
import { BOTTOM, LEFT, RIGHT, rectDrawing, TOP } from "../draw/rect.ts";
import { textDrawing } from "../draw/text.ts";
import { type Formatter, numberFormatter } from "../format/format.ts";
import { estimateText } from "../layout/text.ts";
import { contrastingText, isLightColor } from "../scale/color.ts";
import type { RectGeometry, TextGeometry } from "../scene/scene.ts";
import type { BarSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  buildSeries,
  CATEGORY,
  type Frame,
  fieldBands,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
} from "./mark.ts";
import { rowOf, type Series, TableCache, visibleRange, xExtent, yExtent } from "./series.ts";
import { Slots } from "./slots.ts";
import { unionExtent } from "./trace.ts";

interface BarStyle<S extends Schema> {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** Category field: one bar series per value. */
  series?: CategoryField<S>;
  /** Stack series instead of placing them side by side. */
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  label?: string;
  /**
   * Write each bar's value at its end (or, stacked, inside each segment), as
   * a number or with these Intl.NumberFormat options. Labels that do not fit
   * are left out.
   */
  labels?: boolean | Intl.NumberFormatOptions;
  id?: string;
}

/** Vertical bars: positions on x, lengths on y. */
export interface VerticalBarOptions<S extends Schema> extends BarStyle<S> {
  /** Category field (one band per value) or a numeric or time field. */
  x: FieldName<S>;
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

interface Stack {
  tops: Float64Array[];
  bases: Float64Array[];
}

export class BarMark implements Mark<BarSpec> {
  readonly spec: BarSpec;
  readonly table: Table<Schema>;
  readonly zero: "x" | "y";
  readonly tooltip: "x" | "y";
  readonly bandPadding = 0.2;
  /** Categories on y, lengths on x. */
  readonly #horizontal: boolean;
  /** The field bars are placed by: x for vertical bars, y for horizontal ones. */
  readonly #position: string;
  readonly #categorical: boolean;
  readonly #split: SeriesSplitter;
  readonly #stacks = new TableCache<Map<string, Stack>>();
  /** Slots of bars on a number or time position axis. */
  #slots: Slots | undefined;
  #formatter: { locale: string | undefined; format: Formatter } | undefined;

  constructor(spec: BarSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
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
        throw new Error(
          "Bars with several x fields are horizontal and need one category field as y",
        );
      }
      requireField(table, xs[0]!, [...NUMERIC, ...CATEGORY], "bar x");
      for (const y of ys) requireField(table, y, NUMERIC, "bar y");
      this.#position = xs[0]!;
      lengths = ys;
    }
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "bar series");
    this.zero = this.#horizontal ? "x" : "y";
    this.tooltip = this.#horizontal ? "y" : "x";
    this.#categorical = table.kind(this.#position) === "category";
    this.#split = new SeriesSplitter(
      table,
      this.#categorical ? undefined : this.#position,
      lengths,
      spec.series,
      spec.label,
    );
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
    const series = buildSeries(table, this.#split.sources(), positions, key, palette, spec.fill);
    if (spec.stack) {
      const shown = series.map((s) => !hidden.has(s.key));
      const signature = shown.map(Number).join("");
      const cache = this.#stacks.get(table, () => new Map());
      let stack = cache.get(signature);
      if (!stack || stack.tops[0]?.length !== positions.length) {
        stack = stackBars(series, shown);
        if (cache.size >= 4) cache.clear();
        cache.set(signature, stack);
      }
      series.forEach((s, i) => {
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

  xExtent(series: readonly Series[], log: boolean) {
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
    return extent && this.#slotsOf().pad(extent, log);
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean) {
    // Horizontal bars put bands on y, which take their categories instead.
    if (this.#horizontal) return undefined;
    // Rows without a band (missing categories, index -1) are not drawn.
    const lo = this.#categorical ? 0 : x0;
    const hi = this.#categorical ? Number.POSITIVE_INFINITY : x1;
    return unionExtent(
      series.flatMap((s) => [
        yExtent(s, lo, hi, s.y, log),
        s.y0 ? yExtent(s, lo, hi, s.y0, log) : undefined,
      ]),
    );
  }

  geometry(series: readonly Series[], frame: Frame): (RectGeometry | TextGeometry)[] {
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    const horizontal = this.#horizontal;
    // `along` places bars; `across` measures their lengths.
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    // Each position gets a slot; grouped series split it, stacked ones share it.
    const slot = this.#categorical ? Math.abs(along.bandwidth ?? 0) : this.#slotsOf().width(along);
    const groups = this.spec.stack ? 1 : Math.max(1, visible.length);
    const share = slot / groups;
    const width = groups > 1 ? share * (1 - GROUP_GAP) : share;
    // A zero base has no place on a log axis; bars grow from its low end.
    const zero = across.type === "log" ? across.range[0] : across.map(0);
    const out: (RectGeometry | TextGeometry)[] = [];
    const labels = this.spec.labels
      ? new BarLabels(this.#format(frame.locale), frame, horizontal)
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
    const opacity = this.spec.fillOpacity ?? 1;
    visible.forEach((s, group) => {
      const labeled = labels?.fits(width, spacing, Boolean(this.spec.stack)) ? labels : undefined;
      // Stacked series share the whole slot; grouped ones take their share of it.
      const offset = this.spec.stack ? -slot / 2 : -slot / 2 + share * group + (share - width) / 2;
      const [start, end] = horizontal
        ? [0, s.length]
        : visibleRange(s, along.domain[0], along.domain[1]);
      const positions = horizontal ? s.y : s.x;
      const ends = horizontal ? s.x : s.y;
      const bases = horizontal ? s.x0 : s.y0;
      const rects = frame.floats(s.key, "rect", (end - start) * 4);
      // Unstacked bars round the corners at their value's end. The buffer
      // matches the rectangles' capacity, so it grows only when they do.
      const rounding =
        !this.spec.stack && frame.theme.barRadius > 0
          ? frame.bytes(s.key, "ends", Math.ceil(rects.length / 4))
          : undefined;
      let count = 0;
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        const at = positions[row]!;
        const value = ends[row]!;
        if (!Number.isFinite(value) || (this.#categorical && at < 0)) continue;
        const base = bases ? bases[row]! : Number.NaN;
        const center = along.map(at);
        const tip = across.map(value);
        let root = Number.isFinite(base) ? across.map(base) : zero;
        if (!Number.isFinite(root)) root = zero;
        if (!(Number.isFinite(center) && Number.isFinite(tip))) continue;
        const i = count * 4;
        if (horizontal) {
          rects[i] = Math.min(tip, root);
          rects[i + 1] = center + offset;
          rects[i + 2] = Math.abs(root - tip);
          rects[i + 3] = width;
        } else {
          rects[i] = center + offset;
          rects[i + 1] = Math.min(tip, root);
          rects[i + 2] = width;
          rects[i + 3] = Math.abs(root - tip);
        }
        if (rounding)
          rounding[count] = horizontal ? (tip > root ? RIGHT : LEFT) : tip < root ? TOP : BOTTOM;
        count++;
        if (labeled) {
          const middle = center + offset + width / 2;
          const value = s.values[row]!;
          if (this.spec.stack) labeled.inside(value, middle, root, tip, width, s.color, opacity);
          else {
            const cap = rounding
              ? Math.min(frame.theme.barRadius, width / 2, Math.abs(root - tip))
              : 0;
            labeled.outside(value, middle, root, tip, spacing, s.color, opacity, width, cap);
          }
        }
      }
      out.push({
        kind: "rect",
        draw: rectDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: opacity,
        rects,
        count,
        rounded: rounding && { radius: frame.theme.barRadius, ends: rounding },
      });
      if (labeled) out.push(...labeled.flush(s.key));
    });
    return out;
  }

  /** Room past the bars' ends for their labels; stacked labels sit inside. */
  headroom(series: readonly Series[], context: BandContext): number {
    if (!this.spec.labels || this.spec.stack || series.length === 0) return 0;
    const size = context.theme.fontSize;
    if (!this.#horizontal) return size + LABEL_GAP + 2;
    // Horizontal labels are as wide as their text: judge by the extremes.
    const extent = this.xExtent(series, false);
    if (!extent) return 0;
    const format = this.#format(context.locale);
    const font = `${size}px ${context.theme.font}`;
    return Math.max(...extent.map((value) => estimateText(format(value), font))) + LABEL_GAP + 2;
  }

  /** The value formatter for labels, kept while the locale stays the same. */
  #format(locale: string | undefined): Formatter {
    let cached = this.#formatter;
    if (!cached || cached.locale !== locale) {
      const options = this.spec.labels;
      // The default formatting of `formatNumber`, without its lookups per value.
      const whole = numberFormatter({ maximumFractionDigits: 2 }, locale);
      const small = numberFormatter({ maximumSignificantDigits: 3 }, locale);
      const format =
        typeof options === "object"
          ? numberFormatter(options, locale)
          : (value: number) => (Math.abs(value) >= 1 || value === 0 ? whole(value) : small(value));
      cached = { locale, format };
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

interface LabelGroup {
  anchor: TextGeometry["anchor"];
  fill: string;
  halo: boolean;
  items: { x: number; y: number; text: string }[];
}

/**
 * Value labels of one bar mark, collected per series: past each bar's end,
 * or inside it when that would leave the plot, or for stacks centered in
 * each segment. Widths are estimated from font metrics, since geometry is
 * built without measuring text; labels that do not fit are left out, and
 * values are only formatted for bars that could show them.
 */
class BarLabels {
  readonly #format: Formatter;
  readonly #frame: Frame;
  readonly #horizontal: boolean;
  readonly #size: number;
  readonly #font: string;
  /** What text inside a bar contrasts with: the background, or a page of the theme's kind. */
  readonly #backdrop: string;
  #groups = new Map<string, LabelGroup>();

  constructor(format: Formatter, frame: Frame, horizontal: boolean) {
    const { theme } = frame;
    this.#format = format;
    this.#frame = frame;
    this.#horizontal = horizontal;
    this.#size = theme.fontSize;
    this.#font = `${theme.fontSize}px ${theme.font}`;
    this.#backdrop =
      theme.background !== "transparent"
        ? theme.background
        : isLightColor(theme.text)
          ? "#000000"
          : "#ffffff";
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
   * A label past the bar's end, or just inside it when past would leave the
   * plot. `middle` is the bar's center across its thickness; `spacing` the
   * distance to the neighboring bars' centers; `cap` the radius of the bar's
   * rounded end, which labels inside keep clear of.
   */
  outside(
    value: number,
    middle: number,
    root: number,
    tip: number,
    spacing: number,
    fill: string,
    opacity: number,
    thickness: number,
    cap: number,
  ) {
    const size = this.#size;
    if (!this.#horizontal) {
      if (!this.#inPlot(middle, tip)) return;
      const text = this.#format(value);
      const width = this.#width(text);
      // Wider labels would run into the neighboring bars' labels.
      if (width + LABEL_GAP > spacing) return;
      const up = tip <= root;
      const past = up ? tip - LABEL_GAP - size / 2 : tip + LABEL_GAP + size / 2;
      if (this.#fits(middle - width / 2, past - size / 2, width, size)) {
        this.#add("middle", this.#frame.theme.text, true, middle, past, text);
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
    const text = this.#format(value);
    const width = this.#width(text);
    const forward = tip >= root;
    const past = forward ? tip + LABEL_GAP : tip - LABEL_GAP;
    const top = middle - size / 2;
    if (this.#fits(forward ? past : past - width, top, width, size)) {
      this.#add(forward ? "start" : "end", this.#frame.theme.text, true, past, middle, text);
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
   * A label centered in the visible part of a stacked segment, when it has
   * room there.
   */
  inside(
    value: number,
    middle: number,
    root: number,
    tip: number,
    width: number,
    fill: string,
    opacity: number,
  ) {
    const { plot } = this.#frame;
    const [min, max] = this.#horizontal
      ? [plot.x, plot.x + plot.width]
      : [plot.y, plot.y + plot.height];
    const a = Math.max(min, Math.min(root, tip));
    const b = Math.min(max, Math.max(root, tip));
    const length = b - a;
    if (length <= 0 || (!this.#horizontal && length < this.#size + 2)) return;
    const center = (a + b) / 2;
    const [x, y] = this.#horizontal ? [center, middle] : [middle, center];
    const text = this.#format(value);
    const textWidth = this.#width(text);
    const room = this.#horizontal ? length - LABEL_GAP : width - 2;
    if (textWidth > room) return;
    if (this.#fits(x - textWidth / 2, y - this.#size / 2, textWidth, this.#size))
      this.#inside("middle", fill, opacity, x, y, text);
  }

  /** The labels' geometry for the series `key`; starts the next series. */
  flush(key: string): TextGeometry[] {
    const out: TextGeometry[] = [];
    for (const [stage, group] of this.#groups) {
      const coords = this.#frame.floats(key, stage, group.items.length * 2);
      group.items.forEach((item, i) => {
        coords[i * 2] = item.x;
        coords[i * 2 + 1] = item.y;
      });
      out.push({
        kind: "text",
        draw: textDrawing,
        key: `${key}|${stage}`,
        fill: group.fill,
        anchor: group.anchor,
        halo: group.halo,
        coords,
        labels: group.items.map((item) => item.text),
        count: group.items.length,
      });
    }
    this.#groups = new Map();
    return out;
  }

  #width(text: string): number {
    return estimateText(text, this.#font);
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
   * Text on a bar contrasts with the bar's color over the backdrop; colors
   * it cannot read get the theme's text color with a halo.
   */
  #inside(
    anchor: TextGeometry["anchor"],
    fill: string,
    opacity: number,
    x: number,
    y: number,
    text: string,
  ) {
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
    const stage = `labels ${anchor} ${fill} ${halo}`;
    let group = this.#groups.get(stage);
    if (!group) {
      group = { anchor, fill, halo, items: [] };
      this.#groups.set(stage, group);
    }
    group.items.push({ x, y, text });
  }
}

/**
 * Stacks bars that share a position (x, before horizontal bars swap axes).
 * Positive values stack away from zero in one direction and negative values
 * in the other, each series on top of the previous ones.
 */
function stackBars(series: readonly Series[], shown: readonly boolean[]): Stack {
  const positive = new Map<number, number>();
  const negative = new Map<number, number>();
  const tops: Float64Array[] = [];
  const bases: Float64Array[] = [];
  const allocate = (length: number) =>
    [new Float64Array(length).fill(Number.NaN), new Float64Array(length).fill(Number.NaN)] as const;
  // Series split by a category field cover disjoint rows of one field, so
  // they share table-sized arrays; series of different fields need their own.
  let shared: readonly [Float64Array, Float64Array] | undefined;
  series.forEach((s, i) => {
    if (s.rows && !shared) shared = allocate(s.values.length);
    const [top, base] = s.rows && shared ? shared : allocate(s.values.length);
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const value = shown[i] ? s.values[row]! : 0;
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
  return { tops, bases };
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
export function bar<S extends Schema>(table: Table<S>, options: BarOptions<S>): BarMark {
  const fields = (value: string | readonly string[]) =>
    typeof value === "string" ? value : [...value];
  const spec: BarSpec = {
    type: "bar",
    x: fields(options.x),
    y: fields(options.y),
    ...definedFields(options, [
      "series",
      "stack",
      "fill",
      "fillOpacity",
      "label",
      "labels",
      "id",
      "axis",
      "facet",
    ]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BarMark(spec, table as unknown as Table);
}
