// Charts with facets in the browser: pointer, brush, keyboard, and synced cursors per panel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import type { ChartEvents } from "../../src/dom/events.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { custom } from "../../src/marks/custom.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { facet } from "../../src/model/facet.ts";
import { panels } from "../../src/model/panels.ts";
import { bandBox, MOUSE, modelOf } from "./helpers.ts";

/** Without a background, the canvas holds what marks paint alone. */
const CLEAR = { tokens: { background: "transparent" } } as const;

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
      pointerId: MOUSE,
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
    const [, b] = modelOf(chart).panels();
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

  it("split a custom mark's series by panel, with tooltips and keyboard stops in each", async () => {
    const rows: number[] = [];
    const ticks = custom(data, {
      x: "t",
      y: "v",
      draw({ series, x, y, line: tick }) {
        for (const s of series) {
          rows.push(s.length);
          for (let k = 0; k < s.length; k++) {
            const row = s.rows ? s.rows[k]! : k;
            tick(x(s.x[row]!) - 3, y(s.y[row]!), x(s.x[row]!) + 3, y(s.y[row]!));
          }
        }
      },
    });
    const chart = createChart(host, { locale: "en-US", marks: [ticks], facet: facet("region") });
    expect(rows).toEqual([10, 10]);
    const [, b] = modelOf(chart).panels();
    pointer(chart.root, "pointermove", b!.x.map(4), b!.plot.y + 10);
    await frame();
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toBe("4v100");
    chart.root.focus();
    key(chart, "ArrowRight");
    key(chart, "ArrowDown");
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toBe("b: 0. v: 100");
    chart.destroy();
  });

  it("brush in one panel and show the selection in every panel", async () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    // The brush loads on demand.
    await chart.loading;
    const [a, b] = modelOf(chart).panels();
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
    const [, second] = modelOf(chart).panels();
    expect(second!.key).toBe(JSON.stringify(["a", "y"]));
    expect(second!.label).toBe("a, y");
    chart.destroy();
  });

  it("draw a cursor shared by a synced chart in every panel", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    // Wider than the facets' data, so its cursor can go past theirs.
    const wide = table({ t: [0, 20], v: [0, 1] });
    const plain = createChart(other, {
      interaction: { sync: "group" },
      marks: [line(wide, { x: "t", y: "v" })],
    });
    const faceted = createChart(host, {
      interaction: { sync: "group" },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    pointer(plain.root, "pointermove", plain.toPixel(5, { axis: "x" })!, 150);
    await frame();
    expect(visibleLines(faceted)).toHaveLength(2);
    // Past the data in x, no panel shows it, though the pixel lies in a neighbor.
    pointer(plain.root, "pointermove", plain.toPixel(15, { axis: "x" })!, 150);
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
    const [, b] = modelOf(chart).panels();
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
    const [, after] = modelOf(chart).panels();
    expect(after!.x.map(6)).toBeCloseTo(px, 0);
    chart.destroy();
  });
});

describe("facet panels with y scales of their own", () => {
  const grouped = (mark: ChartMark, options: Partial<ChartOptions> = {}) =>
    createChart(host, {
      locale: "en-US",
      timeZone: "UTC",
      marks: [mark],
      facet: facet("f", { columns: 2 }),
      ...options,
      y: { scope: "panel", ...options.y },
    });

  it("announce a brushed range as the panel it was drawn in formats values", async () => {
    const day = Date.UTC(2026, 0, 1);
    const data = table({
      x: [0, 1, 0, 1],
      y: time([Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1), day, day + 10_000]),
      f: ["A", "A", "B", "B"],
    });
    host.style.width = "1000px";
    const chart = grouped(line(data, { x: "x", y: "y" }), {
      interaction: { brush: "y" },
      y: { type: "time" },
    });
    // The brush loads on demand.
    await chart.loading;
    const b = modelOf(chart).panels()[1]!;
    pointer(chart.root, "pointerdown", b.x.map(0.5), b.y.map(day + 2000));
    pointer(chart.root, "pointermove", b.x.map(0.5), b.y.map(day + 8000));
    pointer(chart.root, "pointerup", b.x.map(0.5), b.y.map(day + 8000));
    expect(chart.root.querySelector("[aria-live]")!.textContent).toContain("00:00:02");
    chart.destroy();
  });

  it("keep x labels clear of the next panel's y labels", () => {
    const data = table({
      x: [1000, 2000, 1000, 2000],
      y: [10000, 20000, 10000, 20000],
      f: ["A", "A", "B", "B"],
    });
    host.style.width = "1000px";
    const chart = grouped(line(data, { x: "x", y: "y" }), {
      theme: { style: { text: { fontSize: 24 } } },
      x: { ticks: 2 },
      y: { format: { minimumFractionDigits: 4 } },
    });
    // The first panel's x labels against the second panel's y labels.
    const [first, second] = modelOf(chart).panels();
    const texts = [...chart.root.querySelectorAll("svg text")];
    const box = (text: Element) => (text as SVGGraphicsElement).getBBox();
    const xLabels = texts
      .filter((t) => t.getAttribute("dominant-baseline") === "hanging")
      .map(box)
      .filter((b) => b.x < first!.plot.x + first!.plot.width);
    const yLabels = texts
      .filter((t) => t.getAttribute("text-anchor") === "end")
      .map(box)
      .filter((b) => b.x > first!.plot.x + first!.plot.width && b.x < second!.plot.x);
    expect(xLabels.length * yLabels.length).toBeGreaterThan(0);
    const meet = (p: DOMRect, q: DOMRect) =>
      p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    expect(xLabels.some((p) => yLabels.some((q) => meet(p, q)))).toBe(false);
    chart.destroy();
  });

  it("refuse a y viewport, which no one scale could show", () => {
    const data = table({ x: [0, 1, 0, 1], y: [1, 2, 100, 200], f: ["A", "A", "B", "B"] });
    const chart = grouped(line(data, { x: "x", y: "y" }));
    expect(() => chart.setViewport({ y: [500, 600] })).toThrow("no one y range");
    // A change refused in part changes nothing.
    expect(() => chart.setViewport({ x: [0, 0.5], y: [500, 600] })).toThrow("no one y range");
    expect(chart.getViewport()).toEqual({ x: null, y: null, yRight: null });
    chart.setViewport({ y: null });
    chart.destroy();
  });
});

