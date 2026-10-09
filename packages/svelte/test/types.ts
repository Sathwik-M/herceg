// Compile-time checks of the component types, run by `npm run typecheck`
// (svelte-check). Markup is checked through the same component signatures
// these calls use, but cannot expect errors, so failing cases are written
// here; `Readme.svelte` holds the README's examples.
import { type Chart as HercegChart, table, time } from "herceg";
import type { ComponentProps } from "svelte";
import { Area, type Chart, Custom, Line, Point, Rule, Text } from "../src/index.js";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;
/** Svelte's own first argument of a component. */
declare const internals: never;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });
const deploys = table({ at: time([Date.now()]), version: ["v2"] });

Line(internals, { data: metrics, x: "time", y: ["p50", "p99"] });
Line(internals, { data: metrics, x: "time", y: "p50", series: "service" });
// @ts-expect-error fields are checked against the component's data
Line(internals, { data: metrics, x: "time", y: "missing" });
// @ts-expect-error a category field is not a numeric encoding
Line(internals, { data: metrics, x: "time", y: "service" });
// A category field places points in its bands; sizes stay numeric.
Point(internals, { data: metrics, x: "service", y: "p50" });
// @ts-expect-error point sizes are number fields
Point(internals, { data: metrics, x: "service", y: "p50", r: "service" });

// Areas of a series field stack on every x any of them has.
Area(internals, { data: metrics, x: "time", y: "p50", series: "service", stack: true });
Area(internals, {
  data: metrics,
  x: "time",
  y: "p50",
  series: "service",
  stack: true,
  stackGaps: "interpolate",
});
// @ts-expect-error gaps are zero or interpolated
Area(internals, { data: metrics, x: "time", y: "p50", stack: true, stackGaps: "linear" });

Rule(internals, { y: 250, label: "SLO" });
Rule(internals, { data: deploys, x: "at", text: "version" });
// @ts-expect-error rule positions from data are number or time fields
Rule(internals, { data: deploys, x: "version" });
// @ts-expect-error with data, text is a field of it, also next to constant positions
Rule(internals, { data: deploys, x: 5, text: "missing" });
Text(internals, { x: Date.now(), y: 100, label: "now", anchor: "end" });
// @ts-expect-error constant text needs a label
Text(internals, { x: 1, y: 2 });
// @ts-expect-error text from data needs a label or a text field
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
  y: { label: "ms" },
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
