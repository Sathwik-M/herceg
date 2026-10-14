// Microbenchmarks for engine hot paths, run in Node:
//   npm run bench -w herceg
// Reports the median and median absolute deviation over repeated runs.

import { count, derive, mean } from "../src/data/derive.ts";
import { col } from "../src/data/expression.ts";
import { fromGeoJSON } from "../src/data/geojson.ts";
import { fromMatrix } from "../src/data/matrix.ts";
import { type RowQuery, rowView } from "../src/data/row-view.ts";
import { type Table, table } from "../src/data/table.ts";
import { fromWall } from "../src/format/zone.ts";
import { estimateText } from "../src/layout/text.ts";
import { m4 } from "../src/lod/m4.ts";
import { MinMaxIndex } from "../src/lod/minmax-index.ts";
import { Polyline } from "../src/lod/polyline.ts";
import { type BarMark, bar } from "../src/marks/bar.ts";
import { contour } from "../src/marks/contour.ts";
import { GridTracer } from "../src/marks/contour-trace.ts";
import { geopoint } from "../src/marks/geopoint.ts";
import { geoshape } from "../src/marks/geoshape.ts";
import { graph } from "../src/marks/graph.ts";
import { histogram } from "../src/marks/histogram.ts";
import { line } from "../src/marks/line.ts";
import { pie } from "../src/marks/pie.ts";
import { point } from "../src/marks/point.ts";
import { PositionStack } from "../src/marks/position-stack.ts";
import { region } from "../src/marks/region.ts";
import { rule } from "../src/marks/rule.ts";
import { SplitRows } from "../src/marks/split.ts";
import { RowStack } from "../src/marks/stack.ts";
import { packSwarm } from "../src/marks/swarm.ts";
import { text } from "../src/marks/text.ts";
import { treemap } from "../src/marks/treemap.ts";
import { UnionStack } from "../src/marks/union-stack.ts";
import { facet } from "../src/model/facet.ts";
import { ChartModel } from "../src/model/model.ts";
import { overviewBars } from "../src/model/navigator-bars.ts";
import { panels } from "../src/model/panels.ts";
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
// Rebuild only the bar overview at fixed scales, with warmed reusable
// buffers. This isolates the exact fallback on a mostly missing source.
const sparseBars = bar(
  table({
    t: Float64Array.from({ length: N }, (_, i) => i),
    v: Float64Array.from({ length: N }, (_, i) => (i < 20 ? 1 : Number.NaN)),
  }),
  { x: "t", y: "v" },
) as BarMark;
let barDrawing: Parameters<BarMark["geometry"]> | undefined;
const barGeometry = sparseBars.geometry.bind(sparseBars);
sparseBars.geometry = (...args) => {
  barDrawing = args;
  return barGeometry(...args);
};
const sparseModel = new ChartModel({ marks: [sparseBars] });
sparseModel.setSize(600, 300, 1);
sparseModel.scene(estimateText);
sparseBars.geometry = barGeometry;
const [barSeries, sourceFrame] = barDrawing!;
const barFrame = {
  ...sourceFrame,
  x: new LinearScale([0, N], [20, 620]),
  y: new LinearScale([0, 2], [42, 8]),
  plot: { x: 20, y: 5, width: 600, height: 40 },
  theme: { ...sourceFrame.theme, barRadius: 0 },
  keyed: false,
};
measure("bar geometry: 1M rows, 20 usable, 600 px", () => sparseBars.geometry(barSeries, barFrame));
measure("bar overview exact: 1M rows, 20 usable, 600 px", () =>
  overviewBars(sparseBars, barSeries, barFrame, 0),
);

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
      .aggregate({ by: ["site"], ops: { mean: mean("v"), n: count() } })
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

