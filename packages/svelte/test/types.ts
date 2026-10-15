// Compile-time checks of the component types, run by `npm run typecheck`
// (svelte-check). Markup is checked through the same component signatures
// these calls use, but cannot expect errors, so failing cases are written
// here; `Readme.svelte` holds the README's examples.
import { type Chart as HercegChart, table, time } from "herceg";
import type { ComponentProps } from "svelte";
import {
  Area,
  Bar,
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
} from "../src/index.js";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;
/** Svelte's own first argument of a component. */
declare const internals: never;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });
Area(internals, {
  data: metrics,
  x: "time",
  y: ["p50", "p99"],
  stack: { offset: "wiggle", order: "inside-out" },
});
Bar(internals, { data: metrics, x: "time", y: ["p50", "p99"], stack: "fill" });
// @ts-expect-error bars refuse stream offsets
Bar(internals, { data: metrics, x: "time", y: "p50", stack: "wiggle" });
const deploys = table({ at: time([Date.now()]), version: ["v2"] });

Line(internals, { data: metrics, x: "time", y: ["p50", "p99"] });
Line(internals, { data: metrics, x: "time", y: "p50", series: "service" });
// @ts-expect-error fields are checked against the component's data
Line(internals, { data: metrics, x: "time", y: "missing" });
// @ts-expect-error along x, a category field is not a numeric encoding
Line(internals, { data: metrics, x: "time", y: "service", orient: "x" });
// A category y lays a line along y, its values on x.
Line(internals, { data: metrics, x: "p50", y: "service" });
// A category field places points in its bands; sizes stay numeric.
Point(internals, { data: metrics, x: "service", y: "p50" });
// @ts-expect-error point sizes are number fields
Point(internals, { data: metrics, x: "service", y: "p50", size: "service" });

// Areas of a series field stack on every x any of them has.
Area(internals, { data: metrics, x: "time", y: "p50", series: "service", stack: true });
Area(internals, {
  data: metrics,
  x: "time",
  y: "p50",
  series: "service",
  stack: { gaps: "interpolate" },
});
// @ts-expect-error gaps are zero or interpolated
Area(internals, { data: metrics, x: "time", y: "p50", stack: { gaps: "linear" } });

Rule(internals, { y: 250, label: "SLO" });
Rule(internals, { data: deploys, x: "at", label: { field: "version" } });
// @ts-expect-error rule positions from data are number or time fields
Rule(internals, { data: deploys, x: "version" });
// @ts-expect-error with data, text is a field of it, also next to constant positions
Rule(internals, { data: deploys, x: 5, label: { field: "missing" } });
Text(internals, { x: Date.now(), y: 100, label: { text: "now", style: { align: "end" } } });
// @ts-expect-error constant text needs a label
Text(internals, { x: 1, y: 2 });
// @ts-expect-error text from data needs a label
Text(internals, { data: deploys, x: "at", y: 1 });

// `draw` is typed from the table when there is one.
Custom(internals, { data: metrics, x: "time", draw: ({ table }) => table.numbers("p50") });
Custom(internals, { draw: ({ text }) => text(1, 2, "label") });
Custom(internals, {
  data: metrics,
  x: "time",
  y: "p50",
  series: "service",
  pointText: (row, format, s) => format.y(s.y[row]!),
  draw: ({ series }) => series.map((s) => s.color),
});
// @ts-expect-error a custom mark's series field is a category field
Custom(internals, { data: metrics, x: "time", y: "p50", series: "p99", draw: () => {} });
// @ts-expect-error x is a field of data
Custom(internals, { data: metrics, x: "missing", draw: () => {} });
// @ts-expect-error without data, draw gets no table
Custom(internals, { draw: ({ table }) => table });
// @ts-expect-error data is a table
Custom(internals, { data: 5, draw: () => {} });

type ChartProps = ComponentProps<typeof Chart>;
export const options: ChartProps = {
  title: "Request latency",
  y: { title: "ms" },
  interaction: { zoom: true },
  onselect: ({ x }) => x?.[0].toFixed(),
  onviewport: ({ x, y, yRight }) => [x, y, yRight],
  onhover: ({ inspection }) => inspection?.points.map(({ mark, row }) => [mark, row]),
};
// @ts-expect-error chart options keep herceg's types
export const wrongTitle: ChartProps = { title: 3 };
// @ts-expect-error handlers receive the event's payload
export const wrongHandler: ChartProps = { onviewport: (domain: number) => domain };
export const bound: HercegChart | null | undefined = options.chart;

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
BoxPlot(internals, { data: boxData, x: "group", ...boxFields });
BoxPlot(internals, { data: boxData, y: "group", ...boxFields, count: "count", notch: true });
BoxPlot(internals, { data: boxData, x: "group", y: "median", whiskers: "range", notch: true });
BoxPlot(internals, { data: boxData, x: "group", y: "median", whiskers: 2 });
// @ts-expect-error raw and precomputed forms exclude each other
BoxPlot(internals, { data: boxData, x: "group", y: "median", ...boxFields });
// @ts-expect-error precomputed whisker ends forbid whiskers
BoxPlot(internals, { data: boxData, x: "group", ...boxFields, whiskers: "range" });
// @ts-expect-error precomputed notches need count
BoxPlot(internals, { data: boxData, x: "group", ...boxFields, notch: true });
// @ts-expect-error statistic fields must be numeric
BoxPlot(internals, { data: boxData, x: "group", ...boxFields, low: "group" });

