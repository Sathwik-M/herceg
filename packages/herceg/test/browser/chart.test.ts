import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { geometry } from "../../src/data/geometry.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { radar } from "../../src/marks/radar.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { treemap } from "../../src/marks/treemap.ts";
import type { ArcGeometry, ShapesGeometry, TextShape } from "../../src/scene/scene.ts";
import { resolveTheme } from "../../src/theme.ts";
import { bandBox } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function series(n: number, seriesCount = 2) {
  const columns: Record<string, Float64Array> = {
    t: Float64Array.from({ length: n }, (_, i) => i * 1000),
  };
  for (let s = 0; s < seriesCount; s++) {
    columns[`s${s}`] = Float64Array.from(
      { length: n },
      (_, i) => Math.sin(i / 10 + s) * 10 + s * 5,
    );
  }
  return table(columns);
}

const markPaths = (chart: Chart) => chart.root.querySelectorAll("svg g[clip-path] path");

describe("mounting", () => {
  it("renders small charts as SVG with an accessible name and description", () => {
    const data = series(50);
    const chart = createChart(host, {
      title: "Load",
      marks: [line(data, { x: "t", y: ["s0", "s1"] })],
    });
    expect(chart.root.getAttribute("role")).toBe("figure");
    expect(chart.root.getAttribute("aria-label")).toBe("Load");
    expect(markPaths(chart)).toHaveLength(2);
    expect(chart.root.querySelector("canvas")).toBeNull();
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("2 series");
    expect(description.textContent).toContain("s0: 50 points");
    chart.destroy();
  });

  it("follows the container size and fixed sizes", () => {
    const chart = createChart(host, { marks: [line(series(10), { x: "t", y: "s0" })] });
    expect(chart.root.querySelector("svg")!.getAttribute("width")).toBe("600");
    chart.update({ width: 400, height: 200 });
    chart.render();
    expect(chart.root.querySelector("svg")!.getAttribute("width")).toBe("400");
    chart.destroy();
  });

  it("re-renders when the container resizes", async () => {
    const chart = createChart(host, { marks: [line(series(10), { x: "t", y: "s0" })] });
    host.style.width = "450px";
    await new Promise((resolve) => setTimeout(resolve, 50));
    await frame();
    expect(chart.root.querySelector("svg")!.getAttribute("width")).toBe("450");
    chart.destroy();
  });

  it("cleans up after repeated mounting", () => {
    const data = series(100);
    for (let i = 0; i < 50; i++) {
      const chart = createChart(host, { marks: [line(data, { x: "t", y: ["s0", "s1"] })] });
      chart.destroy();
    }
    expect(host.childElementCount).toBe(0);
    // Destroyed charts no longer react to their data.
    expect(() => data.append({ t: [1e6], s0: [1], s1: [2] })).not.toThrow();
  });
});

describe("renderers", () => {
  it("moves dense marks to canvas automatically and back", () => {
    const sparse = series(10, 4);
    const chart = createChart(host, {
      marks: [line(sparse, { x: "t", y: ["s0", "s1", "s2", "s3"] })],
    });
    expect(chart.root.querySelector("canvas")).toBeNull();
    // Level of detail keeps one dense line to ~4 points per pixel column, so
    // it takes several dense lines to exceed the SVG budget.
    const dense = series(50_000, 4);
    chart.update({ marks: [line(dense, { x: "t", y: ["s0", "s1", "s2", "s3"] })] });
    chart.render();
    const canvas = chart.root.querySelector("canvas")!;
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(Math.round(600 * devicePixelRatio));
    expect(markPaths(chart)).toHaveLength(0);
    chart.update({ marks: [line(sparse, { x: "t", y: ["s0", "s1", "s2", "s3"] })] });
    chart.render();
    expect(chart.root.querySelector("canvas")).toBeNull();
    expect(markPaths(chart)).toHaveLength(4);
    chart.destroy();
  });

  it("honors an explicit renderer", () => {
    const chart = createChart(host, {
      renderer: "canvas",
      marks: [line(series(10), { x: "t", y: "s0" })],
    });
    expect(chart.root.querySelector("canvas")).not.toBeNull();
    chart.update({ renderer: "svg" });
    chart.render();
    expect(chart.root.querySelector("canvas")).toBeNull();
    chart.destroy();
  });
});

describe("updates", () => {
  it("re-renders on the next frame after appends, once per frame", async () => {
    const data = series(100, 1);
    const chart = createChart(host, { marks: [line(data, { x: "t", y: "s0" })] });
    const before = markPaths(chart)[0]!.getAttribute("d");
    let renders = 0;
    const svg = chart.root.querySelector("svg")!;
    const observer = new MutationObserver(() => renders++);
    observer.observe(svg, { subtree: true, attributes: true, attributeFilter: ["d"] });
    for (let i = 0; i < 10; i++) data.appendRow({ t: 100_000 + i * 1000, s0: 50 });
    expect(markPaths(chart)[0]!.getAttribute("d")).toBe(before);
    await frame();
    await Promise.resolve();
    expect(markPaths(chart)[0]!.getAttribute("d")).not.toBe(before);
    expect(renders).toBe(1);
    observer.disconnect();
    chart.destroy();
  });
});

describe("interaction", () => {
  function pointer(target: Element, type: string, x: number, y: number) {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }),
    );
  }

  it("shows a tooltip and crosshair under the pointer", async () => {
    const start = Date.UTC(2026, 0, 1);
    const data = table({
      t: time(Float64Array.from({ length: 11 }, (_, i) => start + i * 60_000)),
      a: new Float64Array(11).fill(3),
      b: new Float64Array(11).fill(7),
    });
    const chart = createChart(host, {
      timeZone: "UTC",
      locale: "en-US",
      marks: [line(data, { x: "t", y: ["a", "b"] })],
    });
    pointer(chart.root, "pointermove", 300, 150);
    await frame();
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("a3");
    expect(tooltip.textContent).toContain("b7");
    expect(chart.root.querySelectorAll("svg circle")).toHaveLength(2);
    pointer(chart.root, "pointerleave", 0, 0);
    await frame();
    expect(tooltip.style.display).toBe("none");
    chart.destroy();
  });

  it("toggles series from the legend", () => {
    const chart = createChart(host, { marks: [line(series(20), { x: "t", y: ["s0", "s1"] })] });
    const buttons = chart.root.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    chart.render();
    expect(markPaths(chart)).toHaveLength(1);
    expect(chart.root.querySelectorAll("button")[1]!.getAttribute("aria-pressed")).toBe("false");
    chart.destroy();
  });

  it("reads values with the keyboard", () => {
    const data = table({ t: [0, 1, 2], v: [10, 20, 30] });
    const chart = createChart(host, { marks: [line(data, { x: "t", y: "v" })] });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowRight");
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toContain("v: 10");
    key("ArrowRight");
    expect(live.textContent).toContain("v: 20");
    key("End");
    expect(live.textContent).toContain("v: 30");
    chart.destroy();
  });

  it("zooms with the wheel and resets on double click", () => {
    const chart = createChart(host, {
      interaction: { zoom: true },
      marks: [line(series(100), { x: "t", y: "s0" })],
    });
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -200,
        clientX: chart.root.getBoundingClientRect().left + 300,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(chart.model.viewport).not.toBeNull();
    const [lo, hi] = chart.model.viewport!;
    expect(hi - lo).toBeLessThan(99_000);
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(chart.model.viewport).toBeNull();
    chart.destroy();
  });

  it("shares the cursor and zoom with synced charts", async () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const data = series(100);
    const a = createChart(host, {
      interaction: { sync: "group", zoom: true },
      marks: [line(data, { x: "t", y: "s0" })],
    });
    const b = createChart(other, {
      interaction: { sync: "group", zoom: true },
      marks: [line(data, { x: "t", y: "s1" })],
    });
    pointer(a.root, "pointermove", 300, 150);
    await frame();
    expect(b.root.querySelector("svg line")!.getAttribute("visibility")).toBe("visible");
    a.setViewport([10_000, 20_000]);
    expect(b.model.viewport).toEqual([10_000, 20_000]);
    a.destroy();
    b.destroy();
    other.remove();
  });
});

