// Microbenchmarks for engine hot paths, run in Node:
//   npm run bench -w herceg
// Reports the median and median absolute deviation over repeated runs.

import { table } from "../src/data/table.ts";
import { m4 } from "../src/lod/m4.ts";
import { Polyline } from "../src/lod/polyline.ts";
import { LinearScale } from "../src/scale/scale.ts";

function measure(name: string, run: () => void, { warmup = 20, samples = 50, repeat = 1 } = {}) {
  for (let i = 0; i < warmup; i++) run();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    for (let r = 0; r < repeat; r++) run();
    times.push((performance.now() - start) / repeat);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1]!;
  const deviations = times.map((t) => Math.abs(t - median)).sort((a, b) => a - b);
  const mad = deviations[deviations.length >> 1]!;
  const unit =
    median < 0.1
      ? `${(median * 1000).toFixed(2)} µs ± ${(mad * 1000).toFixed(2)}`
      : `${median.toFixed(3)} ms ± ${mad.toFixed(3)}`;
  console.log(`${name.padEnd(48)} ${unit}`);
}

const N = 1_000_000;
const x = Float64Array.from({ length: N }, (_, i) => 1_767_225_600_000 + i * 1000);
const y = Float64Array.from({ length: N }, (_, i) => Math.sin(i / 1000) * 100 + ((i * 7919) % 13));
const yMap = new LinearScale([-120, 120], [400, 0]).mapping();
const out = new Polyline();

const full = new LinearScale([x[0]!, x[N - 1]!], [0, 800]).mapping();
measure("m4: 1M points, 800 px at 2x", () => {
  out.reset();
  m4(x, y, 0, N, full, yMap, 2, out);
});
const zoomed = new LinearScale([x[400_000]!, x[410_000]!], [0, 800]).mapping();
measure("m4: 10k visible of 1M, 800 px at 2x", () => {
  out.reset();
  m4(x, y, 399_999, 410_001, zoomed, yMap, 2, out);
});

const columns: Record<string, Float64Array> = { t: new Float64Array(3000) };
for (let s = 0; s < 15; s++) columns[`s${s}`] = new Float64Array(3000);
const live = table(columns, { maxRows: 3000 });
const row: Record<string, number> = { t: 0 };
for (let s = 0; s < 15; s++) row[`s${s}`] = 1;
measure(
  "table: appendRow, 16 fields, 3,000-row window",
  () => {
    row.t = (row.t ?? 0) + 1;
    live.appendRow(row as never);
  },
  { repeat: 1000 },
);
const batch: Record<string, Float64Array> = { t: new Float64Array(100) };
for (let s = 0; s < 15; s++) batch[`s${s}`] = new Float64Array(100);
measure("table: append 100 rows, 16 fields, 3,000-row window", () => live.append(batch as never), {
  repeat: 100,
});
