// The Streamlit component's front end, called the way Streamlit calls it:
// once per script run, with the payload herceg.streamlit.payload builds.

import { afterEach, describe, expect, it, vi } from "vitest";
import herceg, { type Component, type Header } from "../streamlit.ts";

/**
 * A payload as Python builds it, placed `offset` bytes into a larger buffer
 * as protobuf hands it over.
 */
function payload(
  spec: Header["spec"],
  buffers: ArrayBufferView[],
  events: Header["events"],
  offset = 3,
): Uint8Array {
  const offsets: [number, number][] = [];
  let end = 0;
  for (const buffer of buffers) {
    offsets.push([end, buffer.byteLength]);
    end = Math.ceil((end + buffer.byteLength) / 8) * 8;
  }
  const header = new TextEncoder().encode(JSON.stringify({ spec, buffers: offsets, events }));
  const start = Math.ceil((4 + header.length) / 8) * 8;
  const out = new Uint8Array(offset + start + end).subarray(offset);
  new DataView(out.buffer, out.byteOffset).setUint32(0, header.length, true);
  out.set(header, 4);
  buffers.forEach((buffer, i) => {
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    out.set(bytes, start + offsets[i]![0]);
  });
  return out;
}

function lineChart(title: string, events: Header["events"], options: Partial<Header["spec"]> = {}) {
  return payload(
    {
      title,
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { brush: "x" },
      ...options,
      data: {
        data: {
          columns: {
            x: { type: "number", dtype: "float64", buffer: 0 },
            y: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [{ type: "line", x: "x", y: "y", data: "data" }],
    },
    [new Float64Array([0, 1, 2]), new Float64Array([1, 3, 2])],
    events,
  );
}

/** Bars over categories, in dictionary order, with a brush the script reacts to. */
function bars(dictionary: string[], brush: "x" | "lasso" = "x", title?: string) {
  return payload(
    {
      ...(title && { title }),
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { brush },
      data: {
        data: {
          columns: {
            x: { type: "category", codes: 0, dictionary },
            y: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [{ type: "bar", x: "x", y: "y", data: "data" }],
    },
    [Int32Array.from(dictionary, (_, i) => i), Float64Array.from(dictionary, (_, i) => i + 1)],
    ["select"],
  );
}

/** Streamlit's side of one script run: the payload and the value setters. */
function run(parentElement: HTMLElement | ShadowRoot, data: Uint8Array) {
  const state: [string, unknown][] = [];
  const triggers: [string, unknown][] = [];
  const component: Component = {
    data,
    parentElement,
    setStateValue: (name, value) => state.push([name, value]),
    setTriggerValue: (name, value) => triggers.push([name, value]),
  };
  return { cleanup: herceg(component), state, triggers };
}

let hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts) host.remove();
  hosts = [];
});

function host(): HTMLElement {
  const element = document.createElement("div");
  element.style.width = "400px";
  document.body.append(element);
  hosts.push(element);
  return element;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const figure = (root: ParentNode) => root.querySelector('[role="figure"]')!;
const band = (root: ParentNode) => root.querySelector('svg path[fill-opacity="0.18"]');

/** A pointer event at fractions of the chart's width and height. */
function press(root: ParentNode, type: string, fraction: number, down = 0.5) {
  const target = figure(root);
  const rect = target.getBoundingClientRect();
  const at = {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: rect.left + rect.width * fraction,
    clientY: rect.top + rect.height * down,
  };
  target.dispatchEvent(
    type === "wheel"
      ? new WheelEvent(type, { ...at, deltaY: -200 })
      : new PointerEvent(type, { ...at, pointerId: 1 }),
  );
}

/** Drags across a chart, once its brush, which loads on demand, has. */
async function brush(root: ParentNode, from: number, to: number) {
  await vi.dynamicImportSettled();
  press(root, "pointerdown", from);
  press(root, "pointermove", (from + to) / 2);
  press(root, "pointermove", to);
  press(root, "pointerup", to);
}

describe("Streamlit component", () => {
  it("remounts keyed points when only data changes", () => {
    const spec: Header["spec"] = {
      width: 400,
      height: 200,
      renderer: "svg",
      animation: { values: true, duration: 300 },
      x: { domain: [0, 4] },
      y: { domain: [0, 100] },
      data: {
        data: {
          columns: {
            x: { type: "number", dtype: "float64", buffer: 0 },
            y: { type: "number", dtype: "float64", buffer: 1 },
            id: { type: "category", codes: 2, dictionary: ["a", "b", "c"] },
          },
        },
      },
      marks: [{ type: "point", x: "x", y: "y", data: "data", animationKey: "id" }],
    };
    const parent = host();
    const buffers = (ys: number[], ids: number[]) => [
      new Float64Array([1, 2, 3]),
      new Float64Array(ys),
      new Int32Array(ids),
    ];
    run(parent, payload(spec, buffers([10, 20, 30], [0, 1, 2]), []));
    const root = figure(parent);
    const before = parent.querySelector('[data-kind="point"]')!.getAttribute("d");
    const updated = run(parent, payload(spec, buffers([70, 60, 50], [2, 0, 1]), []));
    expect(figure(parent)).not.toBe(root);
    expect(parent.querySelector('[data-kind="point"]')!.getAttribute("d")).not.toBe(before);
    updated.cleanup();
  });

  it("draws the payload and keeps the chart while runs send the same bytes", () => {
    const parent = host();
    run(parent, lineChart("Latency", []));
    const drawn = figure(parent);
    expect(drawn.getAttribute("aria-label")).toBe("Latency");
    expect(parent.querySelectorAll("svg g[clip-path] path")).toHaveLength(1);
    // The next run delivers equal bytes in a new message.
    const { cleanup } = run(parent, lineChart("Latency", []));
    expect(figure(parent)).toBe(drawn);
    cleanup();
    expect(parent.querySelector('[role="figure"]')).toBeNull();
  });

  it("draws a navigator, keeping its sliders and the x range when new bytes redraw it", async () => {
    const parent = host();
    run(parent, lineChart("Navigated", [], { version: 4, navigator: true }));
    await vi.dynamicImportSettled();
    const sliders = () => parent.querySelectorAll('[aria-label="Range navigator"] [role="slider"]');
    expect(sliders()).toHaveLength(3);
    const [, middle] = sliders();
    const before = middle!.getAttribute("aria-valuetext");
    middle!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
    );
    await frame();
    const shown = middle!.getAttribute("aria-valuetext");
    expect(shown).not.toBe(before);
    run(parent, lineChart("Renamed", [], { version: 4, navigator: { height: 30 } }));
    await vi.dynamicImportSettled();
    await frame();
    expect(sliders()).toHaveLength(3);
    expect(sliders()[1]!.getAttribute("aria-valuetext")).toBe(shown);
  });

  it("reports a brushed range and clicks only when the script reacts to them", async () => {
    const quiet = host();
    const ignored = run(quiet, lineChart("Quiet", []));
    await brush(quiet, 0.3, 0.7);
    press(quiet, "pointerdown", 0.5);
    press(quiet, "pointerup", 0.5);
    expect(ignored.state).toEqual([]);
    expect(ignored.triggers).toEqual([]);

    const parent = host();
    const { state, triggers } = run(parent, lineChart("Reacts", ["select", "click"]));
    await brush(parent, 0.3, 0.7);
    await frame();
    expect(state).toHaveLength(1);
    const [name, value] = state[0]!;
    const { x, ...rest } = value as { x: [number, number] };
    expect(name).toBe("selection");
    expect(rest).toEqual({ y: null, lasso: null, time: [] });
    expect(0 < x[0] && x[0] < x[1] && x[1] < 2).toBe(true);
    // A click clears the brush and reports the data under it.
    press(parent, "pointerdown", 0.5);
    press(parent, "pointerup", 0.5);
    expect(state.at(-1)).toEqual(["selection", null]);
    expect(triggers).toEqual([
      [
        "click",
        {
          axis: "x",
          value: 1,
          time: false,
          label: "1",
          points: [
            { mark: 0, markId: null, key: '[0,"y"]', label: "y", row: 1, value: 3, text: "3" },
          ],
        },
      ],
    ]);
  });

  it("redraws new bytes in place, keeping the brush", async () => {
    const parent = host();
    run(parent, lineChart("Before", ["select"]));
    await brush(parent, 0.3, 0.7);
    await frame();
    const next = run(parent, lineChart("After", ["select"]));
    await frame();
    expect(figure(parent).getAttribute("aria-label")).toBe("After");
    expect(parent.querySelectorAll('[role="figure"]')).toHaveLength(1);
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // Restoring the brush does not rerun the script.
    expect(next.state).toEqual([]);
  });

  it("redraws new bytes in place, keeping a rectangle and the y zoom", async () => {
    const parent = host();
    const options = { interaction: { brush: "xy", zoom: "y" } } as const;
    run(parent, lineChart("Before", ["select"], options));
    press(parent, "wheel", 0.5);
    // The brush loads on demand.
    await vi.dynamicImportSettled();
    press(parent, "pointerdown", 0.3, 0.3);
    press(parent, "pointermove", 0.5, 0.5);
    press(parent, "pointerup", 0.7, 0.7);
    await frame();
    const drawn = () => ({
      outline: band(parent)!.getAttribute("d"),
      yLabels: [...parent.querySelectorAll('svg text[text-anchor="end"]')].map(
        (t) => t.textContent,
      ),
    });
    const before = drawn();
    const next = run(parent, lineChart("After", ["select"], options));
    await frame();
    expect(figure(parent).getAttribute("aria-label")).toBe("After");
    expect(drawn()).toEqual(before);
    expect(next.state).toEqual([]);
    // The script has the rectangle whole.
    press(parent, "pointerdown", 0.2, 0.2);
    press(parent, "pointermove", 0.4, 0.4);
    press(parent, "pointerup", 0.6, 0.6);
    const rectangle = next.state[0]![1] as { x: number[]; y: number[] };
    expect(rectangle.x[0]! < rectangle.x[1]! && rectangle.y[0]! < rectangle.y[1]!).toBe(true);
  });

  it("keeps the zoom of both y axes on a redraw, even when the data changes", async () => {
    const parent = host();
    const chart = (title: string, right: number[]) =>
      payload(
        {
          title,
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { zoom: "xy" },
          data: {
            data: {
              columns: {
                x: { type: "number", dtype: "float64", buffer: 0 },
                y: { type: "number", dtype: "float64", buffer: 1 },
                r: { type: "number", dtype: "float64", buffer: 2 },
              },
            },
          },
          marks: [
            { type: "line", x: "x", y: "y", data: "data" },
            { type: "line", x: "x", y: "r", data: "data", axis: "right" },
          ],
        },
        [new Float64Array([0, 1, 2]), new Float64Array([0, 5, 10]), new Float64Array(right)],
        [],
      );
    // Every label but the title: the axes' ticks and the legend.
    const labels = () =>
      [...parent.querySelectorAll("svg text")]
        .map((text) => text.textContent)
        .filter((text) => text !== "Before" && text !== "After");
    run(parent, chart("Before", [0, 50, 100]));
    press(parent, "wheel", 0.5);
    await frame();
    const before = labels();
    run(parent, chart("After", [0, 500, 1000]));
    await frame();
    expect(labels()).toEqual(before);
  });

  it("keeps a lasso over categories only while they stay where they were", async () => {
    const parent = host();
    const first = run(parent, bars(["a", "b", "c"], "lasso"));
    // The brush loads on demand.
    await vi.dynamicImportSettled();
    press(parent, "pointerdown", 0.2, 0.3);
    for (const [x, y] of [
      [0.5, 0.3],
      [0.5, 0.8],
      [0.2, 0.8],
    ] as const)
      press(parent, "pointermove", x, y);
    press(parent, "pointerup", 0.2, 0.8);
    await frame();
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // The script has the outline, in band positions, and its extent's categories.
    const lasso = first.state[0]![1] as { x: string[]; lasso: number[][] };
    expect(lasso.x).toEqual(["a", "b"]);
    expect(lasso.lasso.length).toBeGreaterThanOrEqual(4);
    // A new chart with the same categories, which redraws.
    run(parent, bars(["a", "b", "c"], "lasso", "Again"));
    await frame();
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // Reordered: the outline would cover other bars, so it goes.
    const reordered = run(parent, bars(["c", "a", "b"], "lasso"));
    await frame();
    expect(band(parent)?.getAttribute("visibility") ?? "hidden").toBe("hidden");
    expect(reordered.state).toEqual([["selection", null]]);
  });

  it("clears the script's selection when a new chart cannot keep the brush", async () => {
    const parent = host();
    run(parent, lineChart("Numbers", ["select"]));
    await brush(parent, 0.3, 0.7);
    await frame();
    // Bars along categories replace the line: a range of numbers means nothing there.
    const next = run(parent, bars(["a", "b"]));
    expect(next.state).toEqual([["selection", null]]);
    expect(band(parent)?.getAttribute("visibility") ?? "hidden").toBe("hidden");
  });

  it("keeps a brush on its category labels when the categories change", async () => {
    const parent = host();
    const { state } = run(parent, bars(["a", "b", "c"]));
    // Across the first two of three bands.
    await brush(parent, 0.15, 0.45);
    await frame();
    const whole = { y: null, lasso: null, time: [] };
    expect(state).toEqual([["selection", { x: ["a", "b"], ...whole }]]);
    // Reordered: the brush covers "a" and "b" where they are now.
    const reordered = run(parent, bars(["b", "a", "c"]));
    expect(reordered.state).toEqual([["selection", { x: ["b", "a"], ...whole }]]);
    await frame();
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // Gone: the brush goes, and the script hears so.
    const replaced = run(parent, bars(["x", "y", "z"]));
    expect(replaced.state).toEqual([["selection", null]]);
  });

  it("follows the app's light or dark theme unless the chart has its own", async () => {
    // The color of the chart's text, wherever the SVG sets it.
    const ink = (root: HTMLElement) => getComputedStyle(root.querySelector("svg text")!).fill;
    const parent = host();
    run(parent, lineChart("Light", []));
    const light = ink(parent);
    parent.style.setProperty("--st-background-color", "#0e1117");
    // Streamlit calls the component again when the theme changes, with the same bytes.
    run(parent, lineChart("Light", []));
    await frame();
    const dark = ink(parent);
    expect(dark).not.toBe(light);
    // A chart drawn while the app is dark starts dark.
    const other = host();
    other.style.setProperty("--st-background-color", "rgb(14, 17, 23)");
    run(other, lineChart("Dark", []));
    expect(ink(other)).toBe(dark);
    // A chart's own theme wins.
    const own = host();
    own.style.setProperty("--st-background-color", "#0e1117");
    run(own, lineChart("Own", [], { theme: "light" }));
    expect(ink(own)).toBe(light);
  });

  it("throws on a chart it cannot draw, for Streamlit to show", () => {
    const broken = payload({ marks: [{ type: "line", x: "x", y: "y" }] }, [], []);
    expect(() => run(host(), broken)).toThrow(/table/);
  });

  it("works inside the shadow root Streamlit isolates styles with", () => {
    const shadow = host().attachShadow({ mode: "open" });
    const { triggers } = run(shadow, lineChart("Shadow", ["click"]));
    expect(figure(shadow).getAttribute("aria-label")).toBe("Shadow");
    press(shadow, "pointerdown", 0.5);
    press(shadow, "pointerup", 0.5);
    expect(triggers).toHaveLength(1);
  });
});

describe("Streamlit component with panels' own x scales", () => {
  /** Two facet panels side by side, a over 0..2 and b over 100..102. */
  function facets(title: string) {
    return payload(
      {
        version: 3,
        title,
        width: 400,
        height: 200,
        renderer: "svg",
        // Rectangles select: zoom is not on along y.
        interaction: { zoom: true, brush: "xy" },
        data: {
          data: {
            columns: {
              x: { type: "number", dtype: "float64", buffer: 0 },
              y: { type: "number", dtype: "float64", buffer: 1 },
              g: { type: "category", codes: 2, dictionary: ["a", "b"] },
            },
          },
        },
        marks: [{ type: "line", x: "x", y: "y", data: "data" }],
        facet: { field: "g", columns: 2 },
        resolve: { x: "independent" },
      },
      [
        new Float64Array([0, 1, 2, 100, 101, 102]),
        new Float64Array([1, 3, 2, 1, 3, 2]),
        new Int32Array([0, 0, 0, 1, 1, 1]),
      ],
      [],
    );
  }
  const xLabels = (root: ParentNode) =>
    [...root.querySelectorAll('svg text[dominant-baseline="hanging"]')].map((t) => t.textContent);

  it("keeps each panel's zoom and the selection in its panel on a redraw", async () => {
    const parent = host();
    run(parent, facets("Before"));
    const fitted = xLabels(parent);
    // Zoom the right panel (b) and select in the left one (a).
    press(parent, "wheel", 0.75);
    // The brush loads on demand.
    await vi.dynamicImportSettled();
    press(parent, "pointerdown", 0.15, 0.3);
    press(parent, "pointermove", 0.2, 0.5);
    press(parent, "pointerup", 0.3, 0.7);
    await frame();
    const before = xLabels(parent);
    // b's labels changed and a's did not.
    expect(before).not.toEqual(fitted);
    expect(before.slice(0, 3)).toEqual(fitted.slice(0, 3));
    const outline = band(parent)!.getAttribute("d");
    run(parent, facets("After"));
    await frame();
    expect(figure(parent).getAttribute("aria-label")).toBe("After");
    expect(xLabels(parent)).toEqual(before);
    expect(band(parent)!.getAttribute("d")).toBe(outline);
  });

  it("keeps a selection on a shared x scale when the panels change", async () => {
    const parent = host();
    const panel = (name: string) =>
      payload(
        {
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { brush: "x" },
          data: {
            data: {
              columns: {
                x: { type: "number", dtype: "float64", buffer: 0 },
                y: { type: "number", dtype: "float64", buffer: 1 },
                g: { type: "category", codes: 2, dictionary: [name] },
              },
            },
          },
          marks: [{ type: "line", x: "x", y: "y", data: "data" }],
          facet: { field: "g" },
        },
        [new Float64Array([0, 1, 2]), new Float64Array([1, 3, 2]), new Int32Array([0, 0, 0])],
        ["select"],
      );
    const first = run(parent, panel("a"));
    await brush(parent, 0.3, 0.7);
    await frame();
    const [, selected] = first.state.at(-1)!;
    const next = run(parent, panel("b"));
    await frame();
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // The script already has this selection.
    expect(next.state).toEqual([]);
    expect(selected).not.toBeNull();
  });

  it("reports clicks with the x of the panel clicked", () => {
    const parent = host();
    const day = Date.UTC(2026, 0, 1);
    const { triggers } = run(
      parent,
      payload(
        {
          version: 3,
          width: 400,
          height: 200,
          renderer: "svg",
          data: {
            series: {
              columns: {
                t: { type: "time", dtype: "float64", buffer: 0 },
                v: { type: "number", dtype: "float64", buffer: 1 },
              },
            },
            spread: {
              columns: {
                ms: { type: "number", dtype: "float64", buffer: 2 },
                n: { type: "number", dtype: "float64", buffer: 1 },
              },
            },
          },
          marks: [
            { type: "line", data: "spread", x: "ms", y: "n", panel: "spread" },
            { type: "line", data: "series", x: "t", y: "v", panel: "series" },
          ],
          panels: [{ id: "spread" }, { id: "series" }],
          grid: { columns: 2 },
          resolve: { x: "independent" },
        },
        [
          new Float64Array([day, day + 60_000, day + 120_000]),
          new Float64Array([1, 3, 2]),
          new Float64Array([10, 20, 30]),
        ],
        ["click"],
      ),
    );
    // The right panel shows times; the left one, which is first, numbers.
    press(parent, "pointerdown", 0.8);
    press(parent, "pointerup", 0.8);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]![1]).toMatchObject({ panel: "series", time: true });
  });
});
