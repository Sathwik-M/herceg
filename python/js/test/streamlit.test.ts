// The Streamlit component's front end, called the way Streamlit calls it:
// once per script run, with the payload herceg.streamlit.payload builds.

import { afterEach, describe, expect, it } from "vitest";
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
function bars(dictionary: string[]) {
  return payload(
    {
      width: 400,
      height: 200,
      renderer: "svg",
      interaction: { brush: "x" },
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
const band = (root: ParentNode) => root.querySelector("svg rect[fill-opacity]");

function press(root: ParentNode, type: string, fraction: number) {
  const target = figure(root);
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      clientX: rect.left + rect.width * fraction,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
    }),
  );
}

function brush(root: ParentNode, from: number, to: number) {
  press(root, "pointerdown", from);
  press(root, "pointermove", (from + to) / 2);
  press(root, "pointermove", to);
  press(root, "pointerup", to);
}

describe("Streamlit component", () => {
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

  it("reports a brushed range and clicks only when the script reacts to them", async () => {
    const quiet = host();
    const ignored = run(quiet, lineChart("Quiet", []));
    brush(quiet, 0.3, 0.7);
    press(quiet, "pointerdown", 0.5);
    press(quiet, "pointerup", 0.5);
    expect(ignored.state).toEqual([]);
    expect(ignored.triggers).toEqual([]);

    const parent = host();
    const { state, triggers } = run(parent, lineChart("Reacts", ["select", "click"]));
    brush(parent, 0.3, 0.7);
    await frame();
    expect(state).toHaveLength(1);
    const [name, value] = state[0]!;
    const { x, time } = value as { x: [number, number]; time: boolean };
    expect(name).toBe("selection");
    expect(time).toBe(false);
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
          points: [{ series: "y", value: 3, text: "3" }],
        },
      ],
    ]);
  });

  it("redraws new bytes in place, keeping the brush", async () => {
    const parent = host();
    run(parent, lineChart("Before", ["select"]));
    brush(parent, 0.3, 0.7);
    await frame();
    const next = run(parent, lineChart("After", ["select"]));
    await frame();
    expect(figure(parent).getAttribute("aria-label")).toBe("After");
    expect(parent.querySelectorAll('[role="figure"]')).toHaveLength(1);
    expect(band(parent)!.getAttribute("visibility")).toBe("visible");
    // Restoring the brush does not rerun the script.
    expect(next.state).toEqual([]);
  });

  it("clears the script's selection when a new chart cannot keep the brush", async () => {
    const parent = host();
    run(parent, lineChart("Numbers", ["select"]));
    brush(parent, 0.3, 0.7);
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
    brush(parent, 0.15, 0.45);
    await frame();
    expect(state).toEqual([["selection", { x: ["a", "b"], time: false }]]);
    // Reordered: the brush covers "a" and "b" where they are now.
    const reordered = run(parent, bars(["b", "a", "c"]));
    expect(reordered.state).toEqual([["selection", { x: ["b", "a"], time: false }]]);
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