const tips = table({ day: ["thu"], sex: ["f"], tip: [1], low: [0], high: [2] });
Point(internals, {
  data: tips,
  x: "day",
  y: "tip",
  series: "sex",
  dodge: true,
  jitter: { width: 0.4 },
});
ErrorBar(internals, { data: tips, x: "day", y1: "low", y2: "high", series: "sex", dodge: true });
Line(internals, { data: tips, x: "day", y: "tip", color: "sex" });
Line(internals, { data: tips, x: "day", y: "tip", color: "sex", series: false });
// @ts-expect-error jitter takes a width
Point(internals, { data: tips, x: "day", y: "tip", jitter: { seed: 2 } });

Histogram(internals, {
  data: metrics,
  y: "p50",
  bins: [0, 1, 2] as const,
  normalize: "probability",
  commonNorm: true,
  cumulative: true,
  dodge: true,
});

Histogram(internals, { data: metrics, x: "time", axis: "right", stack: true, cumulative: true });

// With x and y both, a 2D histogram's cells.
Histogram(internals, { data: metrics, x: "time", y: "p50", bins: { x: 20, y: 10 } });

// @ts-expect-error 2D histograms take no stacks
Histogram(internals, { data: metrics, x: "time", y: "p50", stack: true });

// @ts-expect-error binned axis required
Histogram(internals, { data: metrics, bins: 10 });

// @ts-expect-error binned fields are numeric or time
Histogram(internals, { data: metrics, y: "service" });

// @ts-expect-error horizontal histograms cannot use the right axis
Histogram(internals, { data: metrics, y: "p50", axis: "right" });

// @ts-expect-error dodge and stack exclude each other
Histogram(internals, { data: metrics, x: "time", dodge: true, stack: true });
const linkage = table({ first: [0], second: [1], height: [2], label: ["a"], timestamp: time([0]) });
const treeProps = {
  data: linkage,
  first: "first",
  second: "second",
  height: "height",
  leaves: ["a", "b"],
} as const;
Dendrogram(internals, { ...treeProps, side: "right", facet: "repeat", panel: "tree" });
// @ts-expect-error fields must exist
Dendrogram(internals, { ...treeProps, first: "missing" });
// @ts-expect-error child ids are number fields
Dendrogram(internals, { ...treeProps, first: "label" });
// @ts-expect-error heights cannot be time fields
Dendrogram(internals, { ...treeProps, height: "timestamp" });
// @ts-expect-error leaves are string category labels
Dendrogram(internals, { ...treeProps, leaves: [1, 2] });
// @ts-expect-error data is required
Dendrogram(internals, { first: "first", second: "second", height: "height", leaves: [] });
Rug(internals, { data: metrics, x: "time", side: "top", series: "service" });
Rug(internals, { data: metrics, y: "p50", side: "right" });
// @ts-expect-error exactly one observed axis
Rug(internals, { data: metrics, x: "time", y: "p50" });
// @ts-expect-error an observed axis is required
Rug(internals, { data: metrics });
// @ts-expect-error rugs observe numeric or time fields
Rug(internals, { data: metrics, x: "service" });
// @ts-expect-error x ticks stand at bottom or top
Rug(internals, { data: metrics, x: "time", side: "left" });
// @ts-expect-error y rugs cannot use the right value axis
Rug(internals, { data: metrics, y: "p50", axis: "right" });

Boxen(internals, { data: metrics, x: "service", y: "p50", depth: "trustworthy" });
Boxen(internals, { data: metrics, x: "p50", y: "service", depth: 4, outliers: false });
// @ts-expect-error widthMethod takes the supported rules
Boxen(internals, { data: metrics, x: "service", y: "p50", widthMethod: "square" });
// @ts-expect-error boxen takes no whiskers
Boxen(internals, { data: metrics, x: "service", y: "p50", whiskers: "tukey" });

Violin(internals, {
  data: metrics,
  x: "service",
  y: "p50",
  series: "service",
  split: true,
  inner: "quartiles",
});
Violin(internals, { data: metrics, x: "p50", y: "service", inner: "none" });
// @ts-expect-error inner takes only the supported interiors
Violin(internals, { data: metrics, x: "service", y: "p50", inner: "points" });
// @ts-expect-error split is boolean
Violin(internals, { data: metrics, x: "service", y: "p50", split: "true" });
// @ts-expect-error a series field is categorical
Violin(internals, { data: metrics, x: "service", y: "p50", series: "p50", split: true });
