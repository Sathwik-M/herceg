// The README examples, compiled by `npm run typecheck` so the docs stay true.
import {
  area,
  bar,
  candlestick,
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
  y: { label: "ms" },
});
chart.setViewport([0, 1]);
chart.update({ theme: "dark", interaction: { zoom: true, sync: "dashboard" } });

// Data
const requests = table({ time: time(timestamps), latency: latencies, service: serviceNames });
requests.numbers("latency");
requests.categories("service");
fromRows([{ at: new Date(), value: 1 }]);
const encoded = table({ host: encodedCategory(new Int32Array([0, -1]), ["web"]), v: [1, 2] });
line(encoded, { x: "v", y: "v", series: "host" });

const live = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
live.append({ time: [Date.now()], cpu: [0.42] });
live.appendRow({ time: Date.now(), cpu: 0.4 });
live.set("cpu", 0, 0.5);
live.replace("cpu", 0, [0.1, 0.2]);
live.dropBefore("time", Date.now() - 60_000);
live.reset({ time: newTimes, cpu: newValues });

// Marks
line(metrics, { x: "time", y: ["p50", "p99"] });
line(requests, { x: "time", y: "latency", series: "service" });
const usage = table({ time: time(timestamps), user: userCpu, system: systemCpu });
area(usage, { x: "time", y: "user" });
area(usage, { x: "time", y: ["user", "system"], stack: true });
area(metrics, { x: "time", y1: "p50", y2: "p99" });
rule({ y: 250, label: "SLO" });
rule({ x: deployTime });
// @ts-expect-error series must be a category field
line(requests, { x: "time", y: "latency", series: "latency" });
// @ts-expect-error y must be numeric
line(requests, { x: "time", y: "service" });

// Annotations
const deploys = table({ at: time([Date.now()]), version: ["v2"], build: [42] });
rule({ y: 250, label: "SLO" });
rule({ x: new Date(), label: "now" });
rule(deploys, { x: "at", text: "version" });
rule(deploys, { x: "at", text: "build" });
// @ts-expect-error rule positions are number or time fields
rule(deploys, { x: "version" });
// @ts-expect-error times cannot be drawn as text
rule(deploys, { x: "at", text: "at" });
region({ x1: new Date(0), x2: new Date(), label: "window" });
region(deploys, { x1: "at", x2: Date.now(), text: "version" });
text({ x: 1, y: 2, label: "note" });
text(deploys, { x: "at", y: "build", text: "version", dy: -8 });
// @ts-expect-error constant text needs a label
text({ x: 1, y: 2 });
// @ts-expect-error text from data takes a label or a text field, not both
text(deploys, { x: "at", y: "build", label: "a", text: "version" });
// @ts-expect-error text from data needs a label or a text field
text(deploys, { x: "at", y: "build" });

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
  y: { label: "ms" },
  yRight: { label: "requests/s" },
});
// @ts-expect-error marks go on the left or right axis
line(traffic, { x: "time", y: "requests", axis: "top" });

// Small multiples
declare const targets: Float64Array;
const regional = table({ week: timestamps, units: latencies, region: serviceNames });
const goals = table({ week: timestamps, target: targets });
createChart(element, {
  marks: [
    line(regional, { x: "week", y: "units" }),
    line(goals, { x: "week", y: "target", facet: "repeat" }),
    rule({ y: 100, label: "goal" }),
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
bar(sales, { x: "region", y: "q1", labels: { style: "percent" } });
bar(sales, { x: ["q1", "q2"], y: "region", stack: true });
// @ts-expect-error horizontal bar lengths must be numeric
bar(sales, { x: "team", y: "region" });
// @ts-expect-error several length fields on x need a category y
bar(sales, { x: ["q1", "q2"], y: "q1" });
// @ts-expect-error horizontal bars have no right axis
bar(sales, { x: "q1", y: "region", axis: "right" });
point(metrics, { x: "p50", y: "p99", r: 3 });
// @ts-expect-error point x must be numeric
point(sales, { x: "region", y: "q1" });
const load = table({ hour: time(timestamps), host: serviceNames, cpu: latencies });
heatmap(load, { x: "hour", y: "host", value: "cpu" });
// @ts-expect-error heatmap values must be numeric
heatmap(load, { x: "hour", y: "host", value: "host" });

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
point(cars, { x: "weight", y: "mpg", series: "origin", r: 3 });
const stats = table({ group: regions, low: q1Sales, high: q2Sales });
errorBar(stats, { x: "group", y1: "low", y2: "high" });
errorBar(stats, { x: "group", y: "low", yError: "high" });
const hostLoad = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(hostLoad, { x: "hour", y: "host", value: "cpu" });

// Custom marks
custom({ draw: ({ circle, plot }) => circle(plot.x, plot.y, 3) });
custom(metrics, {
  x: "time",
  y: ["p50", "p99"],
  draw({ table: data, x, y, line: segment }) {
    const t = data.numbers("time");
    const low = data.numbers("p50");
    const high = data.numbers("p99");
    for (let i = 0; i < t.length; i++) segment(x(t[i]!), y(low[i]!), x(t[i]!), y(high[i]!));
  },
});
// @ts-expect-error custom fields are number or time fields of the table
custom(sales, { x: "region", draw() {} });
// @ts-expect-error marks without a table have none in their context
custom({ draw: ({ table: none }) => none });

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
