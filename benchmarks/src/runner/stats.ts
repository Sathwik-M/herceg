export interface Summary {
  n: number;
  median: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
  p95: number;
  p99: number;
  /** Median absolute deviation, a noise estimate robust to outliers. */
  mad: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
  const median = quantile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return {
    n,
    median,
    mean,
    stdev: Math.sqrt(variance),
    min: sorted[0] ?? Number.NaN,
    max: sorted[n - 1] ?? Number.NaN,
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mad: quantile(deviations, 0.5),
  };
}
