// Streamlit reruns of a subplot network while the guide compiler loads: the
// nodes' laid-out places carry over the waiting charts. A test file of its
// own: each runs in a page of its own, where the compiler has not loaded.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import type { Header } from "../streamlit.ts";
import { payload, run } from "./streamlit-payload.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("keeps untouched nodes where a data change left them through reruns before loading", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = document.createElement("div");
    parent.style.width = "600px";
    document.body.append(parent);
    hosts.push(parent);
    const names = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const ring = (extra: boolean, guides: boolean, title = "Ring") => {
      const from = names.map((_, i) => i);
      const to = names.map((_, i) => (i + 1) % 30);
      const dictionary = extra ? [...names, "x"] : names;
      if (extra) {
        from.push(0);
        to.push(30);
      }
      const spec = {
        title,
        width: 600,
        height: 300,
        renderer: "svg",
        interaction: { drag: true },
        panels: [{ id: "g" }, { id: "a" }],
        layout: { type: "grid", columns: [2, 1] },
        data: {
          links: {
            columns: {
              from: { type: "category", codes: 0, dictionary },
              to: { type: "category", codes: 1, dictionary },
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
      } as Header["spec"];
      const v = Float64Array.from(from, (_, i) => i);
      return payload(
        spec,
        [Int32Array.from(from), Int32Array.from(to), v],
        ["itemMove"],
        3,
        undefined,
        "network",
      );
    };
    const charts = () => listener.mock.instances as unknown as MountedChart[];
    const place = (name: string) => {
      const model = MountedChart.modelOf(charts().at(-1)!);
      const key = JSON.stringify([0, name]);
      const at = model.inspectItem(key, "g")!.points[0]!;
      return model.items!.result("g")!.moves!.toLayout(key, at.px, at.py);
    };
    run(parent, ring(false, false));
    await charts().at(-1)!.loading;
    await frame();
    // A data change lays the ring out from where it was.
    run(parent, ring(true, false));
    await frame();
    const far = place("n10");
    // A panel's legend, then a title: two runs while the compiler loads.
    run(parent, ring(true, true));
    const waiting = charts().at(-1)!;
    expect(waiting.getPanels()).toEqual([]);
    run(parent, ring(true, true, "Again"));
    // The run that came meanwhile is drawn once the waiting chart is done.
    await waiting.loading;
    await frame();
    expect(charts().at(-1)).not.toBe(waiting);
    expect(place("n10")[0]).toBeCloseTo(far[0], 6);
    expect(place("n10")[1]).toBeCloseTo(far[1], 6);
  } finally {
    listener.mockRestore();
  }
});
