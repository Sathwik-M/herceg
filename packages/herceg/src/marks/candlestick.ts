import type { NumericArray } from "../data/column.ts";
import type { NumericField, PositionField, Schema, Table } from "../data/table.ts";
import { rectDrawing } from "../draw/rect.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { Breaks } from "../lod/m4.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { RectGeometry, SegmentGeometry } from "../scene/scene.ts";
import type { CandlestickSpec, Frozen } from "../spec/spec.ts";
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
  type SummaryContext,
  valueKind,
} from "./mark.ts";
import { rowOf, type Series, visibleRange, xExtent } from "./series.ts";
import { FILL, Slots } from "./slots.ts";
import { unionExtent } from "./trace.ts";

export interface CandlestickOptions<S extends Schema> {
  /** Time, number, or category field the candles stand at. */
  x: PositionField<S>;
  open: NumericField<S>;
  high: NumericField<S>;
  low: NumericField<S>;
  close: NumericField<S>;
  /** Color of candles closing at or above their open; the theme's `rise` by default. */
  rise?: string;
  /** Color of candles closing below their open; the theme's `fall` by default. */
  fall?: string;
  /**
   * "candlestick" (the default): bodies from open to close, hollow when
   * they rise. "ohlc": bars, a line from low to high with the open ticked
   * to its left and the close to its right, colored by direction.
   */
  variant?: "candlestick" | "ohlc";
  label?: string;
  /** The y axis the prices are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

/** Segments a candle draws at most: a hollow body's four sides and two wicks. */
const SEGMENTS = 6;
/** Segments of an OHLC bar: its line from low to high, and the open and close ticks. */
const OHLC_SEGMENTS = 3;

type Prices = Record<"open" | "high" | "low" | "close", NumericArray>;

/**
 * The candle of a row, written to `out` as open, high, low, close; false
 * when the row makes none. All four prices must be finite, and positive on
 * a log axis. High and low widen to cover open and close, so inconsistent
 * data still draws within its extent.
 */
function candleOf(prices: Prices, row: number, log: boolean, out: Float64Array): boolean {
  const open = prices.open[row]!;
  const close = prices.close[row]!;
  const rawHigh = prices.high[row]!;
  const rawLow = prices.low[row]!;
  // Each price must be finite before high and low widen over the others.
  if (!(Number.isFinite(open) && Number.isFinite(close))) return false;
  if (!(Number.isFinite(rawHigh) && Number.isFinite(rawLow))) return false;
  const high = Math.max(rawHigh, open, close);
  const low = Math.min(rawLow, open, close);
  if (log && !(low > 0)) return false;
  out[0] = open;
  out[1] = high;
  out[2] = low;
  out[3] = close;
  return true;
}

/**
 * Open-high-low-close candles, as for prices. A candle's body spans its open
 * and close, its wicks its low and high. Candles closing at or above their
 * open are hollow, others filled, so direction reads without color while
 * candles are a few pixels wide. The "ohlc" variant draws bars instead: a
 * line from low to high, the open ticked left and the close right, which
 * show direction by their order. When more candles are in view than the plot
 * has pixels, the candles in each pixel column merge into one: the open of
 * the earliest, the close of the latest (by x, then by row), and the highest
 * high and lowest low. The series reads the close, which tooltips mark and
 * the nearest-point search measures from.
 */
export class CandlestickMark implements Mark<Frozen<CandlestickSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<CandlestickSpec>;
  readonly table: Table<Schema>;
  readonly tooltip = "x";
  readonly #categorical: boolean;
  readonly #split: SeriesSplitter;
  readonly #slots: Slots | undefined;
  /** Scratch for one candle's prices. */
  readonly #candle = new Float64Array(4);