// Annotations over a table split by facets: a rule, a region, and a label
// per row, 100,000 rows over 50 regions (2,000 of each to a panel), with
// labels left out where they would cover others. Each panel reads only its
// own rows.
const events = table({
  region: Array.from({ length: SALES_ROWS }, (_, i) => `region ${i % PANELS}`),
  t: Float64Array.from({ length: SALES_ROWS }, (_, i) => Math.floor(i / PANELS)),
  v: Float64Array.from({ length: SALES_ROWS }, (_, i) => (i * 13) % 100),
  end: Float64Array.from({ length: SALES_ROWS }, (_, i) => Math.floor(i / PANELS) + 0.5),
  note: Array.from({ length: SALES_ROWS }, (_, i) => `event ${i % 97}`),
});
const annotated = () => {
  const model = new ChartModel({
    marks: [
      rule(events, { x: "t" }),
      region(events, { x1: "t", x2: "end" }),
      text(events, { x: "t", y: "v", textField: "note", overlap: "hide" }),
    ],
    facet: facet("region", { columns: 10 }),
  });
  model.setSize(2000, 1200, 1);
  return model;
};
measure(
  "facets: first scene of 50 panels of annotations over 100k rows",
  () => annotated().scene(estimateText),
  { warmup: 2, samples: 10 },
);
const notes = annotated();
notes.scene(estimateText);
measure("facets: redraw 50 panels of annotations over 100k rows", () => notes.scene(estimateText), {
  warmup: 3,
  samples: 20,
});

// The same rows as two lines per panel, both on the left axis, or one on
// each with the right axis' scale shared by every panel or each panel's own.
for (const side of ["left only", "shared", "independent"] as const) {
  const right = side !== "left only";
  const model = new ChartModel({
    marks: [
      line(events, { x: "t", y: "v" }),
      line(events, { x: "t", y: "end", ...(right && { axis: "right" as const }) }),
    ],
    facet: facet("region", { columns: 10 }),
    ...(right && { resolve: { yRight: side } }),
  });
  model.setSize(2000, 1200, 1);
  measure(`facets: 50 panels of two lines over 100k rows, ${side}`, () =>
    model.scene(estimateText),
  );
}

// Maps, trees, and networks as they are navigated: a map of 200 regions of
// 1,000 vertices panned (pixels reused, moved) and zoomed a step (projected
// at a new level), a treemap of 10,000 leaves drilled into and back out, and
// a network of 5,000 nodes and 20,000 links with a node dragged. Each is the
// scene the frame draws, not its painting (see benchmarks for that).
const regions = fromGeoJSON({
  type: "FeatureCollection",
  features: Array.from({ length: 200 }, (_, i) => {
    const [cx, cy] = [-171 + (i % 20) * 18, -54 + Math.floor(i / 20) * 12];
    const ring = Array.from({ length: 1000 }, (_, k) => {
      const a = (k / 1000) * 2 * Math.PI;
      const r = 5 + Math.sin(a * 7 + i);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.8];
    });
    ring.push(ring[0]!);
    return {
      type: "Feature" as const,
      properties: { value: i },
      geometry: { type: "Polygon" as const, coordinates: [ring] },
    };
  }),
});
const map = new ChartModel({ marks: [geoshape(regions, { color: "value" })] });
map.setSize(1200, 700, 1);
map.scene(estimateText);
const { x: planeX, y: planeY } = map.items!.result()!.plane!;
/** Shows the plane's middle at `zoom` times the fitted scale, moved `shift` of its width. */
const showMap = (zoom: number, shift: number) => {
  const [x0, x1] = planeX.domain;
  const [y0, y1] = planeY.domain;
  const [cx, cy] = [(x0 + x1) / 2 + (x1 - x0) * shift, (y0 + y1) / 2];
  const [w, h] = [(x1 - x0) / zoom / 2, (y1 - y0) / zoom / 2];
  map.items!.setView({ x: [cx - w, cx + w], y: [cy - h, cy + h] }, undefined);
  return map.scene(estimateText);
};
let panned = 0;
measure("maps: pan 200 regions of 1,000 vertices, zoomed 2x", () => {
  showMap(2, (panned++ % 10) / 100);
});
let level = 0;
measure(
  "maps: zoom 200 regions a step to a new projection level",
  () => {
    // Six levels, more than the shapes' cache keeps: every step projects again.
    showMap(1.2 ** (1 + (level++ % 6)), 0);
  },
  { warmup: 6, samples: 30 },
);