describe("events and brushing", () => {
  function press(target: Element, type: string, x: number, y: number, shiftKey = false) {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: rect.left + x,
        clientY: rect.top + y,
        shiftKey,
        pointerId: 1,
      }),
    );
  }
  function drag(chart: Chart, from: number, to: number, shiftKey = false) {
    const x = chart.model.xScale()!;
    const y = chart.model.yScale()!;
    const py = (y.range[0] + y.range[1]) / 2;
    press(chart.root, "pointerdown", x.map(from), py, shiftKey);
    press(chart.root, "pointermove", x.map((from + to) / 2), py, shiftKey);
    press(chart.root, "pointermove", x.map(to), py, shiftKey);
    press(chart.root, "pointerup", x.map(to), py, shiftKey);
  }
  const band = (chart: Chart) => chart.root.querySelector('svg path[fill-opacity="0.18"]');

  it("selects an x range by brushing and clears it with a click", async () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(series(100), { x: "t", y: "s0" })],
    });
    const selections: (readonly [number, number] | null)[] = [];
    chart.on("select", ({ x }) => selections.push(x));
    drag(chart, 60_000, 20_000);
    await frame();
    const [lo, hi] = chart.selection!.x!;
    expect(lo).toBeCloseTo(20_000, -3);
    expect(hi).toBeCloseTo(60_000, -3);
    expect(selections).toEqual([chart.selection!.x]);
    expect(band(chart)!.getAttribute("visibility")).toBe("visible");
    // A brush selects; it does not zoom.
    expect(chart.model.viewport).toBeNull();
    const x = chart.model.xScale()!;
    press(chart.root, "pointerdown", x.map(80_000), 150);
    press(chart.root, "pointerup", x.map(80_000), 150);
    await frame();
    expect(chart.selection).toBeNull();
    expect(selections.at(-1)).toBeNull();
    expect(band(chart)!.getAttribute("visibility")).toBe("hidden");
    chart.destroy();
  });

  it("zooms to a brushed range when zoom is on too, and pans with Shift", () => {
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [line(series(100), { x: "t", y: "s0" })],
    });
    const viewports: (readonly [number, number] | null)[] = [];
    chart.on("viewport", ({ domain }) => viewports.push(domain));
    drag(chart, 20_000, 60_000);
    const [lo, hi] = chart.model.viewport!;
    expect(lo).toBeCloseTo(20_000, -3);
    expect(hi).toBeCloseTo(60_000, -3);
    expect(chart.selection).toBeNull();
    expect(viewports).toHaveLength(1);
    chart.render();
    drag(chart, 30_000, 40_000, true);
    const [panLo, panHi] = chart.model.viewport!;
    expect(panHi - panLo).toBeCloseTo(hi - lo, 0);
    expect(panLo).toBeLessThan(lo);
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(viewports.at(-1)).toBeNull();
    chart.destroy();
  });

  it("selects with Shift and the arrow keys, and zooms on Enter", () => {
    const data = table({ t: [0, 1, 2, 3], v: [10, 20, 30, 40] });
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [line(data, { x: "t", y: "v" })],
    });
    chart.root.focus();
    const key = (k: string, shiftKey = false) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    key("ArrowRight");
    key("ArrowRight", true);
    key("ArrowRight", true);
    expect(chart.selection?.x).toEqual([0, 2]);
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toContain("Selected 0 to 2. Press Enter to zoom to it.");
    key("Enter");
    expect(chart.model.viewport).toEqual([0, 2]);
    expect(chart.selection).toBeNull();
    key("ArrowLeft", true);
    key("Escape");
    expect(chart.selection).toBeNull();
    chart.destroy();
  });

  it("reports hover changes without the built-in tooltip, and clicks", async () => {
    const data = table({ t: [0, 1, 2], v: [10, 20, 30] });
    const chart = createChart(host, { tooltip: false, marks: [line(data, { x: "t", y: "v" })] });
    const hovers: (number | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.value));
    const clicks: (number | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.value));
    const x = chart.model.xScale()!;
    press(chart.root, "pointermove", x.map(1), 150);
    await frame();
    press(chart.root, "pointermove", x.map(1) + 1, 150);
    await frame();
    press(chart.root, "pointermove", x.map(2), 150);
    await frame();
    // The second move inspects the same point, so it reports nothing new.
    expect(hovers).toEqual([1, 2]);
    expect(chart.root.querySelector("svg line")!.getAttribute("visibility")).toBe("hidden");
    press(chart.root, "pointerdown", x.map(2), 150);
    press(chart.root, "pointerup", x.map(2), 150);
    expect(clicks).toEqual([2]);
    press(chart.root, "pointerleave", 0, 0);
    await frame();
    expect(hovers.at(-1)).toBeUndefined();
    chart.destroy();
  });

  it("keeps brushed ranges inside the plot and cancels them with the browser", () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4] }), { x: "t", y: "v" })],
      x: { domain: [0, 3] },
    });
    expect(chart.root.style.touchAction).toBe("pan-y");
    const x = chart.model.xScale()!;
    press(chart.root, "pointerdown", x.map(1), 150);
    press(chart.root, "pointermove", x.map(2), 150);
    press(chart.root, "pointermove", x.range[1] + 200, 150);
    press(chart.root, "pointerup", x.range[1] + 200, 150);
    expect(chart.selection!.x![1]).toBeCloseTo(3, 6);
    press(chart.root, "pointerdown", x.map(0.5), 150);
    press(chart.root, "pointermove", x.map(2.5), 150);
    press(chart.root, "pointercancel", x.map(2.5), 150);
    press(chart.root, "pointerup", x.map(2.5), 150);
    expect(chart.selection!.x![0]).toBeCloseTo(1, 6);
    chart.destroy();
  });

  it("brushes whole categories, which selects even with zoom on", async () => {
    const sales = table({ region: ["N", "S", "E", "W"], v: [1, 2, 3, 4] });
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [bar(sales, { x: "region", y: "v" })],
    });
    const x = chart.model.xScale()!;
    // From inside the first category to inside the third.
    press(chart.root, "pointerdown", x.map(0) + 5, 150);
    press(chart.root, "pointermove", x.map(1), 150);
    press(chart.root, "pointerup", x.map(2) - 5, 150);
    expect(chart.selection?.x).toEqual([0, 2]);
    expect(chart.model.viewport).toBeNull();
    chart.select([1, 1]);
    await frame();
    const rect = band(chart)!;
    expect(rect.getAttribute("visibility")).toBe("visible");
    expect(bandBox(rect).width).toBeGreaterThan(Math.abs(x.bandwidth!));
    chart.destroy();
  });

  it("starts keyboard selections over after the pointer or a clear", () => {
    const data = table({ t: [0, 1, 2, 3], v: [10, 20, 30, 40] });
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(data, { x: "t", y: "v" })],
    });
    chart.root.focus();
    const key = (k: string, shiftKey = false) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    key("ArrowRight");
    key("ArrowRight", true);
    expect(chart.selection?.x).toEqual([0, 1]);
    chart.select(null);
    key("ArrowRight", true);
    expect(chart.selection?.x).toEqual([1, 2]);
    press(chart.root, "pointermove", 300, 150);
    key("ArrowRight");
    key("ArrowRight", true);
    expect(chart.selection!.x![0]).toBe(chart.selection!.x![1] - 1);
    chart.destroy();
  });

  it("leaves keys on legend buttons to the buttons", () => {
    const chart = createChart(host, {
      interaction: { brush: "x", zoom: true },
      marks: [line(series(20), { x: "t", y: ["s0", "s1"] })],
    });
    chart.select([1000, 5000]);
    const button = chart.root.querySelector("button")!;
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chart.model.viewport).toBeNull();
    expect(chart.selection?.x).toEqual([1000, 5000]);
    chart.destroy();
  });

  it("reports hover again when what it shows changes under a still pointer", async () => {
    const band = table({ t: [0, 1, 2], lo: [2, 2, 2], hi: [20, 20, 20] });
    const chart = createChart(host, {
      marks: [area(band, { x: "t", y1: "lo", y2: "hi" })],
      y: { domain: [0, 30] },
    });
    const texts: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => texts.push(inspection?.points[0]?.text));
    press(chart.root, "pointermove", chart.model.xScale()!.map(1), 150);
    await frame();
    band.set("lo", 1, 7);
    await frame();
    expect(texts).toEqual(["2 – 20", "7 – 20"]);
    chart.destroy();
  });

  it("shares the final viewport when a listener changes it again", () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const data = series(100);
    const interaction = { sync: "reentrant", zoom: true };
    const a = createChart(host, { interaction, marks: [line(data, { x: "t", y: "s0" })] });
    const b = createChart(other, { interaction, marks: [line(data, { x: "t", y: "s1" })] });
    // A clamps every viewport to at most 1,000 wide.
    a.on("viewport", ({ domain }) => {
      if (domain && domain[1] - domain[0] > 1000) a.setViewport([domain[0], domain[0] + 1000]);
    });
    a.setViewport([0, 2000]);
    expect(a.model.viewport).toEqual([0, 1000]);
    expect(b.model.viewport).toEqual([0, 1000]);
    a.destroy();
    b.destroy();
    other.remove();
  });

  it("stops an older viewport broadcast once a member starts a newer one", () => {
    const hosts = [host, document.createElement("div"), document.createElement("div")];
    for (const element of hosts.slice(1)) {
      element.style.cssText = "width:600px;height:300px";
      document.body.append(element);
    }
    const data = series(100);
    const interaction = { sync: "three", zoom: true };
    const [a, b, c] = hosts.map((element) =>
      createChart(element, { interaction, marks: [line(data, { x: "t", y: "s0" })] }),
    ) as [Chart, Chart, Chart];
    // B clamps the range it receives and shares the result.
    b.on("viewport", ({ domain }) => {
      if (domain && domain[1] - domain[0] > 1000) b.setViewport([domain[0], domain[0] + 1000]);
    });
    a.setViewport([0, 2000]);
    for (const chart of [a, b, c]) expect(chart.model.viewport).toEqual([0, 1000]);
    for (const chart of [a, b, c]) chart.destroy();
    for (const element of hosts.slice(1)) element.remove();
  });

  it("stops an older selection broadcast once a member starts a newer one", () => {
    const hosts = [host, document.createElement("div"), document.createElement("div")];
    for (const element of hosts.slice(1)) {
      element.style.cssText = "width:600px;height:300px";
      document.body.append(element);
    }
    const data = series(100);
    const interaction = { sync: "three", brush: "x" as const };
    const [a, b, c] = hosts.map((element) =>
      createChart(element, { interaction, marks: [line(data, { x: "t", y: "s0" })] }),
    ) as [Chart, Chart, Chart];
    // B replaces the selection it receives and shares its own.
    b.on("select", ({ x }) => {
      if (x?.[0] === 1000) b.select([3000, 4000]);
    });
    a.select([1000, 2000]);
    for (const chart of [a, b, c]) expect(chart.selection?.x).toEqual([3000, 4000]);
    for (const chart of [a, b, c]) chart.destroy();
    for (const element of hosts.slice(1)) element.remove();
  });

  it("removes the drag band when a brush ends without a range", async () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4] }), { x: "t", y: "v" })],
    });
    chart.select([1, 2]);
    const x = chart.model.xScale()!;
    press(chart.root, "pointerdown", x.map(0.5), 150);
    press(chart.root, "pointermove", x.map(0.5) + 40, 150);
    await frame();
    press(chart.root, "pointerup", x.map(0.5) + 1, 150);
    await frame();
    expect(chart.selection?.x).toEqual([1, 2]);
    expect(bandBox(band(chart)!).x).toBeCloseTo(x.map(1), 1);
    chart.destroy();
  });

  it("emits only changes, and keeps going when a listener throws", () => {
    const chart = createChart(host, { marks: [line(series(10), { x: "t", y: "s0" })] });
    const seen: unknown[] = [];
    chart.on("select", () => {
      throw new Error("listener failed");
    });
    const stop = chart.on("select", ({ x }) => seen.push(x));
    const errors: unknown[] = [];
    const reportError = globalThis.reportError;
    globalThis.reportError = (error) => errors.push(error);
    try {
      chart.select([5, 1]);
      chart.select([1, 5]);
      stop();
      chart.select(null);
    } finally {
      globalThis.reportError = reportError;
    }
    expect(seen).toEqual([[1, 5]]);
    expect(errors).toHaveLength(2);
    chart.setViewport([0, 1000]);
    chart.destroy();
  });
});

