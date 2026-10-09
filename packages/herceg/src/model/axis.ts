import {
  type Formatter,
  numberFormatter,
  numberTickLabels,
  timeFormatter,
  timeTickLabels,
} from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import type { Breaks } from "../lod/m4.ts";
import {
  BandScale,
  LinearScale,
  LogScale,
  niceDomain,
  niceLogDomain,
  type PositionScale,
} from "../scale/scale.ts";
import { type CalendarScale, niceTimeDomain, TimeScale } from "../scale/time.ts";
import type { Rect, SegmentGeometry } from "../scene/scene.ts";
import type { AxisSpec, XAxisSpec } from "../spec/spec.ts";

export type AxisType = "linear" | "log" | "time" | "band";

export interface AxisPlan {
  scale: PositionScale;
  ticks: number[];
  labels: string[];
  /** The domain ticks were chosen in (see `planAxis`); none for band axes. */
  within?: readonly [number, number];
  /**
   * What a continuous axis was planned with, and for how many ticks, so it
   * can be planned again over other domains (as values move between scenes).
   */
  context?: AxisContext;
  count?: number;
}

export interface AxisContext {
  type: AxisType;
  spec: AxisSpec | undefined;
  zone: TimeZone;
  locale: string | undefined;
  /** Time a time axis leaves out, resolved in `zone` (scale/breaks.ts). */
  breaks?: AxisBreaks | undefined;
}

/** A time axis' breaks as axes use them; implemented by scale/breaks.ts. */
export interface AxisBreaks extends Breaks {
  /** Decorative segments behind data, thinned on the final panel scale. */
  seams?(
    scale: PositionScale,
    plot: Rect,
    options: NonNullable<XAxisSpec["seams"]>,
    color: string,
  ): SegmentGeometry | undefined;
  /** A time scale over `domain` that leaves the breaks out. */
  scale(domain: readonly [number, number], range: readonly [number, number]): PositionScale;
  /** `domain` changed by `change` in positions (time shown), as room at its ends is. */
  inPositions(
    domain: [number, number],
    change: (positions: [number, number]) => [number, number],
  ): [number, number];
  /**
   * `domain`, or when it shows no time (it is inside a break), the hour
   * either side of the break's seam; refused when `configured`.
   */
  showing(domain: [number, number], configured: boolean): [number, number];
}

/** Widens empty or zero-width domains so a scale can be built. */
export function usableDomain(
  domain: readonly [number, number] | undefined,
  type: AxisType,
): [number, number] {
  if (!domain) return type === "log" ? [1, 10] : [0, 1];
  const [lo, hi] = domain;
  if (lo !== hi) return [lo, hi];
  if (type === "log") return [lo / 10, lo * 10];
  if (type === "time") return [lo - 3_600_000, lo + 3_600_000];
  const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
  return [lo - pad, lo + pad];
}

/**
 * Widens an automatic domain so glyphs reaching `inset` pixels past their
 * data position stay inside a plot `pixels` long. Applied after rounding to
 * nice values, so ticks stay round and the axis ends just past them. Log
 * domains widen in log space.
 */
export function insetDomain(
  domain: [number, number],
  inset: number,
  pixels: number,
  type: AxisType,
): [number, number] {
  // Tiny plots keep the data domain rather than shrinking the data to a point.
  if (!(inset > 0) || pixels <= 4 * inset) return domain;
  const log = type === "log";
  const lo = log ? Math.log10(domain[0]) : domain[0];
  const hi = log ? Math.log10(domain[1]) : domain[1];
  const pad = ((hi - lo) * inset) / (pixels - 2 * inset);
  const widened: [number, number] = log
    ? [10 ** (lo - pad), 10 ** (hi + pad)]
    : [lo - pad, hi + pad];
  // Domains near the limits of floating point keep their data ends.
  const usable = widened.every((v) => Number.isFinite(v) && (!log || v > 0));
  return usable ? widened : domain;
}

/**
 * Widens the ends of an automatic domain that lie away from zero (on log
 * axes, the high end) so marks drawing `pixels` past their data there, such
 * as bar labels, stay inside a plot `plotPixels` long. A zero end stays put,
 * so bars keep their baseline on the axis.
 */
