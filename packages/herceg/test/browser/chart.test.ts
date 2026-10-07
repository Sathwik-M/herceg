import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";

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