describe("export", () => {
  it("produces standalone SVG", () => {
    const chart = createChart(host, {
      title: "Export",
      marks: [line(series(20), { x: "t", y: "s0" }), rule({ y: 0 })],
    });
    const svg = chart.toSVG();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<title");
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    chart.destroy();
  });
});

describe("themes that follow the page", () => {
  it("read CSS colors and variables, and re-render when the page switches themes", async () => {
    const style = document.createElement("style");
    style.textContent =
      ":root { --chart-ink: #223344; --chart-one: oklch(0.6 0.15 250); } " +
      ":root.night { --chart-ink: rgb(230, 230, 230); --chart-one: #ff8800; }";
    document.head.append(style);
    const chart = createChart(host, {
      theme: { text: "var(--chart-ink)", palette: ["var(--chart-one)", "oklch(0.7 0.1 150)"] },
      marks: [bar(table({ k: ["a", "b"], v: [1, 2] }), { x: "k", y: "v" })],
    });
    try {
      expect(chart.model.theme.text).toBe("#223344");
      // Colors in any syntax arrive as sRGB hex, which ramps and contrast checks read.
      expect(chart.model.theme.palette[0]).toMatch(/^#[0-9a-f]{6}$/);
      expect(chart.model.theme.palette[1]).toMatch(/^#[0-9a-f]{6}$/);
      expect(host.querySelector("span")).toBeNull();
      document.documentElement.classList.add("night");
      // The chart reads the page again on its next frame.
      await frame();
      await frame();
      expect(chart.model.theme.text).toBe("#e6e6e6");
      expect(chart.model.theme.palette[0]).toBe("#ff8800");
      // Light text on a light theme gets a dark tooltip.
      expect(chart.model.theme.tooltipBackground).toBe(resolveTheme("dark").tooltipBackground);
      expect(markPaths(chart)[0]!.getAttribute("fill")).toBe("#ff8800");
    } finally {
      chart.destroy();
      document.documentElement.classList.remove("night");
      style.remove();
    }
  });

  it("choose light or dark with auto by the surface the chart sits on", () => {
    const light = resolveTheme("light").text;
    const dark = resolveTheme("dark").text;
    host.style.background = "#101418";
    const chart = createChart(host, {
      theme: "auto",
      marks: [line(series(10), { x: "t", y: "s0" })],
    });
    expect(chart.model.theme.text).toBe(dark);
    host.style.background = "#fafafa";
    chart.update({});
    expect(chart.model.theme.text).toBe(light);
    chart.destroy();
  });

  it("find the surface through translucent layers and shadow roots", async () => {
    const dark = resolveTheme("dark").text;
    const light = resolveTheme("light").text;
    const marks = [line(series(10), { x: "t", y: "s0" })];
    const textOn = (container: HTMLElement) => {
      const chart = createChart(container, { theme: "auto", marks });
      const text = chart.model.theme.text;
      chart.destroy();
      return text;
    };
    // A faint dark tint over white is still light; a faint light one over black is dark.
    host.style.background = "white";
    const tint = document.createElement("div");
    tint.style.cssText = "width:600px;height:300px;background:rgba(0,0,0,0.05)";
    host.append(tint);
    expect(textOn(tint)).toBe(light);
    host.style.background = "black";
    tint.style.background = "rgba(255,255,255,0.05)";
    expect(textOn(tint)).toBe(dark);
    tint.remove();
    // Inside a shadow root, the host's background counts.
    host.style.background = "black";
    const shadow = document.createElement("div");
    host.append(shadow);
    const inner = document.createElement("div");
    inner.style.cssText = "width:600px;height:300px";
    shadow.attachShadow({ mode: "open" }).append(inner);
    expect(textOn(inner)).toBe(dark);
    shadow.remove();
    // A chart in a frame judges the frame's own page.
    const frame = document.createElement("iframe");
    frame.style.cssText = "width:600px;height:300px;border:0";
    host.append(frame);
    await new Promise((resolve) => setTimeout(resolve));
    const inFrame = frame.contentDocument!.createElement("div");
    inFrame.style.cssText = "width:600px;height:300px";
    frame.contentDocument!.body.append(inFrame);
    expect(textOn(inFrame)).toBe(light);
    frame.remove();
  });

  it("follow the current color of the page", async () => {
    document.body.style.color = "rgb(10, 20, 30)";
    try {
      const chart = createChart(host, {
        theme: { text: "currentColor" },
        marks: [line(series(10), { x: "t", y: "s0" })],
      });
      expect(chart.model.theme.text).toBe("#0a141e");
      document.body.style.color = "rgb(200, 210, 220)";
      await frame();
      await frame();
      expect(chart.model.theme.text).toBe("#c8d2dc");
      chart.destroy();
    } finally {
      document.body.style.color = "";
    }
  });

  it("follow the user's color scheme with auto on pages that allow dark", () => {
    const { matchMedia } = window;
    let prefersDark = true;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes("dark") && prefersDark;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
    const root = document.documentElement.style;
    try {
      root.colorScheme = "light dark";
      const chart = createChart(host, {
        theme: "auto",
        marks: [line(series(10), { x: "t", y: "s0" })],
      });
      expect(chart.model.theme.text).toBe(resolveTheme("dark").text);
      prefersDark = false;
      for (const listener of listeners) listener();
      chart.render();
      expect(chart.model.theme.text).toBe(resolveTheme("light").text);
      // A theme that stops following the page stops listening.
      chart.update({ theme: "dark" });
      expect(listeners.size).toBe(0);
      chart.update({ theme: { extends: "auto", lineWidth: 3 } });
      expect(listeners.size).toBe(1);
      chart.destroy();
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = matchMedia;
      root.colorScheme = "";
    }
  });
});

describe("pies", () => {
  const sales = table({ region: ["North", "South", "East"], revenue: [50, 30, 20] });
  const pointer = (target: Element, type: string, x: number, y: number) => {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }),
    );
  };

  it("outline the slice under the pointer and show its share", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [pie(sales, { category: "region", value: "revenue" })],
    });
    // North fills the first half, clockwise from the top: right of the center.
    const { x, y, width, height } = planOf(chart);
    pointer(chart.root, "pointermove", x + width / 2 + 40, y + height / 2);
    await frame();
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toContain("revenue");
    expect(tooltip.textContent).toContain("North");
    expect(tooltip.textContent).toContain("50 (50%)");
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    expect(outline.getAttribute("visibility")).toBe("visible");
    expect(outline.getAttribute("d")).toMatch(/A/);
    // No crosshair in a pie.
    expect(
      [...chart.root.querySelectorAll("svg line")].every(
        (l) => l.getAttribute("visibility") === "hidden",
      ),
    ).toBe(true);
    pointer(chart.root, "pointerleave", 0, 0);
    await frame();
    expect(outline.getAttribute("visibility")).toBe("hidden");
    chart.destroy();
  });

  it("report the slice clicked", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [pie(sales, { category: "region", value: "revenue" })],
    });
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.label));
    const { x, y, width, height } = planOf(chart);
    for (const type of ["pointerdown", "pointerup"]) {
      const rect = chart.root.getBoundingClientRect();
      chart.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: rect.left + x + width / 2 + 40,
          clientY: rect.top + y + height / 2,
        }),
      );
    }
    expect(clicks).toEqual(["North"]);
    // A press that strays and comes back is a drag, not a click.
    const rect = chart.root.getBoundingClientRect();
    const at = (type: string, dx: number) =>
      chart.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: rect.left + x + width / 2 + 40 + dx,
          clientY: rect.top + y + height / 2,
        }),
      );
    at("pointerdown", 0);
    at("pointermove", 60);
    at("pointermove", 0);
    at("pointerup", 0);
    expect(clicks).toEqual(["North"]);
    chart.destroy();
  });

  it("read slices with the keyboard, and toggle them from the legend", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [pie(sales, { category: "region", value: "revenue" })],
    });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    expect(live.textContent).toBe("revenue. North: 50 (50%)");
    key("ArrowRight");
    expect(live.textContent).toBe("revenue. South: 30 (30%)");
    key("End");
    expect(live.textContent).toBe("revenue. East: 20 (20%)");
    key("Home");
    expect(live.textContent).toContain("North");
    // Hiding North leaves the others the whole circle.
    chart.root.querySelectorAll("button")[0]!.click();
    chart.render();
    key("ArrowRight");
    expect(live.textContent).toBe("revenue. South: 30 (60%)");
    expect(chart.root.getAttribute("aria-describedby")).toBeTruthy();
    chart.destroy();
  });
});