const leafRows = 10_000;
const sales10k = table({
  region: Array.from({ length: leafRows }, (_, i) => `region ${i % 20}`),
  country: Array.from({ length: leafRows }, (_, i) => `country ${i % 1000}`),
  city: Array.from({ length: leafRows }, (_, i) => `city ${i}`),
  revenue: Float64Array.from({ length: leafRows }, (_, i) => 1 + (i % 13)),
});
const tree10k = new ChartModel({
  marks: [treemap(sales10k, { path: ["region", "country", "city"], value: "revenue" })],
  interaction: { zoom: true },
});
tree10k.setSize(1200, 800, 1);
tree10k.scene(estimateText);
let drilled = 0;
measure("treemap: drill into a region of 10,000 leaves", () => {
  tree10k.items!.setDrillRoot([`region ${drilled++ % 20}`]);
  tree10k.scene(estimateText);
});
measure("treemap: drill into a region and back out, 10,000 leaves", () => {
  tree10k.items!.setDrillRoot([`region ${drilled++ % 20}`]);
  tree10k.scene(estimateText);
  tree10k.items!.setDrillRoot(null);
  tree10k.scene(estimateText);
});

// The same leaves in 12 facet panels by month, which share the drill root:
// each region has rows in 3 months, so a drill leaves 9 panels empty.
const monthly = table({
  month: Array.from({ length: leafRows }, (_, i) => `month ${i % 12}`),
  region: Array.from({ length: leafRows }, (_, i) => `region ${i % 20}`),
  country: Array.from({ length: leafRows }, (_, i) => `country ${i % 1000}`),
  city: Array.from({ length: leafRows }, (_, i) => `city ${i}`),
  revenue: Float64Array.from({ length: leafRows }, (_, i) => 1 + (i % 13)),
});
const facetTrees = new ChartModel({
  marks: [treemap(monthly, { path: ["region", "country", "city"], value: "revenue" })],
  facet: facet("month", { columns: 4 }),
  interaction: { zoom: true },
});
facetTrees.setSize(1600, 1200, 1);
facetTrees.scene(estimateText);
measure("treemap: drill 12 facet panels of 10,000 leaves", () => {
  facetTrees.items!.setDrillRoot([`region ${drilled++ % 20}`]);
  facetTrees.scene(estimateText);
});
measure("treemap: redraw 12 facet panels drilled", () => facetTrees.scene(estimateText));