describe("subplots", () => {
  it("inspect the panel under the pointer, and step between panels by title", async () => {
    const metrics = table({ t: [0, 1, 2], latency: [100, 300, 200], requests: [5, 9, 7] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [
        line(metrics, { x: "t", y: "latency", panel: "latency" }),
        line(metrics, { x: "t", y: "requests", panel: "traffic" }),
      ],
      panels: panels([
        { id: "latency", title: "Latency" },
        { id: "traffic", title: "Requests" },
      ]),
    });
    const target = { panel: "traffic" };
    const [px, py] = [
      chart.toPixel(1, { ...target, axis: "x" })!,
      chart.toPixel(9, { ...target, axis: "y" })!,
    ];
    pointer(chart.root, "pointermove", px, py);
    await frame();
    expect(chart.inspect(px, py)?.panel).toBe("traffic");
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toMatch(/^Latency: /);
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^Requests: /);
    chart.destroy();
  });
});

describe("facet panels with x scales of their own", () => {
  // Region a over 0..9 at 1..10, region b over 100..109 at 100..109.
  const spread = () =>
    table({
      t: Array.from({ length: 20 }, (_, i) => (i < 10 ? i : 90 + i)),
      v: Array.from({ length: 20 }, (_, i) => (i < 10 ? i + 1 : 90 + i)),
      region: Array.from({ length: 20 }, (_, i) => (i < 10 ? "a" : "b")),
    });
  const independent = (options: Partial<ChartOptions> = {}) =>
    createChart(host, {
      locale: "en-US",
      marks: [line(spread(), { x: "t", y: "v" })],
      facet: facet("region"),
      ...options,
      x: { scope: "panel", ...options.x },
    });
  const wheel = (chart: Chart, x: number, y: number) => {
    const rect = chart.root.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      deltaY: -200,
      clientX: rect.left + x,
      clientY: rect.top + y,
      bubbles: true,
      cancelable: true,
    });
    chart.root.dispatchEvent(event);
    return event;
  };
  const dblclick = (chart: Chart, x: number, y: number, target: Element = chart.root) => {
    const rect = chart.root.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }),
    );
  };
  const views = (chart: Chart) => ["a", "b"].map((panel) => chart.getViewport({ panel: panel }).x);

  it("zoom, pan, and reset the x scale of the panel the gesture is in", () => {
    const chart = independent({ interaction: { zoom: true } });
    const events: ChartEvents["viewport"][] = [];
    chart.on("viewport", (event) => events.push(event));
    const [a, b] = modelOf(chart).panels();
    const mid = b!.plot.y + b!.plot.height / 2;
    const px = b!.x.map(104);
    wheel(chart, px, mid);
    chart.render();
    const [, zoomed] = modelOf(chart).panels();
    expect(zoomed!.x.map(104)).toBeCloseTo(px, 0);
    expect(views(chart)[0]).toBeNull();
    expect(views(chart)[1]).not.toBeNull();
    expect(events).toEqual([{ x: views(chart)[1], y: null, yRight: null, panels: ["b"] }]);
    // Over the gap between panels, the wheel scrolls the page.
    expect(wheel(chart, a!.plot.x + a!.plot.width + 4, mid).defaultPrevented).toBe(false);
    // Dragging pans the panel pressed.
    pointer(chart.root, "pointerdown", a!.x.map(5), mid);
    pointer(chart.root, "pointermove", a!.x.map(3), mid);
    pointer(chart.root, "pointerup", a!.x.map(3), mid);
    expect(views(chart)[0]![0]).toBeCloseTo(2, 6);
    expect(events.at(-1)!.panels).toEqual(["a"]);
    // Double click on a panel resets its scale; elsewhere, every scale.
    events.length = 0;
    dblclick(chart, b!.x.map(104), mid);
    expect(views(chart)[0]).not.toBeNull();
    expect(views(chart)[1]).toBeNull();
    dblclick(chart, 2, 2);
    expect(views(chart)).toEqual([null, null]);
    expect(events.map((e) => [e.x, e.panels])).toEqual([
      [null, ["b"]],
      [null, ["a"]],
    ]);
    chart.destroy();
  });

  it("let a drag go when its panel does, and leave views alone on the legend", () => {
    const data = spread();
    const chart = createChart(host, {
      interaction: { zoom: true },
      legend: true,
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    const [, b] = modelOf(chart).panels();
    const y = b!.plot.y + b!.plot.height / 2;
    pointer(chart.root, "pointerdown", b!.x.map(105), y);
    pointer(chart.root, "pointermove", b!.x.map(104), y);
    expect(chart.getViewport({ panel: "b" }).x).not.toBeNull();
    // b's rows go while the button is down: the drag pans nothing more.
    data.reset({ t: [0, 1], v: [1, 2], region: ["a", "a"] });
    chart.render();
    pointer(chart.root, "pointermove", b!.x.map(100), y);
    pointer(chart.root, "pointerup", b!.x.map(100), y);
    expect(
      modelOf(chart)
        .panels()
        .map((p) => p.key),
    ).toEqual(["a"]);
    chart.setViewport([0, 0.5], { panel: "a" });
    const button = chart.root.querySelector("button")!;
    dblclick(chart, 0, 0, button);
    expect(chart.getViewport({ panel: "a" }).x).toEqual([0, 0.5]);
    chart.destroy();
  });

  it("set views by panel, refusing ranges without one", () => {
    const chart = independent();
    expect(() => chart.setViewport([1, 2])).toThrow("panel: required when panels");
    expect(() => chart.setViewport([1, 2], { panel: "c" })).toThrow('no panel "c"');
    chart.setViewport([101, 102], { panel: "b" });
    expect(views(chart)).toEqual([null, [101, 102]]);
    // A y range applies to every panel: one event per x scale.
    const events: ChartEvents["viewport"][] = [];
    chart.on("viewport", (event) => events.push(event));
    chart.setViewport({ y: [0, 50] });
    expect(events).toEqual([
      { x: null, y: [0, 50], yRight: null, panels: ["a"] },
      { x: [101, 102], y: [0, 50], yRight: null, panels: ["b"] },
    ]);
    expect(chart.getViewport({ panel: "b" })).toEqual({ x: [101, 102], y: [0, 50], yRight: null });
    expect(() => chart.getViewport()).toThrow("panel: required when panels");
    // A listener changing the view again while the first scale's event is
    // reported: its change reports both scales, and the outer report does
    // not report the second scale again.
    events.length = 0;
    const stop = chart.on("viewport", ({ y }) => {
      if (y?.[1] === 60) chart.setViewport({ y: [0, 70] });
    });
    chart.setViewport({ y: [0, 60] });
    expect(events.map((e) => [e.y, e.panels])).toEqual([
      [[0, 60], ["a"]],
      [[0, 70], ["a"]],
      [[0, 70], ["b"]],
    ]);
    stop();
    chart.setViewport(null);
    expect(views(chart)).toEqual([null, null]);
    chart.destroy();
  });

  it("report letting go of a y zoom when panels get y scales of their own", () => {
    const chart = independent({ y: { scope: "chart" }, x: { scope: "panel" } });
    const events: ChartEvents["viewport"][] = [];
    chart.on("viewport", (event) => events.push(event));
    chart.setViewport({ y: [0, 10] });
    chart.update({ y: { scope: "panel" }, x: { scope: "panel" } });
    expect(chart.getViewport({ panel: "a" }).y).toBeNull();
    chart.update({ y: { scope: "chart" }, x: { scope: "panel" } });
    // The same zoom again is a change, and is reported.
    chart.setViewport({ y: [0, 10] });
    expect(events.map((e) => [e.y, e.panels])).toEqual([
      [[0, 10], ["a"]],
      [[0, 10], ["b"]],
      [null, ["a"]],
      [null, ["b"]],
      [[0, 10], ["a"]],
      [[0, 10], ["b"]],
    ]);
    // A listener the drawing calls (hover) changing the view: its change
    // is reported once, within the report of the y zoom let go.
    events.length = 0;
    const [a] = modelOf(chart).panels();
    let zoomed = false;
    chart.on("hover", () => {
      if (zoomed) return;
      zoomed = true;
      chart.setViewport([101, 102], { panel: "a" });
    });
    pointer(chart.root, "pointermove", a!.plot.x + 10, a!.plot.y + 10);
    chart.update({ y: { scope: "panel" }, x: { scope: "panel" } });
    expect(events.map((e) => [e.x, e.y, e.panels])).toEqual([
      [[101, 102], null, ["a"]],
      [null, null, ["b"]],
    ]);
    chart.destroy();
  });

  it("brush in one panel and select in the panels sharing its x scale", async () => {
    const data = spread();
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    // The brush loads on demand.
    await chart.loading;
    const selections: ChartEvents["select"][] = [];
    chart.on("select", (event) => selections.push(event));
    const [, b] = modelOf(chart).panels();
    const y = b!.plot.y + b!.plot.height / 2;
    pointer(chart.root, "pointerdown", b!.x.map(102), y);
    pointer(chart.root, "pointermove", b!.x.map(104), y);
    pointer(chart.root, "pointerup", b!.x.map(104), y);
    expect(chart.selection!.x![0]).toBeCloseTo(102, 6);
    expect(chart.selectionPanels).toEqual(["b"]);
    expect(selections.at(-1)!.panels).toEqual(["b"]);
    await frame();
    const bands = [...chart.root.querySelectorAll('svg path[fill-opacity="0.18"]')].filter(
      (r) => r.getAttribute("visibility") === "visible",
    );
    expect(bands.map((r) => bandBox(r).x)).toEqual([expect.closeTo(b!.x.map(102), 1)]);
    // Without a panel, a selection could be in either scale.
    expect(() => chart.select([1, 2])).toThrow("panel: required when panels");
    chart.select([1, 2], { panel: "a" });
    expect(chart.selectionPanels).toEqual(["a"]);
    // A selection whose panels go goes too.
    data.reset({ t: [0, 1], v: [1, 2], region: ["b", "b"] });
    chart.render();
    expect(chart.selection).toBeNull();
    expect(selections.at(-1)).toEqual({ x: null, y: null, lasso: null, panels: ["a"] });
    chart.destroy();
  });

  it("zoom to a keyboard selection only while its panel stays", () => {
    const data = spread();
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    chart.select([102, 104], { panel: "b" });
    // Clearing the selection, which Enter does first, takes b away.
    chart.on("select", ({ x }) => {
      if (x) return;
      data.reset({ t: [0, 1], v: [1, 2], region: ["a", "a"] });
      chart.render();
    });
    // Errors in event handlers reach the window, not the dispatcher.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    key(chart, "Enter");
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect(chart.getViewport({ panel: "a" }).x).toBeNull();
    chart.destroy();
  });

  it("zoom to a keyboard selection only where it still is, when a listener changes panels", () => {
    const data = spread();
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    const events: ChartEvents["viewport"][] = [];
    chart.on("viewport", (event) => events.push(event));
    chart.select([102, 104], { panel: "b" });
    // The listener changes the data and leaves drawing to the next frame.
    chart.on("select", ({ x }) => {
      if (!x) data.reset({ t: [0, 1], v: [1, 2], region: ["a", "a"] });
    });
    key(chart, "Enter");
    expect(events).toEqual([]);
    expect(
      modelOf(chart)
        .panels()
        .map((p) => p.key),
    ).toEqual(["a"]);
    chart.destroy();
  });

  it("set views and selections by panel right after options change how panels share x", () => {
    const chart = independent();
    chart.update({ x: { scope: "chart" } });
    chart.setViewport([100, 101], { panel: "b" });
    chart.select([100, 100.5], { panel: "b" });
    chart.render();
    expect(chart.getViewport().x).toEqual([100, 101]);
    expect(chart.selection!.x).toEqual([100, 100.5]);
    expect(chart.selectionPanels).toEqual(["a", "b"]);
    chart.update({ x: { scope: "panel" } });
    chart.setViewport([1, 2], { panel: "a" });
    chart.render();
    expect([chart.getViewport({ panel: "a" }).x, chart.getViewport({ panel: "b" }).x]).toEqual([
      [1, 2],
      null,
    ]);
    chart.destroy();
  });

  it("name the panels of a selection on a shared x scale as they come and go", () => {
    const data = spread();
    const chart = createChart(host, {
      marks: [line(data, { x: "t", y: "v" })],
      facet: facet("region"),
    });
    chart.select([1, 2]);
    expect(chart.selectionPanels).toEqual(["a", "b"]);
    data.reset({ t: [0, 1, 2], v: [1, 2, 3], region: ["b", "c", "d"] });
    chart.render();
    expect(chart.selectionPanels).toEqual(["b", "c", "d"]);
    expect(chart.selection!.x).toEqual([1, 2]);
    chart.destroy();
  });

  it("zoom a brushed range in its own panel's scale", async () => {
    const chart = independent({ interaction: { brush: "x", zoom: true } });
    // The brush loads on demand.
    await chart.loading;
    const [a] = modelOf(chart).panels();
    const y = a!.plot.y + a!.plot.height / 2;
    pointer(chart.root, "pointerdown", a!.x.map(2), y);
    pointer(chart.root, "pointermove", a!.x.map(6), y);
    pointer(chart.root, "pointerup", a!.x.map(6), y);
    expect(views(chart)[0]![0]).toBeCloseTo(2, 6);
    expect(views(chart)[1]).toBeNull();
    chart.destroy();
  });

  it("select with the keyboard within a scale, and carry the cursor across scales by its place", () => {
    const chart = independent({ interaction: { brush: "x", zoom: true } });
    const live = chart.root.querySelector("[aria-live]")!;
    const shift = (name: string) =>
      chart.root.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, shiftKey: true, bubbles: true }),
      );
    key(chart, "End");
    shift("ArrowLeft");
    expect(chart.selectionPanels).toEqual(["a"]);
    expect(chart.selection!.x).toEqual([8, 9]);
    // Down to b, at the same place across its plot: 8 of 0..9 is 108 of 100..109.
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^b: 108\. /);
    // A range does not reach from a's values into b's.
    shift("ArrowLeft");
    expect(chart.selection!.x).toEqual([107, 108]);
    expect(chart.selectionPanels).toEqual(["b"]);
    key(chart, "Enter");
    expect(views(chart)).toEqual([null, [107, 108]]);
    chart.destroy();
  });

  it("share cursors but not views or selections with synced charts", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const plain = createChart(other, {
      interaction: { sync: "split", zoom: true, brush: "x" },
      marks: [line(spread(), { x: "t", y: "v" })],
    });
    const split = independent({ interaction: { sync: "split", zoom: true, brush: "x" } });
    plain.setViewport([100, 105]);
    plain.select([101, 102]);
    expect(views(split)).toEqual([null, null]);
    expect(split.selection).toBeNull();
    split.setViewport([2, 3], { panel: "a" });
    split.select([4, 5], { panel: "a" });
    expect(plain.getViewport().x).toEqual([100, 105]);
    expect(plain.selection!.x).toEqual([101, 102]);
    // A cursor at 104 shows in b, whose scale holds it, and not in a.
    pointer(plain.root, "pointermove", plain.toPixel(104, { axis: "x" })!, 150);
    await frame();
    expect(visibleLines(split)).toHaveLength(1);
    plain.destroy();
    split.destroy();
    other.remove();
  });
});