describe("treemaps", () => {
  it("outline the node under the pointer and report its path", async () => {
    const sales = table({
      region: ["Europe", "Europe", "Asia"],
      country: ["France", "Spain", "Japan"],
      revenue: [3, 2, 5],
    });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [treemap(sales, { path: ["region", "country"], value: "revenue" })],
    });
    const hovers: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.label));
    const { x, y, width, height } = planOf(chart);
    const rect = chart.root.getBoundingClientRect();
    for (const [px, py] of [
      [x + width * 0.25, y + height * 0.6],
      [x + width * 0.75, y + height * 0.6],
    ] as const) {
      chart.root.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + px,
          clientY: rect.top + py,
        }),
      );
      await frame();
    }
    // Europe and Asia are equal halves, Europe on the left.
    expect(hovers).toContain("Asia / Japan");
    expect(hovers.some((label) => label?.startsWith("Europe / "))).toBe(true);
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    expect(outline.getAttribute("visibility")).toBe("visible");
    chart.destroy();
  });
});

describe("gauges and funnels", () => {
  const pointer = (chart: Chart, type: string, x: number, y: number) => {
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX: rect.left + x,
        clientY: rect.top + y,
      }),
    );
  };
  const tooltipOf = (chart: Chart) =>
    [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
  const key = (chart: Chart, k: string) =>
    chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("show a gauge's value on hover and to the keyboard, as it streams", async () => {
    const cpu = table({ cpu: [40, 73] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [gauge(cpu, { value: "cpu", label: "CPU" })],
    });
    const { x, y, width, height } = planOf(chart);
    pointer(chart, "pointermove", x + width / 2, y + height / 2);
    await frame();
    expect(tooltipOf(chart).textContent).toContain("73 of 0 to 100");
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    expect(outline.getAttribute("visibility")).toBe("visible");
    pointer(chart, "pointerleave", 0, 0);
    await frame();
    chart.root.focus();
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("cpu. CPU: 73 of 0 to 100");
    cpu.appendRow({ cpu: 120 });
    chart.render();
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("cpu. CPU: 120 of 0 to 100, above the maximum");
    expect(chart.root.textContent).toContain("120");
    chart.destroy();
  });

  it("paint a gauge's dial, bands, and value on a canvas", () => {
    const chart = createChart(host, {
      renderer: "canvas",
      theme: "light",
      marks: [
        gauge(table({ cpu: [73] }), {
          value: "cpu",
          bands: [
            { to: 50, color: "#00ff00" },
            { to: 100, color: "#ff0000" },
          ],
        }),
      ],
    });
    const canvas = chart.root.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (x: number, y: number) =>
      Array.from(context.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data);
    // The scene again, for positions: arcs do not depend on how text measures.
    const marks = chart.model.scene(estimateText).panels[0]!.marks;
    const arcs = (key: string) => (marks.find((m) => m.key === key) as ArcGeometry).arcs;
    const [cx, cy, r0, r, start, end] = arcs("gauge-dial").subarray(6, 12) as unknown as number[];
    const at = (angle: number, radius: number) =>
      pixel(cx! + radius * Math.cos(angle), cy! + radius * Math.sin(angle));
    const middle = (r0! + r!) / 2;
    // The value's arc in its band's color, the track beyond it, the first band outside.
    expect(at((start! + end!) / 2, middle)).toEqual([255, 0, 0, 255]);
    expect(at((end! + start! + (4 / 3) * Math.PI) / 2, middle)).toEqual([232, 235, 240, 255]);
    const [, , b0, b1, a0, a1] = arcs("gauge-bands").subarray(0, 6) as unknown as number[];
    expect(at((a0! + a1!) / 2, (b0! + b1!) / 2)).toEqual([0, 255, 0, 255]);
    // The value is painted on the canvas; the labels stay in SVG.
    const value = marks.find((m) => m.kind === "shapes") as ShapesGeometry;
    const { x, y } = value.shapes[0] as TextShape;
    let inked = 0;
    for (let dx = -value.fontSize; dx <= value.fontSize; dx++)
      inked += +(pixel(x + dx, y)[3]! > 200);
    expect(inked).toBeGreaterThan(4);
    const svg = chart.root.querySelector("svg")!.textContent;
    expect(svg).toContain("cpu");
    expect(svg).not.toContain("73");
    chart.destroy();
  });

  it("read funnel stages top to bottom, and report the one clicked", async () => {
    const stages = table({ stage: ["Visit", "Cart", "Purchase"], users: [2000, 1200, 300] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [funnel(stages, { category: "stage", value: "users" })],
    });
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.label));
    const { x, y, width, height } = planOf(chart);
    // The middle of the last stage's row, right of its narrow bar.
    const last = y + height - height / 3.6 / 2;
    pointer(chart, "pointermove", x + width - 20, last);
    await frame();
    expect(tooltipOf(chart).textContent).toContain("Purchase");
    expect(tooltipOf(chart).textContent).toContain(
      "300, 15% of the first stage, 25% of the previous",
    );
    pointer(chart, "pointerdown", x + width - 20, last);
    pointer(chart, "pointerup", x + width - 20, last);
    expect(clicks).toEqual(["Purchase"]);
    pointer(chart, "pointerleave", 0, 0);
    chart.root.focus();
    const live = chart.root.querySelector("[aria-live]")!;
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("users. Visit: 2,000");
    key(chart, "ArrowDown");
    expect(live.textContent).toBe("users. Cart: 1,200, 60% of the first stage");
    key(chart, "End");
    expect(live.textContent).toContain("Purchase");
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(
      "Funnel of users by stage: 3 stages from 2,000 (Visit) to 300 (Purchase), 15% of the first.",
    );
    chart.destroy();
  });
});

