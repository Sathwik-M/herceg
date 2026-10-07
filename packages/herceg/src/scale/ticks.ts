// Tick and nice-domain arithmetic for linear values, after d3-array's
// approach: steps are 1, 2, or 5 times a power of ten, and ticks are computed
// as integer multiples of the step to avoid accumulating rounding errors.

const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/** Tick spacing for about `count` ticks across [start, stop]. */
export function tickStep(start: number, stop: number, count: number): number {
  const raw = Math.abs(stop - start) / Math.max(1, count);
  let step = 10 ** Math.floor(Math.log10(raw));
  const error = raw / step;
  if (error >= E10) step *= 10;
  else if (error >= E5) step *= 5;
  else if (error >= E2) step *= 2;
  return step;
}

/** About `count` round values within [start, stop], ascending. */
export function linearTicks(start: number, stop: number, count: number): number[] {
  if (!(Number.isFinite(start) && Number.isFinite(stop)) || count <= 0) return [];
  if (start === stop) return [start];
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  const step = tickStep(lo, hi, count);
  // Subnormal or overflowing spans have no usable step; show the ends.
  if (!(step > 0) || !Number.isFinite(step)) return [lo, hi];
  // Dividing by the inverse keeps values like 0.3 exact.
  const inverse = step < 1 ? Math.round(1 / step) : 0;
  const first = inverse ? Math.ceil(lo * inverse) : Math.ceil(lo / step);
  const last = inverse ? Math.floor(hi * inverse) : Math.floor(hi / step);
  // When the step is below the precision of the values, multiples of it are
  // not representable; fall back to the domain ends.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 1000)
    return [lo, hi];
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(inverse ? i / inverse : i * step);
  return ticks;
}

/** Extends [start, stop] outward to multiples of the tick step. */
export function niceDomain(start: number, stop: number, count: number): [number, number] {
  if (!(Number.isFinite(start) && Number.isFinite(stop)) || start === stop) return [start, stop];
  const reversed = stop < start;
  let lo = reversed ? stop : start;
  let hi = reversed ? start : stop;
  let previous = 0;
  // Rounding can change the step; repeat until it is stable.
  for (let i = 0; i < 10; i++) {
    const step = tickStep(lo, hi, count);
    if (step === previous) break;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    previous = step;
  }
  return reversed ? [hi, lo] : [lo, hi];
}

/** Number of decimals needed to print multiples of `step` exactly. */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let decimals = 0; decimals < 15; decimals++) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * scaled) return decimals;
  }
  return 15;
}
