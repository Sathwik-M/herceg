import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { rule } from "../../src/marks/rule.ts";
import { resolveTheme } from "../../src/theme.ts";

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
  const band = (chart: Chart) => chart.root.querySelector("svg rect[fill-opacity]");

  it("selects an x range by brushing and clears it with a click", async () => {
    const chart = createChart(host, {
      interaction: { brush: "x" },
      marks: [line(series(100), { x: "t", y: "s0" })],
    });
    const selections: (readonly [number, number] | null)[] = [];
    chart.on("select", ({ x }) => selections.push(x));
    drag(chart, 60_000, 20_000);
    await frame();
    const [lo, hi] = chart.selection!;
    expect(lo).toBeCloseTo(20_000, -3);
    expect(hi).toBeCloseTo(60_000, -3);
    expect(selections).toEqual([chart.selection]);
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
    expect(chart.selection).toEqual([0, 2]);
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
    expect(chart.selection![1]).toBeCloseTo(3, 6);
    press(chart.root, "pointerdown", x.map(0.5), 150);
    press(chart.root, "pointermove", x.map(2.5), 150);
    press(chart.root, "pointercancel", x.map(2.5), 150);
    press(chart.root, "pointerup", x.map(2.5), 150);
    expect(chart.selection![0]).toBeCloseTo(1, 6);
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
    expect(chart.selection).toEqual([0, 2]);
    expect(chart.model.viewport).toBeNull();
    chart.select([1, 1]);
    await frame();
    const rect = band(chart)!;
    expect(rect.getAttribute("visibility")).toBe("visible");
    expect(Number(rect.getAttribute("width"))).toBeGreaterThan(Math.abs(x.bandwidth!));
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
    expect(chart.selection).toEqual([0, 1]);
    chart.select(null);
    key("ArrowRight", true);
    expect(chart.selection).toEqual([1, 2]);
    press(chart.root, "pointermove", 300, 150);
    key("ArrowRight");
    key("ArrowRight", true);
    expect(chart.selection![0]).toBe(chart.selection![1] - 1);
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
    expect(chart.selection).toEqual([1000, 5000]);
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
    expect(chart.selection).toEqual([1, 2]);
    expect(Number(band(chart)!.getAttribute("x"))).toBeCloseTo(x.map(1), 3);
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
