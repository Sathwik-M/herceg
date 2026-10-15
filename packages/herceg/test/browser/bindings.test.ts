// Gesture bindings in the browser: the presets' page-friendly defaults,
// bindings of a chart's own, cancellation, pinches, and keys.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromGeoJSON } from "../../src/data/geojson.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { line } from "../../src/marks/line.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { MOUSE } from "./helpers.ts";

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
const data = () =>
  table({
    t: Float64Array.from({ length: 101 }, (_, i) => i),
    v: Float64Array.from({ length: 101 }, (_, i) => Math.sin(i / 10)),
  });

/** The middle of the chart's plot, in pixels of the chart. */
function middle(chart: Chart): [number, number] {
  const { plot } = chart.getPanels()[0]!;
  return [plot.x + plot.width / 2, plot.y + plot.height / 2];
}

function wheel(chart: Chart, init: WheelEventInit) {
  const rect = chart.root.getBoundingClientRect();
  const [x, y] = middle(chart);
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    ...init,
  });
  chart.root.dispatchEvent(event);
  return event;
}

function pointer(chart: Chart, type: string, x: number, y: number, init: PointerEventInit = {}) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: MOUSE,
      button: 0,
      ...init,
    }),
  );
}

function key(chart: Chart, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  chart.root.dispatchEvent(event);
  return event;
}

const span = (chart: Chart) => {
  const [lo, hi] = chart.getViewport().x ?? [0, 100];
  return hi - lo;
};