describe("sankey diagrams", () => {
  const flows = table({
    from: ["Coal", "Coal", "Gas", "Electricity"],
    to: ["Electricity", "Industry", "Electricity", "Homes"],
    twh: [80, 40, 50, 130],
  });

  it("outline the node or link under the pointer, and report it and clicks on it", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [sankey(flows, { source: "from", target: "to", value: "twh" })],
    });
    const hovers: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.label));
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    const rect = chart.root.getBoundingClientRect();
    for (const key of [
      [0, "Electricity"],
      [0, "Coal", "Electricity"],
    ]) {
      const { px, py } = chart.model.inspectItem(JSON.stringify(key))!.points[0]!;
      chart.root.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + px,
          clientY: rect.top + py,
        }),
      );
      await frame();
      expect(outline.getAttribute("visibility")).toBe("visible");
    }
    expect(hovers).toEqual(["Electricity", "Coal → Electricity"]);
    // Bands are outlined by their curves, nodes by their rectangles.
    expect(outline.getAttribute("d")).toMatch(/C/);
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toBe("twhCoal → Electricity80");
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.label));
    const { px, py } = chart.model.inspectItem(JSON.stringify([0, "Gas"]))!.points[0]!;
    for (const type of ["pointerdown", "pointerup"]) {
      chart.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: rect.left + px,
          clientY: rect.top + py,
        }),
      );
    }
    expect(clicks).toEqual(["Gas"]);
    chart.destroy();
  });

  it("read nodes, then links, with the keyboard", () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [sankey(flows, { source: "from", target: "to", value: "twh" })],
    });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    expect(live.textContent).toBe("twh. Coal: 120 out");
    key("ArrowDown");
    expect(live.textContent).toBe("twh. Gas: 50 out");
    key("ArrowDown");
    expect(live.textContent).toBe("twh. Electricity: 130 in, 130 out");
    key("End");
    expect(live.textContent).toBe("twh. Electricity → Homes: 130");
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(
      "Sankey of twh: 5 nodes in 3 columns and 4 flows; the largest flow is Electricity → Homes, 130.",
    );
    chart.destroy();
  });
});

