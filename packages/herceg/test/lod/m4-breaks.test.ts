// Level of detail on time axes with breaks: every path (column scans, index
// queries, point by point) gives what a plain reference gives.
import { describe, expect, it } from "vitest";
import { type Breaks, type Mapping, m4, mapValue } from "../../src/lod/m4.ts";
import { MinMaxIndex, type RangeIndex } from "../../src/lod/minmax-index.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { RowsIndex } from "../../src/lod/rows-index.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";

const MINUTE = 60_000;

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function points(out: Polyline) {
  return {
    coords: Array.from(out.coords.subarray(0, out.count * 2)),
    starts: [...out.starts],
  };
}

/**
 * M4 by its definition: shown points grouped by device-pixel column in order,
 * missing values breaking the line, each group's first, lowest, highest,
 * and last points.
 */
function reference(
  breaks: Breaks,
  x: Float64Array,
  y: Float64Array,
  start: number,
  end: number,
  xMap: Mapping,
  yMap: Mapping,
  ratio: number,
): Polyline {
  const out = new Polyline();
  let group: number[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    let low = first;
    let high = first;
    for (const k of group) {
      if (y[k]! < y[low]!) low = k;
      else if (y[k]! > y[high]!) high = k;
    }
    const [a, b] = low < high ? [low, high] : [high, low];
    const kept = [first, a, b, last].filter((k, i, all) => all.indexOf(k) === i);
    for (const k of kept) out.push(mapValue(xMap, x[k]!), mapValue(yMap, y[k]!));
    group = [];
  };
  let column = Number.NaN;
  for (let k = start; k < end; k++) {
    if (breaks.hides(x[k]!)) continue;
    if (!Number.isFinite(y[k]!)) {
      flush();
      column = Number.NaN;
      out.break();
      continue;
    }
    // Device pixels, with m4's arithmetic.
    const xo = xMap.offset * ratio;
    const xf = xMap.factor * ratio;
    const c = Math.floor(xo + (breaks.collapse(x[k]!) - xMap.origin) * xf);
    if (c !== column) {
      flush();
      column = c;
    }
    group.push(k);
  }
  flush();
  return out;
}

describe("m4 with axis breaks", () => {
  // Three weeks of minutes in New York, around the clock: trading hours are
  // shown, nights and weekends hidden.
  const breaks = timeBreaks([{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }]).calendar(
    "America/New_York",
  );
  const next = seeded(5);
  const start = Date.UTC(2025, 2, 3, 5);
  const n = 21 * 24 * 60;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Pairs of equal x, and values without ties.
    x[i] = start + Math.floor(i / 2) * 2 * MINUTE + (i % 2) * MINUTE * (i % 7 === 0 ? 0 : 1);
    y[i] = next() < 0.001 ? Number.NaN : Math.sin(i / 500) * 100 + next();
  }
  x.sort();

  const cases = [
    { from: 0, to: n, width: 800, ratio: 1 },
    { from: 3000, to: 9000, width: 640, ratio: 1.5 },
    { from: 12_000, to: 12_400, width: 900, ratio: 2 },
    // Dense enough for index queries: over 200 points a column.
    { from: 0, to: n, width: 60, ratio: 1 },
  ];

  it("gives the reference's output on every path", () => {
    for (const { from, to, width, ratio } of cases) {
      const lo = breaks.collapse(x[from]!);
      const hi = breaks.collapse(x[to - 1]!);
      const xMap: Mapping = {
        origin: lo,
        offset: 40,
        factor: width / (hi - lo),
        log: false,
        breaks,
      };
      const yMap: Mapping = { origin: 0, offset: 300, factor: -1, log: false };
      const expected = points(reference(breaks, x, y, from, to, xMap, yMap, ratio));
      const scanned = new Polyline();
      m4(x, y, from, to, xMap, yMap, ratio, scanned);
      expect(points(scanned)).toEqual(expected);
      const rows = Uint32Array.from({ length: n }, (_, i) => i);
      const pointwise = new Polyline();
      m4(x, y, from, to, xMap, yMap, ratio, pointwise, rows);
      expect(points(pointwise)).toEqual(expected);
      const indexed = new Polyline();
      m4(x, y, from, to, xMap, yMap, ratio, indexed, undefined, new MinMaxIndex(y));
      expect(points(indexed)).toEqual(expected);
    }
  });

  it("gives the reference's output through rows, with and without their index", () => {
    // Every other row, as one series of long-format data, and the same points gathered.
    const rows = Uint32Array.from({ length: n >> 1 }, (_, k) => 2 * k + (k % 3 === 0 ? 1 : 0));
    const xs = Float64Array.from(rows, (row) => x[row]!);
    const ys = Float64Array.from(rows, (row) => y[row]!);
    const summaries = new RowsIndex();
    summaries.update(y, rows, 0, rows.length);
    const index: RangeIndex = {
      length: rows.length,
      gapShare: summaries.gapShare,
      query: (_values, from, to, out) => summaries.query(y, rows, from, to, out),
    };
    for (const { from, to, width, ratio } of cases) {
      const [a, b] = [from >> 1, to >> 1];
      const lo = breaks.collapse(xs[a]!);
      const hi = breaks.collapse(xs[b - 1]!);
      const xMap: Mapping = {
        origin: lo,
        offset: 40,
        factor: width / (hi - lo),
        log: false,
        breaks,
      };
      const yMap: Mapping = { origin: 0, offset: 300, factor: -1, log: false };
      const expected = points(reference(breaks, xs, ys, a, b, xMap, yMap, ratio));
      for (const through of [undefined, index]) {
        const out = new Polyline();
        m4(x, y, a, b, xMap, yMap, ratio, out, rows, through);
        expect(points(out)).toEqual(expected);
      }
    }
  });

  it("joins the points either side of a break, and keeps four points a column", () => {
    const from = 0;
    const to = n;
    const lo = breaks.collapse(x[from]!);
    const hi = breaks.collapse(x[to - 1]!);
    const xMap: Mapping = { origin: lo, offset: 0, factor: 100 / (hi - lo), log: false, breaks };
    const yMap: Mapping = { origin: 0, offset: 0, factor: 1, log: false };
    const values = Float64Array.from(y, (v) => (Number.isNaN(v) ? 0 : v));
    const out = new Polyline();
    m4(x, values, from, to, xMap, yMap, 1, out);
    // No missing values, so one run, though most minutes are hidden.
    expect(out.starts).toEqual([0]);
    expect(out.count).toBeLessThanOrEqual(4 * 101);
    // Every point is a shown one.
    for (let i = 0; i < out.count; i++) expect(out.coords[i * 2]!).toBeLessThanOrEqual(100.001);
  });
});
