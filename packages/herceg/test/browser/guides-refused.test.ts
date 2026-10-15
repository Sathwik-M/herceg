// A chart's first configuration that the guide compiler, loading for it,
// refuses: the chart draws and exports nothing until an update it accepts.
import { expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { axis } from "../../src/guides/options.ts";
import { line } from "../../src/marks/line.ts";

it("draws nothing for a configuration the loading compiler refuses, until an update", async () => {
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
  const texts = () =>
    [...host.querySelectorAll("svg text")].map((text) => text.textContent).filter(Boolean);
  const chart = createChart(host, {
    marks: [line(table({ x: [0, 1, 2], v: [1, 3, 2] }), { x: "x", y: "v" })],
    y: { title: "Load" },
    guides: [axis({ scale: "x", place: { side: "left" } })],
  });
  await expect(chart.loading).rejects.toThrow(/x axes go on the "top" or the "bottom"/);
  chart.render();
  expect(texts()).toEqual([]);
  expect(() => chart.toSVG()).toThrow(/chart: its code has not loaded; await chart.loading/);
  chart.update({ guides: [axis({ scale: "x", place: { side: "top" } })] });
  await chart.loading;
  chart.render();
  expect(texts()).toContain("Load");
  chart.destroy();
  host.remove();
});
