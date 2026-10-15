// Scale identity. A chart's position scales are named: the short forms `x`,
// `y`, and `yRight` define the scales "x", "y", and "yRight" and their axes.
// A scale's `scope` says which panels share one instance of it, with one
// domain (each panel keeps its own pixel range). An instance's type comes
// from the marks its own panels draw on it, found after marks are assigned
// to panels, so one subplot can put categories on its y axis while another
// puts numbers on its own.

import type { ChartAxisOptions } from "../guides/options.ts";
import type { Mark } from "../marks/mark.ts";
import type { AxisSpec, ScaleScope } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";

/** The position scales the short forms define: x, the left y, and the right y. */
export type ScaleName = "x" | "y" | "yRight";

/** Each position scale's scope. */
export type Scopes = Readonly<Record<ScaleName, ScaleScope>>;

/** The scales' settings a chart's scopes are read from. */
export interface ScaledConfig {
  readonly x?: ChartAxisOptions | undefined;
  readonly y?: ChartAxisOptions | undefined;
  readonly yRight?: ChartAxisOptions | undefined;
}

/**
 * The scope of each position scale: its own, or by default the whole chart
 * for x, `yDefault` for y (each panel of subplots, the whole chart in
 * facets), and y's for yRight.
 */
export function scopesOf(config: ScaledConfig, yDefault: ScaleScope): Scopes {
  const y = config.y?.scope ?? yDefault;
  return { x: config.x?.scope ?? "chart", y, yRight: config.yRight?.scope ?? y };
}

/** Which scale an instance is of, and in subplots, how numbers placed with another's categories are refused. */
export interface InstanceOf {
  scale: ScaleName;
  /** The error for `numbers` on an instance where `categories` places categories (see `mixedPanels`). */
  mixed?: ((numbers: Mark, categories: Mark) => Error) | undefined;
}

/**
 * The type of one instance of a scale, from the marks its panels draw on it
 * and its `declared` type: a band scale when they place categories along it
 * (then every mark placing a field there must), otherwise the declared
 * type, else time when one places times, else linear.
 */
export function instanceType(
  marks: readonly Mark[],
  declared: AxisSpec["type"],
  where: InstanceOf,
): AxisType {
  const { scale } = where;
  const channel = scale === "x" ? "x" : "y";
  const kinds = marks.map((mark) => mark.channelKind(channel));
  const banding = kinds.indexOf("category");
  if (banding >= 0) {
    if (scale === "yRight") throw new Error('axis: "right" takes no category y values');
    // Every mark with a field on this channel must band it.
    const index = kinds.findIndex((kind) => kind !== undefined && kind !== "category");
    if (index >= 0) {
      const numbers = marks[index]!;
      throw (
        where.mixed?.(numbers, marks[banding]!) ??
        new Error(`${numbers.spec.type} ${channel}: numbers cannot share a category axis`)
      );
    }
    if (declared)
      throw new Error(`chart ${scale}.type: the axis shows categories; drop "${declared}"`);
    return "band";
  }
  if (declared) return declared;
  return kinds.includes("time") ? "time" : "linear";
}

/**
 * In subplots, the error for numbers placed on a scale instance another
 * mark places categories on: when the two draw in different panels
 * (`panelOf` says which; undefined for every panel), scales of their own
 * would part them.
 */
export function mixedPanels(
  numbers: Mark,
  categories: Mark,
  scale: ScaleName,
  panelOf: (mark: Mark) => string | undefined,
): Error {
  const channel = scale === "x" ? "x" : "y";
  const [here, there] = [panelOf(numbers), panelOf(categories)];
  return new Error(
    here === undefined || there === undefined || here === there
      ? `${numbers.spec.type} ${channel}: numbers cannot share a category axis`
      : `${numbers.spec.type} ${channel}: numbers in panel "${here}" cannot share scale "${scale}" with the categories of the ${categories.spec.type} in panel "${there}"; give ${scale} scope "panel"`,
  );
}
