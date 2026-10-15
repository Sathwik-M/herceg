// Compile-time checks of the component types, run by `npm run typecheck`.
// Vue's template type checker (vue-tsc) checks a mark component in a
// template by calling it with the props written there, and <Chart> against
// its `$props`, so these lines check what templates check.
import { type Chart as HercegChart, table, time } from "herceg";
import {
  Boxen,
  BoxPlot,
  type Chart,
  Custom,
  Dendrogram,
  ErrorBar,
  Histogram,
  Line,
  Point,
  Rug,
  Rule,
  Text,
  Violin,
} from "../src/index.ts";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });
const deploys = table({ at: time([Date.now()]), version: ["v2"] });

Line({ data: metrics, x: "time", y: ["p50", "p99"] });
Line({ data: metrics, x: "time", y: "p50", series: "service" });
// @ts-expect-error fields are checked against the component's data
Line({ data: metrics, x: "time", y: "missing" });
// @ts-expect-error along x, a category field is not a numeric encoding
Line({ data: metrics, x: "time", y: "service", orient: "x" });
// A category y lays a line along y, its values on x.
Line({ data: metrics, x: "p50", y: "service" });
// A category field places points in its bands; sizes stay numeric.
Point({ data: metrics, x: "service", y: "p50" });
// @ts-expect-error point sizes are number fields
Point({ data: metrics, x: "service", y: "p50", size: "service" });

// The template checker passes `:data` as a call expression, from which
// TypeScript cannot tell union members apart; `unwrap` stands in for it.
const unwrap = <T>(value: T) => value;

Rule({ y: 250, label: "SLO" });
Rule({ data: unwrap(deploys), x: "at", label: { field: "version" } });
// @ts-expect-error rule positions from data are number or time fields
Rule({ data: unwrap(deploys), x: "version" });
// @ts-expect-error with data, text is a field of it, also next to constant positions
Rule({ data: unwrap(deploys), x: 5, label: { field: "missing" } });
Text({ x: Date.now(), y: 100, label: { text: "now", style: { align: "end" } } });
// @ts-expect-error constant text needs a label
Text({ x: 1, y: 2 });
// @ts-expect-error text from data needs a label
Text({ data: unwrap(deploys), x: "at", y: 1 });

// `draw` is typed from the table when there is one.
Custom({ data: unwrap(metrics), x: "time", draw: ({ table }) => table.numbers("p50") });
Custom({ draw: ({ text }) => text(1, 2, "label") });
// @ts-expect-error x is a field of data
Custom({ data: unwrap(metrics), x: "missing", draw: () => {} });
// @ts-expect-error without data, draw gets no table
Custom({ draw: ({ table }) => table });
// @ts-expect-error data is a table
Custom({ data: 5, draw: () => {} });

type ChartProps = InstanceType<typeof Chart>["$props"];
export const options: ChartProps = {
  title: "Request latency",
  y: { title: "ms" },
  interaction: { zoom: true },
  legend: true,
  onSelect: ({ x }) => x?.[0].toFixed(),
  onViewport: ({ x, y, yRight }) => [x, y, yRight],
  onHover: ({ inspection }) => inspection?.points.map(({ mark, row }) => [mark, row]),
};
// @ts-expect-error chart options keep herceg's types
export const wrongTitle: ChartProps = { title: 3 };
// @ts-expect-error listeners receive the event's payload
export const wrongListener: ChartProps = { onViewport: (domain: number) => domain };

// A template ref exposes the chart and nothing else of the component.
declare const instance: InstanceType<typeof Chart>;
export const chart: HercegChart | null = instance.chart;
// @ts-expect-error the render function is internal
instance.renderChart;

const boxData = table({
  group: ["a"],
  low: [0],
  q1: [1],
  median: [2],
  q3: [3],
  high: [4],
  count: [20],
});
const boxFields = { low: "low", q1: "q1", median: "median", q3: "q3", high: "high" } as const;
BoxPlot({ data: boxData, x: "group", ...boxFields });
BoxPlot({ data: boxData, y: "group", ...boxFields, count: "count", notch: true });
BoxPlot({ data: boxData, x: "group", y: "median", whiskers: "range", notch: true });
BoxPlot({ data: boxData, x: "group", y: "median", whiskers: 2 });
// @ts-expect-error raw and precomputed forms exclude each other
BoxPlot({ data: boxData, x: "group", y: "median", ...boxFields });
// @ts-expect-error precomputed whisker ends forbid whiskers
BoxPlot({ data: boxData, x: "group", ...boxFields, whiskers: "range" });
// @ts-expect-error precomputed notches need count
BoxPlot({ data: boxData, x: "group", ...boxFields, notch: true });
// @ts-expect-error statistic fields must be numeric
BoxPlot({ data: boxData, x: "group", ...boxFields, low: "group" });

