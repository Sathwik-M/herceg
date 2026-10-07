// The README examples, compiled by `npm run typecheck` so the docs stay true.
import {
  area,
  bar,
  createChart,
  fromRows,
  heatmap,
  line,
  point,
  renderToSVG,
  rule,
  table,
  time,
} from "../../src/index.ts";

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

// Server rendering
renderToSVG({ width: 640, height: 320, marks: [line(metrics, { x: "time", y: "p99" })] });

// Bars, points, heatmaps
const sales = table({ region: ["N", "S"], q1: [1, 2], q2: [3, 4], team: ["a", "b"] });
bar(sales, { x: "region", y: ["q1", "q2"] });
bar(sales, { x: "region", y: "q1", series: "team", stack: true });
// @ts-expect-error bar heights must be numeric
bar(sales, { x: "region", y: "team" });
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
const hostLoad = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(hostLoad, { x: "hour", y: "host", value: "cpu" });
