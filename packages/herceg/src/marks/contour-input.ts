// How a contour spec's options go together, checked by the contour mark
// and by spec validation (spec/validate.ts) without loading the mark.

/** Most thresholds; more would trace a pass of the grid each. */
const MAX_THRESHOLDS = 1000;

/**
 * Why a contour spec's options do not go together, if they do not: a
 * count of thresholds out of range, too few or too many of them for its
 * variant, or styles of the other variant.
 */
export function contourFormError(spec: Record<string, unknown>): string | undefined {
  const bands = spec.variant === "bands";
  const { thresholds } = spec;
  if (
    typeof thresholds === "number" &&
    !(Number.isInteger(thresholds) && thresholds >= 1 && thresholds <= MAX_THRESHOLDS)
  )
    return `contour thresholds: expected a whole number from 1 to ${MAX_THRESHOLDS}, or values; received ${thresholds}`;
  const least = bands ? 2 : 1;
  if (
    Array.isArray(thresholds) &&
    (thresholds.length < least || thresholds.length > MAX_THRESHOLDS)
  )
    return `contour thresholds: expected ${least} to ${MAX_THRESHOLDS} values${bands ? ", a band between each two" : ""}; received ${thresholds.length}`;
  if (bands) {
    const given = ["stroke", "strokeWidth"].find((name) => spec[name] !== undefined);
    if (given)
      return `contour ${given}: draws lines; bands take colors and fillOpacity, so drop ${given} or use variant: "lines"`;
  } else if (spec.fillOpacity !== undefined)
    return 'contour fillOpacity: fills bands; lines take stroke and strokeWidth, so drop it or use variant: "bands"';
  return undefined;
}