const tips = table({ day: ["thu"], sex: ["f"], tip: [1], low: [0], high: [2] });
Point({ data: tips, x: "day", y: "tip", series: "sex", dodge: true, jitter: { width: 0.4 } });
ErrorBar({ data: tips, x: "day", y1: "low", y2: "high", series: "sex", dodge: true });
Line({ data: tips, x: "tip", y: "tip", legendGroup: "sex" });
// @ts-expect-error jitter takes a width
Point({ data: tips, x: "day", y: "tip", jitter: { seed: 2 } });

Histogram({
  data: metrics,
  y: "p50",
  bins: [0, 1, 2] as const,
  normalize: "probability",
  commonNorm: true,
  cumulative: true,
  dodge: true,
});

Histogram({ data: metrics, x: "time", axis: "right", stack: true, cumulative: true });

// With x and y both, a 2D histogram's cells.
Histogram({ data: metrics, x: "time", y: "p50", bins: { x: 20, y: 10 } });

// @ts-expect-error 2D histograms take no stacks
Histogram({ data: metrics, x: "time", y: "p50", stack: true });

// @ts-expect-error binned axis required
Histogram({ data: metrics, bins: 10 });

// @ts-expect-error binned fields are numeric or time
Histogram({ data: metrics, y: "service" });

// @ts-expect-error horizontal histograms cannot use the right axis
Histogram({ data: metrics, y: "p50", axis: "right" });

// @ts-expect-error dodge and stack exclude each other
Histogram({ data: metrics, x: "time", dodge: true, stack: true });
const linkage = table({ first: [0], second: [1], height: [2], label: ["a"], timestamp: time([0]) });
const treeProps = {
  data: linkage,
  first: "first",
  second: "second",
  height: "height",
  leaves: ["a", "b"],
} as const;
Dendrogram({ ...treeProps, side: "right", facet: "repeat", panel: "tree" });
// @ts-expect-error fields must exist
Dendrogram({ ...treeProps, first: "missing" });
// @ts-expect-error child ids are number fields
Dendrogram({ ...treeProps, first: "label" });
// @ts-expect-error heights cannot be time fields
Dendrogram({ ...treeProps, height: "timestamp" });
// @ts-expect-error leaves are string category labels
Dendrogram({ ...treeProps, leaves: [1, 2] });
// @ts-expect-error data is required
Dendrogram({ first: "first", second: "second", height: "height", leaves: [] });
Rug({ data: metrics, x: "time", side: "top", series: "service" });
Rug({ data: metrics, y: "p50", side: "right" });
// @ts-expect-error exactly one observed axis
Rug({ data: metrics, x: "time", y: "p50" });
// @ts-expect-error an observed axis is required
Rug({ data: metrics });
// @ts-expect-error rugs observe numeric or time fields
Rug({ data: metrics, x: "service" });
// @ts-expect-error x ticks stand at bottom or top
Rug({ data: metrics, x: "time", side: "left" });
// @ts-expect-error y rugs cannot use the right value axis
Rug({ data: metrics, y: "p50", axis: "right" });

Boxen({ data: metrics, x: "service", y: "p50", series: "service", depth: "trustworthy" });
Boxen({ data: metrics, x: "p50", y: "service", depth: 4, widthMethod: "area", outliers: false });
// @ts-expect-error widthMethod takes the supported rules
Boxen({ data: metrics, x: "service", y: "p50", widthMethod: "square" });
// @ts-expect-error boxen takes no whiskers
Boxen({ data: metrics, x: "service", y: "p50", whiskers: "tukey" });

Violin({
  data: metrics,
  x: "service",
  y: "p50",
  series: "service",
  split: true,
  inner: "quartiles",
});
Violin({ data: metrics, x: "p50", y: "service", inner: "none" });
// @ts-expect-error inner takes only the supported interiors
Violin({ data: metrics, x: "service", y: "p50", inner: "points" });
// @ts-expect-error split is boolean
Violin({ data: metrics, x: "service", y: "p50", split: "true" });
// @ts-expect-error a series field is categorical
Violin({ data: metrics, x: "service", y: "p50", series: "p50", split: true });
