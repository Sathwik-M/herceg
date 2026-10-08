// Deterministic benchmark datasets. Every library receives the same values;
// adapters convert them into the input format each library documents.

/** Series sharing one x column (timestamps in epoch milliseconds). */
export interface SeriesData {
  x: Float64Array;
  ys: Float64Array[];
  names: string[];
}

/** Independent x/y points for scatter plots. */
export interface PointData {
  x: Float64Array;
  y: Float64Array;
}

/** Points with a size and a color value each, for bubble charts. */
export interface BubbleData extends PointData {
  size: Float64Array;
  value: Float64Array;
}

/** Category axis with one value column per series, for bar charts. */
export interface CategoryData {
  categories: string[];
  series: { name: string; values: Float64Array }[];
}

/** Dense row-major grid for heatmaps. */
export interface GridData {
  columns: number;
  rows: number;
  values: Float64Array;
}

/** Open, high, low, and close prices at regular times, for candlesticks. */
export interface CandleData {
  x: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
}

/** Values to bin, for histograms. */
export interface SampleData {
  values: Float64Array;
}

export const START_TIME = Date.UTC(2026, 0, 1);
export const STEP_MS = 1000;

/** mulberry32: small, fast, and good enough for synthetic data. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  const u = 1 - next();
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Random-walk time series with regular 1 s spacing. */
export function timeSeries(seriesCount: number, points: number, seed = 1): SeriesData {
  const x = new Float64Array(points);
  for (let i = 0; i < points; i++) x[i] = START_TIME + i * STEP_MS;
  const ys: Float64Array[] = [];
  const names: string[] = [];
  for (let s = 0; s < seriesCount; s++) {
    const next = random(seed * 7919 + s);
    const y = new Float64Array(points);
    let value = 100 + s * 20;
    for (let i = 0; i < points; i++) {
      value += gaussian(next) * 2;
      y[i] = value;
    }
    ys.push(y);
    names.push(`series ${s + 1}`);
  }
  return { x, ys, names };
}

/** Continues a time series: the values that follow `data` for `count` steps. */
export function continueSeries(
  data: SeriesData,
  count: number,
  tick: number,
): { x: Float64Array; ys: Float64Array[] } {
  const last = data.x.length - 1;
  const x = new Float64Array(count);
  for (let i = 0; i < count; i++) x[i] = data.x[last]! + (tick * count + i + 1) * STEP_MS;
  const ys = data.ys.map((series, s) => {
    const next = random(tick * 104729 + s);
    const out = new Float64Array(count);
    let value = series[last]!;
    for (let i = 0; i < count; i++) {
      value += gaussian(next) * 2;
      out[i] = value;
    }
    return out;
  });
  return { x, ys };
}

/** Gaussian clusters. */
export function scatterPoints(count: number, seed = 1): PointData {
  const next = random(seed);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const centers = [
    [20, 30],
    [60, 70],
    [75, 25],
    [40, 55],
  ] as const;
  for (let i = 0; i < count; i++) {
    const center = centers[i % centers.length]!;
    x[i] = center[0] + gaussian(next) * 8;
    y[i] = center[1] + gaussian(next) * 8;
  }
  return { x, y };
}

/**
 * Gaussian clusters with sizes from 1 to 100 and color values from -50 to
 * 50, in ascending order of value: every library draws bubbles in data order
 * (Herceg in order of color, high values last), so overlaps look the same.
 */
export function bubbles(count: number, seed = 1): BubbleData {
  const next = random(seed * 31 + 7);
  const points = scatterPoints(count, seed);
  const rows = Array.from({ length: count }, (_, i) => ({
    x: points.x[i]!,
    y: points.y[i]!,
    size: 1 + next() * 99,
    value: next() * 100 - 50,
  })).sort((a, b) => a.value - b.value);
  return {
    x: Float64Array.from(rows, (row) => row.x),
    y: Float64Array.from(rows, (row) => row.y),
    size: Float64Array.from(rows, (row) => row.size),
    value: Float64Array.from(rows, (row) => row.value),
  };
}

/**
 * The bubble encoding every library is given: radii from 2 to 12 pixels with
 * area growing linearly from size 0 to the largest size, and colors from the
 * first ramp color at the least value to the second at the greatest.
 */
export const BUBBLE = { minRadius: 2, maxRadius: 12, colors: ["#f7fbff", "#08306b"] } as const;

/** Radius in pixels of a size, for libraries that take radii per point. */
export function bubbleRadius(size: number, maxSize: number): number {
  const { minRadius: r0, maxRadius: r1 } = BUBBLE;
  return Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * (size / maxSize));
}

/** CSS color of a value, for libraries that take colors per point. */
export function bubbleColor(value: number, min: number, max: number): string {
  const t = max > min ? (value - min) / (max - min) : 1;
  const [a, b] = BUBBLE.colors.map((hex) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)),
  );
  const rgb = a!.map((channel, i) => Math.round(channel + (b![i]! - channel) * t));
  return `rgb(${rgb.join(",")})`;
}

export function categories(categoryCount: number, seriesCount: number, seed = 1): CategoryData {
  const next = random(seed);
  const names = Array.from({ length: categoryCount }, (_, i) => `C${i + 1}`);
  const series = Array.from({ length: seriesCount }, (_, s) => {
    const values = new Float64Array(categoryCount);
    for (let i = 0; i < categoryCount; i++) values[i] = Math.round(10 + next() * 90);
    return { name: `series ${s + 1}`, values };
  });
  return { categories: names, series };
}

export function grid(columns: number, rows: number, seed = 1): GridData {
  const next = random(seed);
  const values = new Float64Array(columns * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const wave = Math.sin(c / 9) * Math.cos(r / 7);
      values[r * columns + c] = wave * 50 + next() * 10;
    }
  }
  return { columns, rows, values };
}

/** A random-walk price with one candle per minute. */
export function candles(points: number, seed = 1): CandleData {
  const next = random(seed);
  const x = new Float64Array(points);
  const open = new Float64Array(points);
  const high = new Float64Array(points);
  const low = new Float64Array(points);
  const close = new Float64Array(points);
  let price = 100;
  for (let i = 0; i < points; i++) {
    x[i] = START_TIME + i * 60 * STEP_MS;
    open[i] = price;
    price = Math.max(1, price + gaussian(next));
    close[i] = price;
    high[i] = Math.max(open[i]!, price) + next() * 0.8;
    low[i] = Math.min(open[i]!, price) - next() * 0.8;
  }
  return { x, open, high, low, close };
}

/** Normally distributed values around 100, for histograms. */
export function samples(points: number, seed = 1): SampleData {
  const next = random(seed);
  const values = new Float64Array(points);
  for (let i = 0; i < points; i++) values[i] = 100 + gaussian(next) * 15;
  return { values };
}

/** Bytes of numeric payload, used to report memory amplification. */
export function seriesBytes(data: SeriesData): number {
  return data.x.byteLength + data.ys.reduce((sum, y) => sum + y.byteLength, 0);
}
