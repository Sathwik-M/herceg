// Kernel density estimates of a group's values, for violins.

import { quantile } from "./quantile.ts";

/**
 * Silverman's rule of thumb for a Gaussian kernel's bandwidth,
 * 0.9 min(sd, IQR / 1.34) n^(-1/5) (R's default), using the standard
 * deviation alone when the interquartile range is zero; 0 when the values
 * do not vary.
 */
export function silverman(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n < 2) return 0;
  // Spreads are measured in halves of the range, so that neither squares nor
  // differences of tiny or huge values underflow or overflow.
  const half = sorted[n - 1]! / 2 - sorted[0]! / 2;
  if (!(half > 0)) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (sorted[i]! / 2 - mean) / (i + 1);
  let squares = 0;
  for (let i = 0; i < n; i++) squares += ((sorted[i]! / 2 - mean) / half) ** 2;
  const sd = Math.sqrt(squares / (n - 1));
  const iqr = (quantile(sorted, 0.75) / 2 - quantile(sorted, 0.25) / 2) / half / 1.34;
  return 0.9 * 2 * (iqr > 0 ? Math.min(sd, iqr) : sd) * n ** -0.2 * half;
}

/** A density estimated at evenly spaced values from `lo` to `hi`. */
export interface Density {
  lo: number;
  hi: number;
  /** The density at each value, integrating to about 1. */
  values: Float64Array;
}

/** Spacing of the values a density is estimated at, in bandwidths, unless there would be too many. */
const STEP = 1 / 3;
/** Fewest and most values a density is estimated at. */
const MIN_POINTS = 100;
const MAX_POINTS = 512;
/** Past this many bandwidths the kernel is below 1e-14 of its peak. */
const REACH = 8;

/**
 * The Gaussian kernel density of ascending, finite values, from `cut`
 * bandwidths below the lowest value to `cut` above the highest (Plotly's
 * "soft" span). Values are first split between the two estimation points
 * around them (linear binning), so the cost after sorting is one pass over
 * the values and a convolution of at most 512 points; a third of a bandwidth
 * apart, that changes the estimate by well under a percent of its peak.
 *
 * When the span is too wide for that spacing (a distant outlier, a tiny
 * bandwidth), each point gets the kernel's average over the interval around
 * it instead of its value there, and the span reaches at least one spacing
 * past the extreme values: features narrower than the spacing cannot be
 * drawn, but their mass stays where it is, and the profile through the
 * points still integrates to 1. Undefined when there are no values, the
 * bandwidth is not positive, or the span or density overflows.
 */
export function kde(sorted: ArrayLike<number>, bandwidth: number, cut = 2): Density | undefined {
  const n = sorted.length;
  if (n === 0 || !(bandwidth > 0)) return undefined;
  const range = sorted[n - 1]! - sorted[0]!;
  let pad = cut * bandwidth;
  if (!Number.isFinite(range + 2 * pad)) return undefined;
  const points = Math.min(
    MAX_POINTS,
    Math.max(MIN_POINTS, Math.ceil((range + 2 * pad) / (bandwidth * STEP)) + 1),
  );
  let step = (range + 2 * pad) / (points - 1);
  // Values within a step of an end would lose part of their mass outside
  // the profile, so a coarse grid ends a whole step past them.
  if (step > pad) {
    step = range / (points - 3);
    pad = step;
  }
  if (!(step > 0 && Number.isFinite(step))) return undefined;
  const lo = sorted[0]! - pad;
  const hi = sorted[n - 1]! + pad;
  const weights = new Float64Array(points);
  for (let i = 0; i < n; i++) {
    const at = (sorted[i]! - lo) / step;
    const below = Math.min(points - 2, Math.floor(at));
    const t = at - below;
    weights[below]! += 1 - t;
    weights[below + 1]! += t;
  }
  const reach = Math.min(points - 1, Math.ceil((REACH * bandwidth) / step));
  const kernel = new Float64Array(reach + 1);
  if (step <= bandwidth * STEP) {
    // Divided in turn, so that large counts and bandwidths do not overflow.
    const scale = 1 / n / bandwidth / Math.sqrt(2 * Math.PI);
    for (let j = 0; j <= reach; j++)
      kernel[j] = Math.exp(-0.5 * ((j * step) / bandwidth) ** 2) * scale;
  } else {
    // The kernel's mass within half a step of each point, per unit of value.
    const c = step / (bandwidth * Math.SQRT2);
    const scale = 1 / n / step;
    kernel[0] = (1 - erfc(c / 2)) * scale;
    for (let j = 1; j <= reach; j++)
      kernel[j] = ((erfc((j - 0.5) * c) - erfc((j + 0.5) * c)) / 2) * scale;
  }
  // All the values at one point make the highest density possible.
  if (!Number.isFinite(n * kernel[0]!)) return undefined;
  const values = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const weight = weights[i]!;
    if (weight === 0) continue;
    const last = Math.min(points - 1, i + reach);
    for (let j = Math.max(0, i - reach); j <= last; j++)
      values[j]! += weight * kernel[Math.abs(i - j)]!;
  }
  return { lo, hi, values };
}

/**
 * The complementary error function for x >= 0, to within 1.5e-7
 * (Abramowitz and Stegun 7.1.26).
 */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}
