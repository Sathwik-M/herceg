// `color` on marks drawing series of summaries and observations (histograms,
// box plots, boxen plots, violins, error bars, rugs): as on lines, areas,
// and bars, a category field names the series, whose values color them,
// and a color is the mark's primary paint (a fill, or an error bar's or a
// rug's stroke).

import type { Table } from "../data/table.ts";
import { ChartError } from "../spec/errors.ts";
import { CATEGORY, requireField } from "./mark.ts";

interface Colored {
  readonly type: string;
  readonly color?: string | undefined;
  readonly series?: string | undefined;
  readonly fill?: string | undefined;
  readonly stroke?: string | undefined;
}

/**
 * `spec` with its `color` read: a field's as its `series` (another series
 * field is refused), a color's as its `paint` unless that is set. A name
 * that is neither a field nor a color, or both, is refused where the
 * browser can tell colors (CSS.supports).
 */
export function colored<T extends Colored>(spec: T, table: Table, paint: "fill" | "stroke"): T {
  const { color, type } = spec;
  if (color === undefined) return spec;
  const css = globalThis.CSS?.supports("color", color);
  const fail = (message: string) =>
    new ChartError({ code: "invalid-option", path: "color", message: `${type} color: ${message}` });
  if (table.has(color)) {
    if (css)
      throw fail(
        `"${color}" names both a field and a color; give series: "${color}", or ${paint}: "${color}"`,
      );
    requireField(table, color, CATEGORY, `${type} color`);
    if (spec.series !== undefined && spec.series !== color)
      throw fail(
        "colors the series, so it names their field; give series or color, or the same field for both",
      );
    return { ...spec, series: color };
  }
  if (css === false)
    throw fail(
      `"${color}" is neither a field nor a color; the table has ${table
        .fields()
        .map((f) => `"${f}"`)
        .join(", ")}, and colors are hex, rgb(), hsl(), var(), or CSS names`,
    );
  return spec[paint] === undefined ? { ...spec, [paint]: color } : spec;
}

/**
 * Refuses `color` on a mark that chooses its colors itself (`series`: by
 * series), as specs refuse it, for callers whose options have no types.
 */
export function refuseColor(options: object, type: string, series = false): void {
  if ((options as { color?: unknown }).color !== undefined)
    throw new ChartError({
      code: "invalid-option",
      path: "color",
      message: `${type} color: ${
        series
          ? "the mark colors by series; give series, the field naming them"
          : "the mark chooses its colors itself; remove it (fill or stroke, where it takes them, set one)"
      }`,
    });
}