describe("presets", () => {
  it("pan without zooming: drags and the wheel sideways pan, the vertical wheel scrolls the page", () => {
    const chart = createChart(host, {
      interaction: { pan: "x" },
      x: { domain: [0, 100] },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    const down = wheel(chart, { deltaY: 120 });
    expect(down.defaultPrevented).toBe(false);
    expect(wheel(chart, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(chart.getViewport().x).toBeNull();
    const sideways = wheel(chart, { deltaX: 60 });
    expect(sideways.defaultPrevented).toBe(true);
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeGreaterThan(0);
    expect(hi - lo).toBeCloseTo(100, 6);
    const [x, y] = middle(chart);
    pointer(chart, "pointerdown", x, y);
    pointer(chart, "pointermove", x + 50, y);
    pointer(chart, "pointerup", x + 50, y);
    expect(chart.getViewport().x![0]).toBeLessThan(lo);
    chart.destroy();
  });

  it("zoom with Ctrl or ⌘ and the wheel, plus and minus, and reset with 0", () => {
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    expect(wheel(chart, { deltaY: -100 }).defaultPrevented).toBe(false);
    expect(chart.getViewport().x).toBeNull();
    expect(wheel(chart, { deltaY: -100, metaKey: true }).defaultPrevented).toBe(true);
    const zoomed = span(chart);
    expect(zoomed).toBeLessThan(100);
    chart.root.focus();
    expect(key(chart, "+").defaultPrevented).toBe(true);
    expect(span(chart)).toBeCloseTo(zoomed / 1.25, 6);
    key(chart, "-");
    expect(span(chart)).toBeCloseTo(zoomed, 6);
    key(chart, "0");
    expect(chart.getViewport().x).toBeNull();
    chart.destroy();
  });

  it("leave the plain wheel over a map to the page", async () => {
    const regions = triangle();
    const chart = createChart(host, {
      interaction: { zoom: true },
      marks: [geoshape(regions, { labelField: "name" })],
    });
    await chart.loading;
    const event = wheel(chart, { deltaY: -100 });
    expect(event.defaultPrevented).toBe(false);
    expect(chart.getViewport().x).toBeNull();
    expect(wheel(chart, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(chart.getViewport().x).not.toBeNull();
    chart.destroy();
  });

  it("take a wheel step after options changed the scale, drawing first", () => {
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      x: { domain: [-100, 100] },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    chart.render();
    chart.update({ interaction: { zoom: "x" }, x: { domain: [1, 100], type: "log" } });
    wheel(chart, { deltaY: -100, ctrlKey: true });
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeGreaterThan(1);
    expect(hi).toBeLessThan(100);
    expect(() => chart.render()).not.toThrow();
    chart.destroy();
  });

  it("set the touch policy the chart's first scene calls for", async () => {
    const first = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    await first.loading;
    first.destroy();
    // Attached at once, before its scene, which waits for the guide compiler.
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      x: { ticks: { every: 10 } },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    await chart.loading;
    await frame();
    expect(chart.root.style.touchAction).toBe("pan-y");
    chart.destroy();
  });

  it("add wheel steps up between frames, drawing nothing until the frame", async () => {
    const charts = [0, 1].map(() =>
      createChart(host, {
        interaction: { zoom: "x" },
        x: { domain: [0, 100] },
        marks: [line(data(), { x: "t", y: "v" })],
      }),
    );
    const [stepped, once] = charts as [Chart, Chart];
    const renders: unknown[] = [];
    stepped.on("render", (event) => renders.push(event));
    // Ten steps in one task zoom as one step of all of them, about the same pixel.
    for (let i = 0; i < 10; i++) wheel(stepped, { deltaY: -20, ctrlKey: true });
    expect(renders).toEqual([]);
    wheel(once, { deltaY: -200, ctrlKey: true });
    const [a, b] = [stepped.getViewport().x!, once.getViewport().x!];
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
    for (const chart of charts) chart.destroy();
  });
});

/** A map of one triangle. */
function triangle() {
  return fromGeoJSON({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "A" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
          ],
        },
      },
    ],
  });
}

describe("bindings", () => {
  it("bind keys and buttons on maps, and double clicks on 3D charts", async () => {
    const map = createChart(host, {
      interaction: {
        pan: true,
        bindings: [
          { gesture: { type: "key", key: "z" }, action: { type: "zoom", factor: 2 } },
          { gesture: { type: "drag", button: 2 }, action: { type: "pan" } },
        ],
      },
      marks: [geoshape(triangle(), { labelField: "name" })],
    });
    await map.loading;
    map.root.focus();
    expect(key(map, "z").defaultPrevented).toBe(true);
    const zoomed = map.getViewport();
    expect(zoomed.x).not.toBeNull();
    const [x, y] = [300, 150];
    pointer(map, "pointerdown", x, y, { button: 2 });
    pointer(map, "pointermove", x + 40, y, { button: 2 });
    pointer(map, "pointerup", x + 40, y, { button: 2 });
    expect(map.getViewport().x).not.toEqual(zoomed.x);
    map.destroy();
    const cube = createChart(host, {
      interaction: {
        bindings: [{ gesture: { type: "doubleClick" }, action: { type: "zoom", factor: 2 } }],
      },
      marks: [
        point3d(table({ x: [0, 1, 2], y: [0, 1, 2], z: [0, 1, 2] }), { x: "x", y: "y", z: "z" }),
      ],
    });
    await cube.loading;
    const before = cube.getCamera()!.zoom;
    const rect = cube.root.getBoundingClientRect();
    cube.root.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: rect.left + 300,
        clientY: rect.top + 150,
      }),
    );
    expect(cube.getCamera()!.zoom).toBeCloseTo(before * 2, 6);
    // Ctrl and minus is the page's zoom, not the camera's.
    cube.root.focus();
    expect(key(cube, "-", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(cube.getCamera()!.zoom).toBeCloseTo(before * 2, 6);
    cube.destroy();
  });

  it("pan a map along the axes a key binding names", async () => {
    const map = createChart(host, {
      interaction: {
        pan: true,
        bindings: [
          {
            gesture: { type: "key", key: "j" },
            action: { type: "pan", axes: "y", step: [0.2, 0.1] },
          },
        ],
      },
      marks: [geoshape(triangle(), { labelField: "name" })],
    });
    await map.loading;
    map.root.focus();
    // From a view of its own, as shown (a box the plane fits whole), so
    // that both ranges are there to compare.
    map.setViewport({ x: [0, 0.2], y: [0, 0.2] });
    key(map, "j");
    const before = map.getViewport();
    key(map, "j");
    const after = map.getViewport();
    expect(after.x).toEqual(before.x);
    expect(after.y).not.toEqual(before.y);
    // Arrows with Ctrl or ⌘ do not pan: the map's own take Shift alone.
    key(map, "ArrowRight", { shiftKey: true, ctrlKey: true });
    expect(map.getViewport()).toEqual(after);
    map.destroy();
  });

  it("zoom with the plain wheel while the chart has the focus, when bound so", () => {
    const chart = createChart(host, {
      interaction: {
        bindings: [{ gesture: { type: "wheel", focused: true }, action: { type: "zoom" } }],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    expect(wheel(chart, { deltaY: -100 }).defaultPrevented).toBe(false);
    chart.root.focus();
    expect(wheel(chart, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(span(chart)).toBeLessThan(100);
    chart.destroy();
  });

  it("take a gesture back from the presets with pageScroll", () => {
    const chart = createChart(host, {
      interaction: {
        pan: "x",
        bindings: [{ gesture: { type: "wheel", axis: "x" }, action: { type: "pageScroll" } }],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    expect(wheel(chart, { deltaX: 60 }).defaultPrevented).toBe(false);
    expect(chart.getViewport().x).toBeNull();
    chart.destroy();
  });

  it("pan by a step with a bound key", () => {
    const chart = createChart(host, {
      x: { domain: [0, 100] },
      interaction: {
        bindings: [
          {
            gesture: { type: "key", key: "ArrowRight", modifiers: ["alt"] },
            action: { type: "pan", step: [0.25, 0] },
          },
        ],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    chart.root.focus();
    expect(key(chart, "ArrowRight", { altKey: true }).defaultPrevented).toBe(true);
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeCloseTo(25, 6);
    expect(hi).toBeCloseTo(125, 6);
    chart.destroy();
  });

  it("refuse a gesture bound twice, leaving the chart as it was", () => {
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      x: { domain: [0, 100] },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    const twice = { gesture: { type: "pinch" }, action: { type: "zoom" } } as const;
    expect(() =>
      chart.update({ interaction: { bindings: [twice, twice] }, errorMode: "throw" }),
    ).toThrow("interaction.bindings[1]: duplicates binding 0; remove one or change its gesture");
    // Its zoom is as it was.
    expect(wheel(chart, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(chart.getViewport().x).not.toBeNull();
    chart.destroy();
  });

  it("leave pinches to the page when a binding says so, in a chart that drags both ways", async () => {
    const chart = createChart(host, {
      interaction: {
        pan: "xy",
        bindings: [{ gesture: { type: "pinch" }, action: { type: "pageScroll" } }],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    await chart.loading;
    expect(chart.root.style.touchAction).toBe("pinch-zoom");
    chart.update({ interaction: { pan: "xy" } });
    expect(chart.root.style.touchAction).toBe("none");
    chart.destroy();
  });
});

describe("gestures", () => {
  it("go back to where a pan started with Escape", () => {
    const chart = createChart(host, {
      interaction: { pan: "x" },
      x: { domain: [0, 100] },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    chart.setViewport([10, 60]);
    const [x, y] = middle(chart);
    chart.root.focus();
    pointer(chart, "pointerdown", x, y);
    pointer(chart, "pointermove", x - 80, y);
    expect(chart.getViewport().x![0]).toBeGreaterThan(10);
    expect(key(chart, "Escape").defaultPrevented).toBe(true);
    expect(chart.getViewport().x).toEqual([10, 60]);
    // The release that follows moves nothing more.
    pointer(chart, "pointermove", x - 120, y);
    pointer(chart, "pointerup", x - 120, y);
    expect(chart.getViewport().x).toEqual([10, 60]);
    chart.destroy();
  });

  it("zoom with a pinch about its middle, and leave pinches to the page without zoom", () => {
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    expect(chart.root.style.touchAction).toBe("pan-y");
    const [x, y] = middle(chart);
    const touch = (type: string, id: number, px: number) =>
      pointer(chart, type, px, y, { pointerId: id, pointerType: "touch" });
    touch("pointerdown", 11, x - 20);
    touch("pointerdown", 12, x + 20);
    touch("pointermove", 12, x + 60);
    touch("pointermove", 11, x - 60);
    touch("pointerup", 11, x - 60);
    touch("pointerup", 12, x + 60);
    // Fingers three times as far apart show a third of the range, about the middle.
    expect(span(chart)).toBeCloseTo(100 / 3, 1);
    const [lo, hi] = chart.getViewport().x!;
    expect((lo + hi) / 2).toBeCloseTo(chart.fromPixel(x, { axis: "x" })!, 0);
    chart.update({ interaction: { pan: "x" } });
    expect(chart.root.style.touchAction).toBe("pan-y pinch-zoom");
    chart.destroy();
  });

  it("keep what was under a pinch's fingers under them, as they move one at a time", () => {
    const chart = createChart(host, {
      interaction: { zoom: "x" },
      x: { domain: [0, 100] },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    chart.render();
    const { plot } = chart.getPanels()[0]!;
    const [x, y] = middle(chart);
    const d = plot.width / 12;
    const touch = (type: string, id: number, px: number) =>
      pointer(chart, type, px, y, { pointerId: id, pointerType: "touch" });
    // Each finger moves out on its own: the middle moves, and moves back.
    touch("pointerdown", 31, x - d);
    touch("pointerdown", 32, x + d);
    touch("pointermove", 31, x - 3 * d);
    touch("pointermove", 32, x + 3 * d);
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeCloseTo(100 / 3, 6);
    expect(hi).toBeCloseTo(200 / 3, 6);
    // Both move right together: the view pans, its span kept.
    touch("pointermove", 31, x - 2 * d);
    touch("pointermove", 32, x + 4 * d);
    const [a, b] = chart.getViewport().x!;
    expect(b - a).toBeCloseTo(100 / 3, 6);
    expect(a).toBeLessThan(lo);
    touch("pointerup", 31, x - 2 * d);
    touch("pointerup", 32, x + 4 * d);
    chart.destroy();
  });

  it("scrub the cursor with a touch drag bound to it, panning nothing", async () => {
    const chart = createChart(host, {
      interaction: {
        zoom: "x",
        bindings: [{ gesture: { type: "drag", pointer: "touch" }, action: { type: "cursor" } }],
      },
      marks: [line(data(), { x: "t", y: "v" })],
    });
    const hovers: (number | undefined)[] = [];
    chart.on("hover", ({ inspection }) => hovers.push(inspection?.points[0]?.row));
    const [x, y] = middle(chart);
    const touch = (type: string, px: number) =>
      pointer(chart, type, px, y, { pointerId: 21, pointerType: "touch" });
    touch("pointerdown", x);
    touch("pointermove", x + 100);
    await frame();
    touch("pointerup", x + 100);
    expect(chart.getViewport().x).toBeNull();
    expect(hovers.at(-1)).toBeGreaterThan(50);
    chart.destroy();
  });
});