describe("subplots with x scales of their own", () => {
  it("zoom the panel under the pointer, in its own units, and report its key", () => {
    const day = Date.UTC(2026, 0, 1);
    const series = table({ t: time([day, day + 60_000, day + 120_000]), v: [1, 3, 2] });
    const spread = table({ ms: [10, 20, 30], n: [4, 9, 2] });
    const chart = createChart(host, {
      interaction: { zoom: true },
      marks: [
        line(series, { x: "t", y: "v", panel: "series" }),
        line(spread, { x: "ms", y: "n", panel: "spread" }),
      ],
      panels: panels([{ id: "series" }, { id: "spread" }], { rowHeights: [2, 1] }),
      x: { scope: "panel" },
    });
    const events: ChartEvents["viewport"][] = [];
    chart.on("viewport", (event) => events.push(event));
    const [, spreadPanel] = modelOf(chart).panels();
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -200,
        clientX: rect.left + spreadPanel!.x.map(20),
        clientY: rect.top + spreadPanel!.plot.y + 5,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(chart.getViewport({ panel: "series" }).x).toBeNull();
    const [lo, hi] = chart.getViewport({ panel: "spread" }).x!;
    expect(lo).toBeGreaterThan(10);
    expect(hi).toBeLessThan(30);
    expect(events.map((e) => e.panels)).toEqual([["spread"]]);
    chart.destroy();
  });
});

