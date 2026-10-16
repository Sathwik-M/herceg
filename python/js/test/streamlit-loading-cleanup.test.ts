// A Streamlit run refused while it waited for a chart restoring what the
// user had: the component's cleanup takes its error too. A test file of its
// own: each runs in a page of its own, where the compiler has not loaded.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import type { Header } from "../streamlit.ts";
import { payload, run } from "./streamlit-payload.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

it("cleans up the error of a run queued behind a waiting chart", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = document.createElement("div");
    document.body.append(parent);
    hosts.push(parent);
    const line = (panel: string) => ({ type: "line", x: "v", y: "v", data: "data", panel });
    const spec = (marks: unknown[]) =>
      ({
        width: 400,
        height: 200,
        renderer: "svg",
        panels: [{ id: "a" }, { id: "b" }],
        layout: { type: "grid", columns: [1, 1] },
        data: { data: { columns: { v: { type: "number", dtype: "float64", buffer: 0 } } } },
        // A panel's legend needs the guide compiler, which loads first.
        guides: [{ type: "legend", panel: "a" }],
        marks,
      }) as Header["spec"];
    const buffers = [new Float64Array([1, 2])];
    run(parent, payload(spec([line("a"), line("b")]), buffers, []));
    const waiting = listener.mock.instances.at(-1) as MountedChart;
    expect(waiting.getPanels()).toEqual([]);
    // A run whose mark names no panel the chart has, queued meanwhile.
    const refused = run(parent, payload(spec([line("a"), line("nowhere")]), buffers, []));
    await waiting.loading;
    expect(parent.querySelector('[role="alert"]')).not.toBeNull();
    refused.cleanup();
    expect(parent.children).toHaveLength(0);
  } finally {
    listener.mockRestore();
  }
});
