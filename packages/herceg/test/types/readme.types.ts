// The README examples, compiled by `npm run typecheck` so the docs stay true.
import {
  area,
  bar,
  candlestick,
  category,
  col,
  createChart,
  custom,
  encodedCategory,
  errorBar,
  facet,
  fromRows,
  heatmap,
  histogram,
  line,
  point,
  region,
  renderToSVG,
  rule,
  type Selection,
  table,
  text,
  time,
} from "../../src/index.ts";
import { renderToPDF } from "../../src/pdf.ts";

declare const timestamps: Float64Array;
declare const p50Latency: Float64Array;
declare const p99Latency: number[];
declare const latencies: Float64Array;
declare const serviceNames: string[];
declare const minutes: Float64Array;
declare const statusCodes: string[];
declare const counts: Float64Array;
declare const userCpu: Float64Array;
declare const systemCpu: Float64Array;
declare const newTimes: Float64Array;
declare const newValues: Float64Array;
declare const deployTime: number;
declare const element: HTMLElement;

// Quick start
const metrics = table({ time: time(timestamps), p50: p50Latency, p99: p99Latency });
const chart = createChart(element, {
  title: "Request latency",
  marks: [line(metrics, { x: "time", y: ["p50", "p99"] }), rule({ y: 250, label: "SLO" })],
  y: { title: "ms" },
});
chart.setViewport([0, 1]);
chart.update({ theme: "dark", interaction: { zoom: true, sync: "dashboard" } });

// Data
const requests = table({
  time: time(["2026-01-21T09:30:00Z", "2026-01-21T09:31:00Z"]),
  latency: latencies,
  service: serviceNames,
  status: category([200, 503]),
});
requests.numbers("latency");
requests.categories("service");
const latency: number | null = requests.value("latency", 0);
const when: number | null = requests.value("time", 0);
const status: string | null = requests.value("status", 1);
void [latency, when, status];
fromRows([{ at: new Date(), value: 1 }]);
fromRows([{ at: 0, status: 200 }], { types: { at: "time", status: "category" } });
const encoded = table({ host: encodedCategory(new Int32Array([0, -1]), ["web"]), v: [1, 2] });
line(encoded, { x: "v", y: "v", series: "host" });

const live = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
live.append({ time: [Date.now()], cpu: [0.42] });
live.appendRow({ time: Date.now(), cpu: 0.4 });
live.set("cpu", 0, 0.5);
live.replace("cpu", 0, [0.1, 0.2]);
live.dropBefore("time", Date.now() - 60_000);
live.reset({ time: newTimes, cpu: newValues });

// Animation
{
  const sales = table({ region: ["N", "S"], revenue: [40, 60] });
  createChart(element, {
    marks: [bar(sales, { x: "region", y: "revenue" }), rule({ y: 50 })],
    animation: { values: true },
  });
  sales.setColumn("revenue", [55, 45]);
  // @ts-expect-error values are animated or not
  createChart(element, { marks: [], animation: { values: "bars" } });
}

// Marks
line(metrics, { x: "time", y: ["p50", "p99"] });
line(requests, { x: "time", y: "latency", series: "service" });
const usage = table({ time: time(timestamps), user: userCpu, system: systemCpu });
area(usage, { x: "time", y: "user" });
area(usage, { x: "time", y: ["user", "system"], stack: true });
const responses = table({ minute: time(minutes), status: statusCodes, count: counts });
area(responses, { x: "minute", y: "count", series: "status", stack: true });
area(responses, {
  x: "minute",
  y: "count",
  series: "status",
  stack: { gaps: "interpolate" },
});
area(metrics, { x: "time", y1: "p50", y2: "p99" });
rule({ y: 250, label: "SLO" });
rule({ x: deployTime });
// @ts-expect-error series must be a category field
line(requests, { x: "time", y: "latency", series: "latency" });
// @ts-expect-error along x, y must be numeric
line(requests, { x: "time", y: "service", orient: "x" });
// A category y lays a line along y.
line(requests, { x: "latency", y: "service" });

// Annotations
const deploys = table({ at: time([Date.now()]), version: ["v2"], build: [42] });
rule({ y: 250, label: "SLO" });
rule({ x: new Date(), label: "now" });
rule(deploys, { x: "at", label: { field: "version" } });
rule(deploys, { x: "at", label: { field: "build" } });
// @ts-expect-error rule positions are number or time fields
rule(deploys, { x: "version" });
// @ts-expect-error times cannot be drawn as text
rule(deploys, { x: "at", label: { field: "at" } });
region({ x1: new Date(0), x2: new Date(), label: "window" });
region(deploys, { x1: "at", x2: Date.now(), label: { field: "version" } });
text({ x: 1, y: 2, label: "note" });
text(deploys, { x: "at", y: { field: "build", offset: -8 }, label: { field: "version" } });
// @ts-expect-error constant text needs a label
text({ x: 1, y: 2 });
// @ts-expect-error a label takes its text or a field, not both
text(deploys, { x: "at", y: "build", label: { text: "a", field: "version" } });
// @ts-expect-error text from data needs a label
text(deploys, { x: "at", y: "build" });

