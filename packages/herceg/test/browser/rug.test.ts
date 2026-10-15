import { afterEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { rug } from "../../src/marks/rug.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { positionOf } from "../helpers/keyboard.ts";
import { modelOf } from "./helpers.ts";

/** Without a background, the canvas holds what marks paint alone. */
const CLEAR = { tokens: { background: "transparent" } } as const;

const charts: Chart[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const chart of charts.splice(0)) chart.destroy();
  for (const host of hosts.splice(0)) host.remove();
});
function mount(options: Parameters<typeof createChart>[1]) {
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
  hosts.push(host);
  const chart = createChart(host, options);
  charts.push(chart);
  return chart;
}
function key(chart: Chart, name: string) {
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  return chart.root.querySelector('[aria-live="polite"]')!.textContent;
}
function pixel(chart: Chart, px: number, py: number) {
  const canvas = chart.root.querySelector("canvas")!;
  const ratio = canvas.width / chart.root.clientWidth;
  return canvas.getContext("2d")!.getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1)
    .data;
}

describe("rug renderers", () => {
  it.each([
    ["svg", "x"],
    ["svg", "y"],
    ["canvas", "x"],
    ["canvas", "y"],
  ] as const)("renders packed ticks in %s along %s", (renderer, axis) => {
    const t = table({ v: [3, 1, 2, 2] });
    const chart = mount({
      theme: CLEAR,
      renderer,
      marks: [
        axis === "x"
          ? rug(t, { x: "v", stroke: "#ff0000", strokeWidth: 2 })
          : rug(t, { y: "v", stroke: "#ff0000", strokeWidth: 2 }),
      ],
    });
    const model = modelOf(chart);
    const hit = positionOf(model, model.series()[0]!.key, 0)!;
    expect(hit.points[0]!.row).toBe(1);
    if (renderer === "svg") {
      const path = chart.root.querySelector('path[stroke="#ff0000"]')!;
      expect(path.getAttribute("d")!.match(/M/g)).toHaveLength(4);
      expect(path.getAttribute("stroke-width")).toBe("2");
    } else {
      const inside = positionOf(model, model.series()[0]!.key, 1)!.points[0]!;
      const color = pixel(chart, inside.px, inside.py);
      expect(color[0]).toBeGreaterThan(200);
      expect(color[1]).toBeLessThan(50);
      expect(color[2]).toBeLessThan(50);
    }
    expect(key(chart, "ArrowRight")).toBe("1. v: 1");
    expect(key(chart, "ArrowRight")).toBe("2. v: 2");
    expect(key(chart, "ArrowRight")).toBe("2. v: 2");
    expect(key(chart, "ArrowRight")).toBe("3. v: 3");
  });

  it.each(["x", "y"] as const)(
    "skips invalid log %s observations with arrows and Home/End",
    (axis) => {
      const t = table({ v: [-2, 0, 1, 10] });
      const chart = mount({
        marks: [axis === "x" ? rug(t, { x: "v" }) : rug(t, { y: "v" })],
        [axis]: { type: "log" },
      });
      expect(key(chart, "ArrowRight")).toBe("1. v: 1");
      expect(key(chart, "ArrowRight")).toBe("10. v: 10");
      expect(key(chart, "Home")).toBe("1. v: 1");
      expect(key(chart, "ArrowLeft")).toBe("1. v: 1");
      expect(key(chart, "End")).toBe("10. v: 10");
    },
  );

  it.each(["svg", "canvas"] as const)("paints no zero-width ticks in %s", (renderer) => {
    const chart = mount({
      theme: CLEAR,
      renderer,
      marks: [rug(table({ v: [1, 2] }), { x: "v", stroke: "#ff0000", strokeWidth: 0 })],
    });
    if (renderer === "svg")
      expect(chart.root.querySelector('path[stroke="#ff0000"]')!.getAttribute("stroke-width")).toBe(
        "0",
      );
    else {
      const model = modelOf(chart);
      const point = positionOf(model, model.series()[0]!.key, 0)!.points[0]!;
      expect(pixel(chart, point.px, point.py)[3]).toBe(0);
    }
  });

  it("reads every y observation when the unused x axis has time breaks", () => {
    const chart = mount({
      marks: [rug(table({ v: [1, 2, 3] }), { y: "v" })],
      x: { type: "time", domain: [0, 4], breaks: timeBreaks([{ from: 2, to: 3 }]) },
    });
    expect(key(chart, "ArrowRight")).toBe("1. v: 1");
    expect(key(chart, "ArrowRight")).toBe("2. v: 2");
    expect(key(chart, "ArrowRight")).toBe("3. v: 3");
  });
});
