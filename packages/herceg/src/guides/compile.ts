// The guide compiler: plans what only charts asking for it need (see
// model/guides.ts). It plans the ticks and formats of axes whose settings
// ask for more than a count and Intl options, the axes `guides` lists, and
// legends and colorbars. A live chart loads it before drawing such a
// configuration; static output imports it.

import type { AxisContext } from "../model/axis.ts";
import type { CompiledGuides, GuideCompiler, GuideKit } from "../model/guides.ts";
import type { ChartConfig } from "../model/model.ts";
import type { ScaleName } from "../model/scales.ts";
import { compiledAxes, listedAxes } from "./axes.ts";
import { compiledLegends, plannedLegends } from "./legends.ts";
import type { Format } from "./options.ts";
import { countOf, tickPlanner, writer } from "./ticks.ts";

/** The compiler, with the chart's code it uses (see `GuideKit`). */
export function guideCompiler(kit: GuideKit): GuideCompiler {
  return { compile: (config) => compile(kit, config) };
}

const SCALES: readonly ScaleName[] = ["x", "y", "yRight"];

function compile(kit: GuideKit, config: ChartConfig): CompiledGuides {
  // Where each setting that may need planning is, for messages: the same
  // value shows through a panel's axis, merged over the chart's.
  const paths = new WeakMap<object, string>();
  const note = (axis: object | undefined, path: string) => {
    for (const key of ["ticks", "format", "tooltipFormat"] as const) {
      const value = (axis as Record<string, unknown> | undefined)?.[key];
      if (typeof value === "object" || typeof value === "function")
        paths.set(value as object, `${path}.${key}`);
    }
  };
  for (const scale of SCALES) note(config[scale], scale);
  config.panels?.list.forEach((panel, i) => {
    for (const scale of SCALES) note(panel[scale], `panels[${i}].${scale}`);
  });
  // The model merged `scales` into the short forms; their settings are named where they are set.
  const { scales } = config;
  // Other scales are categories' (the feature compiler's).
  for (const [name, scale] of Object.entries(scales ?? {}))
    if (
      !SCALES.includes(name as ScaleName) &&
      (scale as { type?: string } | undefined)?.type !== "ordinal"
    )
      throw new Error(
        `chart scales.${name}: marks place values on x, y, and yRight; name one of those, or give type: "ordinal" for a scale of categories`,
      );
  for (const scale of SCALES) note(scales?.[scale], `scales.${scale}`);
  let read = config;
  // Listed axes: each scale's on its default side read as its short form.
  config.guides?.forEach((guide, i) => {
    note(guide, `guides[${i}]`);
  });
  const listed = listedAxes(read);
  if (listed) read = { ...read, ...listed.read };
  // The duplicates policy of the axis whose ticks the model plans for the
  // scale: an axis moved off the default side leaves out repeats, as its
  // other layers do, unless it says otherwise.
  const repeats = (scale: ScaleName) => {
    const axis = listed?.axes.find((one) => one.scale === scale && one.layers[0]!.planned);
    const labels = axis?.layers[0]?.labels;
    return labels ? (labels.duplicates ?? (axis.home ? undefined : "hide")) : undefined;
  };
  const legends = plannedLegends(read);
  return {
    axes: listed && compiledAxes(kit, listed.axes),
    legends: legends && compiledLegends(kit, legends),
    config: read,
    context(context: AxisContext, scale: ScaleName): AxisContext {
      const spec = context.spec;
      if (!spec) return context;
      const { ticks, format, tooltipFormat } = spec;
      // The model reads a count of ticks; the compiler plans the other forms.
      const count = countOf(ticks);
      const plannedTicks = ticks !== undefined && count === undefined;
      const plannedFormat = planned(format);
      const plannedValue = planned(tooltipFormat) || (tooltipFormat === undefined && plannedFormat);
      // A duplicates policy of its own has the compiler write the axis' labels too.
      const policy = context.type !== "band" && repeats(scale) !== undefined;
      if (!plannedTicks && !plannedFormat && !plannedValue && !policy && ticks === count)
        return context;
      const at = (value: unknown, fallback: string) =>
        `chart ${paths.get(value as object) ?? `${scale}.${fallback}`}`;
      // Category axes label every category that fits, and write them as they are.
      if (context.type === "band" && (plannedTicks || plannedFormat))
        throw new Error(
          plannedTicks
            ? `${at(ticks, "ticks")}: a category axis labels the categories that fit; drop ticks, or give a count`
            : `${at(format, "format")}: a category axis writes its categories as they are; drop format`,
        );
      const plan =
        plannedTicks || plannedFormat || policy
          ? tickPlanner(
              kit,
              ticks,
              format,
              context,
              scale,
              { ticks: at(ticks, "ticks"), format: at(format, "format") },
              repeats(scale),
            )
          : undefined;
      const shown = tooltipFormat ?? format;
      const formatValue = plannedValue
        ? writer(kit, shown, context, scale, at(shown, tooltipFormat ? "tooltipFormat" : "format"))
            ?.value
        : undefined;
      const { ticks: _, ...rest } = spec;
      return {
        ...context,
        spec: count === undefined ? rest : { ...rest, ticks: count },
        plan,
        formatValue,
      };
    },
  };
}

/** A format only the compiler writes: a pattern or a function. */
function planned(format: Format | undefined): boolean {
  return typeof format === "function" || (!!format && ("number" in format || "time" in format));
}