// Colors and channels
declare const other: HTMLElement;
const gains = table({ time: time(timestamps), gain: p50Latency, site: serviceNames });
const totals = table({ site: serviceNames, gain: p50Latency });
const sites = gains;
const sharedScales = {
  color: { type: "ordinal", map: { "Site A": "#00ab41", Average: "#222222" } },
} as const;
createChart(element, {
  scales: sharedScales,
  facet: facet("site", { columns: 3 }),
  marks: [line(gains, { x: "time", y: "gain", series: "site", color: "site" })],
});
createChart(other, {
  scales: sharedScales,
  marks: [bar(totals, { x: "site", y: "gain", color: "site" })],
});
const provisional = table({ site: serviceNames, gain: p50Latency, provisional: [1, 0] });
bar(provisional, {
  x: "site",
  y: "gain",
  encode: {
    color: { field: "site", scale: "sites" },
    // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
    opacity: { condition: { when: col("provisional").eq(true), then: 0.45, otherwise: 1 } },
  },
});
line(sites, {
  x: "time",
  y: "gain",
  series: "site",
  color: "site",
  style: { by: { map: { Average: { stroke: "#222222", strokeWidth: 3, dash: "--" } } } },
});
line(metrics, { x: "time", y: ["p50", "p99"], style: { by: { map: { p99: { dash: ":" } } } } });
line(metrics, { x: "time", y: "p50", markers: true, style: { marker: { radius: 4 } } });
// @ts-expect-error markers take a shape's name
line(metrics, { x: "time", y: "p50", markers: "hexagon" });

// Line breaks and conditional bands
const sensors = table({ time: time(timestamps), value: p50Latency, quality: p50Latency });
line(sensors, {
  x: "time",
  y: "value",
  continuity: {
    defined: col("quality").ge(0.8),
    maxGap: { milliseconds: 3_600_000 },
    breakBy: "day",
  },
});
const plant = table({ time: time(timestamps), efficiency: p50Latency, limit: p50Latency });
area(plant, {
  x: "time",
  y1: "efficiency",
  y2: "limit",
  curve: "step-after",
  where: col("efficiency").lt(col("limit")),
  continuity: { breakBy: "day" },
});

// Bars: dodging, outlines, and labels
const units = table({ month: serviceNames, units: p50Latency, region: serviceNames });
bar(units, { x: "month", y: "units", series: "region" });
bar(units, { x: "month", y: "units", series: "region", dodge: false });
bar(units, { x: "month", y: "units", color: "region" });
bar(units, {
  x: "month",
  y: "units",
  stroke: "#1b3a6b",
  strokeWidth: 1,
  labels: { format: { number: ",.0f" }, minLength: 24, place: { outside: false } },
});

// Annotation places and labels
rule({ y: 250, label: { text: "Threshold", place: { attachment: "start", outside: true } } });
rule({ y: 300, span: [{ fraction: 0.5 }, { fraction: 1 }], strokeOpacity: 0.5 });
region({ x1: 0, x2: 1, label: { text: "Maintenance", place: { side: "bottom" } } });
text({ at: { x: { fraction: 0.03 }, y: { data: 1.7 } }, label: "Note" });
text(deploys, {
  x: "at",
  y: { field: "build", offset: -10 },
  label: { field: "build", format: { number: ".1f" }, style: { fontWeight: 600 } },
  overlap: "move",
});

// Export
const exported = { width: 640, height: 320, marks: [line(metrics, { x: "time", y: "p99" })] };
export const svg: string = renderToSVG(exported);
export const pdf: Uint8Array = renderToPDF(exported);

// A second y axis
const traffic = table({ time: time(timestamps), latency: latencies, requests: p50Latency });
createChart(element, {
  marks: [
    line(traffic, { x: "time", y: "latency" }),
    line(traffic, { x: "time", y: "requests", axis: "right" }),
    rule({ y: 5000, label: "capacity", axis: "right" }),
  ],
  y: { title: "ms" },
  yRight: { title: "requests/s" },
});
// @ts-expect-error marks go on the left or right axis
line(traffic, { x: "time", y: "requests", axis: "top" });
const regionalTraffic = table({
  time: time(timestamps),
  latency: latencies,
  requests: p50Latency,
  region: serviceNames,
});
createChart(element, {
  marks: [
    line(regionalTraffic, { x: "time", y: "latency" }),
    line(regionalTraffic, { x: "time", y: "requests", axis: "right" }),
  ],
  facet: facet("region"),

  yRight: { title: "requests/s", scope: "panel" },
});
// @ts-expect-error a right axis is shared, independent, or by rows or columns
createChart(element, { marks: [], facet: facet("region"), yRight: { scope: "undefined" } });

