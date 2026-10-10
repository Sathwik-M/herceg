// Compile-time tests: checked by `npm run typecheck`, never executed.
import { selectionStore } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { loadSpec } from "../../src/spec/load.ts";

declare const element: HTMLElement;
const trips = table({ km: [1, 2], fare: [5, 9], kind: ["a", "b"] });
const stops = table({ t: [0, 1], n: [3, 4] });
const focus = selectionStore(trips);
const near = selectionStore(stops);

// Bindings of tables of different schemas, each typed by its own.
const chart = createChart(element, {
  marks: [point(trips, { x: "km", y: "fare" }), line(stops, { x: "t", y: "n" })],
  interaction: { brush: "xy" },
  rowSelection: rowSelection(
    { store: focus, channel: "focus" },
    { store: near, channel: "near", events: ["click"], effect: "none" },
  ),
});
chart.on("rowSelection", ({ table: changed, channel, selection }) => {
  changed.length satisfies number;
  channel satisfies string;
  if (selection?.kind === "rows") selection.rows.size satisfies number;
});
chart.on("select", ({ rows }) => rows?.[0]?.selection);
chart.on("click", ({ rows }) => rows?.length);
// A selection shown without writing its rows, as when mirroring another view.
chart.select([1, 2], { rows: false });

// @ts-expect-error gestures are brushes, lassos, and clicks
rowSelection({ store: focus, channel: "focus", events: ["drag"] });
// @ts-expect-error effects are highlight or none
rowSelection({ store: focus, channel: "focus", effect: "filter" });
// @ts-expect-error a binding names its channel
rowSelection({ store: focus });

// The loader takes tables and stores of any schema, by name, or another spec's.
loadSpec({ marks: [] }, [], { tables: { trips, stops }, stores: { trips: focus } });
const loaded = loadSpec({ marks: [] });
loadSpec({ marks: [] }, [], { tables: loaded.tables, stores: loaded.stores });
loadSpec({ marks: [] }, [], { stores: new Map([["trips", focus]]) });
