// Microbenchmarks for engine hot paths, run in Node:
//   npm run bench -w herceg
// Reports the median and median absolute deviation over repeated runs.

import { count, derive, mean } from "../src/data/derive.ts";
import { col } from "../src/data/expression.ts";
import { type RowQuery, rowView } from "../src/data/row-view.ts";
import { type Table, table } from "../src/data/table.ts";
import { fromWall } from "../src/format/zone.ts";
import { estimateText } from "../src/layout/text.ts";
import { m4 } from "../src/lod/m4.ts";
import { MinMaxIndex } from "../src/lod/minmax-index.ts";
import { Polyline } from "../src/lod/polyline.ts";
import { pie } from "../src/marks/pie.ts";
import { PositionStack } from "../src/marks/position-stack.ts";
import { SplitRows } from "../src/marks/split.ts";
import { RowStack } from "../src/marks/stack.ts";
import { treemap } from "../src/marks/treemap.ts";
import { UnionStack } from "../src/marks/union-stack.ts";
import { facet } from "../src/model/facet.ts";
import { ChartModel } from "../src/model/model.ts";
import { timeBreaks } from "../src/scale/breaks.ts";
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
const gapped = y.map((value, i) => (i % 100 === 99 ? Number.NaN : value));
measure("m4: 1M points with a gap every 100, 800 px at 2x", () => {
  out.reset();
  m4(x, gapped, 0, N, full, yMap, 2, out);
});
measure("min/max index: build over 1M points", () => {
  new MinMaxIndex(y);
});
const index = new MinMaxIndex(y);
measure("m4 with index: 1M points, 800 px at 2x", () => {
  out.reset();
  m4(x, y, 0, N, full, yMap, 2, out, undefined, index);
});
// Minute bars of New York trading sessions, about ten years of them, on an
// axis that leaves out nights and weekends.
const ZONE = "America/New_York";
const sessions = new Float64Array(N);
for (let day = Date.UTC(2016, 0, 4), n = 0; n < N; day += 86_400_000) {
  const weekday = new Date(day).getUTCDay();
  if (weekday === 0 || weekday === 6) continue;
  const open = fromWall(ZONE, day + 9.5 * 3_600_000);
  for (let m = 0; m < 390 && n < N; m++) sessions[n++] = open + m * 60_000;
}
const breaks = timeBreaks([{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }]);
measure(
  "breaks: resolve ten years in New York",
  () => {
    timeBreaks([{ weekdays: ["sat", "sun"] }, { hours: ["16:00", "09:30"] }])
      .calendar(ZONE)
      .cover(sessions[0]!, sessions[N - 1]!);
  },
  { warmup: 3, samples: 15 },
);
const calendar = breaks.calendar(ZONE);
const sessionMap = calendar.scale([sessions[0]!, sessions[N - 1]!], [0, 800]).mapping();
measure("m4 with breaks: 1M points, ~2,600 sessions, 800 px at 2x", () => {
  out.reset();
  m4(sessions, y, 0, N, sessionMap, yMap, 2, out);
});
measure("m4 with breaks and index: 1M points, 800 px at 2x", () => {
  out.reset();
  m4(sessions, y, 0, N, sessionMap, yMap, 2, out, undefined, index);
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

// Derived tables over 1M rows: a filter with a calculation, an aggregate by a
// category of 20 values, a rolling mean, and appends through a row-by-row pipeline.
const sites = Array.from({ length: N }, (_, i) => `site ${i % 20}`);
const readings = table({ t: x, v: y, site: sites });
measure(
  "derive: filter + calculate, 1M rows",
  () => {
    derive(readings).filter(col("v").gt(0)).calculate("w", col("v").mul(2)).table();
  },
  { warmup: 3, samples: 10 },
);
measure(
  "derive: aggregate mean by 20 sites, 1M rows",
  () => {
    derive(readings)
      .aggregate({ groupby: ["site"], ops: { mean: mean("v"), n: count() } })
      .table();
  },
  { warmup: 3, samples: 10 },
);
measure(
  "derive: rolling mean of 100 rows, 1M rows",
  () => {
    derive(readings)
      .rolling({ size: 100, ops: { avg: { op: "mean", field: "v" } } })
      .table();
  },
  { warmup: 3, samples: 10 },
);
const stream = table({ t: x.slice(0, 100_000), v: y.slice(0, 100_000) }, { maxRows: 100_000 });
derive(stream).filter(col("v").gt(0)).calculate("w", col("v").mul(2)).table();
let next = 100_000;
measure("derive: append 100 rows to a following filter, 100k window", () => {
  const t = Float64Array.from({ length: 100 }, (_, i) => next + i);
  stream.append({ t, v: t.map((value) => Math.sin(value)) });
  next += 100;
});
// Five stacked layers over a million-row window, 10,000 rows per tick.
const layers = ["a", "b", "c", "d", "e"];
const stacked = table(
  Object.fromEntries([["t", x], ...layers.map((name, l) => [name, y.map((v) => v + l)])]),
  { maxRows: N },
);
const stack = new RowStack("sum");
const update = () =>
  stack.update(
    stacked,
    layers.map((name) => stacked.numbers(name)),
    "11111",
  );
update();
let tick = N;
measure("stack: 5 layers, append 10,000 rows, 1M window", () => {
  const t = Float64Array.from({ length: 10_000 }, (_, i) => tick + i);
  const v = t.map((value) => Math.sin(value / 1000));
  stacked.append(Object.fromEntries([["t", t], ...layers.map((name) => [name, v])]));
  tick += 10_000;
  update();
});
// Ten series of a category field, 10,000 positions in a rolling window, one
// position (a row per series) appended per tick: bars stacked at positions,
// areas on the union of the series' x.
const SERIES = 10;
const POSITIONS = 10_000;
const positionRows = (from: number, count: number) => {
  const t = new Float64Array(count * SERIES);
  const v = new Float64Array(count * SERIES);
  const s: string[] = [];
  for (let p = 0; p < count; p++)
    for (let k = 0; k < SERIES; k++) {
      t[p * SERIES + k] = from + p;
      v[p * SERIES + k] = 1 + (((from + p) * 7 + k * 13) % 17);
      s.push(`s${k}`);
    }
  return { t, v, s };
};
const long = table(positionRows(0, POSITIONS), { maxRows: POSITIONS * SERIES });
// Grouped as charts group a streaming table's rows, which the times include.
const split = new SplitRows(long as unknown as Table, "s", "t");
const groupsOf = () => split.groups().map(({ name, rows }) => ({ name, rows, shown: true }));
const bars = new PositionStack();
const areas = new UnionStack();
const stackSeries = (layers = groupsOf()) => {
  bars.update(long, long.numbers("t"), long.numbers("v"), layers, false, undefined);
  areas.update(long, long.numbers("t"), long.numbers("v"), layers, "zero");
};
stackSeries();
let position = POSITIONS;
const appendPosition = () => {
  long.append(positionRows(position++, 1));
  return groupsOf();
};
measure("stack: bars of 10 series, append a position, 100k rows", () => {
  const layers = appendPosition();
  bars.update(long, long.numbers("t"), long.numbers("v"), layers, false, undefined);
});
measure("stack: areas of 10 series, append a position, 100k rows", () => {
  const layers = appendPosition();
  areas.update(long, long.numbers("t"), long.numbers("v"), layers, "zero");
});
measure("stack: bars of 10 series, 100k rows again", () => {
  long.set("v", 0, long.numbers("v")[0]! + 1);
  bars.update(long, long.numbers("t"), long.numbers("v"), groupsOf(), false, undefined);
});
measure("stack: areas of 10 series, 100k rows again", () => {
  long.set("v", 0, long.numbers("v")[0]! + 1);
  areas.update(long, long.numbers("t"), long.numbers("v"), groupsOf(), "zero");
});
// Row views over a million rows: positions only, no column copies.
const hosts = Array.from({ length: 200 }, (_, i) => `host-${(i * 7919) % 1000}`);
const rows = table({
  t: x,
  v: y,
  host: Array.from({ length: N }, (_, i) => hosts[(i * 31) % hosts.length]!),
});
// Views are disposed once read: a view no one keeps is collected only after
// this synchronous loop ends, so samples would hold every earlier view.
const viewOnce = (query: RowQuery) => {
  const view = rowView(rows as unknown as Table, query);
  view.read();
  view.dispose();
};
measure("row view: sort 1M rows by a number", () => viewOnce({ sort: [{ field: "v" }] }), {
  warmup: 2,
  samples: 7,
});
measure(
  "row view: sort 1M rows by a category, then a number",
  () => viewOnce({ sort: [{ field: "host" }, { field: "v", order: "descending" }] }),
  { warmup: 2, samples: 7 },
);
const ascending = Float64Array.from(y).sort();
for (const share of [0.01, 0.5, 0.99]) {
  // The threshold keeping this share of rows, and the share it really keeps.
  const threshold = ascending[Math.floor(N * (1 - share))]!;
  const kept = ascending.length - ascending.findIndex((value) => value >= threshold);
  measure(
    `row view: filter 1M rows, keeping ${((100 * kept) / N).toFixed(1)}%`,
    () => viewOnce({ filter: col("v").ge(threshold) }),
    { warmup: 3, samples: 15 },
  );
}
const window = table({ t: x, v: y }, { maxRows: N });
const sorted = rowView(window, { sort: [{ field: "v" }] });
sorted.read();
let arrival = N;
measure(
  "row view: append 1,000 rows to a sorted 1M-row window",
  () => {
    const t = Float64Array.from({ length: 1000 }, (_, i) => arrival + i);
    window.append({ t, v: t.map((value) => Math.sin(value / 1000) * 100) });
    arrival += 1000;
    sorted.read();
  },
  { warmup: 5, samples: 30 },
);

// Small multiples of a layout mark: a pie of eight products per region, 50
// regions over 100,000 rows, labeled, at 1600 x 1200. A first scene splits the
// rows by panel and sums each panel's; a redraw reads what those kept.
const PANELS = 50;
const SALES_ROWS = 100_000;
const sales = table({
  region: Array.from({ length: SALES_ROWS }, (_, i) => `region ${i % PANELS}`),
  product: Array.from({ length: SALES_ROWS }, (_, i) => `product ${(i * 7) % 8}`),
  revenue: Float64Array.from({ length: SALES_ROWS }, (_, i) => (i * 13) % 100),
});
const pies = () => {
  const model = new ChartModel({
    marks: [pie(sales, { category: "product", value: "revenue" })],
    facet: facet("region", { columns: 10 }),
  });
  model.setSize(1600, 1200, 1);
  return model;
};
measure("facets: first scene of 50 pies over 100k rows", () => pies().scene(estimateText), {
  warmup: 5,
  samples: 30,
});
const drawn = pies();
drawn.scene(estimateText);
measure("facets: redraw 50 pies over 100k rows", () => drawn.scene(estimateText), {
  warmup: 10,
  samples: 50,
});
measure(
  "facets: 50 pies over 100k rows after a row arrives",
  () => {
    sales.append({ region: ["region 3"], product: ["product 1"], revenue: [5] });
    drawn.scene(estimateText);
  },
  { warmup: 5, samples: 30 },
);

// A treemap per region of 100,000 distinct leaves, 2,000 to a panel: each
// panel keeps the part of the tree its rows give a value, not all of it.
const leaves = table({
  region: Array.from({ length: SALES_ROWS }, (_, i) => `region ${i % PANELS}`),
  leaf: Array.from({ length: SALES_ROWS }, (_, i) => `leaf ${i}`),
  revenue: Float64Array.from({ length: SALES_ROWS }, (_, i) => 1 + (i % 7)),
});
measure(
  "facets: first scene of 50 treemaps of 2,000 leaves each",
  () => {
    const model = new ChartModel({
      marks: [treemap(leaves, { path: ["leaf"], value: "revenue", labels: false })],
      facet: facet("region", { columns: 10 }),
      legend: false,
    });
    model.setSize(2000, 1200, 1);
    model.scene(estimateText);
  },
  { warmup: 2, samples: 10 },
);