// Small multiples
declare const targets: Float64Array;
const regional = table({ week: timestamps, units: latencies, region: serviceNames });
const goals = table({ week: timestamps, target: targets });
const launches = table({ week: timestamps, product: serviceNames, region: serviceNames });
createChart(element, {
  marks: [
    line(regional, { x: "week", y: "units" }),
    line(goals, { x: "week", y: "target", facet: "repeat" }),
    rule({ y: 100, label: "goal" }),
    rule(launches, { x: "week", label: { field: "product" } }),
  ],
  facet: facet("region", { columns: 3 }),
});
// @ts-expect-error marks can only repeat
line(regional, { x: "week", y: "units", facet: "split" });

// Bars, points, heatmaps
const sales = table({ region: ["N", "S"], q1: [1, 2], q2: [3, 4], team: ["a", "b"] });
bar(sales, { x: "region", y: ["q1", "q2"] });
bar(sales, { x: "region", y: "q1", series: "team", stack: true });
// @ts-expect-error bar heights must be numeric
bar(sales, { x: "region", y: "team" });
bar(sales, { x: "q1", y: "region" });
bar(sales, { x: "region", y: "q1", labels: { format: { style: "percent" } } });
bar(sales, { x: ["q1", "q2"], y: "region", stack: true });
// @ts-expect-error horizontal bar lengths must be numeric
bar(sales, { x: "team", y: "region" });
// @ts-expect-error several length fields on x need a category y
bar(sales, { x: ["q1", "q2"], y: "q1" });
// @ts-expect-error horizontal bars have no right axis
bar(sales, { x: "q1", y: "region", axis: "right" });
point(metrics, { x: "p50", y: "p99", radius: 3 });
point(sales, { x: "region", y: "q1" });
point(sales, { x: "q1", y: "region", series: "team" });
// @ts-expect-error point sizes must be numeric
point(sales, { x: "region", y: "q1", size: "team" });
// @ts-expect-error a point has a constant radius or a size field, not both
point(metrics, { x: "p50", y: "p99", radius: 3, size: "p50" });
// Colors follow a number field on a ramp, or a category field value by value.
point(sales, { x: "region", y: "q1", color: "q2" });
point(sales, { x: "region", y: "q1", color: "team" });
// Shapes by a category field: its name, or { field }.
point(sales, { x: "region", y: "q1", symbol: { field: "team" } });
// @ts-expect-error symbol fields are category fields
point(sales, { x: "region", y: "q1", symbol: { field: "q1" } });
const load = table({ hour: time(timestamps), host: serviceNames, cpu: latencies });
heatmap(load, { x: "hour", y: "host", color: "cpu" });
// @ts-expect-error heatmap values must be numeric
heatmap(load, { x: "hour", y: "host", color: "host" });

// README: bars, points, heatmaps
declare const regions: string[];
declare const q1Sales: number[];
declare const q2Sales: number[];
declare const hours: Float64Array;
declare const hostNames: string[];
declare const cpuValues: Float64Array;
declare const cars: import("../../src/index.ts").Table<{
  weight: "number";
  mpg: "number";
  origin: "category";
}>;
const regionSales = table({ region: regions, q1: q1Sales, q2: q2Sales });
bar(regionSales, { x: "region", y: ["q1", "q2"] });
bar(requests, { x: "time", y: "latency" });
point(cars, { x: "weight", y: "mpg", series: "origin", radius: 3 });
const stats = table({ group: regions, low: q1Sales, high: q2Sales });
errorBar(stats, { x: "group", y1: "low", y2: "high" });
errorBar(stats, { x: "group", y: "low", yError: "high" });
const hostLoad = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(hostLoad, { x: "hour", y: "host", color: "cpu" });
const spectrum = table({ time: time(hours), frequency: cpuValues, power: cpuValues });
heatmap(spectrum, { x: "time", y: "frequency", color: "power", sampling: { reduce: "max" } });
heatmap(spectrum, { x: "time", y: "frequency", color: "power", reduce: "sum" });
// @ts-expect-error reduce takes "last", "mean", "sum", "min", or "max"
heatmap(spectrum, { x: "time", y: "frequency", color: "power", reduce: "median" });

