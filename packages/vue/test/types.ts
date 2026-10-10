// Compile-time checks of the component types, run by `npm run typecheck`.
// Vue's template type checker (vue-tsc) checks a mark component in a
// template by calling it with the props written there, and <Chart> against
// its `$props`, so these lines check what templates check.
import { type Chart as HercegChart, table, time } from "herceg";
import { BoxPlot, type Chart, Custom, Line, Point, Rule, Text } from "../src/index.ts";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });
const deploys = table({ at: time([Date.now()]), version: ["v2"] });

Line({ data: metrics, x: "time", y: ["p50", "p99"] });
Line({ data: metrics, x: "time", y: "p50", series: "service" });
// @ts-expect-error fields are checked against the component's data
Line({ data: metrics, x: "time", y: "missing" });
// @ts-expect-error a category field is not a numeric encoding
Line({ data: metrics, x: "time", y: "service" });
// A category field places points in its bands; sizes stay numeric.
Point({ data: metrics, x: "service", y: "p50" });
// @ts-expect-error point sizes are number fields
Point({ data: metrics, x: "service", y: "p50", r: "service" });

// The template checker passes `:data` as a call expression, from which
// TypeScript cannot tell union members apart; `unwrap` stands in for it.
const unwrap = <T>(value: T) => value;

Rule({ y: 250, label: "SLO" });
Rule({ data: unwrap(deploys), x: "at", text: "version" });
// @ts-expect-error rule positions from data are number or time fields
Rule({ data: unwrap(deploys), x: "version" });
// @ts-expect-error with data, text is a field of it, also next to constant positions
Rule({ data: unwrap(deploys), x: 5, text: "missing" });
Text({ x: Date.now(), y: 100, label: "now", anchor: "end" });
// @ts-expect-error constant text needs a label
Text({ x: 1, y: 2 });
// @ts-expect-error text from data needs a label or a text field
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
  y: { label: "ms" },
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
