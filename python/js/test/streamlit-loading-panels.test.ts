// Streamlit reruns while the guide compiler loads that take panels away and
// bring them back: what was theirs goes with them. A test file of its own:
// each runs in a page of its own, where the compiler has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import type { Header } from "../streamlit.ts";
import { payload, run } from "./streamlit-payload.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("lets a panel's view, brush, and drill root go when a run before loading takes its mark away", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = document.createElement("div");
    parent.style.width = "600px";
    document.body.append(parent);
    hosts.push(parent);
    const line = { type: "line", x: "value", y: "value", data: "data" };
    const tree = { type: "treemap", data: "data", path: ["region", "city"], value: "value" };
    const pie = { type: "pie", data: "data", category: "region", value: "value" };
    const spec = (away: boolean, guides: boolean) =>
      ({
        width: 600,
        height: 300,
        renderer: "svg",
        interaction: { zoom: "x", brush: "x" },
        panels: [{ id: "a" }, { id: "t" }, { id: "b" }],
        layout: { type: "grid", columns: [1, 1, 1] },
        data: {
          data: {
            columns: {
              region: { type: "category", codes: 0, dictionary: ["East", "West"] },
              city: { type: "category", codes: 1, dictionary: ["A", "B", "C"] },
              value: { type: "number", dtype: "float64", buffer: 2 },
            },
          },
        },
        // A panel's legend needs the guide compiler, which loads first.
        ...(guides && { guides: [{ type: "legend", panel: "b" }] }),
        marks: [
          // a and the tree's panel keep their ids, drawing pies meanwhile.
          { ...(away ? pie : line), panel: "a" },
          { ...(away ? pie : tree), panel: "t" },
          { ...line, panel: "b" },
        ],
      }) as Header["spec"];
    const buffers = [
      new Int32Array([0, 0, 1]),
      new Int32Array([0, 1, 2]),
      new Float64Array([1, 2, 4]),
    ];
    const send = (away: boolean, guides: boolean) =>
      run(parent, payload(spec(away, guides), buffers, ["viewport", "select", "drill"]));
    send(false, false);
    const first = listener.mock.instances.at(-1) as MountedChart;
    await first.loading;
    first.render();
    first.setViewport({ x: [1.5, 3] }, { panel: "a" });
    first.select({ x: [1.6, 2.5], y: null, lasso: null }, { panel: "a" });
    first.setDrillRoot('[1,"East"]', { panel: "t" });
    expect(first.getDrillRoot({ panel: "t" })).not.toBeUndefined();
    // a's line and the tree go, then come back: two runs while the compiler loads.
    send(true, true);
    expect((listener.mock.instances.at(-1) as MountedChart).getPanels()).toEqual([]);
    send(false, true);
    // The run that came meanwhile is drawn once the waiting chart is done.
    await (listener.mock.instances.at(-1) as MountedChart).loading;
    await frame();
    const last = listener.mock.instances.at(-1) as MountedChart;
    expect(last.getViewport({ panel: "a" }).x).toBeNull();
    expect(last.selection).toBeNull();
    expect(last.getDrillRoot({ panel: "t" })?.path ?? []).toEqual([]);
  } finally {
    listener.mockRestore();
  }
});