// Custom marks
custom({ draw: ({ circle, plot }) => circle(plot.x, plot.y, 3) });
custom(metrics, {
  x: "time",
  y: ["p50", "p99"],
  series: false,
  draw({ table: data, x, y, line: segment }) {
    const t = data.numbers("time");
    const low = data.numbers("p50");
    const high = data.numbers("p99");
    for (let i = 0; i < t.length; i++) segment(x(t[i]!), y(low[i]!), x(t[i]!), y(high[i]!));
  },
});
custom(requests, {
  x: "time",
  y: "latency",
  series: "service",
  description: "Request latency per service.",
  pointText: (row, format, s) => `${format.y(s.y[row]!)} ms`,
  draw({ series, x, y, line, circle }) {
    for (const s of series) {
      for (let k = 0; k < s.length; k++) {
        const row = s.rowAt(k);
        const [px, py] = [x(s.x[row]!), y(s.y[row]!)];
        line(px, y(0), px, py, { stroke: s.color });
        circle(px, py, 4, { fill: s.color });
      }
    }
  },
});
custom(requests, {
  x: "time",
  y: "latency",
  draw({ series }) {
    // @ts-expect-error series are read-only views of the table
    series[0]!.y[0] = 0;
  },
});
// @ts-expect-error custom fields are number or time fields of the table
custom(sales, { x: "region", draw() {} });
// @ts-expect-error y fields are number or time fields
custom(requests, { x: "time", y: "service", draw() {} });
// @ts-expect-error series fields are category fields
custom(requests, { x: "time", y: "latency", series: "latency", draw() {} });
// @ts-expect-error series is a category field or false
custom(requests, { x: "time", y: "latency", series: true, draw() {} });
// @ts-expect-error marks without a table have no series
custom({ series: "service", draw() {} });
// @ts-expect-error marks without a table have none in their context
custom({ draw: ({ table: none }) => none });
// @ts-expect-error nor series to draw
custom({ draw: ({ series }) => series });

// Candlesticks
const prices = table({
  day: time(timestamps),
  open: latencies,
  high: latencies,
  low: latencies,
  close: latencies,
  name: serviceNames,
});
candlestick(prices, { x: "day", open: "open", high: "high", low: "low", close: "close" });
// @ts-expect-error prices are number fields
candlestick(prices, { x: "day", open: "name", high: "high", low: "low", close: "close" });

// Histograms
histogram(metrics, { x: "p50" });
histogram(metrics, { x: "time", bins: { step: 3_600_000 }, normalize: "percent" });
// @ts-expect-error histogram values are number or time fields
histogram(sales, { x: "region" });

// Error bars
errorBar(sales, { x: "region", y1: "q1", y2: "q2" });
errorBar(sales, { y: "region", x1: "q1", x2: "q2", cap: 0 });
errorBar(sales, { x: "region", y: "q1", yError: "q2" });
// @ts-expect-error interval ends are number or time fields
errorBar(sales, { x: "region", y1: "team", y2: "q2" });
// @ts-expect-error horizontal error bars have no right axis
errorBar(sales, { y: "region", x1: "q1", x2: "q2", axis: "right" });

// Events and selections
chart.select({ x: [0, 1], y: [10, 20], lasso: null });
chart.select([0, 1]);
const selected: Selection | null = chart.selection;
const brushed: readonly [number, number] | null | undefined = selected?.x;
chart.on("select", ({ x, y, lasso }) => [x, y, lasso, brushed]);

// Panels and pixels
declare const event: PointerEvent;
const box = chart.root.getBoundingClientRect();
const [px, py] = [event.clientX - box.left, event.clientY - box.top];
const at = { panel: "North", axis: "x" } as const;
const where: number | undefined = chart.toPixel(Date.UTC(2026, 0, 5), at);
const value = chart.fromPixel(px, at);
const label: string | undefined = value === undefined ? "" : chart.formatValue(value, at);
const found = chart.inspect(px, py);
chart.on("render", () => chart.getPanels().map(({ plot, x }) => [plot.width, x?.domain]));
[where, label, found?.points];

// Hiding series
const [first] = chart.getLegend();
chart.setVisibility(first!.key, false);
const hidden: readonly string[] = chart.getHiddenKeys();
chart.setHiddenKeys(hidden);
chart.on("visibility", ({ hiddenKeys }) => hiddenKeys.length);

// Tooltips
declare const daily: Float64Array;
const latencyTable = table({ time: time(daily), p99: daily, requests: daily });
createChart(element, {
  locale: "en-US",
  marks: [
    line(latencyTable, {
      x: "time",
      y: "p99",
      tooltip: { fields: [{ field: "requests", label: "Requests" }] },
    }),
  ],
  x: { tooltipFormat: { weekday: "short", month: "short", day: "numeric" } },
  y: { title: "ms", tooltipFormat: { style: "unit", unit: "millisecond" } },
});
createChart(element, {
  marks: [line(latencyTable, { x: "time", y: "p99" })],
  renderTooltip: ({ points }) => `${points[0]?.text ?? ""} ms`,
});

// Export of a mounted chart
async function exportChart() {
  chart.toSVG();
  await chart.toPNG({ scale: 2 });
  renderToPDF(chart);
}
void exportChart;
