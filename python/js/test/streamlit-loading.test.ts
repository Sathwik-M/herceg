// The Streamlit component rerunning into a subplot chart whose first scene
// waits for the guide compiler. A test file of its own: each runs in a page
// of its own, where the compiler has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import type { Header } from "../streamlit.ts";
import { payload, run } from "./streamlit-payload.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function host(): HTMLElement {
  const element = document.createElement("div");
  element.style.width = "400px";
  document.body.append(element);
  hosts.push(element);
  return element;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("keeps a subplot network's moved node across a rerun waiting for its guides", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const spec = (guides: boolean) =>
      ({
        width: 400,
        height: 200,
        renderer: "svg",
        interaction: { drag: true },
        panels: [{ id: "g" }, { id: "a" }],
        layout: { type: "grid", columns: [1, 1] },
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
          { type: "line", x: "v", y: "v", data: "links", panel: "a" },
        ],
      }) as Header["spec"];
    const buffers = [new Int32Array([0, 1]), new Int32Array([0, 1]), new Float64Array([1, 2])];
    run(parent, payload(spec(false), buffers, ["itemMove"], 3, undefined, "network"));
    const chart = listener.mock.instances[0] as MountedChart;
    await chart.loading;
    chart.render();
    chart.setItemPosition('[0,"East"]', { x: 10, y: 20 }, { panel: "g" });
    run(parent, payload(spec(true), buffers, ["itemMove"], 3, undefined, "network"));
    const waiting = listener.mock.instances.at(-1) as MountedChart;
    // Its panels come with its first scene; another run comes before it.
    expect(waiting.getPanels()).toEqual([]);
    run(
      parent,
      payload({ ...spec(true), title: "Again" }, buffers, ["itemMove"], 3, undefined, "network"),
    );
    expect(parent.querySelector('[role="alert"]')).toBeNull();
    // The run that came meanwhile is drawn once the waiting chart is done.
    await waiting.loading;
    await frame();
    const next = listener.mock.instances.at(-1) as MountedChart;
    expect(next).not.toBe(waiting);
    expect(next.getItemPositions({ panel: "g" })['[0,"East"]']).toEqual({ x: 10, y: 20 });
  } finally {
    listener.mockRestore();
  }
});