// Six subplots of the 200 regions, one panned while the other five keep their view.
const sixMaps = new ChartModel({
  marks: ["a", "b", "c", "d", "e", "f"].map((panel) =>
    geoshape(regions, { color: "value", panel }),
  ),
  panels: panels(
    ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
    { columns: 3 },
  ),
});
sixMaps.setSize(1800, 900, 1);
sixMaps.scene(estimateText);
const sixPlane = sixMaps.items!.result("a")!.plane!;
let sixPanned = 0;
measure("maps: pan one of 6 subplots of 200 regions, zoomed 2x", () => {
  const [x0, x1] = sixPlane.x.domain;
  const [y0, y1] = sixPlane.y.domain;
  const shift = ((sixPanned++ % 10) / 100) * (x1 - x0);
  const [w, h] = [(x1 - x0) / 4, (y1 - y0) / 4];
  const [cx, cy] = [(x0 + x1) / 2 + shift, (y0 + y1) / 2];
  sixMaps.items!.setView({ x: [cx - w, cx + w], y: [cy - h, cy + h] }, "a");
  sixMaps.scene(estimateText);
});
// Six facet panels of a base map of the 200 regions, under a city per region
// split by six values, sharing one view: a pan moves them all.
const sixFacets = new ChartModel({
  marks: [
    geoshape(regions, { color: "value", facet: "repeat" }),
    geopoint(
      table({
        lon: Float64Array.from({ length: 200 }, (_, i) => -171 + (i % 20) * 18),
        lat: Float64Array.from({ length: 200 }, (_, i) => -54 + Math.floor(i / 20) * 12),
        group: Array.from({ length: 200 }, (_, i) => `group ${i % 6}`),
      }),
      { longitude: "lon", latitude: "lat" },
    ),
  ],
  facet: facet("group", { columns: 3 }),
});
sixFacets.setSize(1800, 900, 1);
sixFacets.scene(estimateText);
const facetPlane = sixFacets.items!.result("group 0")!.plane!;
let facetPanned = 0;
measure("maps: pan 6 facet panels of 200 regions, zoomed 2x", () => {
  const [x0, x1] = facetPlane.x.domain;
  const [y0, y1] = facetPlane.y.domain;
  const shift = ((facetPanned++ % 10) / 100) * (x1 - x0);
  const [w, h] = [(x1 - x0) / 4, (y1 - y0) / 4];
  const [cx, cy] = [(x0 + x1) / 2 + shift, (y0 + y1) / 2];
  sixFacets.items!.setView({ x: [cx - w, cx + w], y: [cy - h, cy + h] }, undefined);
  sixFacets.scene(estimateText);
});

let seed = 7;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const linkFrom: string[] = [];
const linkTo: string[] = [];
const paired = new Set<string>();
while (linkFrom.length < 20_000) {
  const a = Math.floor(random() * 5000);
  // Mostly near neighbors, some far.
  const b =
    random() < 0.8 ? (a + 1 + Math.floor(random() * 20)) % 5000 : Math.floor(random() * 5000);
  const key = a < b ? `${a} ${b}` : `${b} ${a}`;
  if (a === b || paired.has(key)) continue;
  paired.add(key);
  linkFrom.push(`n${a}`);
  linkTo.push(`n${b}`);
}
const network = new ChartModel({
  marks: [graph(table({ from: linkFrom, to: linkTo }), { source: "from", target: "to" })],
  interaction: { drag: true },
});
network.setSize(1200, 900, 1);
network.scene(estimateText);
const moves = network.items!.result()!.moves!;
const [hubX, hubY] = moves.pixelOf('[0,"n0"]')!;
let dragged = 0;
measure("graph: drag a node of 5,000 nodes and 20,000 links", () => {
  const step = dragged++ % 40;
  network.items!.drag('[0,"n0"]', moves.toLayout('[0,"n0"]', hubX + step, hubY + step / 2));
  network.scene(estimateText);
});

// Swarm layout: normally distributed values in one band 80 pixels wide over
// a 300-pixel plot, points of radius 2.5, laid out from scratch; and a
// chart's scene of a swarm over four bands, as zooming lays it out again.
const normal = () => {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};
for (const n of [1000, 10_000, 100_000]) {
  const pixels = Float64Array.from({ length: n }, () => 150 + 40 * normal()).sort();
  const radii = new Float64Array(n).fill(2.5);
  const offsets = new Float64Array(n);
  measure(
    `swarm: pack ${n.toLocaleString("en-US")} points in one band`,
    () => {
      packSwarm(pixels, radii, 0, n, 80, offsets);
    },
    { warmup: 3, samples: n >= 100_000 ? 5 : 20 },
  );
}
for (const n of [1000, 10_000, 100_000]) {
  const days = ["thu", "fri", "sat", "sun"];
  const swarmed = new ChartModel({
    marks: [
      point(
        table({
          day: Array.from({ length: n }, (_, i) => days[i % 4]!),
          v: Float64Array.from({ length: n }, normal),
        }),
        { x: "day", y: "v", swarm: true },
      ),
    ],
  });
  swarmed.setSize(800, 400, 1);
  let zoom = 0;
  measure(
    `swarm: scene of ${n.toLocaleString("en-US")} points in 4 bands, zoomed`,
    () => {
      const spread = 3 + (zoom++ % 2);
      swarmed.setYViewport({ y: [-spread, spread], yRight: null });
      swarmed.scene(estimateText);
    },
    { warmup: 2, samples: n >= 100_000 ? 5 : 15 },
  );
}

