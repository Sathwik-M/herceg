// Hydrating server markup: the runtime takes over the nodes
// `renderToSnapshot` wrote and draws again only what differs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { hydrateChart } from "../../src/dom/hydrate.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { renderToSnapshot } from "../../src/render/snapshot.ts";
import { MOUSE } from "./helpers.ts";
import { hasWebGL2 } from "./webgl.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:640px;height:320px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function options(): ChartOptions {
  const start = Date.UTC(2026, 0, 1);
  const data = table({
    t: time(Float64Array.from({ length: 24 }, (_, i) => start + i * 3_600_000)),
    a: Float64Array.from({ length: 24 }, (_, i) => 10 + Math.sin(i / 3) * 4),
    b: Float64Array.from({ length: 24 }, (_, i) => 12 + Math.cos(i / 4) * 3),
  });
  return {
    title: "Requests",
    marks: [line(data, { x: "t", y: ["a", "b"] }), rule({ y: 12, label: "Target" })],
    interaction: { pan: "x" },
  };
}

/** Every geometry node the layer drew: what adoption must keep as it is. */
const geometry = (root: Element) => [...root.querySelectorAll("svg [data-kind]")];

describe("hydrateChart", () => {
  it("takes over the server's nodes, writing none of the data, and answers as a chart", async () => {
    const initial = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "requests" });
    host.innerHTML = initial.html;
    const root = host.firstElementChild!;
    const before = geometry(root);
    expect(before.length).toBeGreaterThan(2);
    const written: MutationRecord[] = [];
    const observer = new MutationObserver((records) => written.push(...records));
    observer.observe(root.querySelector("svg")!, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const chart = hydrateChart(host, options(), initial);
    await frame();
    observer.disconnect();
    expect(chart.root).toBe(root);
    // The same nodes, none of them written: not the data, the grid, or the axes.
    expect(geometry(chart.root)).toEqual(before);
    const geometryWrites = written.filter(
      ({ target }) => target instanceof Element && target.closest("[data-kind]"),
    );
    expect(geometryWrites).toEqual([]);
    // Ids are the snapshot's, the description is there, and the legend toggles.
    expect(chart.root.getAttribute("aria-describedby")).toBe("requests-description");
    const buttons = chart.root.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    expect(chart.getHiddenKeys()).toHaveLength(1);
    chart.destroy();
  });

  it("keeps the focus on the chart's element, and takes input", async () => {
    const initial = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "focus" });
    host.innerHTML = initial.html;
    const root = host.firstElementChild as HTMLElement;
    root.focus();
    const chart = hydrateChart(host, options(), initial);
    expect(document.activeElement).toBe(root);
    await chart.loading;
    const { plot } = chart.getPanels()[0]!;
    const rect = chart.root.getBoundingClientRect();
    const at = (type: string, x: number) =>
      chart.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: rect.left + x,
          clientY: rect.top + plot.y + plot.height / 2,
          pointerId: MOUSE,
          button: 0,
        }),
      );
    at("pointerdown", plot.x + 200);
    at("pointermove", plot.x + 100);
    at("pointerup", plot.x + 100);
    expect(chart.getViewport().x).not.toBeNull();
    chart.destroy();
  });

  it("draws what differs: a line given another color is drawn again, the others not", () => {
    const initial = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "other" });
    host.innerHTML = initial.html;
    const before = geometry(host);
    const changed = options();
    const [lines, target] = changed.marks as [ReturnType<typeof line>, ReturnType<typeof rule>];
    changed.marks = [lines, rule({ y: 12, label: "Target", stroke: "#d0021b" })];
    void target;
    const chart = hydrateChart(host, changed, initial);
    const after = geometry(chart.root);
    const kinds = (nodes: Element[], kind: string) =>
      nodes.filter((node) => node.getAttribute("data-kind") === kind);
    // The lines' nodes are the server's, untouched; the rule's group is
    // drawn again in its new color.
    expect(kinds(after, "line")).toEqual(kinds(before, "line"));
    expect(kinds(after, "rule")[0]!.innerHTML).toContain("#d0021b");
    chart.destroy();
  });

  it("refuses markup whose text or attributes differ from the snapshot's", () => {
    const initial = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "edited" });
    host.innerHTML = initial.html;
    const label = [...host.querySelectorAll("svg text")].at(-1)!;
    label.textContent = "WRONG";
    expect(() => hydrateChart(host, options(), initial)).toThrow("is not the snapshot's");
    host.innerHTML = initial.html;
    host.querySelector("svg [data-kind] path, svg [data-kind]")!.setAttribute("stroke", "red");
    expect(() => hydrateChart(host, options(), initial)).toThrow("is not the snapshot's");
  });

  it("keeps the markup's size while code it waits for loads", () => {
    const ticked = (): ChartOptions => ({
      ...options(),
      // Ticks every so often need the guide compiler, which loads.
      x: { ticks: { every: "6 hours" } },
    });
    const initial = renderToSnapshot(ticked(), { width: 640, height: 320, idPrefix: "waits" });
    host.innerHTML = initial.html;
    const chart = hydrateChart(host, ticked(), initial);
    expect(chart.root.getBoundingClientRect().height).toBe(320);
    expect(chart.root.getBoundingClientRect().width).toBe(640);
    chart.destroy();
  });

  it("refuses markup the snapshot does not describe, leaving it as it is", () => {
    const initial = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "odd" });
    host.innerHTML = initial.html;
    host.querySelector("svg")!.lastElementChild!.remove();
    const html = host.innerHTML;
    expect(() => hydrateChart(host, options(), initial)).toThrow(
      'hydrateChart initial: the markup of "odd" in the host is not the snapshot\'s',
    );
    expect(host.innerHTML).toBe(html);
    expect(() => hydrateChart(host, options(), { ...initial, version: 2 as 1 })).toThrow(
      "a snapshot of another herceg (version 2)",
    );
  });

  it("keeps the markup of a chart drawn on canvas until the canvas has drawn", () => {
    const n = 6000;
    const data = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 100)),
    });
    const dense: ChartOptions = { renderer: "canvas", marks: [line(data, { x: "x", y: "y" })] };
    const initial = renderToSnapshot(dense, { width: 640, height: 320, idPrefix: "dense" });
    host.innerHTML = initial.html;
    const chart = hydrateChart(host, dense, initial);
    // The canvas drew in the same task as the SVG data went.
    expect(chart.root.querySelector("canvas")).not.toBeNull();
    expect(
      geometry(chart.root).filter((node) => node.getAttribute("data-kind") === "line"),
    ).toHaveLength(0);
    chart.destroy();
  });

  it("lays out at the snapshot's size, then follows its host", async () => {
    const initial = renderToSnapshot(options(), { width: 500, height: 300, idPrefix: "sized" });
    host.innerHTML = initial.html;
    const chart = hydrateChart(host, options(), initial);
    expect(chart.root.querySelector("svg")!.getAttribute("width")).toBe("500");
    await expect.poll(() => chart.root.querySelector("svg")!.getAttribute("width")).toBe("640");
    chart.destroy();
  });

  it("writes the same markup each time, with the ids it is given", () => {
    const a = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "same" });
    const b = renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "same" });
    expect(a.html).toBe(b.html);
    expect(a.html).not.toMatch(/herceg-\d/);
    expect(() =>
      renderToSnapshot(options(), { width: 640, height: 320, idPrefix: "x", timeZone: "local" }),
    ).toThrow('renderToSnapshot timeZone: "local" is the server\'s zone');
    expect(() =>
      renderToSnapshot(
        { ...options(), timeZone: "local" },
        { width: 640, height: 320, idPrefix: "x" },
      ),
    ).toThrow('renderToSnapshot timeZone: "local" is the server\'s zone');
  });

  it("matches a chart created in the browser, node for node", () => {
    const bars = (): ChartOptions => ({
      marks: [bar(table({ k: ["a", "b", "c"], v: [3, 1, 2] }), { x: "k", y: "v" })],
      locale: "en-US",
      timeZone: "UTC",
    });
    const initial = renderToSnapshot(bars(), { width: 640, height: 320, idPrefix: "bars" });
    host.innerHTML = initial.html;
    const hydrated = hydrateChart(host, bars(), initial);
    const other = document.createElement("div");
    other.style.cssText = "width:640px;height:320px";
    document.body.append(other);
    const created = createChart(other, bars());
    // The layers' structure and the data's nodes (the browser's own text
    // measurement may place other tick labels).
    const shape = (root: Element) => [
      [...root.querySelector("svg")!.children].map((node) => node.tagName),
      [...root.querySelectorAll("svg [data-kind]")].map((node) => node.getAttribute("data-kind")),
      [...root.children].map((node) => node.tagName),
    ];
    expect(shape(hydrated.root)).toEqual(shape(created.root));
    hydrated.destroy();
    created.destroy();
    other.remove();
  });

  it.skipIf(!hasWebGL2())(
    "keeps the server's points on screen until the GPU painter draws them",
    async () => {
      const n = 100_000;
      const cloud: ChartOptions = {
        marks: [
          point(
            table({
              x: Float64Array.from({ length: n }, (_, i) => i % 1000),
              y: Float64Array.from({ length: n }, (_, i) => Math.floor(i / 1000)),
            }),
            { x: "x", y: "y" },
          ),
        ],
      };
      const initial = renderToSnapshot(cloud, { width: 640, height: 320, idPrefix: "cloud" });
      host.innerHTML = initial.html;
      const points = host.querySelector('[data-kind="point"]')!;
      const chart = hydrateChart(host, cloud, initial);
      // Its painter loads: the server's points stay, and nothing is painted over them.
      expect(chart.loading).toBeDefined();
      expect(host.contains(points)).toBe(true);
      await chart.loading;
      await frame();
      expect(chart.root.querySelector("canvas")).not.toBeNull();
      expect(host.contains(points)).toBe(false);
      chart.destroy();
    },
  );
});