describe("networks", () => {
  const talks = () =>
    table({ from: ["Ana", "Ana", "Bo", "Cy"], to: ["Bo", "Cy", "Cy", "Dee"], n: [3, 1, 2, 5] });
  const people = () =>
    table({ name: ["Ana", "Bo", "Cy", "Dee"], team: ["Data", "Data", "Data", "Sales"] });
  const network = (links = talks(), nodes = people()) =>
    graph(links, { source: "from", target: "to", value: "n", nodes, node: "name", group: "team" });
  const move = (chart: Chart, px: number, py: number, type = "pointermove") => {
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX: rect.left + px,
        clientY: rect.top + py,
      }),
    );
  };

  it("outline the node or link under the pointer, and report it and clicks on it", async () => {
    const chart = createChart(host, { locale: "en-US", marks: [network()] });
    const hovers: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.label));
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    for (const key of [
      [0, "Cy"],
      [0, "Cy", "Dee"],
    ]) {
      const { px, py } = chart.model.inspectItem(JSON.stringify(key))!.points[0]!;
      move(chart, px, py);
      await frame();
      expect(outline.getAttribute("visibility")).toBe("visible");
    }
    expect(hovers).toEqual(["Cy", "Cy — Dee"]);
    // Links are outlined by a band around them.
    expect(outline.getAttribute("d")).toMatch(/^M[\d. ]+L[\d. ]+L[\d. ]+L[\d. ]+Z$/);
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toBe("nCy — Dee5");
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.label));
    const { px, py } = chart.model.inspectItem(JSON.stringify([0, "Ana"]))!.points[0]!;
    move(chart, px, py, "pointerdown");
    move(chart, px, py, "pointerup");
    expect(clicks).toEqual(["Ana"]);
    chart.destroy();
  });

  it("read nodes, then links, with the keyboard, and hide groups from the legend", () => {
    const chart = createChart(host, { locale: "en-US", marks: [network()] });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    expect(live.textContent).toBe("n. Ana: 2 links, n 4 (team Data)");
    key("ArrowDown");
    expect(live.textContent).toBe("n. Bo: 2 links, n 5 (team Data)");
    key("End");
    expect(live.textContent).toBe("n. Cy — Dee: 5");
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(
      "Network of 4 nodes and 4 links in 2 groups; most connected: Cy (3 links). Strongest link: Cy — Dee, n 5.",
    );
    // Hiding Sales leaves Dee and its link out, and the others where they were.
    const before = chart.model.inspectItem(JSON.stringify([0, "Ana"]))!.points[0]!;
    const [data, sales] = chart.root.querySelectorAll("button");
    expect(data!.textContent).toBe("Data");
    sales!.click();
    chart.render();
    expect(sales!.getAttribute("aria-pressed")).toBe("false");
    key("End");
    expect(live.textContent).toBe("n. Bo — Cy: 2");
    expect(chart.model.inspectItem(JSON.stringify([0, "Dee"]))).toBeUndefined();
    const after = chart.model.inspectItem(JSON.stringify([0, "Ana"]))!.points[0]!;
    expect([after.px, after.py]).toEqual([before.px, before.py]);
    chart.destroy();
  });

  it("redraw when either table changes", async () => {
    const [links, nodes] = [talks(), people()];
    const chart = createChart(host, { locale: "en-US", marks: [network(links, nodes)] });
    await frame();
    nodes.append({ name: ["Eve"], team: ["Ops"] });
    await frame();
    expect([...chart.root.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Data",
      "Sales",
      "Ops",
    ]);
    links.append({ from: ["Eve"], to: ["Ana"], n: [1] });
    await frame();
    expect(chart.model.inspectItem(JSON.stringify([0, "Eve", "Ana"]))).toBeDefined();
    chart.destroy();
  });
});

describe("maps", () => {
  const square = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];
  const regions = () =>
    table({
      name: ["Ada", "Bel", "Cor"],
      party: ["Red", "Blue", "Red"],
      shape: geometry({
        coordinates: Float64Array.from([
          ...square(0, 0, 10),
          ...square(3, 3, 4),
          ...square(10, 0, 10),
          ...square(20, 0, 10),
        ]),
        ringOffsets: Int32Array.from([0, 4, 8, 12, 16]),
        polygonOffsets: Int32Array.from([0, 2, 3, 4]),
        geometryOffsets: Int32Array.from([0, 1, 2, 3]),
      }),
    });
  const places = () => table({ city: ["Port"], lon: [15], lat: [5], people: [40] });
  const map = (shapes = regions()) => [
    geoshape(shapes, { name: "name", color: "party" }),
    geopoint(places(), { longitude: "lon", latitude: "lat", r: "people", name: "city" }),
  ];
  const move = (chart: Chart, px: number, py: number, type = "pointermove") => {
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX: rect.left + px,
        clientY: rect.top + py,
      }),
    );
  };

  it("outline the region or point under the pointer and show its tooltip", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      projection: "equirectangular",
      marks: map(),
    });
    const hovers: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.label));
    const outline = chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none']")!;
    for (const key of [
      [0, 0],
      [1, 0],
    ]) {
      const { px, py } = chart.model.inspectItem(JSON.stringify(key))!.points[0]!;
      move(chart, px, py);
      await frame();
      expect(outline.getAttribute("visibility")).toBe("visible");
    }
    expect(hovers).toEqual(["Ada", "Port"]);
    const tooltip = [...chart.root.children].find(
      (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
    ) as HTMLElement;
    expect(tooltip.textContent).toBe("peoplePort40");
    chart.destroy();
  });

  it("read regions, then points, with the keyboard, and gray categories out from the legend", () => {
    const chart = createChart(host, { locale: "en-US", projection: "mercator", marks: map() });
    chart.root.focus();
    const key = (k: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    expect(live.textContent).toBe("party. Ada: Red");
    key("End");
    expect(live.textContent).toBe("people. Port: 40");
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(
      "Map of 3 regions colored by party: Red 2, Blue 1. 1 point on the map sized by people; largest Port (40).",
    );
    // Hiding Red grays its regions out; they stay on the map and in reading order.
    const before = chart.model.inspectItem(JSON.stringify([0, 2]))!.points[0]!;
    const [red] = chart.root.querySelectorAll("button");
    expect(red!.textContent).toBe("Red");
    red!.click();
    chart.render();
    const after = chart.model.inspectItem(JSON.stringify([0, 2]))!.points[0]!;
    expect([after.px, after.py]).toEqual([before.px, before.py]);
    expect(after.color).not.toBe(before.color);
    chart.destroy();
  });

  it("paint regions on a canvas with holes left empty", () => {
    const chart = createChart(host, {
      projection: "equirectangular",
      marks: [geoshape(regions(), { fill: "#ff0000", strokeWidth: 0 })],
      renderer: "canvas",
    });
    const canvas = host.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const pixel = (px: number, py: number) =>
      Array.from(
        canvas.getContext("2d")!.getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1)
          .data,
      );
    // Ada's exterior, the first ring of its outline: its middle is the lake's.
    const outline = chart.model.inspectItem(JSON.stringify([0, 0]))!;
    const exterior = (outline as { outline: string }).outline.split("Z")[0]!;
    const values = exterior.match(/-?[\d.]+/g)!.map(Number);
    const xs = values.filter((_, i) => i % 2 === 0);
    const ys = values.filter((_, i) => i % 2 === 1);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    expect(pixel((x0 + x1) / 2, (y0 + y1) / 2)[3]).toBe(0);
    expect(pixel(x0 + (x1 - x0) / 10, (y0 + y1) / 2)).toEqual([255, 0, 0, 255]);
    chart.destroy();
  });

  it("redraw when values change, keeping the regions in place", async () => {
    const shapes = regions();
    const chart = createChart(host, { locale: "en-US", marks: map(shapes) });
    const before = chart.model.inspectItem(JSON.stringify([0, 1]))!;
    expect(before.points[0]!.text).toBe("Blue");
    shapes.setColumn("party", ["Red", "Red", "Red"]);
    await frame();
    const after = chart.model.inspectItem(JSON.stringify([0, 1]))!;
    expect(after.points[0]!.text).toBe("Red");
    expect([after.points[0]!.px, after.points[0]!.py]).toEqual([
      before.points[0]!.px,
      before.points[0]!.py,
    ]);
    chart.destroy();
  });
});

/** The room a pie chart's mark has: its one panel. */
function planOf(chart: Chart) {
  const svg = chart.toSVG();
  const clip =
    /<clipPath id="[^"]+"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
      svg,
    )!;
  const [x, y, width, height] = clip.slice(1).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

