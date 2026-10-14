// Letter values (Hofmann, Wickham, and Kafadar's letter-value plots): a
// sample's quartiles, eighths, sixteenths, ... out from its median, as
// Seaborn's `LetterValues` takes them, for boxen marks.

import { quantile } from "./quantile.ts";

/** How many letter values each side a group has: a rule, or a number of levels. */
export type LetterDepth = "tukey" | "proportion" | "trustworthy" | "full" | number;

/**
 * The number of levels (letter values each side, the quartiles being the
 * first) for `n` values, by Seaborn's rules: Tukey's leaves 5 to 8 values in
 * each tail, "proportion" about `proportion` of them, "trustworthy" stops
 * where a letter value's confidence interval at `alpha` would reach the
 * next, and "full" reaches every value. At least 1. Logarithms are cut to
 * whole numbers toward zero, as Python's `int` cuts them.
 */
export function letterDepth(
  n: number,
  depth: LetterDepth,
  proportion: number,
  alpha: number,
): number {
  let k: number;
  if (depth === "full") k = Math.trunc(Math.log2(n)) + 1;
  else if (depth === "tukey") k = Math.trunc(Math.log2(n)) - 3;
  else if (depth === "proportion")
    k = Math.trunc(Math.log2(n)) - Math.trunc(Math.log2(n * proportion)) + 1;
  else if (depth === "trustworthy") {
    // The upper quantile from the lower tail, which tiny alphas do not round
    // away (nor, halved, underflow to 0).
    const point = 2 * normalQuantile(Math.max(alpha / 2, Number.MIN_VALUE)) ** 2;
    k = Math.trunc(Math.log2(n / point)) + 1;
  } else k = Math.trunc(depth);
  return Math.max(k, 1);
}

/**
 * The 2k letter values of ascending values, lowest first: the quantiles
 * 2^-(k+1), ..., 1/8, 1/4, then 3/4, 7/8, ..., 1 - 2^-(k+1), interpolated
 * linearly (NumPy's percentiles); with `full`, the extremes themselves.
 */
export function letterValues(sorted: ArrayLike<number>, k: number, full: boolean): Float64Array {
  const out = new Float64Array(2 * k);
  for (let level = 0; level < k; level++) {
    // Level 0 is the outermost: 2^-(k+1) from either end.
    const tail = 0.5 ** (k + 1 - level);
    out[level] = quantile(sorted, tail);
    out[2 * k - 1 - level] = quantile(sorted, 1 - tail);
  }
  if (full && sorted.length) {
    out[0] = sorted[0]!;
    out[2 * k - 1] = sorted[sorted.length - 1]!;
  }
  return out;
}

/**
 * The standard normal distribution's quantile at `p`, by Wichura's
 * algorithm AS 241, as Python's `statistics.NormalDist().inv_cdf`
 * computes it (relative error about 1e-16).
 */
export function normalQuantile(p: number): number {
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * horner(r, CENTER_NUMERATOR)) / horner(r, CENTER_DENOMINATOR);
  }
  let r = Math.sqrt(-Math.log(q <= 0 ? p : 1 - p));
  let x: number;
  if (r <= 5) {
    r -= 1.6;
    x = horner(r, NEAR_NUMERATOR) / horner(r, NEAR_DENOMINATOR);
  } else {
    r -= 5;
    x = horner(r, FAR_NUMERATOR) / horner(r, FAR_DENOMINATOR);
  }
  return q < 0 ? -x : x;
}

/** A polynomial's value at `r`, its coefficients from the highest power down. */
function horner(r: number, coefficients: readonly number[]): number {
  let out = 0;
  for (const c of coefficients) out = out * r + c;
  return out;
}

const CENTER_NUMERATOR = [
  2509.0809287301227, 33430.57558358813, 67265.7709270087, 45921.95393154987, 13731.69376550946,
  1971.5909503065513, 133.14166789178438, 3.3871328727963665,
];
const CENTER_DENOMINATOR = [
  5226.495278852854, 28729.085735721943, 39307.89580009271, 21213.794301586597, 5394.196021424751,
  687.1870074920579, 42.31333070160091, 1,
];
const NEAR_NUMERATOR = [
  0.0007745450142783414, 0.022723844989269184, 0.2417807251774506, 1.2704582524523684,
  3.6478483247632045, 5.769497221460691, 4.630337846156546, 1.4234371107496835,
];
const NEAR_DENOMINATOR = [
  1.0507500716444169e-9, 0.0005475938084995345, 0.015198666563616457, 0.14810397642748008,
  0.6897673349851, 1.6763848301838038, 2.053191626637759, 1,
];
const FAR_NUMERATOR = [
  2.0103343992922881e-7, 2.7115555687434876e-5, 0.0012426609473880784, 0.026532189526576124,
  0.29656057182850487, 1.7848265399172913, 5.463784911164114, 6.657904643501103,
];
const FAR_DENOMINATOR = [
  2.0442631033899397e-15, 1.421511758316446e-7, 1.8463183175100548e-5, 0.0007868691311456133,
  0.014875361290850615, 0.1369298809227358, 0.599832206555888, 1,
];
