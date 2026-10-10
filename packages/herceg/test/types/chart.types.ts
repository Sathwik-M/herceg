// Compile-time tests: checked by `npm run typecheck`, never executed.
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";
import type { PlotRect } from "../../src/scene/scene.ts";

declare const element: HTMLElement;
declare const maybeTitle: string | undefined;
const data = table({ x: [0, 1], y: [1, 2] });
const chart = createChart(element, { marks: [line(data, { x: "x", y: "y" })] });

// Undefined resets an option to its default; values replace it.
chart.update({ title: undefined, theme: "dark" });
chart.update({ title: maybeTitle, y: { title: "ms" } });
chart.update({ x: { seams: true }, theme: { grid: "#123456" } });
chart.update({ x: { seams: { minSpacing: 40 } } });
// @ts-expect-error seam spacing is a number of CSS pixels
chart.update({ x: { seams: { minSpacing: "40" } } });
// @ts-expect-error only x axes have time-break seams
chart.update({ y: { seams: true } });
// Marks can be replaced, never unset.
chart.update({ marks: [line(data, { x: "x", y: "y" })] });
// @ts-expect-error a chart always has marks
chart.update({ marks: undefined });
// @ts-expect-error options are checked as ever
chart.update({ theme: "sepia" });

// The handle carries no engine state; marks show their spec, not how they draw.
// @ts-expect-error the model is internal
chart.model;
// @ts-expect-error frames are drawn by the scheduler or `render()`
chart.flush();
// @ts-expect-error synced charts reach each other through their sync group
chart.syncCursor(1);
const drawn = line(data, { x: "x", y: "y" });
drawn.spec.x satisfies string | readonly string[];
// @ts-expect-error drawing is internal
drawn.geometry;
// @ts-expect-error only the mark functions make marks
createChart(element, { marks: [{ spec: { type: "line" } }] });

// Panels and axes are read-only snapshots, mapped by panel and axis.
const [panel] = chart.getPanels();
panel?.x?.categories satisfies readonly string[] | undefined;
// @ts-expect-error snapshots are read-only
panel!.plot.x = 0;
chart.toPixel(1, { axis: "yRight", panel: "a" }) satisfies number | undefined;
// @ts-expect-error an axis is x, y, or yRight
chart.toPixel(1, { axis: "z" });
chart.inspect(10, 10, { mode: "nearest" });
chart.setVisibility(["a", "b"], false);
chart.on("visibility", ({ hiddenKeys }) => hiddenKeys satisfies readonly string[]);

// A custom mark's plot is the public, read-only rectangle.
custom({
  draw({ plot }) {
    plot satisfies PlotRect;
    // @ts-expect-error the chart draws with it
    plot.width = 0;
  },
});
