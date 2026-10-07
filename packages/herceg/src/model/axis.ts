import {
  type Formatter,
  numberFormatter,
  numberTickLabels,
  timeFormatter,
  timeTickLabels,
} from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import {
  type ContinuousScale,
  LinearScale,
  LogScale,
  niceDomain,
  niceLogDomain,
} from "../scale/scale.ts";
import { niceTimeDomain, TimeScale } from "../scale/time.ts";
import type { AxisSpec } from "../spec/spec.ts";

export type AxisType = "linear" | "log" | "time";

export interface AxisPlan {
  scale: ContinuousScale;
  ticks: number[];
  labels: string[];
}

export interface AxisContext {
  type: AxisType;
  spec: AxisSpec | undefined;
  zone: TimeZone;
  locale: string | undefined;
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

/** Applies the axis' nice option to a domain. */
export function niceAxisDomain(
  domain: [number, number],
  context: AxisContext,
  count: number,
  nice: boolean,
): [number, number] {
  if (!nice) return domain;
  if (context.type === "log") return niceLogDomain(domain[0], domain[1]);
  if (context.type === "time") return niceTimeDomain(domain[0], domain[1], count, context.zone);
  return niceDomain(domain[0], domain[1], count);
}

export function createScale(
  context: AxisContext,
  domain: readonly [number, number],
  range: readonly [number, number],
): ContinuousScale {
  if (context.type === "log") return new LogScale(domain, range);
  if (context.type === "time") return new TimeScale(domain, range, context.zone);
  return new LinearScale(domain, range);
}

export function planAxis(
  context: AxisContext,
  domain: readonly [number, number],
  range: readonly [number, number],
  count: number,
): AxisPlan {
  const scale = createScale(context, domain, range);
  const ticks = scale.ticks(count);
  const format = context.spec?.format;
  let labels: string[];
  if (format) {
    const formatter =
      context.type === "time"
        ? timeFormatter(format as Intl.DateTimeFormatOptions, context.zone, context.locale)
        : numberFormatter(format as Intl.NumberFormatOptions, context.locale);
    labels = ticks.map(formatter);
  } else if (scale instanceof TimeScale) {
    labels = timeTickLabels(ticks, scale.interval(count), context.zone, context.locale);
  } else {
    labels = numberTickLabels(ticks, context.locale);
  }
  return { scale, ticks, labels };
}

/** Formatter for single values on this axis, as shown in tooltips. */
export function valueFormatter(context: AxisContext, fallback: Formatter): Formatter {
  const format = context.spec?.format;
  if (!format) return fallback;
  return context.type === "time"
    ? timeFormatter(format as Intl.DateTimeFormatOptions, context.zone, context.locale)
    : numberFormatter(format as Intl.NumberFormatOptions, context.locale);
}