export function headroomDomain(
  domain: [number, number],
  pixels: number,
  plotPixels: number,
  type: AxisType,
): [number, number] {
  if (!(pixels > 0)) return domain;
  const log = type === "log";
  const low = !log && domain[0] < 0;
  const high = log || domain[1] > 0;
  const sides = Number(low) + Number(high);
  if (sides === 0 || plotPixels <= 4 * sides * pixels) return domain;
  const lo = log ? Math.log10(domain[0]) : domain[0];
  const hi = log ? Math.log10(domain[1]) : domain[1];
  const pad = ((hi - lo) * pixels) / (plotPixels - sides * pixels);
  const ends: [number, number] = [low ? lo - pad : lo, high ? hi + pad : hi];
  const widened: [number, number] = log ? [10 ** ends[0], 10 ** ends[1]] : ends;
  return widened.every((v) => Number.isFinite(v) && (!log || v > 0)) ? widened : domain;
}

/** Applies the axis' nice option to a domain. */
export function niceAxisDomain(
  domain: [number, number],
  context: AxisContext,
  count: number,
  nice: boolean,
): [number, number] {
  if (!nice) return domain;
  if (context.type === "log") return niceLogDomain(domain[0], domain[1]);
  if (context.type === "time") {
    const breaks = context.breaks;
    // With breaks, the interval follows the time shown.
    const span = breaks && breaks.collapse(domain[1]) - breaks.collapse(domain[0]);
    return niceTimeDomain(domain[0], domain[1], count, context.zone, span);
  }
  return niceDomain(domain[0], domain[1], count);
}

export function createScale(
  context: AxisContext,
  domain: readonly [number, number],
  range: readonly [number, number],
): PositionScale {
  if (context.type === "log") return new LogScale(domain, range);
  if (context.type === "time" && context.breaks) return context.breaks.scale(domain, range);
  if (context.type === "time") return new TimeScale(domain, range, context.zone);
  return new LinearScale(domain, range);
}

/**
 * Ticks and labels for a scale over `domain`. Ticks are chosen in `within`
 * (part of the domain): a domain rounded to nice values and then widened
 * for glyphs keeps the nice values as its ticks, while choosing in the
 * widened domain could step past them (a span just over a threshold takes
 * a coarser step, and a short axis can keep only one tick).
 */
export function planAxis(
  context: AxisContext,
  domain: readonly [number, number],
  range: readonly [number, number],
  count: number,
  within: readonly [number, number] = domain,
): AxisPlan {
  const scale = createScale(context, domain, range);
  const ticker = within === domain ? scale : createScale(context, within, range);
  const ticks = ticker.ticks(count);
  const format = context.spec?.format;
  let labels: string[];
  if (format) {
    const formatter =
      context.type === "time"
        ? timeFormatter(format as Intl.DateTimeFormatOptions, context.zone, context.locale)
        : numberFormatter(format as Intl.NumberFormatOptions, context.locale);
    labels = ticks.map(formatter);
  } else if (ticker.type === "time") {
    const time = ticker as CalendarScale;
    const contexts = time.tickContexts?.(ticks);
    labels = timeTickLabels(ticks, time.interval(count), context.zone, context.locale, contexts);
  } else {
    labels = numberTickLabels(ticks, context.locale);
  }
  return { scale, ticks, labels, within, context, count };
}

/** `plan` for a panel `offset` pixels along: the same ticks and labels on a moved range. */
export function shiftPlan(plan: AxisPlan, context: AxisContext, offset: number): AxisPlan {
  if (offset === 0) return plan;
  const { scale } = plan;
  const range: [number, number] = [scale.range[0] + offset, scale.range[1] + offset];
  const moved =
    scale instanceof BandScale
      ? new BandScale(scale.categories, range, scale.padding)
      : createScale(context, scale.domain, range);
  return { ...plan, scale: moved };
}

/** Formatter for single values on this axis, as shown in tooltips. */
export function valueFormatter(context: AxisContext, fallback: Formatter): Formatter {
  const format = context.spec?.format;
  if (!format) return fallback;
  return context.type === "time"
    ? timeFormatter(format as Intl.DateTimeFormatOptions, context.zone, context.locale)
    : numberFormatter(format as Intl.NumberFormatOptions, context.locale);
}

/**
 * A band axis. Labels are thinned to every k-th band so neighbors do not
 * overlap: `size` is the room the largest label takes along the axis (for
 * horizontal labels their width, for vertical ones a line height).
 */
export function planBandAxis(
  categories: readonly string[],
  range: readonly [number, number],
  padding: number,
  size: number,
): AxisPlan {
  const scale = new BandScale(categories, range, padding);
  const every = Math.max(1, Math.ceil((size + 6) / Math.max(1e-9, Math.abs(scale.step))));
  const ticks: number[] = [];
  for (let i = 0; i < categories.length; i += every) ticks.push(i);
  return { scale, ticks, labels: ticks.map((i) => categories[i]!) };
}