describe("facet panels with categories of their own", () => {
  // N holds b and d, S a and c: band 0 is b in N and a in S.
  const sales = () =>
    table({ region: ["N", "S", "N", "S"], product: ["b", "a", "d", "c"], units: [1, 2, 3, 4] });
  const options = (data = sales()): ChartOptions => ({
    locale: "en-US",
    marks: [bar(data, { x: "product", y: "units" })],
    facet: facet("region"),
    x: { scope: "panel" },
  });

  it("brush a panel's own categories, and clear the selection when they change", async () => {
    const data = table({
      region: ["N", "N", "S", "S", "E"],
      product: ["b", "d", "a", "c", "x"],
      units: [1, 3, 2, 4, 5],
    });
    const chart = createChart(host, { ...options(data), interaction: { brush: "x" } });
    await chart.loading;
    const selections: ChartEvents["select"][] = [];
    chart.on("select", (event) => selections.push(event));
    const [, s] = modelOf(chart).panels();
    const y = s!.plot.y + s!.plot.height / 2;
    pointer(chart.root, "pointerdown", s!.x.map(0) - 5, y);
    pointer(chart.root, "pointermove", s!.x.map(1), y);
    pointer(chart.root, "pointerup", s!.x.map(1), y);
    expect(chart.selection!.x).toEqual([0, 1]);
    expect(chart.selectionPanels).toEqual(["S"]);
    await frame();
    const bands = [...chart.root.querySelectorAll('svg path[fill-opacity="0.18"]')].filter(
      (r) => r.getAttribute("visibility") === "visible",
    );
    expect(bands).toHaveLength(1);
    expect(bandBox(bands[0]!).x).toBeGreaterThanOrEqual(s!.plot.x);
    // Other panels leaving, or their categories changing, leave it be.
    data.dropFirst(2);
    data.append({ region: ["E"], product: ["y"], units: [6] });
    chart.render();
    expect(
      modelOf(chart)
        .panels()
        .map((p) => p.key),
    ).toEqual(["S", "E"]);
    expect(chart.selection!.x).toEqual([0, 1]);
    expect(chart.selectionPanels).toEqual(["S"]);
    // Its own changing, band 1 would be another category (b keeps its place
    // in the table's dictionary, before a): it is cleared.
    data.append({ region: ["S"], product: ["b"], units: [7] });
    chart.render();
    expect(modelOf(chart).panels()[0]!.x.categories).toEqual(["b", "a", "c"]);
    expect(chart.selection).toBeNull();
    expect(selections.at(-1)).toEqual({ x: null, y: null, lasso: null, panels: ["S"] });
    chart.destroy();
  });

  it("read each panel's categories with the keyboard, carrying the cursor across by place", () => {
    const chart = createChart(host, options());
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("N: b. units: 1");
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("d. units: 3");
    // S's second band, where N's d was, is c.
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("S: c. units: 4");
    chart.destroy();
  });

  it("paint each panel's bars at its own categories on a canvas", () => {
    const chart = createChart(host, {
      ...options(),
      renderer: "canvas",
      theme: { tokens: { palette: ["#ff0000"] } },
    });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (x: number, y: number) =>
      Array.from(
        canvas.getContext("2d")!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1)
          .data,
      );
    const [n, s] = modelOf(chart).panels();
    // S's c (band 1) is 4 tall; N's d (band 1) 3.
    expect(pixel(s!.x.map(1), s!.y.map(3.5))).toEqual([255, 0, 0, 255]);
    expect(pixel(n!.x.map(1), n!.y.map(3.5))).not.toEqual([255, 0, 0, 255]);
    expect(pixel(n!.x.map(1), n!.y.map(2.5))).toEqual([255, 0, 0, 255]);
    const labels = [...host.querySelectorAll("svg text")].map((node) => node.textContent);
    expect(labels).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));
    chart.destroy();
  });
});

