import type { CandleData, CategoryData, GridData, PointData, SeriesData } from "../datasets.ts";

export interface ChartOptions {
  width: number;
  height: number;
  /** Enable the library's hover tooltip or crosshair. */
  tooltip: boolean;
  /**
   * Use the configuration the library documents for large data (decimation,
   * WebGL traces, Canvas renderer, ...). Each adapter comments what it changes.
   */
  large: boolean;
  /** Configure the library's zoom interaction (zoom scenarios only). */
  zoom: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface ChartHandle<T> {
  /** Replace the complete dataset with one of the same shape. */
  setData(data: T): void | Promise<void>;
  /**
   * While the library is still rendering the latest change over several
   * frames, returns a promise that resolves when it finishes; otherwise
   * undefined. Only progressive renderers implement it.
   */
  rendered?(): Promise<void> | undefined;
  /**
   * Client (viewport) coordinates of a data point, used to aim pointer moves
   * at real data. `series` and `index` identify the point; `x` and `y` are its
   * values.
   */
  pixelOf(series: number, index: number, x: number, y: number): Point;
  resize(width: number, height: number): void | Promise<void>;
  destroy(): void;
  /**
   * Append points to every series and keep only the newest `keep` points,
   * using the update path the library documents for live data. Line charts
   * only; omitted when the library has no such path.
   */
  append?(x: Float64Array, ys: Float64Array[], keep: number): void | Promise<void>;
  /**
   * Show only x values in [x0, x1], through the library's documented zoom or
   * axis-range path. Line charts only; omitted when the library has none.
   */
  setViewport?(x0: number, x1: number): void | Promise<void>;
}

export interface ChartKind<T> {
  /**
   * Converts benchmark data into the library's input format. Adapters call it
   * inside `create` and `setData`, so conversion is part of every timed
   * operation; the harness also times it alone as a diagnostic.
   */
  prepare(data: T, options: ChartOptions): unknown;
  create(
    container: HTMLElement,
    data: T,
    options: ChartOptions,
  ): ChartHandle<T> | Promise<ChartHandle<T>>;
}

export interface Adapter {
  id: string;
  /** Renderer used by the normal and large configurations. */
  renderer: { normal: string; large: string };
  line?: ChartKind<SeriesData>;
  area?: ChartKind<SeriesData>;
  bar?: ChartKind<CategoryData>;
  scatter?: ChartKind<PointData>;
  heatmap?: ChartKind<GridData>;
  candlestick?: ChartKind<CandleData>;
}

/** Candlestick colors: rising (hollow) and falling (filled) candles. */
export const RISE = "#1baf7a";
export const FALL = "#e34948";

export const PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#4f46e5",
  "#ca8a04",
  "#0d9488",
  "#c026d3",
  "#e11d48",
  "#2dd4bf",
  "#78716c",
];

export function color(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

/** Shifts and pushes into plain arrays, the way most libraries expect rolling data. */
export function rollArray<T>(target: T[], values: ArrayLike<T>, keep: number): void {
  for (let i = 0; i < values.length; i++) target.push(values[i]!);
  if (target.length > keep) target.splice(0, target.length - keep);
}

/** Offsets element-relative coordinates by the element's position in the viewport. */
export function clientPoint(element: Element, x: number, y: number): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + x, y: rect.top + y };
}
