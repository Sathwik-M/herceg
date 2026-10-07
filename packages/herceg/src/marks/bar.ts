import type { NumericArray } from "../data/column.ts";
import {
  type CategoryField,
  type FieldName,
  lowerBound,
  type NumericField,
  type Schema,
  type Table,
  upperBound,
} from "../data/table.ts";
import { rectDrawing } from "../draw/rect.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { RectGeometry } from "../scene/scene.ts";
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
import { unionExtent } from "./trace.ts";

interface BarStyle<S extends Schema> {
  /** Category field: one bar series per value. */
  series?: CategoryField<S>;
  /** Stack series instead of placing them side by side. */
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  label?: string;
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
}

/** A category `y` makes bars horizontal; otherwise they are vertical. */
export type BarOptions<S extends Schema> = VerticalBarOptions<S> | HorizontalBarOptions<S>;

/** Fraction of the spacing between numeric x values that bars fill. */
const FILL = 0.8;
/** Gap between grouped bars, as a fraction of each bar's slot. */
const GROUP_GAP = 0.1;
const MAX_WIDTH = 64;

interface Positions {
  /** Distinct finite x values, ascending. */
  values: Float64Array;
  /** Smallest gap between neighboring values, linear and in log10 units. */
  gap: number;
  logGap: number;
}

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
  readonly #positions = new TableCache<Positions>();

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
    if (!extent) return undefined;
    // Leave half a bar slot of room at each end, measured on the axis's own
    // scale so log axes keep positive bounds.
    const { gap, logGap } = this.#xPositions();
    const [lo, hi] = log ? [Math.log10(extent[0]), Math.log10(extent[1])] : extent;
    const half = ((log ? logGap : gap) || hi - lo || 1) / 2;
    const [start, end] = log ? [10 ** (lo - half), 10 ** (hi + half)] : [lo - half, hi + half];
    // Padding that overflows or underflows keeps the data's own end.
    const usable = (value: number) => Number.isFinite(value) && (!log || value > 0);
    return [usable(start) ? start : extent[0], usable(end) ? end : extent[1]] as const;
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

  geometry(series: readonly Series[], frame: Frame): RectGeometry[] {
    const visible = series.filter((s) => !frame.hidden.has(s.key));
    const horizontal = this.#horizontal;
    // `along` places bars; `across` measures their lengths.
    const along = horizontal ? frame.y : frame.x;
    const across = horizontal ? frame.x : frame.y;
    // Each position gets a slot; grouped series split it, stacked ones share it.
    const slot = this.#categorical
      ? Math.abs(along.bandwidth ?? 0)
      : Math.min(MAX_WIDTH, this.#pixelGap(along) * FILL);
    const groups = this.spec.stack ? 1 : Math.max(1, visible.length);
    const share = slot / groups;
    const width = groups > 1 ? share * (1 - GROUP_GAP) : share;
    // A zero base has no place on a log axis; bars grow from its low end.
    const zero = across.type === "log" ? across.range[0] : across.map(0);
    const out: RectGeometry[] = [];
    visible.forEach((s, group) => {
      // Stacked series share the whole slot; grouped ones take their share of it.
      const offset = this.spec.stack ? -slot / 2 : -slot / 2 + share * group + (share - width) / 2;
      const [start, end] = horizontal
        ? [0, s.length]
        : visibleRange(s, along.domain[0], along.domain[1]);
      const positions = horizontal ? s.y : s.x;
      const ends = horizontal ? s.x : s.y;
      const bases = horizontal ? s.x0 : s.y0;
      const rects = frame.floats(s.key, "rect", (end - start) * 4);
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
        count++;
      }
      out.push({
        kind: "rect",
        draw: rectDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: this.spec.fillOpacity ?? 1,
        rects,
        count,
      });
    });
    return out;
  }

  /** Distinct x values of the table and their spacing, which bar widths follow. */
  #xPositions(): Positions {
    return this.#positions.get(this.table, () => {
      const x = this.table.numbers(this.#position as never);
      const sorted = Float64Array.from(x);
      if (!this.table.isSorted(this.#position as never)) sorted.sort();
      let count = 0;
      for (const value of sorted) {
        if (Number.isFinite(value) && (count === 0 || value !== sorted[count - 1])) {
          sorted[count++] = value;
        }
      }
      const values = sorted.subarray(0, count);
      return { values, gap: minGap(values, false), logGap: minGap(values, true) };
    });
  }

  /** Smallest pixel distance between neighboring x positions in view. */
  #pixelGap(x: PositionScale): number {
    const positions = this.#xPositions().values;
    const lo = Math.min(x.domain[0], x.domain[1]);
    const hi = Math.max(x.domain[0], x.domain[1]);
    // One neighbor past each edge, so zooming onto one bar keeps its width.
    const start = Math.max(0, lowerBound(positions, lo) - 1);
    const end = Math.min(positions.length, upperBound(positions, hi) + 1);
    let best = Infinity;
    let previous = Number.NaN;
    for (let i = start; i < end; i++) {
      const pixel = x.map(positions[i]!);
      if (!Number.isFinite(pixel)) continue;
      const gap = Math.abs(pixel - previous);
      if (gap < best) best = gap;
      previous = pixel;
    }
    return best > 0 && Number.isFinite(best) ? best : MAX_WIDTH / FILL;
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

/** Smallest gap between neighboring positions, in log10 units on log axes. */
function minGap(positions: Float64Array, log: boolean): number {
  let best = Infinity;
  let previous = Number.NaN;
  for (const position of positions) {
    if (log && !(position > 0)) continue;
    const value = log ? Math.log10(position) : position;
    if (value - previous < best) best = value - previous;
    previous = value;
  }
  return Number.isFinite(best) ? best : 0;
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
    ...definedFields(options, ["series", "stack", "fill", "fillOpacity", "label", "id"]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BarMark(spec, table as unknown as Table);
}
