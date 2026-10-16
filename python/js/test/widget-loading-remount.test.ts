// The notebook widget drawing a chart again while the one before it waits
// for the guide compiler to restore what the user had. A test file of its
// own: each runs in a page of its own, where the compiler has not loaded.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import widgetModule, { type Snapshot } from "../widget.ts";
import { MockModel, snapshot } from "./widget-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

it("keeps what the legends hid through charts drawn before the panels are known", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  const base = snapshot();
  const [marked] = base.spec.marks;
  const subplots = (revision: number, legend: boolean): Snapshot => ({
    ...base,
    revision,
    spec: {
      ...base.spec,
      panels: [{ id: "a" }, { id: "b" }],
      layout: { type: "grid", columns: [1, 1] },
      // A panel's legend needs the guide compiler, which loads first.
      ...(legend && { guides: [{ type: "legend", panel: "a" }] }),
      marks: [
        { ...marked!, color: "host", panel: "a" },
        { ...marked!, color: "host", panel: "b" },
      ],
    } as Snapshot["spec"],
  });
  const model = new MockModel({ _chart: subplots(0, false), _listening: [] });
  const widget = widgetModule();
  cleanups.push(widget.initialize({ model }));
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  cleanups.push(widget.render({ model, el: host }), () => host.remove());
  const first = listener.mock.instances[0] as MountedChart;
  await first.loading;
  first.render();
  const [entry] = first.getLegend();
  first.setVisibility(entry!.key, false);
  // Drawn again with a panel's legend, it waits.
  model.set("_chart", subplots(1, true));
  const waiting = listener.mock.instances.at(-1) as MountedChart;
  expect(waiting.getPanels()).toEqual([]);
  // Drawn again before it is done, as one chart of no subplots.
  model.set("_chart", {
    ...base,
    revision: 2,
    spec: { ...base.spec, marks: [{ ...marked!, color: "host" }] } as Snapshot["spec"],
  });
  const last = listener.mock.instances.at(-1) as MountedChart;
  expect(last).not.toBe(waiting);
  await last.loading;
  last.render();
  expect(last.getHiddenKeys()).toEqual([entry!.key]);
});