describe("zooming and brushing in two dimensions", () => {
  const points = () =>
    table({
      x: Float64Array.from({ length: 50 }, (_, i) => i),
      y: Float64Array.from({ length: 50 }, (_, i) => (i * 7) % 50),
    });
  const at = (chart: Chart, type: string, px: number, py: number) => {
    const rect = chart.root.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + px,
      clientY: rect.top + py,
    };
    chart.root.dispatchEvent(
      type === "wheel"
        ? new WheelEvent("wheel", { ...init, deltaY: -200 })
        : new PointerEvent(type, { ...init, button: 0, pointerId: 1 }),
    );
  };
  const center = (chart: Chart) => {
    const { plot } = chart.model.panels()[0]!;
    return [plot.x + plot.width / 2, plot.y + plot.height / 2] as const;
  };

  it("zooms y, or both axes, with the wheel, and resets both on double click", () => {
    const chart = createChart(host, {
      interaction: { zoom: "y" },
      marks: [point(points(), { x: "x", y: "y" })],
    });
    const viewports: (readonly [number, number] | null)[] = [];
    chart.on("viewport", ({ y }) => viewports.push(y));
    at(chart, "wheel", ...center(chart));
    expect(chart.model.viewport).toBeNull();
    const [lo, hi] = chart.model.yViewport!.y;
    expect(hi - lo).toBeLessThan(45);
    expect(viewports).toEqual([chart.model.yViewport!.y]);
    chart.update({ interaction: { zoom: "xy" } });
    chart.render();
    at(chart, "wheel", ...center(chart));
    expect(chart.model.viewport).not.toBeNull();
    // Double click resets both, also after y stopped zooming.
    chart.update({ interaction: { zoom: "x" } });
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect([chart.model.viewport, chart.model.yViewport]).toEqual([null, null]);
    chart.destroy();
  });

  it("ignores rectangles and lassos without both width and height", () => {
    const chart = createChart(host, {
      interaction: { brush: "xy", zoom: "xy" },
      marks: [point(points(), { x: "x", y: "y" })],
    });
    chart.setYViewport([10, 40]);
    chart.render();
    const { x, y } = chart.model.panels()[0]!;
    const flat = () => {
      at(chart, "pointerdown", x.map(10), y.map(20));
      at(chart, "pointermove", x.map(20), y.map(20) + 1);
      at(chart, "pointerup", x.map(30), y.map(20));
    };
    // A flat rectangle does not zoom, so y keeps its zoom.
    flat();
    expect(chart.model.viewport).toBeNull();
    expect(chart.model.yViewport!.y).toEqual([10, 40]);
    // Without zoom, it selects nothing; nor does a flat lasso.
    for (const brush of ["xy", "lasso"] as const) {
      chart.update({ interaction: { brush } });
      flat();
      expect(chart.selection).toBeNull();
    }
    chart.destroy();
  });

  it("clips a lasso to each plot rather than moving its corners", () => {
    const chart = createChart(host, {
      interaction: { brush: "lasso" },
      marks: [point(points(), { x: "x", y: "y" })],
    });
    // A region drawn while zoomed in reaches past the plot once zoomed out.
    chart.select({
      x: [-20, 30],
      y: [10, 40],
      lasso: [
        [-20, 10],
        [30, 10],
        [30, 40],
      ],
    });
    chart.render();
    const { plot, x, y } = chart.model.panels()[0]!;
    const outline = chart.root.querySelector('svg path[fill-opacity="0.18"]')!;
    expect(x.map(-20)).toBeLessThan(plot.x);
    expect(outline.getAttribute("d")).toMatch(
      new RegExp(`^M${x.map(-20).toFixed(1)} ${y.map(10).toFixed(1)}L`),
    );
    const id = /^url\(#(.+)\)$/.exec(outline.getAttribute("clip-path") ?? "")?.[1];
    const clip = chart.root.querySelector(`[id="${id}"] rect`)!;
    expect(["x", "y", "width", "height"].map((name) => Number(clip.getAttribute(name)))).toEqual([
      plot.x,
      plot.y,
      plot.width,
      plot.height,
    ]);
    chart.destroy();
  });

  it("keeps reversed axes reversed when zooming", () => {
    const data = table({ t: [0, 10], a: [0, 10], b: [0, 100] });
    const chart = createChart(host, {
      interaction: { zoom: "xy" },
      x: { domain: [10, 0] },
      y: { domain: [0, 10] },
      yRight: { domain: [100, 0] },
      marks: [line(data, { x: "t", y: "a" }), line(data, { x: "t", y: "b", axis: "right" })],
    });
    const before = chart.model.panels()[0]!;
    // Pointer events carry whole pixels.
    const [px, py] = center(chart).map(Math.round) as [number, number];
    const under = [before.x.invert(px), before.y.invert(py), before.yRight!.invert(py)];
    at(chart, "wheel", px, py);
    chart.render();
    const after = chart.model.panels()[0]!;
    // The values under the pointer stay there, on every axis.
    expect(after.x.map(under[0]!)).toBeCloseTo(px, 6);
    expect(after.y.map(under[1]!)).toBeCloseTo(py, 6);
    expect(after.yRight!.map(under[2]!)).toBeCloseTo(py, 6);
    expect(after.x.map(2)).toBeGreaterThan(after.x.map(8));
    expect(after.yRight!.map(20)).toBeLessThan(after.yRight!.map(80));
    chart.destroy();
  });

  it("zooms to a selection on Enter only along zoomable axes, and never to a lasso", () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const marks = [point(points(), { x: "x", y: "y" })];
    const a = createChart(host, { interaction: { brush: "lasso", sync: "enter" }, marks });
    const b = createChart(other, {
      interaction: { brush: "xy", zoom: "xy", sync: "enter" },
      marks,
    });
    const enter = () =>
      b.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    a.select({
      x: [10, 30],
      y: [10, 30],
      lasso: [
        [10, 10],
        [30, 10],
        [20, 30],
      ],
    });
    enter();
    expect([b.model.viewport, b.model.yViewport]).toEqual([null, null]);
    expect(b.selection?.lasso).toHaveLength(3);
    // A rectangle needs both axes to zoom; an x range only x.
    b.update({ interaction: { brush: "x", zoom: "x", sync: "enter" } });
    a.select({ x: [10, 30], y: [10, 30], lasso: null });
    enter();
    expect([b.model.viewport, b.model.yViewport]).toEqual([null, null]);
    a.select([10, 30]);
    enter();
    expect(b.model.viewport).toEqual([10, 30]);
    // A chart that only zooms zooms to a rectangle it received, and Escape
    // clears one it did not zoom to.
    b.update({ interaction: { zoom: "xy", sync: "enter" } });
    b.setViewport(null);
    a.select({ x: [10, 30], y: [10, 30], lasso: null });
    enter();
    expect(b.model.viewport).toEqual([10, 30]);
    const [y0, y1] = b.model.yViewport!.y;
    expect([y0, y1].map((y) => y.toFixed(6))).toEqual(["10.000000", "30.000000"]);
    a.select({ x: [10, 20], y: [10, 20], lasso: null });
    b.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(b.selection).toBeNull();
    a.destroy();
    b.destroy();
    other.remove();
  });

  it("selects along the axis the keyboard steps along", () => {
    const chart = createChart(host, {
      interaction: { brush: "y" },
      marks: [bar(table({ c: ["a", "b", "c"], v: [1, 2, 3] }), { y: "c", x: "v" })],
    });
    const key = (k: string, shiftKey = false) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    key("ArrowRight", true);
    expect(chart.selection).toEqual({ x: null, y: [0, 1], lasso: null });
    expect(live.textContent).toContain("Selected a to b.");
    // Rectangles and lassos take a range along that axis too.
    chart.update({
      interaction: { brush: "lasso" },
      marks: [line(table({ t: [0, 1, 2], v: [1, 2, 3] }), { x: "t", y: "v" })],
    });
    chart.render();
    key("Escape");
    key("ArrowRight");
    key("ArrowRight", true);
    expect(chart.selection).toEqual({ x: [0, 1], y: null, lasso: null });
    chart.destroy();
  });

  it("announces selections made with the pointer", () => {
    const chart = createChart(host, {
      interaction: { brush: "xy" },
      marks: [point(points(), { x: "x", y: "y" })],
    });
    const { x, y } = chart.model.panels()[0]!;
    const live = chart.root.querySelector("[aria-live]")!;
    at(chart, "pointerdown", x.map(10), y.map(40));
    at(chart, "pointermove", x.map(20), y.map(30));
    at(chart, "pointerup", x.map(30), y.map(20));
    expect(live.textContent).toBe("Selected x from 10 to 30 and y from 20 to 40.");
    chart.update({ interaction: { brush: "lasso" } });
    at(chart, "pointerdown", x.map(10), y.map(10));
    at(chart, "pointermove", x.map(40), y.map(10));
    at(chart, "pointermove", x.map(40), y.map(40));
    at(chart, "pointerup", x.map(10), y.map(40));
    expect(live.textContent).toBe("Selected a freehand region.");
    chart.destroy();
  });

  it("selects rectangles and lassos, and zooms to rectangles along zoomed axes", () => {
    const chart = createChart(host, {
      interaction: { brush: "xy" },
      marks: [point(points(), { x: "x", y: "y" })],
    });
    const { plot, x, y } = chart.model.panels()[0]!;
    at(chart, "pointerdown", x.map(10), y.map(40));
    at(chart, "pointermove", x.map(20), y.map(30));
    at(chart, "pointerup", x.map(30), y.map(20));
    const box = chart.selection!;
    expect(box.x![0]).toBeCloseTo(10, 6);
    expect(box.x![1]).toBeCloseTo(30, 6);
    expect(box.y![0]).toBeCloseTo(20, 6);
    expect(box.y![1]).toBeCloseTo(40, 6);
    expect(box.lasso).toBeNull();
    // A lasso reports its outline in data values, and its extent.
    chart.update({ interaction: { brush: "lasso" } });
    chart.render();
    const corners = [
      [10, 10],
      [40, 10],
      [40, 40],
      [10, 40],
    ] as const;
    at(chart, "pointerdown", x.map(10), y.map(10));
    for (const [cx, cy] of corners.slice(1)) at(chart, "pointermove", x.map(cx), y.map(cy));
    at(chart, "pointerup", x.map(10), y.map(40));
    const lasso = chart.selection!;
    expect(lasso.lasso!.length).toBeGreaterThanOrEqual(4);
    expect(lasso.x![0]).toBeCloseTo(10, 6);
    expect(lasso.y![1]).toBeCloseTo(40, 6);
    expect(chart.root.style.touchAction).toBe("none");
    // With zoom along both axes, a rectangle zooms instead of selecting.
    chart.update({ interaction: { brush: "xy", zoom: "xy" } });
    chart.select(null);
    chart.render();
    at(chart, "pointerdown", x.map(10), y.map(40));
    at(chart, "pointermove", x.map(20), y.map(30));
    at(chart, "pointerup", x.map(30), y.map(20));
    expect(chart.selection).toBeNull();
    expect(chart.model.viewport![0]).toBeCloseTo(10, 6);
    expect(chart.model.yViewport!.y[1]).toBeCloseTo(40, 6);
    expect(plot.width).toBeGreaterThan(0);
    chart.destroy();
  });

  it("shares selections with synced charts", () => {
    const other = document.createElement("div");
    other.style.cssText = "width:600px;height:300px";
    document.body.append(other);
    const options = {
      interaction: { brush: "xy" as const, sync: "pair" },
      marks: [point(points(), { x: "x", y: "y" })],
    };
    const a = createChart(host, options);
    const b = createChart(other, options);
    const seen: (readonly [number, number] | null)[] = [];
    b.on("select", ({ y }) => seen.push(y));
    a.select({ x: [5, 15], y: [10, 20], lasso: null });
    expect(b.selection).toEqual({ x: [5, 15], y: [10, 20], lasso: null });
    expect(seen).toEqual([[10, 20]]);
    a.select(null);
    expect(b.selection).toBeNull();
    a.destroy();
    b.destroy();
    other.remove();
  });

  it("zooms the right axis with the left one", () => {
    const data = table({ t: [0, 1, 2, 3], a: [0, 10, 20, 30], b: [0, 1000, 2000, 3000] });
    const chart = createChart(host, {
      marks: [line(data, { x: "t", y: "a" }), line(data, { x: "t", y: "b", axis: "right" })],
      y: { domain: [0, 30] },
      yRight: { domain: [0, 3000] },
    });
    chart.setYViewport([10, 20]);
    const viewport = chart.model.yViewport!;
    expect(viewport.y).toEqual([10, 20]);
    expect(viewport.yRight![0]).toBeCloseTo(1000, 6);
    expect(viewport.yRight![1]).toBeCloseTo(2000, 6);
    chart.render();
    expect(chart.model.yRightScale()!.domain).toEqual([viewport.yRight![0], viewport.yRight![1]]);
    chart.destroy();
  });
});

