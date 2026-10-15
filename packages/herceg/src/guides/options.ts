// Guides as TypeScript takes them: the portable guide types (spec/guides.ts)
// where ticks and formats may also be functions, which run in the browser
// and in static output but cannot be in a spec. `axis`, `legend`, and
// `colorbar` make the plain objects `guides` holds; writing the objects
// with their `type` is the same.

import type {
  AxisGuideSpec,
  AxisSpec,
  ChartAxisSpec,
  ColorbarSpec,
  FormatSpec,
  LegendGuideSpec,
  OrdinalScaleSpec,
  PanelSpec,
  ScaleSpec,
  TickLayerSpec,
  TicksSpec,
  XAxisSpec,
} from "../spec/spec.ts";

/** What a tick generator is told about the axis it chooses ticks for. */
export interface TickContext {
  /** The scale: "x", "y", or "yRight". */
  readonly scale: string;
  readonly type: "linear" | "log" | "time";
  /** The part of the domain ticks are chosen in, ascending: numbers, or epoch milliseconds. */
  readonly domain: readonly [number, number];
  /** The axis' length in pixels. */
  readonly pixels: number;
  /** How many ticks the axis would choose by itself. */
  readonly count: number;
  readonly timeZone: string;
  readonly locale: string | undefined;
}

/**
 * Chooses an axis' ticks (JavaScript only): values inside the domain, epoch
 * milliseconds or Dates on time axes. Called as the axis is planned, never
 * on pointer movement.
 */
export type TickGenerator = (context: TickContext) => readonly (number | Date)[];

/** What a formatter is told about the value it writes. */
export interface FormatContext {
  /** A tick's label, or one value (in a tooltip, the keyboard's announcements, a crosshair label). */
  readonly kind: "tick" | "value";
  readonly scale: string;
  readonly type: "linear" | "log" | "time";
  readonly timeZone: string;
  readonly locale: string | undefined;
  /** For a tick: its place among the layer's ticks, and their values. */
  readonly index?: number | undefined;
  readonly values?: readonly number[] | undefined;
}

/**
 * Writes a value (JavaScript only): a number, or epoch milliseconds on time
 * axes. "" leaves a tick unlabeled.
 */
export type ValueFormatter = (value: number, context: FormatContext) => string;

/** Which ticks an axis draws (see `TicksSpec`), or a function choosing them. */
export type Ticks =
  | Exclude<TicksSpec, { values: unknown }>
  | { values: readonly (number | string | Date)[] }
  | TickGenerator;

/** How values are written (see `FormatSpec`), or a function writing them. */
export type Format = FormatSpec | ValueFormatter;

/** Ticks and formats that may be functions. */
interface Functions {
  ticks?: Ticks;
  format?: Format;
  tooltipFormat?: Format;
}

/** A panel's axis settings, or a 3D chart's. */
export type AxisOptions = Omit<AxisSpec, keyof Functions> & Functions;
/** The chart's `y` or `yRight`: a scale with its axis. */
export type ChartAxisOptions = Omit<ChartAxisSpec, keyof Functions> & Functions;
/** The chart's `x`, without its breaks (built with `timeBreaks`). */
export type XAxisOptions = Omit<XAxisSpec, keyof Functions | "breaks"> & Functions;
/** A position scale's settings in the chart's `scales`. */
export type ScaleOptions = Omit<ScaleSpec, "tooltipFormat"> & Pick<Functions, "tooltipFormat">;

/** One of `panels`, with axes whose ticks and formats may be functions. */
export type PanelOptions = Omit<PanelSpec, "x" | "y" | "yRight"> & {
  x?: AxisOptions;
  y?: AxisOptions;
  yRight?: AxisOptions;
};

/** A layer of an axis' ticks. */
export type TickLayerOptions = Omit<TickLayerSpec, "ticks" | "format"> &
  Pick<Functions, "ticks" | "format">;
/** An axis guide. */
export type AxisGuideOptions = Omit<AxisGuideSpec, "ticks" | "format" | "layers"> &
  Pick<Functions, "ticks" | "format"> & { layers?: readonly TickLayerOptions[] };
/** A colorbar guide. */
export type ColorbarOptions = Omit<ColorbarSpec, "ticks" | "format" | "layers"> &
  Pick<Functions, "ticks" | "format"> & { layers?: readonly TickLayerOptions[] };
/** A legend guide. */
export type LegendGuideOptions = LegendGuideSpec;
/** A guide in the chart's `guides`. */
export type GuideOptions = AxisGuideOptions | LegendGuideOptions | ColorbarOptions;

/**
 * The chart's scales by name: its position scales, over the short forms'
 * settings, and scales of categories (see `OrdinalScaleSpec`).
 */
export interface Scales {
  x?: ScaleOptions;
  y?: ScaleOptions;
  yRight?: ScaleOptions;
  readonly [name: string]: ScaleOptions | OrdinalScaleSpec | undefined;
}

/**
 * An axis showing scale `scale` ("x", "y", or "yRight") along a side of the
 * plots: `{ type: "axis", ...options }`.
 */
export function axis(options: Omit<AxisGuideOptions, "type">): AxisGuideOptions {
  return { type: "axis", ...options };
}

/** A legend of the scales it names, or of all the chart's: `{ type: "legend", ...options }`. */
export function legend(options: Omit<LegendGuideOptions, "type"> = {}): LegendGuideOptions {
  return { type: "legend", ...options };
}

/** A colorbar of a continuous color scale: `{ type: "colorbar", ...options }`. */
export function colorbar(options: Omit<ColorbarOptions, "type"> = {}): ColorbarOptions {
  return { type: "colorbar", ...options };
}
