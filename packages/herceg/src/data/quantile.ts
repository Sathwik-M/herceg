// Order statistics of sorted values: quantiles, and a box plot's summary.

/** The p-quantile of ascending values, interpolating linearly between ranks (as NumPy and pandas do). */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (sorted.length - 1) * p;
  const below = Math.floor(rank);
  const above = Math.min(sorted.length - 1, below + 1);
  const [a, b, t] = [sorted[below]!, sorted[above]!, rank - below];
  if (t === 0) return a;
  // Values of opposite signs near the largest double differ by more than it.
  const difference = b - a;
  return Number.isFinite(difference) ? a + difference * t : a * (1 - t) + b * t;
}

/** What a box plot shows of a group's values. */
export interface BoxStats {
  count: number;
  q1: number;
  median: number;
  q3: number;
  /**
   * Observed extremes within the fences. Custom IQR multiples keep the ends
   * at least as far out as the quartiles when observations do not reach them.
   */
  low: number;
  high: number;
  /** Values beyond the whiskers, ascending. */
  outliers: number[];
}

/** Box plot statistics of ascending, finite values. */
export function boxStats(
  sorted: ArrayLike<number>,
  whiskers: "tukey" | "range" | number = "tukey",
): BoxStats {
  const n = sorted.length;
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const multiple = typeof whiskers === "number" ? whiskers : 1.5;
  const iqr = q3 - q1;
  const legacy = multiple === 1.5;
  const reach = multiple === 0 ? 0 : multiple * iqr;
  let lowerFence = q1 - reach;
  let upperFence = q3 + reach;
  // Default boxes and violins retain the old arithmetic and observed ends.
  // Custom multiples require spec version 6, so can use corrected fences.
  if (!legacy && multiple !== 0 && !Number.isFinite(reach)) {
    // Halve before multiplying: an overflowing reach can cancel with a
    // quartile to give a representable fence. If even halfReach overflows,
    // neither fence can be finite after cancellation with a finite quartile.
    const halfIqr = Number.isFinite(iqr) ? iqr / 2 : q3 / 2 - q1 / 2;
    const halfReach = multiple * halfIqr;
    lowerFence = (q1 / 2 - halfReach) * 2;
    upperFence = (q3 / 2 + halfReach) * 2;
  }
  let first = 0;
  while (whiskers !== "range" && first < n && sorted[first]! < lowerFence) first++;
  let last = n - 1;
  while (whiskers !== "range" && last >= 0 && sorted[last]! > upperFence) last--;
  const outliers: number[] = [];
  for (let i = 0; i < first; i++) outliers.push(sorted[i]!);
  for (let i = last + 1; i < n; i++) outliers.push(sorted[i]!);
  return {
    count: n,
    q1,
    median,
    q3,
    low: n > 0 ? (legacy ? sorted[first]! : Math.min(q1, sorted[first] ?? q1)) : Number.NaN,
    high: n > 0 ? (legacy ? sorted[last]! : Math.max(q3, sorted[last] ?? q3)) : Number.NaN,
    outliers,
  };
}