  constructor(input: CandlestickSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    requireField(table, spec.x, [...NUMERIC, ...CATEGORY], "candlestick x");
    for (const name of ["open", "high", "low", "close"] as const)
      requireField(table, spec[name], NUMERIC, `candlestick ${name}`);
    this.#categorical = table.kind(spec.x) === "category";
    this.#slots = this.#categorical ? undefined : new Slots(table, spec.x);
    this.#split = new SeriesSplitter(
      table,
      this.#categorical ? undefined : spec.x,
      [spec.close],
      undefined,
      spec.label ?? spec.close,
    );
  }

  channelKind(axis: "x" | "y") {
    const { spec, table } = this;
    if (axis === "x") return table.kind(spec.x);
    return valueKind(table, [spec.open, spec.high, spec.low, spec.close]);
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return axis === "x" && this.#categorical
      ? fieldBands(this.table, this.spec.x, context)
      : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { spec, table } = this;
    const positions = this.#categorical
      ? bandIndices(table, spec.x, bands.x?.keys ?? [], context)
      : table.numbers(spec.x as never);
    const color = spec.rise ?? context.theme.rise;
    return buildSeries(table, this.#split.sources(), positions, key, palette, color);
  }

  xExtent(series: readonly Series[], log: boolean, breaks?: Breaks) {
    if (!this.#slots) return undefined;
    const extent = unionExtent(series.map((s) => xExtent(s, log)));
    // Leave half a candle slot of room at each end.
    return extent && this.#slots.pad(extent, log, breaks);
  }

  /**
   * The lowest low and highest high of candles whose center is in [x0, x1]
   * and not inside one of the x axis' `breaks`.
   */
  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    const prices = this.#prices();
    const candle = this.#candle;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      const [start, end] = this.#categorical ? [0, s.length] : visibleRange(s, lo, hi);
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        const at = s.x[row]!;
        if (this.#categorical ? at < 0 : !(at >= lo && at <= hi)) continue;
        if (breaks?.hides(at) || !candleOf(prices, row, log, candle)) continue;
        if (candle[2]! < min) min = candle[2]!;
        if (candle[1]! > max) max = candle[1]!;
      }
    }
    return min <= max ? ([min, max] as const) : undefined;
  }

  geometry(series: readonly Series[], frame: Frame): (SegmentGeometry | RectGeometry)[] {
    const out: (SegmentGeometry | RectGeometry)[] = [];
    const { x, y, plot } = frame;
    const prices = this.#prices();
    const log = y.type === "log";
    const rise = this.spec.rise ?? frame.theme.rise;
    const fall = this.spec.fall ?? frame.theme.fall;
    const candle = this.#candle;
    const ohlc = this.spec.variant === "ohlc";
    // Candles at times an axis break leaves out are not drawn.
    const breaks = x.breaks;
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const [start, end] = this.#categorical
        ? [0, s.length]
        : visibleRange(s, x.domain[0], x.domain[1]);
      const width = this.#categorical ? Math.abs(x.bandwidth ?? 0) : this.#slots!.width(x);
      // Candles whose body reaches the plot.
      const reaches = (center: number) =>
        center >= plot.x - width / 2 && center <= plot.x + plot.width + width / 2;
      // Candles merge when there are more of them than pixel columns; either
      // way there are at most as many as columns, so buffers stay bounded.
      const columns = Math.max(1, Math.ceil(plot.width));
      let count = 0;
      for (let k = start; k < end && count <= columns; k++) {
        const row = rowOf(s, k);
        const at = s.x[row]!;
        if ((this.#categorical && at < 0) || breaks?.hides(at)) continue;
        if (reaches(x.map(at)) && candleOf(prices, row, log, candle)) count++;
      }
      const merged = count > columns;
      const capacity = merged ? columns : count;
      const rising = frame.floats(s.key, "rise", capacity * SEGMENTS * 4);
      // A falling candle draws one wick beside its body; a falling bar, all its segments.
      const falling = frame.floats(s.key, "fall", capacity * (ohlc ? OHLC_SEGMENTS : 1) * 4);
      const bodies = ohlc ? undefined : frame.floats(s.key, "body", capacity * 4);
      let risingCount = 0;
      let fallingCount = 0;
      let bodyCount = 0;
      const segment = (
        to: Float32Array,
        at: number,
        a: number,
        b: number,
        c: number,
        d: number,
      ) => {
        to[at * 4] = a;
        to[at * 4 + 1] = b;
        to[at * 4 + 2] = c;
        to[at * 4 + 3] = d;
      };
      const draw = (center: number, width: number, o: number, h: number, l: number, c: number) => {
        const [yo, yh, yl, yc] = [y.map(o), y.map(h), y.map(l), y.map(c)];
        const left = center - width / 2;
        const right = center + width / 2;
        if (ohlc) {
          const rises = c >= o;
          const to = rises ? rising : falling;
          let at = rises ? risingCount : fallingCount;
          segment(to, at++, center, yh, center, yl);
          segment(to, at++, left, yo, center, yo);
          segment(to, at++, center, yc, right, yc);
          if (rises) risingCount = at;
          else fallingCount = at;
          return;
        }
        const top = Math.min(yo, yc);
        const bottom = Math.max(yo, yc);
        if (c >= o) {
          // A hollow body: its four sides, and wicks above and below it.
          segment(rising, risingCount++, left, top, right, top);
          segment(rising, risingCount++, left, bottom, right, bottom);
          segment(rising, risingCount++, left, top, left, bottom);
          segment(rising, risingCount++, right, top, right, bottom);
          segment(rising, risingCount++, center, Math.min(yh, top), center, top);
          segment(rising, risingCount++, center, bottom, center, Math.max(yl, bottom));
        } else {
          segment(falling, fallingCount++, center, yh, center, yl);
          const at = bodyCount++ * 4;
          bodies![at] = left;
          bodies![at + 1] = top;
          bodies![at + 2] = width;
          // A candle that barely moves still shows as a line.
          bodies![at + 3] = Math.max(1, bottom - top);
        }
      };
      if (merged) {
        this.#merge(s, start, end, frame, log, columns, draw);
      } else {
        for (let k = start; k < end; k++) {
          const row = rowOf(s, k);
          const at = s.x[row]!;
          if ((this.#categorical && at < 0) || breaks?.hides(at)) continue;
          const center = x.map(at);
          if (!reaches(center) || !candleOf(prices, row, log, candle)) continue;
          draw(center, width, candle[0]!, candle[1]!, candle[2]!, candle[3]!);
        }
      }
      // Bars wide enough to read a heavier line get one.
      const strokeWidth = ohlc && !merged && width >= 8 ? 2 : 1;
      out.push(
        {
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|rise`,
          stroke: rise,
          strokeWidth,
          coords: rising,
          count: risingCount,
        },
        {
          kind: "segments",
          draw: segmentDrawing,
          key: `${s.key}|fall`,
          stroke: fall,
          strokeWidth,
          coords: falling,
          count: fallingCount,
        },
      );
      if (bodies) {
        out.push({
          kind: "rect",
          draw: rectDrawing,
          key: `${s.key}|body`,
          fill: fall,
          fillOpacity: 1,
          rects: bodies,
          count: bodyCount,
        });
      }
    }
    return out;
  }

  /**
   * Merges the candles in view into one per pixel column of the plot, in any
   * row order: the open of the column's earliest candle and the close of its
   * latest (by x; equal x by row order), and its highest high and lowest low.
   */
  #merge(
    s: Series,
    start: number,
    end: number,
    frame: Frame,
    log: boolean,
    columns: number,
    draw: (center: number, width: number, o: number, h: number, l: number, c: number) => void,
  ): void {
    const { x, plot } = frame;
    const prices = this.#prices();
    const candle = this.#candle;
    // Per column: the rows of its first and last candle, and its low and high.
    const first = new Int32Array(columns).fill(-1);
    const last = new Int32Array(columns);
    const lows = new Float64Array(columns);
    const highs = new Float64Array(columns);
    for (let k = start; k < end; k++) {
      const row = rowOf(s, k);
      const at = s.x[row]!;
      if ((this.#categorical && at < 0) || x.breaks?.hides(at)) continue;
      const offset = x.map(at) - plot.x;
      // Only candles centered in the plot; the domain's end maps to its edge.
      if (!(offset >= 0 && offset <= plot.width)) continue;
      if (!candleOf(prices, row, log, candle)) continue;
      const column = Math.min(columns - 1, Math.floor(offset));
      const earliest = first[column]!;
      if (earliest < 0) {
        first[column] = row;
        last[column] = row;
        lows[column] = candle[2]!;
        highs[column] = candle[1]!;
        continue;
      }
      if (at < s.x[earliest]!) first[column] = row;
      if (at >= s.x[last[column]!]!) last[column] = row;
      if (candle[2]! < lows[column]!) lows[column] = candle[2]!;
      if (candle[1]! > highs[column]!) highs[column] = candle[1]!;
    }
    for (let column = 0; column < columns; column++) {
      const row = first[column]!;
      if (row < 0) continue;
      const open = prices.open[row]!;
      const close = prices.close[last[column]!]!;
      // The last column may be a fraction of a pixel wide.
      const left = plot.x + column;
      const right = Math.min(left + 1, plot.x + plot.width);
      draw((left + right) / 2, FILL * (right - left), open, highs[column]!, lows[column]!, close);
    }
  }

  /** Whether a row draws a candle: inspection skips rows that do not. */
  shows(_series: Series, row: number, y: PositionScale): boolean {
    return candleOf(this.#prices(), row, y.type === "log", this.#candle);
  }

  /** The candle's four prices, high and low widened as drawn. */
  pointText(_series: Series, row: number, format: AxisFormat): string {
    const candle = this.#candle;
    if (!candleOf(this.#prices(), row, false, candle)) return "";
    const [open, high, low, close] = Array.from(candle, format.y);
    return `open ${open}, high ${high}, low ${low}, close ${close}`;
  }

  /** Candles, their price range, and the latest candle, over a series' parts in every panel. */
  summarize(parts: readonly Series[], name: string, { format, log }: SummaryContext): string {
    const prices = this.#prices();
    const candle = this.#candle;
    let count = 0;
    let low = Infinity;
    let high = -Infinity;
    // The latest candle by x, then by row, as merged columns take their close.
    let latest = -1;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const part of parts) {
      for (let k = 0; k < part.length; k++) {
        const row = rowOf(part, k);
        const position = part.x[row]!;
        // As drawn: a placed x (a band on category axes) and a valid candle.
        if (this.#categorical ? position < 0 : !Number.isFinite(position)) continue;
        if (!candleOf(prices, row, log, candle)) continue;
        count++;
        low = Math.min(low, candle[2]!);
        high = Math.max(high, candle[1]!);
        const at = this.#categorical ? row : part.x[row]!;
        if (at > latestAt || (at === latestAt && row > latest)) {
          latest = row;
          latestAt = at;
        }
      }
    }
    const bars = this.spec.variant === "ohlc";
    const noun = (n: number) =>
      bars ? (n === 1 ? "OHLC bar" : "OHLC bars") : n === 1 ? "candle" : "candles";
    if (count === 0 || latest < 0) return `${name}: no ${noun(0)}`;
    const f = format.y;
    candleOf(prices, latest, log, candle);
    const [o, h, l, c] = candle;
    return `${name}: ${count} ${noun(count)}, prices from ${f(low)} to ${f(high)}; the last opened at ${f(o!)}, ranged from ${f(l!)} to ${f(h!)}, and closed at ${f(c!)}`;
  }

  #prices(): Prices {
    const { table, spec } = this;
    const read = (field: string) => table.numbers(field as never);
    return {
      open: read(spec.open),
      high: read(spec.high),
      low: read(spec.low),
      close: read(spec.close),
    };
  }
}

/**
 * Open-high-low-close candles at each `x`, as for prices.
 *
 * ```ts
 * candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close" })
 * ```
 */
export function candlestick<S extends Schema>(
  table: Table<S>,
  options: CandlestickOptions<S>,
): ChartMark<Frozen<CandlestickSpec>> {
  const spec: CandlestickSpec = {
    type: "candlestick",
    x: options.x,
    open: options.open,
    high: options.high,
    low: options.low,
    close: options.close,
    ...definedFields(options, ["variant", "rise", "fall", "label", "axis", "facet", "panel", "id"]),
  };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new CandlestickMark(spec, table as unknown as Table);
}