describe("radars", () => {
  const players = table({ name: ["Ana", "Bo"], speed: [8, 4], power: [6, 9], range: [4, 2] });
  const chart = () =>
    createChart(host, {
      locale: "en-US",
      marks: [radar(players, { fields: ["speed", "power", "range"], series: "name" })],
    });

  it("outline the value nearest the pointer, show it, and report clicks", async () => {
    const shown = chart();
    const hovers: (string | undefined)[] = [];
    const clicks: (string | undefined)[] = [];
    shown.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.text));
    shown.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.label));
    // Ana's speed, the first value.
    const first = shown.model.inspectItem(shown.model.stepItem(undefined, 1)!)!.points[0]!;
    const rect = shown.root.getBoundingClientRect();
    const at = (type: string, px: number, py: number) =>
      shown.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: rect.left + px,
          clientY: rect.top + py,
        }),
      );
    const top = { x: first.px, y: first.py };
    at("pointermove", top.x + 3, top.y + 2);
    await frame();
    expect(hovers.at(-1)).toBe("speed: 8 (of 0 to 10)");
    const outline = shown.root.querySelector("svg path[visibility][fill='none']")!;
    expect(outline.getAttribute("visibility")).toBe("visible");
    at("pointerdown", top.x, top.y);
    at("pointerup", top.x, top.y);
    expect(clicks).toEqual(["Ana"]);
    shown.destroy();
  });

  it("paint on a canvas, with their labels in SVG", () => {
    const painted = createChart(host, {
      renderer: "canvas",
      marks: [radar(players, { fields: ["speed", "power", "range"], series: "name" })],
    });
    const canvas = painted.root.querySelector("canvas")!;
    const ratio = canvas.width / painted.root.clientWidth;
    const { px, py } = painted.model.inspectItem(painted.model.stepItem(undefined, 1)!)!.points[0]!;
    const pixel = canvas
      .getContext("2d")!
      .getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1).data;
    // An opaque dot at Ana's speed; the spokes' names stay text.
    expect(pixel[3]).toBe(255);
    expect(painted.root.querySelector("svg")!.textContent).toContain("power");
    painted.destroy();
  });

  it("read values with the keyboard, series by series, and toggle series from the legend", () => {
    const shown = chart();
    shown.root.focus();
    const key = (k: string) =>
      shown.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const live = shown.root.querySelector("[aria-live]")!;
    key("ArrowRight");
    expect(live.textContent).toBe("Value. Ana: speed: 8 (of 0 to 10)");
    key("End");
    expect(live.textContent).toBe("Value. Bo: range: 2 (of 0 to 10)");
    // Hiding Bo leaves Ana's values, on a scale fitted to them.
    shown.root.querySelectorAll("button")[1]!.click();
    shown.render();
    key("End");
    expect(live.textContent).toBe("Value. Ana: range: 4 (of 0 to 8)");
    shown.destroy();
  });
});
