// The Streamlit component's front end, called the way Streamlit calls it:
// once per script run, with the payload herceg.streamlit.payload builds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import { MOUSE } from "../../../scripts/browser/mouse.ts";
import type { Header } from "../streamlit.ts";
import { itemChart, key } from "./items.ts";
import { focusMap, mapSpec } from "./maps.ts";
import { payload, run } from "./streamlit-payload.ts";
import { threeSpec } from "./three.ts";

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
      ? new WheelEvent(type, { ctrlKey: true, ...at, deltaY: -200 })
      : new PointerEvent(type, { ...at, pointerId: MOUSE }),
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
    run(parent, lineChart("Navigated", [], { navigator: true }));
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
    run(parent, lineChart("Renamed", [], { navigator: { height: 30 } }));
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

  it("reports a row selection of each payload's data, also one a kept brush wrote again", async () => {
    const parent = host();
    const bound = (title: string, epoch: string) =>
      payload(
        {
          title,
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { brush: "x" },
          rowSelection: { channel: "focus" },
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
        ["rowSelection"],
        3,
        epoch,
      );
    const first = run(parent, bound("Before", "e1"));
    await brush(parent, 0.3, 0.7);
    await frame();
    const [name, value] = first.state.at(-1)!;
    expect(name).toBe("rows");
    expect(value).toMatchObject({ table: "data", channel: "focus", epoch: "e1" });
    expect((value as { selection: { kind: string } }).selection.kind).toBe("predicate");
    // New data: the kept brush selects its rows of it, which the script hears of.
    const next = run(parent, bound("After", "e2"));
    await frame();
    expect(next.state.at(-1)).toMatchObject(["rows", { epoch: "e2", channel: "focus" }]);
  });

  it("keeps rows selected in the same data on a run that changes only how the chart looks", async () => {
    const parent = host();
    const bound = (title: string) =>
      payload(
        {
          title,
          width: 400,
          height: 200,
          renderer: "svg",
          rowSelection: { channel: "focus" },
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
        ["rowSelection"],
        3,
        "e1",
      );
    const first = run(parent, bound("Before"));
    const root = figure(parent) as HTMLElement;
    root.focus();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    root.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await frame();
    const [, held] = first.state.at(-1)!;
    expect((held as { selection: { kind: string } }).selection.kind).toBe("rows");
    // A new title, the same data: the row stays selected, and the script has nothing new to hear.
    const next = run(parent, bound("Retitled"));
    await frame();
    expect(parent.querySelector('svg [opacity="0.25"]')).not.toBeNull();
    expect(next.state.filter(([name]) => name === "rows")).toEqual([]);
  });

  it("clears a brush's rows when a run that keeps the data cannot keep the brush", async () => {
    const parent = host();
    const bound = (x: Header["spec"]["x"]) =>
      payload(
        {
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { brush: "x" },
          rowSelection: { channel: "focus" },
          ...(x && { x }),
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
        [new Float64Array([1, 2, 3]), new Float64Array([1, 3, 2])],
        ["rowSelection"],
        3,
        "e1",
      );
    const first = run(parent, bound(undefined));
    await brush(parent, 0.3, 0.7);
    await frame();
    const [, brushed] = first.state.at(-1)!;
    expect((brushed as { selection: { kind: string } }).selection.kind).toBe("predicate");
    // A log x axis: the brush's range cannot carry over, and nor do its rows.
    const next = run(parent, bound({ type: "log" }));
    await frame();
    expect(next.state.at(-1)).toMatchObject(["rows", { channel: "focus", selection: null }]);
    expect(parent.querySelector('svg [opacity="0.25"]')).toBeNull();
  });

  it("clears rows a brush along a stack's values wrote when it cannot be kept", async () => {
    const parent = host();
    const bound = (y: Header["spec"]["y"]) =>
      payload(
        {
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { brush: "y" },
          rowSelection: { channel: "focus" },
          ...(y && { y }),
          data: {
            data: {
              columns: {
                x: { type: "number", dtype: "float64", buffer: 0 },
                a: { type: "number", dtype: "float64", buffer: 1 },
                b: { type: "number", dtype: "float64", buffer: 2 },
              },
            },
          },
          marks: [{ type: "area", x: "x", y: ["a", "b"], stack: true, data: "data" }],
        },
        [new Float64Array([0, 1, 2]), new Float64Array([1, 2, 3]), new Float64Array([2, 1, 2])],
        ["rowSelection"],
        3,
        "e1",
      );
    const first = run(parent, bound(undefined));
    await vi.dynamicImportSettled();
    press(parent, "pointerdown", 0.5, 0.3);
    press(parent, "pointermove", 0.5, 0.5);
    press(parent, "pointermove", 0.5, 0.7);
    press(parent, "pointerup", 0.5, 0.7);
    await frame();
    // Stacks brushed along their values select rows by where they are drawn.
    const [, brushed] = first.state.at(-1)!;
    expect((brushed as { selection: { kind: string } }).selection.kind).toBe("rows");
    const next = run(parent, bound({ type: "log" }));
    await frame();
    expect(next.state.at(-1)).toMatchObject(["rows", { channel: "focus", selection: null }]);
  });

  it("reports rows selected while the script did not listen once it listens again", async () => {
    const parent = host();
    const bound = (events: Header["events"]) =>
      payload(
        {
          width: 400,
          height: 200,
          renderer: "svg",
          rowSelection: { channel: "focus" },
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
        3,
        "e1",
      );
    const key = (name: string) =>
      (figure(parent) as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    const first = run(parent, bound(["rowSelection"]));
    (figure(parent) as HTMLElement).focus();
    key("ArrowRight");
    key(" ");
    await frame();
    const rowsOf = (state: [string, unknown][]) =>
      (state.at(-1)![1] as { selection: { rows: number[] } }).selection.rows;
    const reported = rowsOf(first.state);
    // The script stops listening; another row is selected meanwhile.
    const quiet = run(parent, bound([]));
    (figure(parent) as HTMLElement).focus();
    key("ArrowRight");
    key("ArrowRight");
    key(" ");
    await frame();
    expect(quiet.state).toEqual([]);
    const again = run(parent, bound(["rowSelection"]));
    await frame();
    expect(rowsOf(again.state)).not.toEqual(reported);
  });

  it("reports a kept brush's rows of data replaced while the script did not listen", async () => {
    const parent = host();
    const bound = (events: Header["events"], epoch: string, y: number[]) =>
      payload(
        {
          width: 400,
          height: 200,
          renderer: "svg",
          interaction: { brush: "x" },
          rowSelection: { channel: "focus" },
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
        [new Float64Array([0, 1, 2]), new Float64Array(y)],
        events,
        3,
        epoch,
      );
    run(parent, bound(["rowSelection"], "e1", [1, 3, 2]));
    await brush(parent, 0.3, 0.7);
    await frame();
    // New data while the script does not listen; then it listens again, the data as it is.
    run(parent, bound([], "e2", [2, 1, 3]));
    await frame();
    const again = run(parent, bound(["rowSelection"], "e2", [2, 1, 3]));
    await frame();
    expect(again.state.at(-1)).toMatchObject(["rows", { epoch: "e2", channel: "focus" }]);
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
    // On the app's own background, which the chart shows through, also
    // where the app gives no theme.
    const surface = (root: HTMLElement) =>
      root.querySelector("svg > g:first-of-type > rect:first-child")?.getAttribute("fill") ??
      "none";
    expect(surface(other)).toBe("none");
    expect(surface(parent)).toBe("none");
    const plain = host();
    run(plain, lineChart("Plain", []));
    expect(surface(plain)).toBe("none");
    // A chart's own theme wins, with its own background.
    const own = host();
    own.style.setProperty("--st-background-color", "#0e1117");
    run(own, lineChart("Own", [], { theme: "light" }));
    expect(ink(own)).toBe(light);
    expect(surface(own)).toBe("#ffffff");
  });

  it("shows a chart it cannot draw in the chart's place, until a run shows one", () => {
    const element = host();
    const broken = payload({ marks: [{ type: "line", x: "x", y: "y" }] }, [], []);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run(element, broken);
    error.mockRestore();
    const alert = element.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/^Chart could not be rendered\n.*no tables/);
    run(element, lineChart("Fixed", []));
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(figure(element).getAttribute("aria-label")).toBe("Fixed");
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
        x: { scope: "panel" },
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
          layout: { type: "grid", columns: [1, 1] },
          x: { scope: "panel" },
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

describe("Streamlit item interaction", () => {
  function items(
    type: "treemap" | "sunburst" | "graph",
    title: string,
    events: Header["events"],
    epoch = "layout",
  ) {
    const fixture = itemChart(type, title);
    return payload(
      fixture.spec,
      fixture.buffers,
      events,
      3,
      "data",
      type === "graph" ? epoch : undefined,
    );
  }

  it.each(["treemap", "sunburst"] as const)(
    "returns %s drilling and carries it across reruns without repeated reports",
    async (type) => {
      const parent = host();
      const first = run(parent, items(type, "First", ["drill"]));
      await vi.dynamicImportSettled();
      key(parent, "ArrowRight");
      key(parent, "Enter");
      expect(first.state).toEqual([["drill_root", { root: { path: ['[0,"East"]'] }, panels: {} }]]);
      const same = run(parent, items(type, "First", ["drill"]));
      expect(same.state).toEqual([]);
      const styled = run(parent, items(type, "Styled", ["drill"]));
      await vi.dynamicImportSettled();
      await frame();
      expect(parent.querySelector("nav")!.textContent).toContain("East");
      expect(styled.state).toEqual([]);
      key(parent, "0");
      expect(styled.state).toEqual([["drill_root", { root: null, panels: {} }]]);
      styled.cleanup();
    },
  );

  it("accumulates moves, preserves style-only reruns, and clears changed networks", async () => {
    const parent = host();
    const first = run(parent, items("graph", "First", ["itemMove"]));
    await vi.dynamicImportSettled();
    key(parent, "ArrowRight");
    key(parent, "ArrowRight", true);
    await frame();
    expect(first.state).toHaveLength(1);
    const [name, value] = first.state[0]!;
    expect(name).toBe("item_positions");
    const moved = value as { epoch: string; positions: Record<string, [number, number]> };
    expect(moved.epoch).toBe("layout");
    expect(Object.keys(moved.positions)).toEqual(['[0,"East"]']);
    await frame();
    const geometry = () => parent.querySelector('[data-kind="point"]')!.getAttribute("d");
    const before = geometry();
    const styled = run(parent, items("graph", "Styled", ["itemMove"]));
    await frame();
    expect(geometry()).toBe(before);
    expect(styled.state).toEqual([]);
    const changed = run(parent, items("graph", "Styled", ["itemMove"], "new-layout"));
    expect(changed.state).toEqual([
      ["item_positions", { epoch: "new-layout", positions: {}, panels: {} }],
    ]);
    const again = run(parent, items("graph", "Styled", ["itemMove"], "new-layout"));
    expect(again.state).toEqual([]);
    again.cleanup();
  });

  it("keeps nodes' places and moves when a rerun changes a network's data", async () => {
    const listener = vi.spyOn(MountedChart.prototype, "on");
    const names = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const ring = (extra: boolean) => {
      const from = names.map((_, i) => i);
      const to = names.map((_, i) => (i + 1) % 30);
      const dictionary = extra ? [...names, "x"] : names;
      if (extra) {
        from.push(0);
        to.push(30);
      }
      const spec: Header["spec"] = {
        width: 400,
        height: 300,
        renderer: "svg",
        interaction: { drag: true },
        data: {
          links: {
            columns: {
              from: { type: "category", codes: 0, dictionary },
              to: { type: "category", codes: 1, dictionary },
            },
          },
        },
        marks: [{ type: "graph", data: "links", source: "from", target: "to" }],
      };
      return payload(
        spec,
        [Int32Array.from(from), Int32Array.from(to)],
        ["itemMove"],
        3,
        extra ? "more" : "ring",
        "network",
      );
    };
    const charts = () => listener.mock.instances as unknown as MountedChart[];
    const place = (name: string) => {
      const model = MountedChart.modelOf(charts().at(-1)!);
      const at = model.inspectItem(JSON.stringify([0, name]))!.points[0]!;
      return model.items!.result()!.moves!.toLayout(JSON.stringify([0, name]), at.px, at.py);
    };
    const parent = host();
    run(parent, ring(false));
    await vi.dynamicImportSettled();
    charts().at(-1)!.setItemPosition('[0,"n20"]', { x: 5, y: 6 });
    await frame();
    const far = place("n10");
    const again = run(parent, ring(true));
    await frame();
    // The node far from the change, and the moved one, are where they were.
    expect(place("n10")[0]).toBeCloseTo(far[0], 6);
    expect(place("n10")[1]).toBeCloseTo(far[1], 6);
    expect(charts().at(-1)!.getItemPositions()).toEqual({ '[0,"n20"]': { x: 5, y: 6 } });
    again.cleanup();
  });

  it("reports current state when reactions become enabled after ignored interaction", async () => {
    const parent = host();
    const ignored = run(parent, items("graph", "First", []));
    await vi.dynamicImportSettled();
    key(parent, "ArrowRight");
    key(parent, "ArrowRight", true);
    expect(ignored.state).toEqual([]);
    const listening = run(parent, items("graph", "First", ["itemMove"]));
    expect(listening.state).toHaveLength(1);
    await vi.dynamicImportSettled();
    key(parent, "0");
    await frame();
    expect((listening.state.at(-1)![1] as { positions: object }).positions).toEqual({});
    listening.cleanup();
  });
});

it("reports and keeps each subplot tree's root and map's view across reruns", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const fixture = itemChart("treemap");
    const [tree] = fixture.spec.marks;
    const spec = {
      ...fixture.spec,
      height: 300,
      interaction: { zoom: true },
      projection: "equirectangular",
      panels: [{ id: "tree" }, { id: "map" }],
      layout: { type: "grid", columns: [1, 1] },
      data: {
        ...fixture.spec.data,
        places: {
          columns: {
            lon: { type: "number", dtype: "float64", buffer: 3 },
            lat: { type: "number", dtype: "float64", buffer: 4 },
          },
        },
      },
      marks: [
        { ...tree!, panel: "tree" },
        { type: "geopoint", data: "places", longitude: "lon", latitude: "lat", panel: "map" },
      ],
    } as Header["spec"];
    const buffers = [...fixture.buffers, new Float64Array([0, 10]), new Float64Array([0, 10])];
    const first = run(parent, payload(spec, buffers, ["drill", "viewport"]));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setDrillRoot(["East"], { panel: "tree" });
    chart.setViewport({ x: [0, 0.1], y: [0, 0.1] }, { panel: "map" });
    expect(first.state.find(([name]) => name === "drill_root")).toEqual([
      "drill_root",
      { root: null, panels: { tree: { path: ['[0,"East"]'] } } },
    ]);
    const view = first.state.findLast(([name]) => name === "viewport")![1] as {
      panels: Record<string, { x: unknown }>;
    };
    expect(view.panels.map!.x).toEqual([0, 0.1]);
    // A rerun that only restyles keeps both.
    const next = run(parent, payload({ ...spec, title: "Styled" }, buffers, ["drill", "viewport"]));
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored.getDrillRoot({ panel: "tree" })?.key).toBe('[0,"East"]');
    expect(restored.getViewport({ panel: "map" }).x).toEqual([0, 0.1]);
    expect(next.state).toEqual([]);
    next.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("reports each subplot's own x view and the panel of the selection", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const line = (panel: string) => ({ type: "line", x: "x", y: "y", data: "data", panel });
    const spec = {
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { zoom: "x", brush: "x" },
      panels: [{ id: "latency" }, { id: "errors" }],
      layout: { type: "grid", columns: [2, 1] },
      data: {
        data: {
          columns: {
            x: { type: "number", dtype: "float64", buffer: 0 },
            y: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [line("latency"), line("errors")],
    } as Header["spec"];
    const { state } = run(
      parent,
      payload(
        spec,
        [new Float64Array([0, 1, 2]), new Float64Array([1, 3, 2])],
        ["viewport", "select"],
      ),
    );
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setViewport({ x: [0, 1] }, { panel: "latency" });
    chart.setViewport({ x: [1, 2] }, { panel: "errors" });
    const view = state.findLast(([name]) => name === "viewport")![1] as {
      x?: unknown;
      panels: Record<string, { x: unknown }>;
    };
    // No view is the whole chart's: each panel has its own.
    expect(view.x).toBeUndefined();
    expect(view.panels.latency!.x).toEqual([0, 1]);
    expect(view.panels.errors!.x).toEqual([1, 2]);
    chart.select({ x: [1.2, 1.8], y: null, lasso: null }, { panel: "errors" });
    await vi.dynamicImportSettled();
    expect(state.findLast(([name]) => name === "selection")![1]).toMatchObject({
      panels: ["errors"],
      x: [1.2, 1.8],
    });
  } finally {
    listener.mockRestore();
  }
});

it("keeps subplots' views across reruns of a chart waiting for its guides", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const line = (panel: string) => ({ type: "line", x: "x", y: "y", data: "data", panel });
    const spec = (title: string) =>
      ({
        title,
        width: 400,
        height: 200,
        renderer: "svg",
        interaction: { zoom: "x" },
        panels: [{ id: "latency" }, { id: "errors" }],
        layout: { type: "grid", columns: [2, 1] },
        // A panel's legend needs the guide compiler, which loads first.
        guides: [{ type: "legend", panel: "latency" }],
        data: {
          data: {
            columns: {
              x: { type: "number", dtype: "float64", buffer: 0 },
              y: { type: "number", dtype: "float64", buffer: 1 },
            },
          },
        },
        marks: [line("latency"), line("errors")],
      }) as Header["spec"];
    const buffers = [new Float64Array([0, 1, 2]), new Float64Array([1, 3, 2])];
    run(parent, payload(spec("Before"), buffers, ["viewport"]));
    const chart = listener.mock.instances[0] as MountedChart;
    // Its panels come with its first scene.
    expect(chart.getPanels()).toEqual([]);
    await chart.loading;
    chart.render();
    chart.setViewport({ x: [1, 2] }, { panel: "errors" });
    run(parent, payload(spec("After"), buffers, ["viewport"]));
    expect(parent.querySelector('[role="alert"]')).toBeNull();
    const next = listener.mock.instances.at(-1) as MountedChart;
    expect(next).not.toBe(chart);
    await next.loading;
    await frame();
    expect(next.getViewport({ panel: "errors" }).x).toEqual([1, 2]);
    expect(next.getViewport({ panel: "latency" }).x).toBeNull();
  } finally {
    listener.mockRestore();
  }
});

it("keeps a selection on the panels sharing x when an inset comes before them", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const columns = {
      c: { type: "category", codes: 0, dictionary: ["a", "b", "z"] },
      v: { type: "number", dtype: "float64", buffer: 1 },
    };
    const plain = {
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { brush: "x" },
      data: { data: { columns } },
      marks: [{ type: "bar", x: "c", y: "v", data: "data" }],
    } as Header["spec"];
    const laidOut = {
      ...plain,
      width: 600,
      height: 400,
      x: { scope: "chart" },
      panels: [{ id: "share" }, { id: "detail" }, { id: "bars" }],
      layout: {
        type: "grid",
        columns: [1, 1],
        cells: [
          {
            row: 0,
            column: 0,
            content: { type: "panel", panel: "share", insets: [{ panel: "detail" }] },
          },
          { row: 0, column: 1, content: { type: "panel", panel: "bars" } },
        ],
      },
      marks: [
        { type: "pie", category: "c", value: "v", data: "data", panel: "share" },
        { type: "line", x: "v", y: "v", data: "data", panel: "detail" },
        { type: "bar", x: "c", y: "v", data: "data", panel: "bars" },
      ],
    } as Header["spec"];
    const buffers = [new Int32Array([0, 1, 2]), new Float64Array([1, 2, 3])];
    run(parent, payload(plain, buffers, ["select"]));
    const chart = listener.mock.instances[0] as MountedChart;
    chart.render();
    chart.select({ x: [0, 1], y: null, lasso: null });
    run(parent, payload(laidOut, buffers, ["select"]));
    const next = listener.mock.instances.at(-1) as MountedChart;
    await next.loading;
    await frame();
    expect(next.selection?.x).toEqual([0, 1]);
    expect(next.selectionPanels).toEqual(["bars"]);
  } finally {
    listener.mockRestore();
  }
});

it("keeps two map subplots' views and a lasso in one, naming its panel, across reruns", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const place = (panel: string) => ({
      type: "geopoint",
      data: "places",
      longitude: "lon",
      latitude: "lat",
      panel,
    });
    const spec = {
      width: 400,
      height: 300,
      renderer: "svg",
      projection: "equirectangular",
      interaction: { zoom: true, brush: "lasso" },
      panels: [{ id: "a" }, { id: "b" }],
      layout: { type: "grid", columns: [1, 1] },
      data: {
        places: {
          columns: {
            lon: { type: "number", dtype: "float64", buffer: 0 },
            lat: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [place("a"), place("b")],
    } as Header["spec"];
    const buffers = [new Float64Array([0, 10]), new Float64Array([0, 10])];
    const events: Header["events"] = ["select", "viewport"];
    const first = run(parent, payload(spec, buffers, events));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setViewport({ x: [0, 0.1], y: [0, 0.1] }, { panel: "b" });
    const lasso: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    chart.select({ x: null, y: null, lasso }, { panel: "b" });
    expect(first.state.findLast(([name]) => name === "selection")![1]).toMatchObject({
      panels: ["b"],
      lasso,
    });
    // A rerun that only restyles keeps both, and the script hears nothing new.
    const next = run(parent, payload({ ...spec, title: "Styled" }, buffers, events));
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored).not.toBe(chart);
    expect(restored.getViewport({ panel: "b" }).x).toEqual([0, 0.1]);
    expect(restored.getViewport({ panel: "a" }).x).toBeNull();
    expect(restored.selection?.lasso).toEqual(lasso);
    expect(restored.selectionPanels).toEqual(["b"]);
    expect(next.state).toEqual([]);
    next.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("keeps the trees still drawn when a rerun draws another mark in a tree's subplot", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const fixture = itemChart("treemap");
    const [tree] = fixture.spec.marks;
    const spec = {
      ...fixture.spec,
      height: 300,
      panels: [{ id: "a" }, { id: "b" }],
      layout: { type: "grid", columns: [1, 1] },
      marks: [
        { ...tree!, panel: "a" },
        { ...tree!, panel: "b" },
      ],
    } as Header["spec"];
    const first = run(parent, payload(spec, fixture.buffers, ["drill"]));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setDrillRoot(["East"], { panel: "b" });
    // Panel a now draws a pie.
    const pie = {
      type: "pie" as const,
      data: "data",
      category: "region",
      value: "value",
      panel: "a",
    };
    const next = run(
      parent,
      payload({ ...spec, marks: [pie, spec.marks[1]!] }, fixture.buffers, ["drill"]),
    );
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored).not.toBe(chart);
    expect(restored.getDrillRoot({ panel: "b" })?.key).toBe('[1,"East"]');
    first.cleanup();
    next.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("redraws a network subplot too large to draw, keeping the other's view", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const names = Array.from({ length: 5001 }, (_, i) => `n${i}`);
    const graph = (panel: string, nodes?: string) => ({
      type: "graph" as const,
      data: "links",
      source: "from",
      target: "to",
      ...(nodes && { nodes, node: "id" }),
      panel,
    });
    const spec = {
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { zoom: true },
      panels: [{ id: "a" }, { id: "b" }],
      data: {
        links: {
          columns: {
            from: { type: "category", codes: 0, dictionary: ["n0"] },
            to: { type: "category", codes: 1, dictionary: ["n1"] },
          },
        },
        nodes: { columns: { id: { type: "category", codes: 2, dictionary: names } } },
      },
      marks: [graph("a", "nodes"), graph("b")],
    } as Header["spec"];
    const buffers = [new Int32Array([0]), new Int32Array([0]), Int32Array.from(names, (_, i) => i)];
    const first = run(parent, payload(spec, buffers, ["viewport"], 3, "data", "layout"));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setViewport({ x: [0, 1], y: [0, 1] }, { panel: "b" });
    const next = run(
      parent,
      payload({ ...spec, title: "Styled" }, buffers, ["viewport"], 3, "data", "layout"),
    );
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored).not.toBe(chart);
    expect(restored.getViewport({ panel: "b" }).x).toEqual([0, 1]);
    first.cleanup();
    next.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("coalesces network resets into one final Streamlit state value", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const fixture = itemChart("graph");
    const runState = run(
      parent,
      payload(fixture.spec, fixture.buffers, ["itemMove"], 3, "data", "layout"),
    );
    const chart = listener.mock.instances[0] as MountedChart;
    await vi.dynamicImportSettled();
    for (const [i, name] of ["East", "West", "A", "B", "C"].entries()) {
      chart.setItemPosition(JSON.stringify([0, name]), { x: i, y: i });
    }
    await frame();
    expect(runState.state).toHaveLength(1);
    runState.state.length = 0;
    key(parent, "0");
    await frame();
    expect(runState.state).toEqual([
      ["item_positions", { epoch: "layout", positions: {}, panels: {} }],
    ]);
    runState.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("reports and restores a network's plane, lasso and moved positions across compatible runs", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const fixture = itemChart("graph");
    const spec = {
      ...fixture.spec,
      interaction: { zoom: true, drag: true, brush: "lasso" as const },
    };
    const first = run(
      parent,
      payload(spec, fixture.buffers, ["viewport", "itemMove", "select"], 3, "data", "layout"),
    );
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setViewport({ x: [-80, 80], y: [20, 80] });
    chart.setItemPosition('[0,"East"]', { x: 0, y: 50 });
    chart.render();
    chart.select({
      x: null,
      y: null,
      lasso: [
        [-2, 48],
        [2, 48],
        [2, 52],
        [-2, 52],
      ],
    });
    await frame();
    expect(first.state.some(([name]) => name === "viewport")).toBe(true);
    const view = chart.getViewport();
    const selection = chart.selection;
    const next = run(
      parent,
      payload(
        { ...spec, title: "Styled" },
        fixture.buffers,
        ["viewport", "itemMove", "select"],
        3,
        "data",
        "layout",
      ),
    );
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored.getViewport()).toEqual(view);
    expect(restored.selection).toEqual(selection);
    expect(restored.toSVG()).toContain("a5 5");
    const reset = run(
      parent,
      payload(
        { ...spec, title: "New data" },
        fixture.buffers,
        ["viewport"],
        3,
        "new-data",
        "new-layout",
      ),
    );
    const changed = listener.mock.instances.at(-1) as MountedChart;
    expect(changed.getViewport()).toEqual({ x: null, y: null, yRight: null });
    expect(changed.selection).toBeNull();
    expect(reset.state).toEqual([
      ["viewport", { x: null, y: null, yRight: null, time: [], epoch: "new-layout" }],
    ]);
    next.cleanup();
    reset.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it("keeps map plane ranges and lassos through Streamlit redraws", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const spec: Header["spec"] = {
      width: 400,
      height: 300,
      renderer: "svg",
      projection: "equirectangular",
      interaction: { zoom: true, brush: "lasso" },
      data: {
        data: {
          columns: {
            lon: { type: "number", dtype: "float64", buffer: 0 },
            lat: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [{ type: "geopoint", data: "data", longitude: "lon", latitude: "lat" }],
    };
    const buffers = [new Float64Array([0, 10]), new Float64Array([0, 10])];
    run(parent, payload(spec, buffers, ["viewport"]));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setViewport({ x: [-0.1, 0.1], y: [0.02, 0.08] });
    chart.select({
      x: null,
      y: null,
      lasso: [
        [0, 0],
        [0.02, 0],
        [0.02, 0.02],
        [0, 0.02],
      ],
    });
    // As the user left them, before the chart the rerun replaces goes.
    const [view, selection] = [chart.getViewport(), chart.selection];
    const next = run(parent, payload({ ...spec, title: "Styled" }, buffers, ["viewport"]));
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored.getViewport()).toEqual(view);
    expect(restored.selection).toEqual(selection);
    next.cleanup();
  } finally {
    listener.mockRestore();
  }
});

it.each([
  {
    name: "changed inferred parameters",
    projection: "conic-equal-area" as const,
    lon: 0,
    lat: 70,
    keeps: false,
  },
  {
    name: "stable inferred parameters",
    projection: "conic-equal-area" as const,
    lon: -95,
    lat: 35,
    keeps: true,
  },
  {
    name: "explicit parameters",
    projection: {
      type: "conic-equal-area" as const,
      centralMeridian: -95,
      parallels: [30, 40] as const,
    },
    lon: 0,
    lat: 70,
    keeps: true,
  },
  {
    name: "fit-derived parameters",
    projection: {
      type: "conic-equal-area" as const,
      fit: [
        [-110, 20],
        [-80, 50],
      ] as const,
    },
    lon: 0,
    lat: 70,
    keeps: true,
  },
])(
  "restores a map only with matching resolved projection: $name",
  ({ projection, lon, lat, keeps }) => {
    const listener = vi.spyOn(MountedChart.prototype, "on");
    try {
      const parent = host();
      const spec = mapSpec(projection);
      run(
        parent,
        payload(
          spec,
          [new Float64Array([-100, -90]), new Float64Array([30, 40])],
          ["select", "viewport", "rowSelection"],
          3,
          "old",
        ),
      );
      const chart = listener.mock.instances[0] as MountedChart;
      const kept = focusMap(chart);
      const next = run(
        parent,
        payload(
          spec,
          [new Float64Array([-100, -90, lon]), new Float64Array([30, 40, lat])],
          ["select", "viewport", "rowSelection"],
          3,
          "new",
        ),
      );
      const restored = listener.mock.instances.at(-1) as MountedChart;
      expect(restored.getViewport()).toEqual(
        keeps ? kept.viewport : { x: null, y: null, yRight: null },
      );
      expect(restored.selection).toEqual(keeps ? kept.selection : null);
      const rows = next.state.filter(([name]) => name === "rows").at(-1)?.[1];
      expect(rows).toMatchObject({ selection: keeps ? { kind: "rows", rows: [0] } : null });
      next.cleanup();
    } finally {
      listener.mockRestore();
    }
  },
);

it("keeps cameras across Streamlit reruns and resets only changed defaults", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  try {
    const parent = host();
    const spec = threeSpec();
    const first = run(parent, payload(spec, [], ["camera"]));
    await vi.dynamicImportSettled();
    const chart = listener.mock.instances[0] as MountedChart;
    chart.setCamera({ azimuth: 40 }, { panel: "a" });
    chart.setCamera({ azimuth: 70 }, { panel: "b" });
    await frame();
    expect(first.state.at(-1)).toMatchObject([
      "camera",
      { panels: { a: { azimuth: 40 }, b: { azimuth: 70 } } },
    ]);
    const second = run(
      parent,
      payload(
        {
          ...spec,
          title: "Styled",
          panels: [
            { id: "a", camera: { azimuth: 20 } },
            { id: "b", camera: { azimuth: 80 } },
          ],
        },
        [],
        ["camera"],
      ),
    );
    const restored = listener.mock.instances.at(-1) as MountedChart;
    expect(restored.getCamera({ panel: "a" })!.azimuth).toBe(40);
    expect(restored.getCamera({ panel: "b" })!.azimuth).toBe(80);
    first.cleanup();
    second.cleanup();
  } finally {
    listener.mockRestore();
  }
});
