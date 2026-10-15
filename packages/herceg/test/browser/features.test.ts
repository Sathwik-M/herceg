// Live charts whose marks need the feature compiler: they load it before
// drawing, and draw its features on SVG and Canvas as static output does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const sites = table({
  t: [0, 1, 2, 0, 1, 2],
  v: [1, 2, 3, 2, 3, 1],
  site: ["A", "A", "A", "Average", "Average", "Average"],
});
const strokes = () =>
  [...host.querySelectorAll("svg path")].map((path) => path.getAttribute("stroke"));

describe("charts drawing marks' features", () => {
  // First in the file, so that the compiler loads for it.
  it("draw once the feature compiler loads, in the colors their scales fix", async () => {
    const chart = createChart(host, {
      renderer: "svg",
      scales: { color: { type: "ordinal", map: { Average: "#222222" } } },
      marks: [
        line(sites, {
          x: "t",
          y: "v",
          series: "site",
          color: "site",
          style: { by: { map: { Average: { dash: "--" } } } },
        }),
      ],
    });
    const loading = chart.loading;
    if (loading) {
      expect(strokes()).not.toContain("#222222");
      expect(() => chart.toSVG()).toThrow(/chart: its code has not loaded; await chart.loading/);
      await loading;
    }
    expect(strokes()).toContain("#222222");
    const dashed = [...host.querySelectorAll('svg path[stroke="#222222"]')];
    expect(dashed.some((path) => path.getAttribute("stroke-dasharray"))).toBe(true);
    expect(chart.toSVG()).toContain('stroke="#222222"');
    chart.destroy();
  });

  it("tell colors from fields as the page reads CSS", async () => {
    const chart = createChart(host, {
      renderer: "svg",
      marks: [line(sites, { x: "t", y: "v", color: "rebeccapurple" })],
    });
    await chart.loading;
    expect(strokes()).toContain("rebeccapurple");
    expect(() =>
      chart.update({ marks: [line(sites, { x: "t", y: "v", color: "stie" as never })] }),
    ).toThrow(/"stie" is neither a field nor a color/);
    chart.destroy();
  });

  for (const renderer of ["svg", "canvas"] as const)
    it(`draw markers, outlined bars, labels, and conditional bands on ${renderer}`, async () => {
      const hours = table({
        t: time([0, 1, 2, 3, 4].map((h) => Date.UTC(2026, 3, 1, h * 6))),
        e: [0.9, 0.7, 0.6, 0.85, 0.95],
        limit: [0.8, 0.8, 0.8, 0.8, 0.8],
      });
      const chart = createChart(host, {
        renderer,
        timeZone: "UTC",
        marks: [
          area(hours, { x: "t", y1: "e", y2: "limit", where: col("e").lt(col("limit")) }),
          line(hours, { x: "t", y: "e", markers: true, continuity: { breakBy: "day" } }),
          rule({
            y: 0.8,
            label: { text: "Limit", place: { attachment: "start", outside: true } },
          }),
          text({ at: { x: { fraction: 0.03 }, y: { data: 0.65 } }, label: "note" }),
        ],
      });
      await chart.loading;
      chart.render();
      const svg = chart.toSVG();
      expect(svg).toContain(">Limit<");
      expect(svg).toContain(">note<");
      const sales = table({ zone: ["a", "b"], gain: [60, 30] });
      chart.update({
        marks: [
          bar(sales, {
            x: "zone",
            y: "gain",
            fill: "#3266d6",
            stroke: "#1b3a6b",
            labels: { place: { outside: false } },
          }),
        ],
      });
      await chart.loading;
      chart.render();
      const bars = chart.toSVG();
      expect(bars).toContain('stroke="#1b3a6b"');
      // White labels inside the blue bars.
      expect(bars).toMatch(/<g fill="#ffffff"[^>]*><text[^>]*>60</);
      chart.destroy();
    });
});
