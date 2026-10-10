/** A box plot's mutually exclusive raw and precomputed forms, checked for untyped callers. */
export function boxPlotFormError(spec: {
  x?: unknown;
  y?: unknown;
  low?: unknown;
  q1?: unknown;
  median?: unknown;
  q3?: unknown;
  high?: unknown;
  count?: unknown;
  whiskers?: unknown;
  notch?: unknown;
}): string | undefined {
  const statistics = ["low", "q1", "median", "q3", "high"] as const;
  const provided = statistics.filter((name) => spec[name] !== undefined);
  const precomputed = provided.length > 0 || spec.count !== undefined;
  if (precomputed) {
    if (spec.x !== undefined && spec.y !== undefined)
      return `boxplot: raw x and y, or precomputed ${[...provided, ...(spec.count !== undefined ? ["count"] : [])].join(", ")}, not both; drop one`;
    if (spec.x === undefined && spec.y === undefined)
      return "boxplot: precomputed statistics need one category field, x or y";
    const missing = statistics.filter((name) => spec[name] === undefined);
    if (missing.length) return `boxplot: precomputed statistics need ${missing.join(", ")}`;
    if (spec.whiskers !== undefined)
      return "boxplot whiskers: low and high give precomputed whisker ends; drop whiskers";
    if (spec.notch === true && spec.count === undefined)
      return "boxplot notch: precomputed statistics need count for a notch";
  } else if (spec.x === undefined || spec.y === undefined) {
    return "boxplot: needs x and y, or precomputed statistics";
  }
  const whiskers = spec.whiskers;
  if (
    whiskers !== undefined &&
    whiskers !== "tukey" &&
    whiskers !== "range" &&
    !(typeof whiskers === "number" && Number.isFinite(whiskers) && whiskers >= 0)
  )
    return `boxplot whiskers: expected "tukey", "range", or a finite nonnegative IQR multiple; received ${typeof whiskers === "number" ? whiskers : JSON.stringify(whiskers)}`;
  if (spec.notch !== undefined && typeof spec.notch !== "boolean")
    return `boxplot notch: expected true or false; received ${JSON.stringify(spec.notch)}`;
  return undefined;
}
