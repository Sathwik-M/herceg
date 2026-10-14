// Guide text in a live chart: the HTML legend's labels take their style's
// box and halo, as static output draws them.
import { afterEach, beforeEach, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { canvasMeasurer } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

it("gives the HTML legend's labels their box and halo", () => {
  const data = table({ x: [0, 1, 2], a: [1, 3, 2], b: [2, 1, 3] });
  const chart = createChart(host, {
    marks: [line(data, { x: "x", y: "a" }), line(data, { x: "x", y: "b" })],
    legend: {
      style: {
        legendLabel: {
          background: { fill: "#ffeeaa", radius: 3 },
          padding: { left: 4, right: 4 },
          halo: { color: "#00ff00", width: 2 },
        },
      },
    },
  });
  const label = host.querySelector('[aria-label="Legend"] button > span:last-child') as HTMLElement;
  const text = label.firstElementChild as HTMLElement;
  const style = getComputedStyle(label);
  expect(style.backgroundColor).toBe("rgb(255, 238, 170)");
  expect([style.paddingLeft, style.paddingRight, style.borderTopLeftRadius]).toEqual([
    "4px",
    "4px",
    "3px",
  ]);
  expect(getComputedStyle(text).getPropertyValue("-webkit-text-stroke-width")).toBe("2px");
  // Turning the series off keeps the label's look, struck through.
  label.closest("button")!.click();
  chart.render();
  expect(text.style.textDecoration).toBe("line-through");
  expect(getComputedStyle(label).backgroundColor).toBe("rgb(255, 238, 170)");
  chart.destroy();
});

it("fades the HTML legend's label text, not its box, as static output does", () => {
  const data = table({ x: [0, 1, 2], a: [1, 3, 2], b: [2, 1, 3] });
  const options = {
    marks: [line(data, { x: "x", y: "a" }), line(data, { x: "x", y: "b" })],
    legend: {
      style: { legendLabel: { opacity: 0.25, background: { fill: "#ffeeaa" }, padding: 2 } },
    },
  };
  const chart = createChart(host, options);
  const label = host.querySelector('[aria-label="Legend"] button > span:last-child') as HTMLElement;
  expect(getComputedStyle(label).opacity).toBe("1");
  expect(getComputedStyle(label.firstElementChild!).opacity).toBe("0.25");
  // The SVG export draws the box opaque under text at the paint's opacity.
  const svg = chart.toSVG();
  expect(svg).toMatch(/<rect [^>]*fill="#ffeeaa"\/><text [^>]*opacity="0.25"/);
  // A hidden series fades its swatch and text as the export does, not the box.
  label.closest("button")!.click();
  chart.render();
  const button = label.closest("button")!;
  expect(getComputedStyle(button).opacity).toBe("1");
  expect(getComputedStyle(label).opacity).toBe("1");
  expect(Number(getComputedStyle(label.firstElementChild!).opacity)).toBeCloseTo(0.1);
  expect(Number(getComputedStyle(button.firstElementChild!).opacity)).toBeCloseTo(0.4);
  expect(chart.toSVG()).toMatch(/<rect [^>]*fill="#ffeeaa"\/><text [^>]*opacity="0.1/);
  chart.destroy();
});

it("draws the HTML legend's label boxes where the scene puts them", () => {
  const data = table({ x: [0, 1, 2], a: [1, 3, 2], b: [2, 1, 3] });
  const chart = createChart(host, {
    marks: [line(data, { x: "x", y: "a" }), line(data, { x: "x", y: "b" })],
    legend: {
      style: {
        legendLabel: {
          background: { fill: "#ffeeaa", stroke: "#333333", strokeWidth: 2 },
          padding: { top: 2, right: 6, bottom: 2, left: 6 },
        },
      },
    },
  });
  const scene = modelOf(chart).scene(
    canvasMeasurer(document.createElement("canvas").getContext("2d")!),
  );
  const legend = scene.guides.find((guide) => guide.kind === "legend")!;
  const boxes = legend.items.flatMap((item) =>
    item.type === "text" && item.box ? [item.box] : [],
  );
  const origin = host.getBoundingClientRect();
  const spans = [...host.querySelectorAll('[aria-label="Legend"] button > span:last-child')];
  expect(spans).toHaveLength(boxes.length);
  spans.forEach((span, i) => {
    const rect = span.getBoundingClientRect();
    const box = boxes[i]!;
    expect(rect.left - origin.left).toBeCloseTo(box.x, 0);
    expect(rect.top - origin.top).toBeCloseTo(box.y, 0);
    expect(rect.height).toBeCloseTo(box.height, 0);
    expect(Math.abs(rect.width - box.width)).toBeLessThan(2);
  });
  chart.destroy();
});