describe("facet panels with heatmaps and points on categories of their own", () => {
  // N holds hours b and d, S a and c: place 1 is d in N and c in S.
  const load = () =>
    table({
      region: ["N", "S", "N", "S", "N"],
      hour: ["b", "a", "d", "c", "b"],
      host: ["p", "q", "q", "p", "p"],
      cpu: [1, 2, 4, 5, 6],
    });
  const cells = (data = load()): ChartOptions => ({
    locale: "en-US",
    marks: [
      heatmap(data, {
        x: "hour",
        y: "host",
        color: "cpu",
        colors: ["#000000", "#ffffff"],
        colorDomain: [0, 10],
      }),
    ],
    facet: facet("region"),
    y: { scope: "panel" },
    x: { scope: "panel" },
  });

  /** The color of a CSS pixel of a chart's canvas. */
  const pixelOf = (chart: Chart) => {
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    return (x: number, y: number) =>
      Array.from(
        canvas.getContext("2d")!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1)
          .data,
      );
  };

  it("paint each panel's cells at its own categories on a canvas", () => {
    const chart = createChart(host, { theme: CLEAR, ...cells(), renderer: "canvas" });
    const pixel = pixelOf(chart);
    const [n, s] = modelOf(chart).panels();
    const gray = (value: number) => Math.round((value / 10) * 255);
    // N's (d, q) is 4 and its (b, p) 6, the later of its two rows there.
    expect(pixel(n!.x.map(1), n!.y.map(1))[0]).toBeCloseTo(gray(4), -1);
    expect(pixel(n!.x.map(0), n!.y.map(0))[0]).toBeCloseTo(gray(6), -1);
    // At the same places, S's cells are its own: (c, p) and (a, q), and no (c, q).
    expect(pixel(s!.x.map(1), s!.y.map(0))[0]).toBeCloseTo(gray(5), -1);
    expect(pixel(s!.x.map(0), s!.y.map(1))[0]).toBeCloseTo(gray(2), -1);
    expect(pixel(s!.x.map(1), s!.y.map(1))[3]).toBe(0);
    chart.destroy();
  });

  it("read each panel's cells with the keyboard, entering a panel at its top left cell", () => {
    const chart = createChart(host, cells());
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("N: b. p: 6");
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("d. q: 4");
    // The bottom of N's grid: Down leaves it for S's.
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("S: c. p: 5");
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("a. q: 2");
    chart.destroy();
  });

  it("paint each panel's points at its own categories on a canvas", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [point(load(), { x: "hour", y: "cpu", radius: 4 })],
      facet: facet("region"),
      x: { scope: "panel" },
      renderer: "canvas",
      theme: { tokens: { palette: ["#ff0000"] } },
    });
    const pixel = pixelOf(chart);
    const [n, s] = modelOf(chart).panels();
    // S's c (place 1) is at 5, N's d (place 1) at 4.
    expect(pixel(s!.x.map(1), s!.y.map(5))).toEqual([255, 0, 0, 255]);
    expect(pixel(n!.x.map(1), n!.y.map(5))).not.toEqual([255, 0, 0, 255]);
    expect(pixel(n!.x.map(1), n!.y.map(4))).toEqual([255, 0, 0, 255]);
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("N: b. cpu: 1");
    chart.destroy();
  });
});

