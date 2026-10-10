import type { NumericArray } from "../data/column.ts";
import type { AreaStack, StackOrder } from "../spec/spec.ts";
import type { AxisFormat } from "./mark.ts";
import type { Series } from "./series.ts";

export function stackError(stack: unknown, area: boolean): string | undefined {
  if (stack === undefined || typeof stack === "boolean" || stack === "fill") return;
  if (area && (stack === "center" || stack === "wiggle")) return;
  return `${area ? "area" : "bar"} stack: expected true, false, or "fill"${area ? ', "center", or "wiggle"; choose a supported stack' : '; use an area for "center" or "wiggle"'}`;
}

export function requireContribution(value: number, location: string): void {
  if (value < 0 && Number.isFinite(value))
    throw new RangeError(
      `${location}: negative values have no nonnegative share or stream thickness; use stack: true for signed values`,
    );
}

/** Normalize owned bar boundaries without area ordering or stream offsets. */
export function fillLayers(
  tops: readonly Float64Array[],
  bases: readonly Float64Array[],
  positions?: NumericArray,
  totals?: Float64Array,
  location = "bar stack",
): number[] {
  const length = tops[0]?.length ?? 0;
  for (let p = 0; p < length; p++) {
    let total = 0;
    for (let l = 0; l < tops.length; l++) {
      const top = tops[l]!;
      if (positions && !Number.isFinite(positions[p]!)) top[p] = Number.NaN;
      if (top[p]! < 0) requireContribution(top[p]!, `${location} "fill" layer ${l} row ${p}`);
      if (Number.isFinite(top[p]!)) total += top[p]!;
    }
    if (!Number.isFinite(total))
      throw new RangeError(`${location}: total exceeds finite numeric range; rescale the values`);
    if (totals) totals[p] = total;
    let below = 0;
    for (let l = 0; l < tops.length; l++) {
      const raw = tops[l]![p]!;
      bases[l]![p] = below;
      if (Number.isFinite(raw)) below += total > 0 ? raw / total : 0;
      tops[l]![p] = Number.isFinite(raw) ? below : Number.NaN;
    }
  }
  return tops.map((_, i) => i);
}

/** Resolve aligned thicknesses in owned buffers, optionally over a panel's rows. */
export function offsetLayers(
  tops: readonly Float64Array[],
  bases: readonly Float64Array[],
  mode: AreaStack,
  order: StackOrder = "input",
  positions?: NumericArray,
  totals?: Float64Array,
  location = "area stack",
  rows?: Uint32Array,
): number[] {
  const layersByInput = tops.map((_, i) => i);
  const length = rows?.length ?? tops[0]?.length ?? 0;
  if (!length) return layersByInput;
  // The caller aligns raw thickness in tops; offsets overwrite it in place.
  for (let l = 0; l < tops.length; l++) {
    const top = tops[l]!;
    for (let i = 0; i < length; i++) {
      const p = rows?.[i] ?? i;
      if (positions && !Number.isFinite(positions[p]!)) top[p] = Number.NaN;
      if (top[p]! < 0)
        requireContribution(top[p]!, `${location} ${JSON.stringify(mode)} layer ${l} row ${p}`);
    }
  }
  let layers = layersByInput;
  if (order === "inside-out") {
    const sums = tops.map((values) => {
      let sum = 0;
      for (let i = 0; i < length; i++) {
        const value = values[rows?.[i] ?? i]!;
        if (Number.isFinite(value)) sum += value;
      }
      return sum;
    });
    const peaks = tops.map((values) => {
      let peak = rows?.[0] ?? 0;
      let max = -Infinity;
      for (let i = 0; i < length; i++) {
        const p = rows?.[i] ?? i;
        if (
          values[p]! > max ||
          (values[p] === max && positions && positions[p]! < positions[peak]!)
        ) {
          max = values[p]!;
          peak = p;
        }
      }
      return peak;
    });
    layers.sort(
      (a, b) =>
        (positions ? positions[peaks[a]!]! - positions[peaks[b]!]! : 0) ||
        peaks[a]! - peaks[b]! ||
        a - b,
    );
    const bottom: number[] = [];
    const top: number[] = [];
    let below = 0;
    let above = 0;
    for (const l of layers) {
      if (above < below) {
        above += sums[l]!;
        top.push(l);
      } else {
        below += sums[l]!;
        bottom.push(l);
      }
    }
    layers = bottom.reverse().concat(top);
  }
  // Visit sorted positions without an order array. Missing positions do
  // not affect the baseline; unsorted field rows need a sorted view.
  let points: number[] | undefined;
  if (positions && mode === "wiggle") {
    let previous = -Infinity;
    for (let i = 0; i < length; i++) {
      const p = rows?.[i] ?? i;
      const at = positions[p]!;
      if (!Number.isFinite(at) || at < previous) {
        points = Array.from({ length }, (_, i) => rows?.[i] ?? i)
          .filter((i) => Number.isFinite(positions[i]!))
          .sort((a, b) => positions[a]! - positions[b]! || a - b);
        break;
      }
      previous = at;
    }
  }
  const value = (l: number, p: number) => (Number.isFinite(tops[l]![p]!) ? tops[l]![p]! : 0);
  let baseline = 0;
  const previousValues = new Float64Array(tops.length);
  for (let j = 0; j < (points?.length ?? length); j++) {
    const p = points?.[j] ?? rows?.[j] ?? j;
    let total = 0;
    let weighted = 0;
    let difference = 0;
    for (const l of layers) total += value(l, p);
    if (totals) totals[p] = total;
    if (!Number.isFinite(total))
      throw new RangeError(`${location}: total exceeds finite numeric range; rescale the values`);
    if (mode === "wiggle" && j > 0 && total > 0) {
      for (const l of layers) {
        const current = value(l, p);
        const delta = current - previousValues[l]!;
        // Normalize the weight before multiplying to keep large finite
        // thicknesses from overflowing the weighted slope.
        weighted += (difference + delta / 2) * (current / total);
        difference += delta;
      }
      baseline -= weighted;
    }
    if (!Number.isFinite(baseline))
      throw new RangeError(
        "area stack wiggle: baseline exceeds finite numeric range; rescale the values",
      );
    let below = mode === "center" ? -total / 2 : mode === "wiggle" ? baseline : 0;
    for (const l of layers) {
      const top = tops[l]!;
      const base = bases[l]!;
      const raw = top[p]!;
      const thickness = Number.isFinite(raw) ? raw : 0;
      previousValues[l] = thickness;
      base[p] = below;
      below += mode === "fill" ? (total > 0 ? thickness / total : 0) : thickness;
      if (!Number.isFinite(below))
        throw new RangeError(
          `${location}: boundary exceeds finite numeric range; rescale the values`,
        );
      top[p] = Number.isFinite(raw) ? below : Number.NaN;
    }
  }
  return layers;
}

export function stackPointText(
  s: Series,
  row: number,
  along: "x" | "y",
  format: AxisFormat,
): string {
  const raw = format.value(s.values[row]!);
  return `${format[along === "x" ? "y" : "x"](stackShare(s, row))} share (${raw} raw)`;
}

export function stackShare(s: Series, row: number): number {
  const total = s.stackTotals?.[row] ?? 0;
  return total > 0 ? s.values[row]! / total : 0;
}
