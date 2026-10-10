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
      return `A box plot cannot take both raw x/y values and precomputed statistics (${[...provided, ...(spec.count !== undefined ? ["count"] : [])].join(", ")})`;
    if (spec.x === undefined && spec.y === undefined)
      return "A precomputed box plot needs exactly one category field: x or y";
    const missing = statistics.filter((name) => spec[name] === undefined);
    if (missing.length) return `A precomputed box plot needs ${missing.join(", ")}`;
    if (spec.whiskers !== undefined)
      return "A precomputed box plot cannot take whiskers: low and high already give its whisker ends";
    if (spec.notch === true && spec.count === undefined)
      return "A precomputed box plot with notch needs count";
  } else if (spec.x === undefined || spec.y === undefined) {
    return "A raw box plot needs x and y";
  }
  const whiskers = spec.whiskers;
  if (
    whiskers !== undefined &&
    whiskers !== "tukey" &&
    whiskers !== "range" &&
    !(typeof whiskers === "number" && Number.isFinite(whiskers) && whiskers >= 0)
  )
    return 'Box plot whiskers must be "tukey", "range", or a finite nonnegative IQR multiple';
  if (spec.notch !== undefined && typeof spec.notch !== "boolean")
    return "Box plot notch must be a boolean";
  return undefined;
}
