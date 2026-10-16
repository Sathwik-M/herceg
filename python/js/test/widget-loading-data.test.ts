// The notebook widget taking Python's node positions, category selection,
// and data while a subplot chart's first scene waits for the guide
// compiler. A test file of its own: each runs in a page of its own, where
// the compiler has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import widgetModule, { type Snapshot } from "../widget.ts";
import { itemChart } from "./items.ts";
import { MockModel, number, snapshot } from "./widget-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("keeps node positions, a category selection, and data sent before the panels are known", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  const fixture = itemChart("graph");
  const [network] = fixture.spec.marks;
  const cats = (dictionary: string[]) => ({
    c: { type: "category" as const, codes: 3, dictionary },
    v: number(4),
  });
  const spec = {
    ...fixture.spec,
    interaction: { drag: true, brush: "x" },
    panels: [{ id: "g" }, { id: "a" }],
    layout: { type: "grid", columns: [1, 1] },
    data: { ...fixture.spec.data, cats: { columns: cats(["a", "b", "c"]) } },
    // A panel's legend needs the guide compiler, which loads first.
    guides: [{ type: "legend", panel: "a" }],
    marks: [
      { ...network!, panel: "g" },
      { type: "bar", x: "c", y: "v", data: "cats", panel: "a" },
    ],
  } as Snapshot["spec"];
  const buffers = [...fixture.buffers, new Int32Array([0, 1, 2]), new Float64Array([1, 2, 3])];
  const model = new MockModel({ _chart: { ...snapshot(), spec, buffers }, _listening: [] });
  const widget = widgetModule();
  cleanups.push(widget.initialize({ model }));
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  cleanups.push(widget.render({ model, el: host }), () => host.remove());
  const chart = listener.mock.instances[0] as MountedChart;
  expect(chart.getPanels()).toEqual([]);
  // Before the first scene: a node's place, a selection of categories, and
  // the same rows again.
  model.receive({
    type: "itemMove",
    revision: 1,
    item_positions: { '[0,"East"]': [10, 20] },
    panel: "g",
  });
  model.receive({
    type: "select",
    revision: 2,
    selection: { x: ["b", "c"], y: null, lasso: null, panels: ["a"], time: [] },
  });
  const again = {
    c: { type: "category" as const, codes: 0, dictionary: ["a", "b", "c"] },
    v: number(1),
  };
  model.receive({ type: "replace", revision: 3, table: "cats", columns: again }, [
    new Int32Array([0, 1, 2]),
    new Float64Array([1, 2, 3]),
  ]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await chart.loading;
  await frame();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(chart.getItemPositions({ panel: "g" })['[0,"East"]']).toEqual({ x: 10, y: 20 });
  expect(chart.selection?.x).toEqual([1, 2]);
  expect(chart.selectionPanels).toEqual(["a"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Python heard nothing of the node moving back or the selection going.
  expect(
    model
      .messages("itemMove")
      .filter(({ item_positions }) => !Object.keys(item_positions as object).length),
  ).toEqual([]);
  expect(model.messages("select").filter(({ selection }) => selection === null)).toEqual([]);
});
