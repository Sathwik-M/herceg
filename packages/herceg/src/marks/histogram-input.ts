/** Most bins a histogram draws; explicit grids are refused rather than coarsened. */
export const MAX_BINS = 1000;

export function histogramFormError(spec: {
  x?: unknown;
  y?: unknown;
  axis?: unknown;
  stack?: unknown;
  dodge?: unknown;
  normalize?: unknown;
  commonNorm?: unknown;
  cumulative?: unknown;
}): string | undefined {
  if ((spec.x === undefined) === (spec.y === undefined))
    return "A histogram needs exactly one field: x or y";
  if (spec.y !== undefined && spec.axis === "right")
    return "A horizontal histogram cannot use the right axis";
  if (spec.stack === true && spec.dodge === true) return "A histogram cannot dodge and stack";
  for (const name of ["commonNorm", "cumulative", "dodge", "stack"] as const)
    if (spec[name] !== undefined && typeof spec[name] !== "boolean")
      return `Histogram ${name} must be a boolean`;
  if (
    spec.normalize !== undefined &&
    !["count", "probability", "percent", "density"].includes(spec.normalize as string)
  )
    return 'Histogram normalize must be "count", "probability", "percent", or "density"';
  return undefined;
}

/** Check supplied edges without changing their precision or their range. */
export function requireHistogramEdges(
  edges: readonly number[],
  path = "Histogram bin edges",
): void {
  if (edges.length < 2 || edges.length > MAX_BINS + 1)
    throw new RangeError(`${path} must contain at least 2 and at most ${MAX_BINS + 1} edges`);
  for (let i = 0; i < edges.length; i++) {
    if (!Number.isFinite(edges[i])) throw new RangeError(`${path}[${i}] must be a finite number`);
    if (i > 0 && !(edges[i]! > edges[i - 1]!))
      throw new RangeError(`${path} must be strictly increasing (edge ${i})`);
  }
}
