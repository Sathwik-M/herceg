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
   * Where the whiskers end: the most extreme values within 1.5 interquartile
   * ranges of the box (Tukey's rule), so whiskers end on actual values.
   */
  low: number;
  high: number;
  /** Values beyond the whiskers, ascending. */
  outliers: number[];
}

/** Box plot statistics of ascending, finite values. */
export function boxStats(sorted: ArrayLike<number>): BoxStats {
  const n = sorted.length;
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  const reach = 1.5 * (q3 - q1);
  let first = 0;
  while (first < n && sorted[first]! < q1 - reach) first++;
  let last = n - 1;
  while (last >= 0 && sorted[last]! > q3 + reach) last--;
  const outliers: number[] = [];
  for (let i = 0; i < first; i++) outliers.push(sorted[i]!);
  for (let i = last + 1; i < n; i++) outliers.push(sorted[i]!);
  return {
    count: n,
    q1,
    median,
    q3,
    low: n > 0 ? sorted[first]! : Number.NaN,
    high: n > 0 ? sorted[last]! : Number.NaN,
    outliers,
  };
}
