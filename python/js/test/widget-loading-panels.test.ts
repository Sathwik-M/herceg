// The notebook widget drawing a chart again while the one before it waits
// for the guide compiler, with other panels: a panel's own settings go with
// it. A test file of its own: each runs in a page of its own, where the
// compiler has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import widgetModule, { type Snapshot } from "../widget.ts";
import { MockModel, snapshot } from "./widget-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

it("lets a panel's settings go with it through charts drawn before the panels are known", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  const base = snapshot();
  const [marked] = base.spec.marks;
  const subplots = (revision: number, ids: [string, string], legend: boolean): Snapshot => ({
    ...base,
    revision,
    spec: {
      ...base.spec,
      panels: ids.map((id) => ({ id })),
      layout: { type: "grid", columns: [1, 1] },
      // A panel's legend needs the guide compiler, which loads first.
      ...(legend && { guides: [{ type: "legend", panel: "b" }] }),
      marks: ids.map((panel) => ({ ...marked!, color: "host", panel })),
    } as Snapshot["spec"],
  });
  const model = new MockModel({ _chart: subplots(0, ["a", "b"], false), _listening: [] });
  const widget = widgetModule();
  cleanups.push(widget.initialize({ model }));
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  cleanups.push(widget.render({ model, el: host }), () => host.remove());
  const first = listener.mock.instances[0] as MountedChart;
  await first.loading;
  first.render();
  // Hidden in the chart, shown in a.
  const [entry] = first.getLegend();
  first.setVisibility(entry!.key, false);
  first.setVisibility(entry!.key, true, { panel: "a" });
  // Drawn with c in a's place, it waits; drawn with a again before it is done.
  model.set("_chart", subplots(1, ["c", "b"], true));
  expect((listener.mock.instances.at(-1) as MountedChart).getPanels()).toEqual([]);
  model.set("_chart", subplots(2, ["a", "b"], true));
  const last = listener.mock.instances.at(-1) as MountedChart;
  await last.loading;
  last.render();
  // a is a new panel: it shows the chart's visibility.
  expect(last.getHiddenKeys()).toEqual([entry!.key]);
  expect(last.getHiddenKeys({ panel: "a" })).toEqual([entry!.key]);
});