// Contours of 1000 x 1000 grids: a smooth field, whose ten thresholds cross
// few cells, and uniform noise, whose cells each cross six of the ten on
// average, traced (lines; bands' rings), then a chart's scenes as its colors change
// and as it zooms, which only project what was traced.
const side = 1000;
const gridXs = Float64Array.from({ length: side }, (_, i) => i);
const fields = {
  smooth: Float64Array.from({ length: side * side }, (_, k) => {
    const [u, v] = [(k % side) / 150 - 3.33, Math.floor(k / side) / 150 - 3.33];
    return Math.exp(-(u * u + v * v)) + 0.3 * Math.sin(u * 2) * Math.cos(v * 3);
  }),
  noise: Float64Array.from({ length: side * side }, () => random()),
};
for (const [name, values] of Object.entries(fields)) {
  const tracer = new GridTracer({ xs: gridXs, ys: gridXs, values });
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  const levels = Array.from({ length: 10 }, (_, k) => lo + ((k + 0.5) / 10) * (hi - lo));
  measure(
    `contour: lines of a ${name} 1000 x 1000 grid at 10 levels`,
    () => {
      for (const t of levels) tracer.lines(t);
    },
    { warmup: 1, samples: 5 },
  );
  measure(
    `contour: band rings of a ${name} 1000 x 1000 grid at 10 levels`,
    () => {
      for (const t of levels) tracer.rings(t);
    },
    { warmup: 1, samples: 5 },
  );
  const chart = new ChartModel({
    marks: [
      contour(fromMatrix({ x: gridXs, y: gridXs, v: values }, { x: "x", y: "y" }), {
        x: "x",
        y: "y",
        color: "v",
        thresholds: levels,
        variant: "bands",
      }),
    ],
  });
  chart.setSize(800, 600, 1);
  chart.scene(estimateText);
  let theme = 0;
  measure(
    `contour: scene of ${name} bands, colors changed`,
    () => {
      chart.update({ marks: chart.config.marks, theme: theme++ % 2 ? "dark" : "light" });
      chart.scene(estimateText);
    },
    { warmup: 1, samples: 5 },
  );
  let zoomed = 0;
  measure(
    `contour: scene of ${name} bands, zoomed`,
    () => {
      const half = 200 + (zoomed++ % 2) * 100;
      chart.setViewport([500 - half, 500 + half]);
      chart.scene(estimateText);
    },
    { warmup: 1, samples: 5 },
  );
}

// A 2D histogram of a million points in 50 x 50 bins (steps of a fiftieth of
// each axis' range, a hair wider so that rounding cannot leave the maximum
// for a 51st): counted, and drawn, by a new chart each time.
const pairsX = Float64Array.from({ length: N }, normal);
const pairsY = Float64Array.from(pairsX, (x) => 0.5 * x + normal());
const pairs = table({ x: pairsX, y: pairsY });
const fiftieths = (values: Float64Array) => {
  let [lo, hi] = [Infinity, -Infinity];
  for (const v of values) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  return { step: ((hi - lo) / 50) * (1 + 1e-12), start: lo };
};
const pairBins = { x: fiftieths(pairsX), y: fiftieths(pairsY) };
measure(
  "histogram 2d: count and draw 1,000,000 points in 50 x 50 bins",
  () => {
    const chart = new ChartModel({ marks: [histogram(pairs, { x: "x", y: "y", bins: pairBins })] });
    chart.setSize(800, 600, 1);
    chart.scene(estimateText);
  },
  { warmup: 1, samples: 5 },
);
