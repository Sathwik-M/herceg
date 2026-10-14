/** A boxen mark's options' problems, for untyped callers; undefined when there are none. */
export function boxenOptionError(spec: {
  depth?: unknown;
  outlierProportion?: unknown;
  trustAlpha?: unknown;
  widthMethod?: unknown;
  outliers?: unknown;
}): string | undefined {
  const { depth, outlierProportion, trustAlpha, widthMethod, outliers } = spec;
  if (
    depth !== undefined &&
    !["tukey", "proportion", "trustworthy", "full"].includes(depth as string) &&
    !(typeof depth === "number" && Number.isInteger(depth) && depth >= 1)
  )
    return `boxen depth: expected "tukey", "proportion", "trustworthy", "full", or a whole number of levels from 1; received ${JSON.stringify(depth)}`;
  for (const [name, value] of [
    ["outlierProportion", outlierProportion],
    ["trustAlpha", trustAlpha],
  ] as const)
    if (value !== undefined && !(typeof value === "number" && value > 0 && value < 1))
      return `boxen ${name}: expected a number between 0 and 1; received ${JSON.stringify(value)}`;
  if (
    widthMethod !== undefined &&
    !["exponential", "linear", "area"].includes(widthMethod as string)
  )
    return `boxen widthMethod: expected "exponential", "linear", or "area"; received ${JSON.stringify(widthMethod)}`;
  if (outliers !== undefined && typeof outliers !== "boolean")
    return `boxen outliers: expected true or false; received ${JSON.stringify(outliers)}`;
  return undefined;
}