describe("facet panels with histograms and box plots", () => {
  // N's values are small and S's large; b is N's second category and S's first.
  const sales = () =>
    table({
      region: ["N", "S", "N", "S", "N", "S", "N", "S"],
      product: ["a", "b", "a", "b", "a", "b", "b", "c"],
      units: [1, 100, 2, 200, 3, 300, 10, 5],
    });

  it("count each panel's rows in its own bins, as tooltips and the keyboard read them", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [histogram(sales(), { x: "units", bins: { step: 5 } })],
      facet: facet("region"),
      x: { scope: "panel" },
    });
    const [n, s] = modelOf(chart).panels();
    expect(n!.x.domain).toEqual([0, 10]);
    expect(s!.x.domain).toEqual([5, 300]);
    pointer(chart.root, "pointermove", s!.x.map(102.5), s!.plot.y + s!.plot.height / 2);
    await frame();
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toContain("100 – 105: 1");
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("N: 2.5. units: 0 – 5: 3");
    // Into S, whose x scale is its own, at the same place across the plot.
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("S: 77.5. units: 75 – 80: 0");
    chart.destroy();
  });

  it("carry the keyboard across panels along y categories of their own", () => {
    for (const layout of ["facet", "subplots"] as const) {
      const data = sales();
      const chart = createChart(host, {
        locale: "en-US",
        ...(layout === "facet"
          ? {
              marks: [boxplot(data, { x: "units", y: "product" })],
              facet: facet("region"),
              y: { scope: "panel" },
            }
          : {
              // N's rows and S's, each in a panel of its own categories.
              marks: [
                boxplot(table({ product: ["a", "b"], units: [2, 10] }), {
                  x: "units",
                  y: "product",
                  panel: "N",
                }),
                boxplot(table({ product: ["b", "c"], units: [200, 5] }), {
                  x: "units",
                  y: "product",
                  panel: "S",
                }),
              ],
              panels: panels([{ id: "N" }, { id: "S" }]),
            }),
      });
      const live = chart.root.querySelector("[aria-live]")!;
      key(chart, "ArrowRight");
      expect(live.textContent).toMatch(/^N: a\. /);
      key(chart, "ArrowRight");
      expect(live.textContent).toMatch(/^b\. /);
      // Into S at the same place down the plot: its second category, c.
      key(chart, "ArrowDown");
      expect(live.textContent).toMatch(/^S: c\. /);
      chart.destroy();
    }
  });

  it("paint each panel's boxes at its own categories on a canvas, and read them", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [boxplot(sales(), { x: "product", y: "units" })],
      facet: facet("region"),
      x: { scope: "panel" },
      renderer: "canvas",
      theme: { tokens: { palette: ["#ff0000"] } },
    });
    const [n, s] = modelOf(chart).panels();
    expect([n!.x.categories, s!.x.categories]).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (x: number, y: number) =>
      Array.from(
        canvas.getContext("2d")!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1)
          .data,
      );
    // S's box at place 0 (b) spans 150 to 250, filled a light red; N's
    // there (a) spans 1 to 3.
    const red = ([r, g]: number[]) => r! - g! > 30;
    expect(red(pixel(s!.x.map(0), s!.y.map(220)))).toBe(true);
    expect(red(pixel(n!.x.map(0), n!.y.map(220)))).toBe(false);
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toMatch(/^N: a\. units: median 2,/);
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^S: b\. units: median 200,/);
    chart.destroy();
  });
});

