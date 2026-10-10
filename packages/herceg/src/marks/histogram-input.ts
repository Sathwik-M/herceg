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
  element?: unknown;
}): string | undefined {
  if ((spec.x === undefined) === (spec.y === undefined))
    return "histogram: needs exactly one of x and y";
  if (spec.y !== undefined && spec.axis === "right")
    return 'histogram axis: horizontal histograms have no right axis; drop axis: "right"';
  for (const name of ["commonNorm", "cumulative", "dodge"] as const)
    if (spec[name] !== undefined && typeof spec[name] !== "boolean")
      return `histogram ${name}: expected true or false; received ${JSON.stringify(spec[name])}`;
  if (spec.stack !== undefined && typeof spec.stack !== "boolean" && spec.stack !== "fill")
    return `histogram stack: expected true, false, or "fill"; received ${JSON.stringify(spec.stack)}`;
  if (spec.stack && spec.dodge === true) return "histogram: dodge or stack, not both; drop one";
  if (
    spec.normalize !== undefined &&
    !["count", "frequency", "probability", "percent", "density"].includes(spec.normalize as string)
  )
    return `histogram normalize: expected "count", "frequency", "probability", "percent", or "density"; received ${JSON.stringify(spec.normalize)}`;
  if (spec.element !== undefined && !["bars", "step", "poly"].includes(spec.element as string))
    return `histogram element: expected "bars", "step", or "poly"; received ${JSON.stringify(spec.element)}`;
  if (spec.dodge === true && spec.element !== undefined && spec.element !== "bars")
    return `histogram dodge: places bars side by side in each bin; drop dodge, or draw element: "bars"`;
  return undefined;
}

/** Check supplied edges without changing their precision or their range. */
export function requireHistogramEdges(edges: readonly number[], path = "histogram bins"): void {
  if (edges.length < 2 || edges.length > MAX_BINS + 1)
    throw new RangeError(`${path}: expected 2 to ${MAX_BINS + 1} edges; received ${edges.length}`);
  for (let i = 0; i < edges.length; i++) {
    if (!Number.isFinite(edges[i]))
      throw new RangeError(`${path}[${i}]: expected a finite number; received ${edges[i]}`);
    if (i > 0 && !(edges[i]! > edges[i - 1]!))
      throw new RangeError(
        `${path}[${i}]: expected a number above ${edges[i - 1]}, the edge before; received ${edges[i]}`,
      );
  }
}
