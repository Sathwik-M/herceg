import {
  type CategoryField,
  type FieldName,
  lowerBound,
  type NumericField,
  type Schema,
  type Table,
  upperBound,
} from "../data/table.ts";
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

export interface BarOptions<S extends Schema> {
  /** Category field (one band per value) or a numeric or time field. */
  x: FieldName<S>;
  /** Bar heights: one field, or several fields drawn side by side or stacked. */
  y: NumericField<S> | readonly NumericField<S>[];
  /** Category field: one bar series per value. */
  series?: CategoryField<S>;
  /** Stack series instead of placing them side by side. */
  stack?: boolean;
  fill?: string;
  fillOpacity?: number;
  label?: string;
  id?: string;
}

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
  readonly zero = true;
  readonly tooltip = "x";
  readonly bandPadding = 0.2;
  readonly #split: SeriesSplitter;
  readonly #categorical: boolean;
  readonly #stacks = new TableCache<Map<string, Stack>>();
  readonly #positions = new TableCache<Positions>();

  constructor(spec: BarSpec, table: Table<Schema>) {
    this.spec = spec;
    this.table = table;
    requireField(table, spec.x, [...NUMERIC, ...CATEGORY], "bar x");
    const ys = typeof spec.y === "string" ? [spec.y] : spec.y;
    for (const y of ys) requireField(table, y, NUMERIC, "bar y");
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "bar series");
    this.#categorical = table.kind(spec.x) === "category";
    this.#split = new SeriesSplitter(
      table,
      this.#categorical ? undefined : spec.x,
      ys,
      spec.series,
      spec.label,
    );
  }

  channelKind(axis: "x" | "y") {
    return axis === "x" ? this.table.kind(this.spec.x) : "number";
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return axis === "x" && this.#categorical
      ? fieldBands(this.table, this.spec.x, context)
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
    // Categorical x: each row's band index is its x position.
    const x = this.#categorical
      ? bandIndices(table, spec.x, bands.x?.keys ?? [], context)
      : table.numbers(spec.x as never);
    const series = buildSeries(table, this.#split.sources(), x, key, palette, spec.fill);
    if (spec.stack) {
      const shown = series.map((s) => !hidden.has(s.key));
      const signature = shown.map(Number).join("");
      const cache = this.#stacks.get(table, () => new Map());
      let stack = cache.get(signature);
      if (!stack || stack.tops[0]?.length !== x.length) {
        stack = stackBars(series, shown);
        if (cache.size >= 4) cache.clear();
        cache.set(signature, stack);
      }
      series.forEach((s, i) => {
        s.y = stack.tops[i]!;
        s.y0 = stack.bases[i];
      });
    }
    return series;
  }

  xExtent(series: readonly Series[], log: boolean) {
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
    const { x, y } = frame;
    // Each x position gets a slot; grouped series split it, stacked ones share it.
    const slot = this.#categorical
      ? Math.abs(x.bandwidth ?? 0)
      : Math.min(MAX_WIDTH, this.#pixelGap(x) * FILL);
    const groups = this.spec.stack ? 1 : Math.max(1, visible.length);
    const share = slot / groups;
    const width = groups > 1 ? share * (1 - GROUP_GAP) : share;
    const zero = y.type === "log" ? y.range[0] : y.map(0);
    const out: RectGeometry[] = [];
    visible.forEach((s, group) => {
      // Stacked series share the whole slot; grouped ones take their share of it.
      const left = this.spec.stack ? -slot / 2 : -slot / 2 + share * group + (share - width) / 2;
      const [start, end] = visibleRange(s, x.domain[0], x.domain[1]);
      const rects = frame.floats(s.key, "rect", (end - start) * 4);
      let count = 0;
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        const at = s.x[row]!;
        const top = s.y[row]!;
        if (!Number.isFinite(top) || (this.#categorical && at < 0)) continue;
        const base = s.y0 ? s.y0[row]! : Number.NaN;
        const center = x.map(at);
        const yTop = y.map(top);
        // A zero base has no place on a log axis; bars rise from its bottom.
        let yBase = Number.isFinite(base) ? y.map(base) : zero;
        if (!Number.isFinite(yBase)) yBase = zero;
        if (!(Number.isFinite(center) && Number.isFinite(yTop))) continue;
        rects[count * 4] = center + left;
        rects[count * 4 + 1] = Math.min(yTop, yBase);
        rects[count * 4 + 2] = width;
        rects[count * 4 + 3] = Math.abs(yBase - yTop);
        count++;
      }
      out.push({
        kind: "rect",
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
      const x = this.table.numbers(this.spec.x as never);
      const sorted = Float64Array.from(x);
      if (!this.table.isSorted(this.spec.x as never)) sorted.sort();
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
 * Stacks bars that share an x value. Positive values stack upward from zero
 * and negative values downward, each series on top of the previous ones.
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
 * Vertical bars. With a category x, each value gets a band; with numeric or
 * time x, bars are centered on their x values.
 *
 * ```ts
 * bar(sales, { x: "region", y: ["2025", "2026"] })
 * bar(requests, { x: "minute", y: "count", series: "status", stack: true })
 * ```
 */
export function bar<S extends Schema>(table: Table<S>, options: BarOptions<S>): BarMark {
  const spec: BarSpec = {
    type: "bar",
    x: options.x,
    y: typeof options.y === "string" ? options.y : [...options.y],
    ...definedFields(options, ["series", "stack", "fill", "fillOpacity", "label", "id"]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new BarMark(spec, table as unknown as Table);
}
