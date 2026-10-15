// A chart whose guides need the guide compiler, when the compiler cannot
// load: it draws nothing and exports nothing until the compiler loads, and
// draws again once its configuration no longer needs it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";

// The compiler's module loads, but making the compiler fails, as a module
// that cannot load would fail the import.
vi.mock("../../src/guides/compile.ts", () => ({
  guideCompiler: () => {
    throw new Error("offline");
  },
}));

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const data = table({ x: [0, 1, 2], v: [1, 3, 2] });
const texts = () =>
  [...host.querySelectorAll("svg text")].map((text) => text.textContent).filter(Boolean);

it("draws nothing while the compiler cannot load, and draws once nothing needs it", async () => {
  const chart = createChart(host, {
    marks: [line(data, { x: "x", y: "v" })],
    y: { title: "Load", format: { number: ".1f" } },
  });
  await expect(chart.loading).rejects.toThrow();
  // Still blocked after the failure: no frame, no export.
  chart.render();
  expect(texts()).toEqual([]);
  expect(() => chart.toSVG()).toThrow(/the guide compiler has not loaded; await chart.loading/);
  // An update still needing it tries again, and fails again.
  chart.update({ y: { title: "Again", format: { number: ".2f" } } });
  await expect(chart.loading).rejects.toThrow();
  expect(texts()).toEqual([]);
  // Without what needs the compiler, the chart draws.
  chart.update({ y: { title: "Plain" } });
  await chart.loading;
  chart.render();
  expect(texts()).toContain("Plain");
  chart.destroy();
});