describe("right axes in panels", () => {
  // Two regions: latency on the left, requests on the right, ten times as many in b.
  const traffic = table({
    t: [0, 1, 2, 0, 1, 2],
    ms: [10, 20, 30, 15, 25, 35],
    requests: [100, 200, 300, 1000, 2000, 3000],
    region: ["a", "a", "a", "b", "b", "b"],
  });
  const marks = [
    line(traffic, { x: "t", y: "ms" }),
    line(traffic, { x: "t", y: "requests", axis: "right" }),
  ];
  const wheel = (chart: Chart, x: number, y: number) => {
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -200,
        clientX: rect.left + x,
        clientY: rect.top + y,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  it("zoom both y axes of every panel through the pixels under the pointer", () => {
    const chart = createChart(host, { marks, facet: facet("region"), interaction: { zoom: "xy" } });
    const viewports: ChartEvents["viewport"][] = [];
    chart.on("viewport", (view) => viewports.push(view));
    const [, b] = modelOf(chart).panels();
    const py = b!.plot.y + b!.plot.height / 3;
    const under = [b!.y.invert(py), b!.yRight!.invert(py)];
    wheel(chart, b!.x.map(1), py);
    chart.render();
    const [a, after] = modelOf(chart).panels();
    expect(after!.y.map(under[0]!)).toBeCloseTo(py, 4);
    expect(after!.yRight!.map(under[1]!)).toBeCloseTo(py, 4);
    // Both axes changed in one event, and every panel shows the same right range.
    expect(viewports).toHaveLength(1);
    expect(viewports[0]!.y && viewports[0]!.yRight).not.toBeNull();
    expect(a!.yRight!.domain).toEqual(after!.yRight!.domain);
    const [info] = chart.getPanels();
    expect([info!.yRight!.group, info!.yRight!.canSetViewport]).toEqual(["", true]);
    chart.destroy();
  });

  it("zoom a brushed rectangle on both y axes, and report the brush in left values", async () => {
    const chart = createChart(host, {
      marks,
      facet: facet("region"),
      interaction: { brush: "xy", zoom: "xy" },
    });
    await chart.loading;
    const [, b] = modelOf(chart).panels();
    const [top, bottom] = [b!.plot.y + 20, b!.plot.y + b!.plot.height - 20];
    const expected = {
      y: [b!.y.invert(bottom), b!.y.invert(top)],
      yRight: [b!.yRight!.invert(bottom), b!.yRight!.invert(top)],
    };
    pointer(chart.root, "pointerdown", b!.x.map(0.5), top);
    pointer(chart.root, "pointermove", b!.x.map(1.5), bottom);
    pointer(chart.root, "pointerup", b!.x.map(1.5), bottom);
    const view = chart.getViewport();
    expect(view.y![0]).toBeCloseTo(expected.y[0]!, 4);
    expect(view.yRight![1]).toBeCloseTo(expected.yRight[1]!, 4);
    chart.destroy();
    // Without zoom, the brush selects: its y is the left axis' values.
    const selecting = createChart(host, {
      marks,
      facet: facet("region"),
      interaction: { brush: "xy" },
    });
    await selecting.loading;
    const [, c] = modelOf(selecting).panels();
    pointer(selecting.root, "pointerdown", c!.x.map(0.5), top);
    pointer(selecting.root, "pointermove", c!.x.map(1.5), bottom);
    pointer(selecting.root, "pointerup", c!.x.map(1.5), bottom);
    expect(selecting.selection!.y![1]).toBeCloseTo(c!.y.invert(top), 4);
    selecting.destroy();
  });

  it("keep right scales of their own out of viewports, and place values on each panel's", () => {
    const chart = createChart(host, {
      marks,
      facet: facet("region"),
      yRight: { scope: "panel" },
      interaction: { zoom: "x" },
    });
    const [a, b] = chart.getPanels();
    expect(a!.yRight!.canSetViewport).toBe(false);
    expect(a!.yRight!.group).not.toBe(b!.yRight!.group);
    expect(() => chart.setViewport({ yRight: [0, 10] })).toThrow("no one y range");
    chart.setViewport({ y: [0, 20] });
    expect(chart.getViewport()).toEqual({ x: null, y: [0, 20], yRight: null });
    // The same value sits at another height in each panel.
    const at = (panel: string) => chart.toPixel(300, { panel, axis: "yRight" })!;
    expect(at("a")).not.toBeCloseTo(at("b"), 0);
    expect(chart.formatValue(2500, { panel: "b", axis: "yRight" })).toBe("2,500");
    chart.destroy();
    expect(() =>
      createChart(host, {
        marks,
        facet: facet("region"),
        yRight: { scope: "panel" },
        interaction: { zoom: "y" },
      }),
    ).toThrow("cannot zoom along y");
  });

  it("announce a panel's own annotations as the keyboard arrives there", () => {
    const events = table({ at: [1, 2], note: ["deploy", "outage"], region: ["a", "b"] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [line(traffic, { x: "t", y: "ms" }), rule(events, { x: "at", textField: "note" })],
      facet: facet("region"),
    });
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toMatch(/^a: Rule: deploy \(x 1\)\. 0\. ms: 10/);
    // Within the panel, it is not repeated.
    key(chart, "ArrowRight");
    expect(live.textContent).not.toContain("deploy");
    key(chart, "ArrowDown");
    expect(live.textContent).toMatch(/^b: Rule: outage \(x 2\)\. /);
    chart.destroy();
  });
});
