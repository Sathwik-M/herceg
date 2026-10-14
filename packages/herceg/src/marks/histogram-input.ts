// What a histogram spec may combine, checked before a mark is made: by the
// marks, and by spec validation (spec/validate.ts) without them.

/** Options of bars that 2D histograms, whose cells count pairs, have no use for. */
const BARS_ONLY = [
  "series",
  "stack",
  "dodge",
  "cumulative",
  "element",
  "commonNorm",
  "fill",
  "fillOpacity",
  "legendGroup",
] as const;

/** Options of 2D histograms' color scale. */
const CELLS_ONLY = ["colors", "colorDomain", "colorMidpoint"] as const;

const NORMALIZE = ["count", "frequency", "probability", "percent", "density"];

/**
 * Whether `bins` gives bins for each axis, `{ x, y }` (either or neither
 * left to its default), rather than one definition.
 */
export function perAxisBins(bins: unknown): bins is { x?: unknown; y?: unknown } {
  return (
    typeof bins === "object" &&
    bins !== null &&
    !Array.isArray(bins) &&
    !("step" in bins) &&
    ("x" in bins || "y" in bins || Object.keys(bins).length === 0)
  );
}

export function histogramFormError(spec: Record<string, unknown>): string | undefined {
  if (spec.x === undefined && spec.y === undefined) return "histogram: needs x, y, or both";
  if (spec.normalize !== undefined && !NORMALIZE.includes(spec.normalize as string))
    return `histogram normalize: expected "count", "frequency", "probability", "percent", or "density"; received ${JSON.stringify(spec.normalize)}`;
  const { bins } = spec;
  if (typeof bins === "object" && bins !== null && !Array.isArray(bins) && "step" in bins) {
    if ("x" in bins || "y" in bins)
      return "histogram bins: { step } bins both axes alike, { x, y } each; give one form";
  }
  if (spec.x !== undefined && spec.y !== undefined) {
    const bars = BARS_ONLY.find((name) => spec[name] !== undefined);
    if (bars === "series")
      return "histogram series: a 2D histogram of x and y counts one distribution; facet by the field instead";
    if (bars)
      return `histogram ${bars}: for bars of x or y; a 2D histogram of both takes none, so drop it`;
    if (spec.axis === "right")
      return 'histogram axis: a 2D histogram places cells, on no right axis; drop axis: "right"';
    if (typeof bins === "object" && bins !== null && !Array.isArray(bins) && !("step" in bins)) {
      const extra = Object.keys(bins).find((key) => key !== "x" && key !== "y");
      if (extra !== undefined)
        return `histogram bins.${extra}: bins of a 2D histogram are { x, y }; drop ${extra}`;
    }
    return undefined;
  }
  const cells = CELLS_ONLY.find((name) => spec[name] !== undefined);
  if (cells)
    return `histogram ${cells}: colors the cells of 2D histograms of x and y; bars take fill`;
  if (perAxisBins(bins))
    return `histogram bins: { x, y } bins both axes of a 2D histogram; give one bin definition for ${spec.x !== undefined ? "x" : "y"}`;
  if (spec.y !== undefined && spec.axis === "right")
    return 'histogram axis: horizontal histograms have no right axis; drop axis: "right"';
  for (const name of ["commonNorm", "cumulative", "dodge"] as const)
    if (spec[name] !== undefined && typeof spec[name] !== "boolean")
      return `histogram ${name}: expected true or false; received ${JSON.stringify(spec[name])}`;
  if (spec.stack !== undefined && typeof spec.stack !== "boolean" && spec.stack !== "fill")
    return `histogram stack: expected true, false, or "fill"; received ${JSON.stringify(spec.stack)}`;
  if (spec.stack && spec.dodge === true) return "histogram: dodge or stack, not both; drop one";
  if (spec.element !== undefined && !["bars", "step", "poly"].includes(spec.element as string))
    return `histogram element: expected "bars", "step", or "poly"; received ${JSON.stringify(spec.element)}`;
  if (spec.dodge === true && spec.element !== undefined && spec.element !== "bars")
    return `histogram dodge: places bars side by side in each bin; drop dodge, or draw element: "bars"`;
  return undefined;
}
