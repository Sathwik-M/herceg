// Charts with facets in the browser: pointer, brush, keyboard, and synced cursors per panel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { bandBox } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function pointer(target: Element, type: string, x: number, y: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: 1,
    }),
  );
}

function key(chart: Chart, name: string) {
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

// Two regions over the same ten x values: a at 1, b at 100.
const ten = (value: number) => Array.from({ length: 10 }, () => value);
const data = table({
  t: Array.from({ length: 20 }, (_, i) => i % 10),
  v: [...ten(1), ...ten(100)],
  region: Array.from({ length: 20 }, (_, i) => (i < 10 ? "a" : "b")),
});

const visibleLines = (chart: Chart) =>
  [...chart.root.querySelectorAll("svg line")].filter(
    (l) => l.getAttribute("visibility") === "visible",
  );

describe("facets in the browser", () => {
  it("show the tooltip and crosshair of the panel under the pointer", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    const [, b] = chart.model.panels();
    pointer(chart.root, "pointermove", b!.x.map(4), b!.plot.y + 10);
    await frame();
    const [crosshair] = visibleLines(chart);
    expect(Number(crosshair!.getAttribute("x1"))).toBeCloseTo(Math.round(b!.x.map(4)) + 0.5, 3);
    expect(Number(crosshair!.getAttribute("y1"))).toBe(b!.plot.y);
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toContain("100");
    // Over the gap between panels, nothing.
    pointer(chart.root, "pointermove", b!.plot.x - 4, b!.plot.y + 10);
    await frame();
    expect(visibleLines(chart)).toHaveLength(0);
    chart.destroy();
  });

  it("brush in one panel and show the selection in every panel", async () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    const [a, b] = chart.model.panels();
    const y = b!.plot.y + b!.plot.height / 2;
    pointer(chart.root, "pointerdown", b!.x.map(2), y);
    pointer(chart.root, "pointermove", b!.x.map(4), y);
    // Past the panel's edge, the drag stops at it.
    pointer(chart.root, "pointerup", b!.plot.x + b!.plot.width + 30, y);
    expect(chart.selection!.x![0]).toBeCloseTo(2, 6);
    expect(chart.selection!.x![1]).toBeCloseTo(9, 6);
    await frame();
    const bands = [...chart.root.querySelectorAll('svg path[fill-opacity="0.18"]')].filter(
      (r) => r.getAttribute("visibility") === "visible",
    );
    expect(bands.map((r) => bandBox(r).x)).toEqual([
      expect.closeTo(a!.x.map(2), 1),
      expect.closeTo(b!.x.map(2), 1),
    ]);
    chart.destroy();
  });

  it("step through a panel with the arrows and move between panels with up and down", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    const live = chart.root.querySelector("[aria-live]")!;
    // Entering a panel names it; steps within it do not.
    key(chart, "ArrowRight");
    expect(live.textContent).toMatch(/^a: /);
    key(chart, "ArrowRight");
    expect(live.textContent).not.toMatch(/^a: /);
    expect(live.textContent).toContain("v: 1");
    // Down moves to the same x in the next panel; past the last, nothing changes.
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^b: 1\. v: 100/);
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^b: 1\. v: 100/);
    key(chart, "ArrowUp");
    expect(live.textContent).toMatch(/^a: 1\. v: 1/);
    chart.destroy();
  });

  it("name grid panels by both their values, and report the panel's key", () => {
    const grid = table({
      t: [0, 1, 0, 1, 0, 1, 0, 1],
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      region: ["a", "a", "a", "a", "b", "b", "b", "b"],
      zone: ["x", "x", "y", "y", "x", "x", "y", "y"],
    });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [line(grid, { x: "t", y: "v" })],
      facet: facet({ row: "region", column: "zone" }),
    });
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toMatch(/^a, x: /);
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^a, y: /);
    const [, second] = chart.model.panels();
    expect(second!.key).toBe(JSON.stringify(["a", "y"]));
    expect(second!.label).toBe("a, y");
    chart.destroy();
  });

  it("draw a cursor shared by a synced chart in every panel", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const plain = createChart(other, {
      interaction: { sync: "group" },
      marks: [line(data, { x: "t", y: "v" })],
    });
    const faceted = createChart(host, {
      interaction: { sync: "group" },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    pointer(plain.root, "pointermove", plain.model.xScale()!.map(5), 150);
    await frame();
    expect(visibleLines(faceted)).toHaveLength(2);
    // Past the data in x, no panel shows it, though the pixel lies in a neighbor.
    faceted.syncCursor(15);
    await frame();
    expect(visibleLines(faceted)).toHaveLength(0);
    plain.destroy();
    faceted.destroy();
    other.remove();
  });

  it("zoom around the value under the pointer in any panel", () => {
    const chart = createChart(host, {
      interaction: { zoom: true },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    const [, b] = chart.model.panels();
    const px = b!.x.map(6);
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -200,
        clientX: rect.left + px,
        clientY: rect.top + b!.plot.y + 10,
        bubbles: true,
        cancelable: true,
      }),
    );
    chart.render();
    const [, after] = chart.model.panels();
    expect(after!.x.map(6)).toBeCloseTo(px, 0);
    chart.destroy();
  });
});
