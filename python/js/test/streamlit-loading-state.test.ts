// Streamlit reruns while the guide compiler loads that change what the
// user's state was kept by: the network's items and a camera's default. A
// test file of its own: each runs in a page of its own, where the compiler
// has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import type { Header } from "../streamlit.ts";
import { payload, run } from "./streamlit-payload.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("lets moves and turns go that a rerun before loading no longer keeps", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = document.createElement("div");
    parent.style.width = "600px";
    document.body.append(parent);
    hosts.push(parent);
    const spec = (azimuth: number, guides: boolean, title = "Chart") =>
      ({
        title,
        width: 600,
        height: 300,
        renderer: "svg",
        interaction: { drag: true, zoom: true },
        panels: [{ id: "g" }, { id: "c", camera: { azimuth } }, { id: "a" }],
        layout: { type: "grid", columns: [1, 1, 1] },
        data: {
          links: {
            columns: {
              from: { type: "category", codes: 0, dictionary: ["East", "West"] },
              to: { type: "category", codes: 1, dictionary: ["A", "B"] },
              v: { type: "number", dtype: "float64", buffer: 2 },
            },
          },
        },
        // A panel's legend needs the guide compiler, which loads first.
        ...(guides && { guides: [{ type: "legend", panel: "a" }] }),
        marks: [
          { type: "graph", data: "links", source: "from", target: "to", panel: "g" },
          { type: "point3d", x: "v", y: "v", z: "v", data: "links", panel: "c" },
          { type: "line", x: "v", y: "v", data: "links", panel: "a" },
        ],
      }) as Header["spec"];
    const buffers = [new Int32Array([0, 1]), new Int32Array([0, 1]), new Float64Array([1, 2])];
    const send = (azimuth: number, guides: boolean, items: string, title?: string) =>
      run(
        parent,
        payload(
          spec(azimuth, guides, title),
          buffers,
          ["itemMove", "camera", "viewport"],
          3,
          undefined,
          items,
        ),
      );
    send(20, false, "e1");
    const first = listener.mock.instances.at(-1) as MountedChart;
    await first.loading;
    first.render();
    first.setItemPosition('[0,"East"]', { x: 10, y: 20 }, { panel: "g" });
    first.setCamera({ azimuth: 40 }, { panel: "c" });
    first.setViewport({ x: [0, 0.5], y: [0, 0.5] }, { panel: "g" });
    // New items and a new default, then a title: two runs while the compiler loads.
    send(80, true, "e2");
    expect((listener.mock.instances.at(-1) as MountedChart).getPanels()).toEqual([]);
    send(80, true, "e2", "Again");
    // The run that came meanwhile is drawn once the waiting chart is done.
    await (listener.mock.instances.at(-1) as MountedChart).loading;
    await frame();
    const last = listener.mock.instances.at(-1) as MountedChart;
    expect(last.getItemPositions({ panel: "g" })).toEqual({});
    expect(last.getCamera({ panel: "c" })?.azimuth).toBe(80);
    // The network's view was of the old items.
    expect(last.getViewport({ panel: "g" }).x).toBeNull();
  } finally {
    listener.mockRestore();
  }
});
