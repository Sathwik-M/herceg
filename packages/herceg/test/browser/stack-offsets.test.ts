import { afterEach, beforeEach, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:350px";
  document.body.append(host);
});
afterEach(() => host.remove());
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

for (const renderer of ["svg", "canvas"] as const) {
  for (const horizontal of [false, true]) {
    it(`reads fill shares and raw values through pointer and keys on ${renderer} along ${horizontal ? "y" : "x"}`, async () => {
      const data = table({ t: [0, 1, 2], a: [2, 4, 3], b: [6, 4, 5] });
      const mark = horizontal
        ? area(data, { x: ["a", "b"], y: "t", orient: "y", stack: "fill" })
        : area(data, { x: "t", y: ["a", "b"], stack: "fill" });
      const chart = createChart(host, {
        marks: [mark],
        renderer,
        [horizontal ? "x" : "y"]: { format: { style: "percent" } },
      });
      const x = chart.toPixel(horizontal ? 0.25 : 0, { axis: "x" })!;
      const y = chart.toPixel(horizontal ? 0 : 0.25, { axis: "y" })!;
      const box = chart.root.getBoundingClientRect();
      chart.root.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + x,
          clientY: box.top + y,
        }),
      );
      await frame();
      expect(chart.root.textContent).toContain("25% share (2 raw)");
      chart.root.focus();
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await frame();
      expect(chart.root.querySelector("[aria-live]")!.textContent).toContain("raw");
      chart.setVisibility(chart.getLegend()[0]!.key, false);
      chart.render();
      const s = modelOf(chart).series()[1]!;
      expect((horizontal ? s.x : s.y)[0]).toBe(1);
      expect(chart.toSVG()).not.toContain("NaN");
      chart.destroy();
    });
  }
  for (const stack of ["center", "wiggle"] as const) {
    for (const axis of ["x", "y", "yRight"] as const) {
      it(`formats ${stack} pointer and keyboard thickness on ${renderer}, ${axis}`, async () => {
        const data = table({ t: [0, 1, 2], a: [2, 4, 3], b: [6, 4, 5] });
        const mark =
          axis === "x"
            ? area(data, { y: "t", x: ["a", "b"], orient: "y", stack })
            : area(data, {
                x: "t",
                y: ["a", "b"],
                stack,
                axis: axis === "yRight" ? "right" : "left",
                curve: "monotone",
              });
        const chart = createChart(host, {
          renderer,
          locale: "en-US",
          marks: [mark],
          [axis]: { tooltipFormat: { style: "unit", unit: "millisecond" } },
        });
        const s = modelOf(chart).series()[0]!;
        const x = chart.toPixel(s.x[0]!, { axis: "x" })!;
        const y = chart.toPixel(s.y[0]!, { axis: axis === "yRight" ? "yRight" : "y" })!;
        const box = chart.root.getBoundingClientRect();
        chart.root.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: box.left + x,
            clientY: box.top + y,
          }),
        );
        await frame();
        expect(chart.root.textContent).toContain("2 ms");
        expect(chart.root.textContent).toContain("6 ms");
        chart.root.focus();
        chart.root.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
        await frame();
        expect(chart.root.querySelector("[aria-live]")!.textContent).toContain("2 ms");
        expect(chart.root.querySelector("[aria-live]")!.textContent).not.toContain("share");
        const before = chart.toSVG();
        data.set("a", 1, 8);
        chart.render();
        expect(chart.toSVG()).not.toBe(before);
        expect(chart.toSVG()).not.toContain("NaN");
        chart.destroy();
      });
    }
  }
  for (const horizontal of [false, true]) {
    it(`reads fill bar shares and raw values through pointer and keyboard on ${renderer}, ${horizontal ? "horizontal" : "vertical"}`, async () => {
      const data = table({ band: ["N", "S"], a: [2, 4], b: [6, 4] });
      const mark = horizontal
        ? bar(data, {
            y: "band",
            x: ["a", "b"],
            stack: "fill",
            labels: { format: { style: "percent" } },
          })
        : bar(data, {
            x: "band",
            y: ["a", "b"],
            stack: "fill",
            labels: { format: { style: "percent" } },
          });
      const chart = createChart(host, {
        renderer,
        marks: [mark],
        [horizontal ? "x" : "y"]: { format: { style: "percent" } },
      });
      const x = chart.toPixel(horizontal ? 0.125 : 0, { axis: "x" })!;
      const y = chart.toPixel(horizontal ? 0 : 0.125, { axis: "y" })!;
      const box = chart.root.getBoundingClientRect();
      chart.root.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + x,
          clientY: box.top + y,
        }),
      );
      await frame();
      expect(chart.root.textContent).toContain("25% share (2 raw)");
      expect(chart.root.textContent).toContain("75% share (6 raw)");
      chart.root.focus();
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await frame();
      expect(chart.root.querySelector("[aria-live]")!.textContent).toContain("25% share (2 raw)");
      expect(chart.toSVG()).toContain("25%");
      chart.destroy();
    });
  }
}
