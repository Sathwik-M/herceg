// Compile-time tests: checked by `npm run typecheck`, never executed.
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";

declare const element: HTMLElement;
declare const maybeTitle: string | undefined;
const data = table({ x: [0, 1], y: [1, 2] });
const chart = createChart(element, { marks: [line(data, { x: "x", y: "y" })] });

// Undefined resets an option to its default; values replace it.
chart.update({ title: undefined, theme: "dark" });
chart.update({ title: maybeTitle, y: { label: "ms" } });
// Marks can be replaced, never unset.
chart.update({ marks: [line(data, { x: "x", y: "y" })] });
// @ts-expect-error a chart always has marks
chart.update({ marks: undefined });
// @ts-expect-error options are checked as ever
chart.update({ theme: "sepia" });
