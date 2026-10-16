// Live charts whose guides need the guide compiler: they load it before
// drawing such a configuration, keep the last frame while an update waits
// for it, and settle `loading` with the frame on screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { axis, legend } from "../../src/guides/options.ts";
import { grid } from "../../src/layout.ts";
import { line } from "../../src/marks/line.ts";
import { panels } from "../../src/model/panels.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const HOUR = 3_600_000;
const start = Date.UTC(2026, 8, 28);
const data = table({
  t: time(Array.from({ length: 49 }, (_, i) => start + i * HOUR)),
  v: Array.from({ length: 49 }, (_, i) => i % 7),
});
const tickLabels = () =>
  [...host.querySelectorAll("svg text")].map((text) => text.textContent).filter(Boolean);

describe("charts with planned guides", () => {
  // First in the file, so that the compiler loads for it.
  it("draw once the guide compiler loads, and settle loading with that frame", async () => {
    const chart = createChart(host, {
      timeZone: "UTC",
      marks: [line(data, { x: "t", y: "v" })],
      x: { ticks: { every: "12 hours" }, format: { time: "%H:%M" } },
      guides: [axis({ scale: "x", style: { tickLabel: { color: "#cc0000" } } })],
    });
    const loading = chart.loading;
    if (loading) {
      // Nothing is drawn before the compiler is here, and nothing exported.
      expect(tickLabels()).toEqual([]);
      expect(() => chart.toSVG()).toThrow(/chart: its code has not loaded; await chart.loading/);
      await loading;
    }
    expect(tickLabels()).toContain("12:00");
    expect(chart.toSVG()).toContain(">12:00<");
    // The listed axis' style is the axis' from its first frame.
    const label = [...host.querySelectorAll("svg text")].find((t) => t.textContent === "12:00")!;
    expect(getComputedStyle(label).fill).toBe("rgb(204, 0, 0)");
    chart.destroy();
  });

  it("keep the last frame while an update waits, then draw the new one", async () => {
    const chart = createChart(host, {
      timeZone: "UTC",
      marks: [line(data, { x: "t", y: "v" })],
      y: { title: "before" },
    });
    expect(tickLabels()).toContain("before");
    chart.update({ x: { ticks: { every: "day" }, format: { time: "%a" } } });
    await chart.loading;
    await new Promise(requestAnimationFrame);
    expect(tickLabels()).toContain("Tue");
    chart.destroy();
  });

  it("draw at once when the compiler has already loaded", async () => {
    const first = createChart(host, {
      marks: [line(data, { x: "t", y: "v" })],
      y: { format: { number: ".1f" } },
    });
    await first.loading;
    first.destroy();
    const second = createChart(host, {
      marks: [line(data, { x: "t", y: "v" })],
      y: { format: { number: ".2f" } },
    });
    expect(second.loading).toBeUndefined();
    expect(tickLabels()).toContain("2.00");
    second.destroy();
  });
});

describe("legends with settings in the browser", () => {
  const values = table({ t: [0, 1, 2], a: [1, 2, 3], b: [3, 2, 1] });
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

  it("toggle every series an entry stands for", async () => {
    const first = table({ t: [0, 1], site: ["North", "South"], v: [1, 2] }, { name: "sites" });
    const second = table({ t: [0, 1], site: ["North", "South"], v: [3, 4] }, { origin: first });
    const chart = createChart(host, {
      panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
      marks: [
        line(first, { x: "t", y: "v", series: "site", panel: "a" }),
        line(second, { x: "t", y: "v", series: "site", panel: "b" }),
      ],
      legend: { place: { side: "bottom" } },
    });
    await chart.loading;
    expect(buttons().map((b) => b.textContent)).toEqual(["North", "South"]);
    buttons()[0]!.click();
    expect(chart.getHiddenKeys()).toEqual(['{"table":"sites","field":"site","value":"North"}']);
    expect(host.querySelectorAll("svg path[stroke]").length).toBeGreaterThan(0);
    buttons()[0]!.click();
    expect(chart.getHiddenKeys()).toHaveLength(0);
    chart.destroy();
  });

  it("draw samples as the marks look", async () => {
    const chart = createChart(host, {
      marks: [line(values, { x: "t", y: ["a", "b"], dash: "--" })],
      legend: { swatches: "mark" },
    });
    await chart.loading;
    const dashes = () => buttons()[0]!.querySelector("svg path")!.getAttribute("stroke-dasharray");
    const dashed = dashes();
    expect(dashed).toBeTruthy();
    // A change of the marks' look redraws the buttons' samples.
    chart.update({ marks: [line(values, { x: "t", y: ["a", "b"], dash: ":" })] });
    await chart.loading;
    chart.render();
    expect(dashes()).toBeTruthy();
    expect(dashes()).not.toBe(dashed);
    chart.destroy();
  });

  it("show each legend's entries as buttons of their own", async () => {
    const chart = createChart(host, {
      marks: [line(values, { x: "t", y: "a", id: "a" }), line(values, { x: "t", y: "b", id: "b" })],
      guides: [legend({ scales: [{ mark: "b", channel: "series" }], place: { side: "right" } })],
    });
    await chart.loading;
    expect(buttons().map((b) => b.textContent)).toEqual(["a", "b"]);
    buttons()[1]!.click();
    expect(chart.getHiddenKeys()).toHaveLength(1);
    expect(JSON.parse(chart.getHiddenKeys()[0]!)).toMatchObject({ value: "b" });
    chart.destroy();
  });
});
