// The notebook widget's front end against a stand-in for anywidget's model:
// what Python sends is applied to the chart, and interaction reaches Python.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SelectionPayload, ViewportPayload } from "../events.ts";
import widgetModule, { type Model, type Snapshot, type Update } from "../widget.ts";
import { controlTime, pointPath } from "./animation.ts";

type Handler = (...args: never[]) => void;

/** anywidget's model as the widget sees it: state, custom messages, and events. */
class MockModel implements Model {
  readonly sent: Record<string, unknown>[] = [];
  readonly #state: Record<string, unknown>;
  readonly #handlers = new Map<string, Handler[]>();

  constructor(state: Record<string, unknown>) {
    this.#state = state;
  }

  get(name: string): unknown {
    return this.#state[name];
  }

  set(name: string, value: unknown) {
    this.#state[name] = value;
    this.#emit(`change:${name}`);
  }

  send(content: object, _callbacks?: unknown, buffers?: ArrayBuffer[] | ArrayBufferView[]) {
    this.sent.push({ ...(content as Record<string, unknown>), ...(buffers && { buffers }) });
  }

  on(event: string, callback: Handler) {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), callback]);
  }

  /** A custom message from Python, with its buffers as the comm delivers them. */
  receive(message: Update, buffers: ArrayBufferView[] = []) {
    this.#emit(
      "msg:custom",
      message,
      buffers.map((b) => new DataView(b.buffer)),
    );
  }

  #emit(event: string, ...args: unknown[]) {
    for (const handler of this.#handlers.get(event) ?? [])
      (handler as (...a: unknown[]) => void)(...args);
  }

  /** Messages of one type sent to Python. */
  messages(type: string) {
    return this.sent.filter((message) => message.type === type);
  }
}

const number = (buffer: number) => ({ type: "number" as const, dtype: "float64" as const, buffer });

function snapshot(options: Record<string, unknown> = {}): Snapshot {
  return {
    revision: 0,
    spec: {
      title: "Live",
      width: 400,
      height: 200,
      renderer: "svg",
      ...options,
      data: {
        data: {
          columns: {
            t: number(0),
            v: number(1),
            host: { type: "category", codes: 2, dictionary: ["a"] },
          },
        },
      },
      marks: [{ type: "line", x: "t", y: "v", data: "data" }],
    },
    buffers: [
      new DataView(new Float64Array([0, 1, 2]).buffer),
      new DataView(new Float64Array([1, 3, 2]).buffer),
      new DataView(new Int32Array([0, 0, 0]).buffer),
    ],
    selection: null,
    viewport: null,
  };
}

/** Rows as Python sends them: columns indexing the message's buffers. */
function rows(t: number[], v: number[], host: string[]) {
  return {
    columns: {
      t: number(0),
      v: number(1),
      host: { type: "category" as const, codes: 2, dictionary: [...new Set(host)] },
    },
    buffers: [
      new Float64Array(t),
      new Float64Array(v),
      Int32Array.from(host, (label) => [...new Set(host)].indexOf(label)),
    ],
  };
}

let hosts: HTMLElement[] = [];
let cleanups: (() => void)[] = [];

function mount(model: MockModel, count = 1) {
  const widget = widgetModule();
  cleanups.push(widget.initialize({ model }));
  return Array.from({ length: count }, () => {
    const host = document.createElement("div");
    host.style.width = "400px";
    document.body.append(host);
    hosts.push(host);
    cleanups.push(widget.render({ model, el: host }));
    return host;
  });
}

beforeEach(() => {
  hosts = [];
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  for (const host of hosts) host.remove();
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const figure = (host: HTMLElement) => host.querySelector('[role="figure"]')!;
/** Points of the drawn line: one path command per vertex. */
const vertices = (host: HTMLElement) =>
  host.querySelector("svg g[clip-path] path")!.getAttribute("d")!.match(/[ML]/g)!.length;
const band = (host: HTMLElement) => host.querySelector('svg path[fill-opacity="0.18"]');

function press(host: HTMLElement, type: string, fraction: number) {
  const rect = figure(host).getBoundingClientRect();
  figure(host).dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: rect.left + rect.width * fraction,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
    }),
  );
}

describe("notebook widget", () => {
  it("renders the snapshot and asks Python whether it is current", () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    expect(figure(host!).getAttribute("aria-label")).toBe("Live");
    expect(vertices(host!)).toBe(3);
    expect(model.sent).toEqual([{ type: "ready", revision: 0 }]);
  });

  it("animates keyed points when Python replaces and reorders the rows", async () => {
    const state = snapshot({
      animation: { values: true, duration: 300 },
      x: { domain: [0, 4] },
      y: { domain: [0, 100] },
    });
    state.spec.marks = [{ type: "point", x: "t", y: "v", data: "data", animationKey: "host" }];
    const initial = rows([1, 2, 3], [10, 20, 30], ["a", "b", "c"]);
    state.spec.data = { data: { columns: initial.columns } };
    state.buffers = initial.buffers.map((buffer) => new DataView(buffer.buffer));
    const next = rows([1, 2, 3], [70, 60, 50], ["c", "a", "d"]);
    const reference = new MockModel({
      _chart: {
        ...state,
        spec: { ...state.spec, animation: false, data: { data: { columns: next.columns } } },
        buffers: next.buffers.map((buffer) => new DataView(buffer.buffer)),
      } satisfies Snapshot,
      _listening: [],
    });
    const model = new MockModel({ _chart: state, _listening: [] });
    const [host] = mount(model);
    const [staticHost] = mount(reference);
    host!.style.cssText = "position:fixed;left:0;top:0;width:400px";
    // Each circle starts with M(x - radius) y, followed by its arc radii.
    const circles = (element: HTMLElement) =>
      pointPath(element)
        .split("M")
        .slice(1)
        .map((command) => {
          const [left, y, r] = command.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
          return { x: left! + r!, y: y!, r: r! };
        });
    await controlTime(host!);
    const before = circles(host!);
    const target = circles(staticHost!);
    // Flush the replacement's first frame while keeping elapsed time at zero.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now());
    model.receive(
      { type: "replace", revision: 1, table: "data", columns: next.columns },
      next.buffers,
    );
    vi.advanceTimersByTime(16);
    now.mockRestore();
    const start = circles(host!);
    expect(start).toHaveLength(4);
    expect(start[0]).toEqual(before[2]); // c
    expect(start[1]).toEqual(before[0]); // a
    expect(start[2]!.r).toBe(0); // d
    expect(start[2]!.x).toBeCloseTo(target[2]!.x, 2);
    expect(start[2]!.y).toBe(target[2]!.y);
    expect(start[3]).toEqual(before[1]); // b
    vi.advanceTimersByTime(80);
    const middle = circles(host!);
    expect(middle).toHaveLength(4);
    expect(middle[0]).not.toEqual(start[0]);
    expect(middle[0]).not.toEqual(target[0]);
    expect(middle[1]).not.toEqual(start[1]);
    expect(middle[1]).not.toEqual(target[1]);
    expect(middle[2]!.r).toBeGreaterThan(0);
    expect(middle[2]!.r).toBeLessThan(target[2]!.r);
    expect(middle[3]!.x).toBeCloseTo(before[1]!.x, 2);
    expect(middle[3]!.y).toBe(before[1]!.y);
    expect(middle[3]!.r).toBeGreaterThan(0);
    expect(middle[3]!.r).toBeLessThan(before[1]!.r);
    vi.advanceTimersByTime(400);
    expect(circles(host!)).toHaveLength(3);
    expect(pointPath(host!)).toBe(pointPath(staticHost!));
  });

  it("appends rows, keeps a rolling window, and replaces data", async () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    const more = rows([3, 4], [5, 4], ["a", "b"]);
    model.receive(
      { type: "append", revision: 1, table: "data", columns: more.columns },
      more.buffers,
    );
    await frame();
    expect(vertices(host!)).toBe(5);
    const window = rows([5], [1], ["c"]);
    model.receive(
      { type: "append", revision: 2, table: "data", columns: window.columns, maxRows: 3 },
      window.buffers,
    );
    await frame();
    expect(vertices(host!)).toBe(3);
    const fresh = rows([0, 1], [2, 2], ["d", "d"]);
    model.receive(
      { type: "replace", revision: 3, table: "data", columns: fresh.columns },
      fresh.buffers,
    );
    await frame();
    expect(vertices(host!)).toBe(2);
  });

  it("changes options in place and removes those set to null", () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    model.receive({ type: "options", revision: 1, options: { title: "Renamed", height: 150 } });
    expect(figure(host!).getAttribute("aria-label")).toBe("Renamed");
    expect((host!.firstElementChild as HTMLElement).style.height).toBe("150px");
    model.receive({ type: "options", revision: 2, options: { title: null } });
    expect(figure(host!).getAttribute("aria-label")).toBe("Chart");
  });

  it("draws a navigator, and adds and removes one with options", async () => {
    const model = new MockModel({
      _chart: snapshot({ navigator: true }),
      _listening: [],
    });
    const [host] = mount(model);
    const sliders = () => host!.querySelectorAll('[aria-label="Range navigator"] [role="slider"]');
    await vi.dynamicImportSettled();
    expect(sliders()).toHaveLength(3);
    model.receive({ type: "options", revision: 1, options: { navigator: null } });
    expect(sliders()).toHaveLength(0);
    model.receive({ type: "options", revision: 2, options: { navigator: { height: 30 } } });
    await vi.dynamicImportSettled();
    await frame();
    expect(sliders()).toHaveLength(3);
  });

  it("changes options of charts that resolve their scales", () => {
    const resolved = snapshot({ resolve: { x: "shared", y: "shared" } });
    const model = new MockModel({ _chart: resolved, _listening: [] });
    const [host] = mount(model);
    model.receive({ type: "options", revision: 1, options: { title: "After" } });
    expect(figure(host!).getAttribute("aria-label")).toBe("After");
  });

  it("loads a network grown past its limit, and draws it once updates bring it back", async () => {
    // A snapshot after Python streamed nodes in: 5,001 of them, one link.
    const names = Array.from({ length: 5001 }, (_, i) => `n${i}`);
    const model = new MockModel({
      _chart: {
        revision: 4,
        spec: {
          width: 400,
          height: 200,
          renderer: "svg",
          data: {
            links: {
              columns: {
                from: { type: "category", codes: 0, dictionary: ["n0"] },
                to: { type: "category", codes: 1, dictionary: ["n1"] },
              },
            },
            nodes: { columns: { id: { type: "category", codes: 2, dictionary: names } } },
          },
          marks: [
            {
              type: "graph",
              data: "links",
              source: "from",
              target: "to",
              nodes: "nodes",
              node: "id",
            },
          ],
        },
        buffers: [
          new DataView(new Int32Array([0]).buffer),
          new DataView(new Int32Array([0]).buffer),
          new DataView(Int32Array.from(names, (_, i) => i).buffer),
        ],
        selection: null,
        viewport: null,
      } satisfies Snapshot,
      _listening: [],
    });
    const [host] = mount(model);
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(host!.textContent).toContain("too many to lay out");
    model.receive(
      {
        type: "replace",
        revision: 5,
        table: "nodes",
        columns: { id: { type: "category", codes: 0, dictionary: ["n0", "n1", "n2"] } },
      },
      [new Int32Array([0, 1, 2])],
    );
    await frame();
    // A link and three nodes, named beside them.
    expect(host!.querySelectorAll("svg g[clip-path] path")).toHaveLength(4);
    const labels = [...host!.querySelectorAll("svg text")].map((text) => text.textContent);
    expect(labels).toEqual(expect.arrayContaining(["n0", "n1", "n2"]));
  });

  it("replaces a table of shapes, reading its geometry column", async () => {
    const square = (x: number) => [x, 0, x + 1, 0, x + 1, 1, x, 1];
    const shapes = () => ({
      type: "geometry" as const,
      coordinates: 0,
      ringOffsets: 1,
      polygonOffsets: 2,
      geometryOffsets: 2,
    });
    const buffers = (count: number) => [
      new DataView(
        Float64Array.from(Array.from({ length: count }, (_, i) => square(i * 2)).flat()).buffer,
      ),
      new DataView(Int32Array.from({ length: count + 1 }, (_, i) => i * 4).buffer),
      new DataView(Int32Array.from({ length: count + 1 }, (_, i) => i).buffer),
    ];
    const model = new MockModel({
      _chart: {
        revision: 1,
        spec: {
          width: 400,
          height: 200,
          renderer: "svg",
          projection: "equirectangular",
          data: { data: { columns: { shape: shapes() } } },
          marks: [{ type: "geoshape", data: "data", geometry: "shape" }],
        },
        buffers: buffers(1),
        selection: null,
        viewport: null,
      } satisfies Snapshot,
      _listening: [],
    });
    const [host] = mount(model);
    const regions = () => host!.querySelectorAll('svg path[fill-rule="evenodd"]');
    expect(regions()).toHaveLength(1);
    model.receive(
      { type: "replace", revision: 2, table: "data", columns: { shape: shapes() } },
      buffers(3).map((view) => new Uint8Array(view.buffer)),
    );
    await frame();
    expect(regions()).toHaveLength(3);
  });

  it("shows invalid options as an error and keeps the chart", () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    model.receive({ type: "options", revision: 1, options: { renderer: "paper" } });
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain("renderer");
    expect(figure(host!)).not.toBeNull();
  });

  it("asks for the whole chart after missing an update, and redraws from it", async () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    const more = rows([3], [5], ["a"]);
    model.receive(
      { type: "append", revision: 2, table: "data", columns: more.columns },
      more.buffers,
    );
    model.receive(
      { type: "append", revision: 3, table: "data", columns: more.columns },
      more.buffers,
    );
    // One request, however many updates arrive before the answer.
    expect(model.messages("resync")).toEqual([{ type: "resync" }]);
    model.set("_chart", { ...snapshot({ title: "Resent" }), revision: 3 });
    expect(figure(host!).getAttribute("aria-label")).toBe("Resent");
    model.receive(
      { type: "append", revision: 4, table: "data", columns: more.columns },
      more.buffers,
    );
    await frame();
    expect(vertices(host!)).toBe(4);
  });

  it("ignores duplicate updates and snapshots older than what it drew", async () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    const more = rows([3], [5], ["a"]);
    const append = { type: "append" as const, revision: 1, table: "data", columns: more.columns };
    model.receive(append, more.buffers);
    model.receive(append, more.buffers);
    model.set("_chart", { ...snapshot({ title: "Old" }), revision: 1 });
    await frame();
    expect(vertices(host!)).toBe(4);
    expect(figure(host!).getAttribute("aria-label")).toBe("Live");
    expect(model.messages("resync")).toEqual([]);
    // Updates keep applying.
    model.receive({ ...append, revision: 2 }, more.buffers);
    await frame();
    expect(vertices(host!)).toBe(5);
  });

  it("appends and replaces columns named like object properties", async () => {
    // Parsed from JSON, as Python's messages are: "__proto__" is an ordinary key.
    const columns = JSON.parse(
      '{"t": {"type": "number", "dtype": "float64", "buffer": 0},' +
        ' "__proto__": {"type": "number", "dtype": "float64", "buffer": 1}}',
    );
    const { buffers } = snapshot();
    const model = new MockModel({
      _chart: {
        ...snapshot(),
        spec: {
          renderer: "svg",
          data: { data: { columns } },
          marks: [{ type: "line", x: "t", y: "__proto__", data: "data" }],
        },
        buffers,
      },
      _listening: [],
    });
    const [host] = mount(model);
    const update = [new Float64Array([3, 4]), new Float64Array([5, 4])];
    model.receive({ type: "append", revision: 1, table: "data", columns }, update);
    await frame();
    expect(vertices(host!)).toBe(5);
    model.receive({ type: "replace", revision: 2, table: "data", columns }, update);
    await frame();
    expect(vertices(host!)).toBe(2);
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports brushing to Python and shows it in every view", async () => {
    const model = new MockModel({
      _chart: snapshot({ interaction: { brush: "x" } }),
      _listening: [],
    });
    const [first, second] = mount(model, 2);
    // The brush loads on demand.
    await vi.dynamicImportSettled();
    press(first!, "pointerdown", 0.3);
    press(first!, "pointermove", 0.5);
    press(first!, "pointermove", 0.7);
    press(first!, "pointerup", 0.7);
    await frame();
    const [selected] = model.messages("select") as { selection: SelectionPayload }[];
    const [lo, hi] = selected!.selection.x as number[];
    expect(selected!.selection).toMatchObject({ y: null, lasso: null, time: [] });
    expect(0 < lo! && lo! < hi! && hi! < 2).toBe(true);
    expect(band(second!)!.getAttribute("visibility")).toBe("visible");
    // A selection from Python is drawn without being echoed back.
    model.receive({
      type: "select",
      revision: 1,
      selection: { x: [0.5, 1], y: null, lasso: null },
    });
    await frame();
    expect(model.messages("select")).toHaveLength(1);
    model.receive({ type: "select", revision: 2, selection: null });
    await frame();
    expect(band(first!)!.getAttribute("visibility")).toBe("hidden");
  });

  it("reports row selections numbered as Python numbers rows, and shows Python's", async () => {
    const base = snapshot({ interaction: { brush: "x" } });
    const model = new MockModel({
      _chart: {
        ...base,
        spec: { ...base.spec, rowSelection: { channel: "focus" } },
        // Five rows dropped and two replaces before this snapshot.
        rows: { data: [5, 2] },
        rowSelections: [{ table: "data", channel: "focus", selection: null }],
      } satisfies Snapshot,
      _listening: [],
    });
    const [first, second] = mount(model, 2);
    await vi.dynamicImportSettled();
    press(first!, "pointerdown", 0.3);
    press(first!, "pointermove", 0.5);
    press(first!, "pointermove", 0.7);
    press(first!, "pointerup", 0.7);
    await frame();
    const [brushed] = model.messages("rowSelection") as {
      selection: { kind: string; expression: unknown };
    }[];
    expect(brushed).toMatchObject({ table: "data", channel: "focus" });
    expect(brushed!.selection.kind).toBe("predicate");
    // Both views draw the same store: the other dims rows outside it too.
    await frame();
    expect(second!.querySelector('svg [opacity="0.25"]')).not.toBeNull();
    // Space under the keyboard cursor selects its row: identity 5 + 0, generation 2.
    const root = figure(first!) as HTMLElement;
    root.focus();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    root.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const clicked = model.messages("rowSelection").at(-1) as {
      selection: { kind: string; generation: number };
      buffers: ArrayBuffer[];
    };
    expect(clicked.selection).toEqual({ kind: "rows", generation: 2 });
    expect(Array.from(new Float64Array(clicked.buffers[0]!))).toEqual([5]);
    // Rows Python selects show without going back to Python.
    const reports = model.messages("rowSelection").length;
    model.receive(
      { type: "rows", revision: 1, table: "data", channel: "focus", selection: { kind: "rows" } },
      [new Uint32Array([1, 2])],
    );
    await frame();
    expect(model.messages("rowSelection")).toHaveLength(reports);
    model.receive({
      type: "rows",
      revision: 2,
      table: "data",
      channel: "focus",
      selection: null,
    });
    await frame();
    expect(second!.querySelector('svg [opacity="0.25"]')).toBeNull();
    // Options change without touching the binding.
    model.receive({ type: "options", revision: 3, options: { title: "Retitled" } });
    expect(figure(first!).getAttribute("aria-label")).toBe("Retitled");
    // A brush in one view is shown in the other without writing its rows again.
    const before = model.messages("rowSelection").length;
    press(second!, "pointerdown", 0.3);
    press(second!, "pointermove", 0.5);
    press(second!, "pointermove", 0.7);
    press(second!, "pointerup", 0.7);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(model.messages("rowSelection")).toHaveLength(before + 1);
    expect(band(first!)!.getAttribute("visibility")).toBe("visible");
    expect(band(second!)!.getAttribute("visibility")).toBe("visible");
  });

  it("keeps the brush a view drew last over another view's, with its rows", async () => {
    const base = snapshot({ interaction: { brush: "x" } });
    const model = new MockModel({
      _chart: {
        ...base,
        spec: { ...base.spec, rowSelection: { channel: "focus" } },
        rows: { data: [0, 0] },
        rowSelections: [{ table: "data", channel: "focus", selection: null }],
      } satisfies Snapshot,
      _listening: [],
    });
    const [first, second] = mount(model, 2);
    await vi.dynamicImportSettled();
    const drag = (host: HTMLElement, from: number, to: number) => {
      press(host, "pointerdown", from);
      press(host, "pointermove", (from + to) / 2);
      press(host, "pointermove", to);
      press(host, "pointerup", to);
    };
    drag(first!, 0.2, 0.4);
    await frame();
    // The second view's brush replaces the first's rows: the first shows it, and lets its own go.
    drag(second!, 0.6, 0.8);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(band(first!)!.getAttribute("visibility")).toBe("visible");
    expect(band(second!)!.getAttribute("visibility")).toBe("visible");
    const last = model.messages("rowSelection").at(-1) as { selection: { kind: string } | null };
    expect(last.selection?.kind).toBe("predicate");
    const selected = model.messages("select").at(-1) as { selection: SelectionPayload | null };
    expect(selected.selection?.x).not.toBeNull();
  });

  it("starts from Python's viewport, reports zooming, and follows Python", async () => {
    const model = new MockModel({
      _chart: {
        ...snapshot({ interaction: { zoom: true } }),
        viewport: { x: [0.5, 1.5], y: null, yRight: null },
      },
      _listening: [],
    });
    const [host] = mount(model);
    const labels = () => figure(host!).querySelector("svg")!.textContent;
    await frame();
    const zoomed = labels();
    // Double-clicking resets the zoom.
    figure(host!).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await frame();
    const [reset] = model.messages("viewport");
    expect(reset).toEqual({
      type: "viewport",
      viewport: { x: null, y: null, yRight: null, time: [] },
      origin: reset!.origin,
      revision: 0,
    });
    expect(labels()).not.toBe(zoomed);
    // Python's broadcast of this browser's own range changes nothing here.
    model.receive({
      type: "viewport",
      revision: 1,
      viewport: { x: [0.5, 1.5], y: null, yRight: null },
      origin: reset!.origin as string,
    });
    await frame();
    expect(labels()).not.toBe(zoomed);
    // A viewport from Python is drawn without being echoed back.
    model.receive({
      type: "viewport",
      revision: 2,
      viewport: { x: [0.5, 1.5], y: null, yRight: null },
    });
    await frame();
    expect(labels()).toBe(zoomed);
    expect(model.messages("viewport")).toHaveLength(1);
  });

  it("reports both y axes with the axes holding times, and shows Python's whole viewport", async () => {
    const base = snapshot({ interaction: { zoom: "xy" } });
    const spec = {
      ...base.spec,
      data: {
        data: {
          columns: {
            t: { type: "time" as const, dtype: "float64" as const, buffer: 0 },
            v: number(1),
          },
        },
      },
      marks: [
        { type: "line" as const, x: "t", y: "v", data: "data" },
        { type: "line" as const, x: "t", y: "v", data: "data", axis: "right" as const },
      ],
    };
    const model = new MockModel({ _chart: { ...base, spec }, _listening: [] });
    const [host] = mount(model);
    const rect = figure(host!).getBoundingClientRect();
    figure(host!).dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -100,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
    const [zoomed] = model.messages("viewport") as { viewport: ViewportPayload }[];
    const { x, y, yRight, time } = zoomed!.viewport;
    expect(time).toEqual(["x"]);
    expect([x, y, yRight].every((ends) => ends !== null && ends[0] < ends[1])).toBe(true);
    // Python's viewport replaces the whole view: the right axis no longer zoomed.
    const ticks = () =>
      [...figure(host!).querySelectorAll("svg text")].map((t) => t.textContent).join(" ");
    model.receive({
      type: "viewport",
      revision: 1,
      viewport: { x: [0, 2], y: [0, 10], yRight: null },
    });
    await frame();
    expect(ticks()).toContain("10");
    expect(model.messages("viewport")).toHaveLength(1);
  });

  it("reports y and lasso selections, and lets a lasso go when its categories move", async () => {
    const bars = (dictionary: string[], brush: string): Snapshot => ({
      ...snapshot(),
      spec: {
        width: 400,
        height: 200,
        renderer: "svg",
        interaction: { brush: brush as "y" },
        data: {
          data: { columns: { c: { type: "category", codes: 0, dictionary }, v: number(1) } },
        },
        marks: [{ type: "bar", x: "v", y: "c", data: "data" }],
      },
      buffers: [
        new DataView(new Int32Array([0, 1]).buffer),
        new DataView(new Float64Array([1, 2]).buffer),
      ],
    });
    const model = new MockModel({ _chart: bars(["a", "b"], "y"), _listening: [] });
    const [host] = mount(model);
    model.receive({
      type: "select",
      revision: 1,
      selection: { x: null, y: ["b", "b"], lasso: null },
    });
    await frame();
    expect(band(host!)!.getAttribute("visibility")).toBe("visible");
    expect(model.messages("select")).toEqual([]);
    // A lasso's outline is band positions, kept while the categories stay.
    const outline: [number, number][] = [
      [0, 0],
      [2, 0],
      [2, 1],
    ];
    // As a browser reports it: with the categories its outline is over.
    const lasso = {
      x: [0, 2] as [number, number],
      y: ["a", "b"] as [string, string],
      lasso: outline,
      categories: [null, ["a", "b"]] as [null, string[]],
    };
    model.receive({ type: "select", revision: 2, selection: lasso });
    const replace = (revision: number, dictionary: string[]) =>
      model.receive(
        {
          type: "replace",
          revision,
          table: "data",
          columns: { c: { type: "category", codes: 0, dictionary }, v: number(1) },
        },
        [new Int32Array([0, 1]), new Float64Array([1, 2])],
      );
    replace(3, ["a", "b"]);
    await frame();
    expect(model.messages("select")).toEqual([]);
    replace(4, ["b", "a"]);
    await frame();
    expect(model.messages("select").map(({ selection }) => selection)).toEqual([null]);
    // Drawn by the pointer, a lasso reports the categories it is over.
    model.receive({ type: "select", revision: 5, selection: null });
    const rect = figure(host!).getBoundingClientRect();
    const at = (type: string, x: number, y: number) =>
      figure(host!).dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
          pointerId: 1,
        }),
      );
    model.receive({
      type: "options",
      revision: 6,
      options: { interaction: { brush: "lasso" } },
    });
    at("pointerdown", 0.3, 0.3);
    for (const [x, y] of [
      [0.6, 0.3],
      [0.6, 0.8],
      [0.3, 0.8],
    ] as const)
      at("pointermove", x, y);
    at("pointerup", 0.3, 0.8);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const drawn = model.messages("select").at(-1)!.selection as SelectionPayload;
    expect(drawn.categories).toEqual([null, ["b", "a"]]);
    expect(drawn.lasso!.length).toBeGreaterThanOrEqual(4);
  });

  it("lets a lasso go that a remounted output finds over moved categories", async () => {
    // Python's lasso names no categories: the first chart to show it learns
    // them and tells Python, so later outputs and browsers check them too.
    for (const categories of [[["a", "b"], null] as [string[], null], undefined]) {
      for (const cleanup of cleanups.splice(0)) cleanup();
      const model = new MockModel({ _chart: lassoed(categories), _listening: [] });
      const widget = widgetModule();
      cleanups.push(widget.initialize({ model }));
      const host = document.createElement("div");
      host.style.width = "400px";
      document.body.append(host);
      hosts.push(host);
      const unmount = widget.render({ model, el: host });
      // The brush that draws the restored lasso loads on demand.
      await vi.dynamicImportSettled();
      await frame();
      expect(band(host)!.getAttribute("visibility")).toBe("visible");
      const learned = model.messages("select").map(({ selection }) => selection);
      expect(learned).toEqual(
        categories ? [] : [expect.objectContaining({ categories: [["a", "b"], null] })],
      );
      unmount();
      // The categories reorder while no output shows the chart.
      model.receive(
        {
          type: "replace",
          revision: 1,
          table: "data",
          columns: { c: { type: "category", codes: 0, dictionary: ["b", "a"] }, v: number(1) },
        },
        [new Int32Array([0, 1]), new Float64Array([1, 2])],
      );
      cleanups.push(widget.render({ model, el: host }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(band(host)?.getAttribute("visibility") ?? "hidden").toBe("hidden");
      expect(model.messages("select").at(-1)!.selection).toBeNull();
    }
  });

  function lassoed(categories: [string[], null] | undefined): Snapshot {
    return {
      ...snapshot(),
      spec: {
        width: 400,
        height: 200,
        renderer: "svg",
        interaction: { brush: "lasso" },
        data: {
          data: {
            columns: { c: { type: "category", codes: 0, dictionary: ["a", "b"] }, v: number(1) },
          },
        },
        marks: [{ type: "bar", x: "c", y: "v", data: "data" }],
      },
      buffers: [
        new DataView(new Int32Array([0, 1]).buffer),
        new DataView(new Float64Array([1, 2]).buffer),
      ],
      selection: {
        x: ["a", "b"],
        y: [0, 1],
        lasso: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        ...(categories && { categories }),
      },
    };
  }

  it("drops zooming not yet reported when Python sets the viewport", async () => {
    // The throttle's timer runs only when the test says so; frames still run.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const model = new MockModel({
      _chart: snapshot({ interaction: { zoom: true } }),
      _listening: [],
    });
    const [host] = mount(model);
    const wheel = (deltaY: number) => {
      const rect = figure(host!).getBoundingClientRect();
      figure(host!).dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    };
    wheel(-100);
    // Each wheel zooms from the scale last drawn.
    await frame();
    wheel(-100);
    // The first zoom is sent at once; the second waits for the throttle.
    expect(model.messages("viewport")).toHaveLength(1);
    model.receive({
      type: "viewport",
      revision: 1,
      viewport: { x: [0.25, 0.75], y: null, yRight: null },
    });
    vi.advanceTimersByTime(200);
    expect(model.messages("viewport")).toHaveLength(1);
  });

  it("keeps a category selection on its labels when the data changes", async () => {
    const bars = (dictionary: string[]): Snapshot => ({
      ...snapshot(),
      spec: {
        width: 400,
        height: 200,
        renderer: "svg",
        interaction: { brush: "x" },
        data: {
          data: {
            columns: {
              c: { type: "category", codes: 0, dictionary },
              v: number(1),
            },
          },
        },
        marks: [{ type: "bar", x: "c", y: "v", data: "data" }],
      },
      buffers: [
        new DataView(new Int32Array([0, 1]).buffer),
        new DataView(new Float64Array([1, 2]).buffer),
      ],
    });
    const model = new MockModel({ _chart: bars(["a", "b"]), _listening: [] });
    const [host] = mount(model);
    const replace = (revision: number, dictionary: string[]) =>
      model.receive(
        {
          type: "replace",
          revision,
          table: "data",
          columns: { c: { type: "category", codes: 0, dictionary }, v: number(1) },
        },
        [new Int32Array([0, 1]), new Float64Array([1, 2])],
      );
    // The outline's first point: its left edge.
    const left = () =>
      Number(
        band(host!)!
          .getAttribute("d")!
          .match(/-?[\d.]+/)![0],
      );
    model.receive({
      type: "select",
      revision: 1,
      selection: { x: ["a", "a"], y: null, lasso: null },
    });
    // The brush that draws the selection loads on demand.
    await vi.dynamicImportSettled();
    await frame();
    const before = left();
    // "a" moves to the second band: the brush follows it.
    replace(2, ["b", "a"]);
    await frame();
    expect(left()).toBeGreaterThan(before);
    expect(model.messages("select")).toEqual([]);
    // Data without the selected labels clears the selection, and Python hears
    // so; labels of data not drawn yet are found in it.
    replace(3, ["c", "d"]);
    model.receive({
      type: "select",
      revision: 4,
      selection: { x: ["d", "d"], y: null, lasso: null },
    });
    await frame();
    expect(band(host!)!.getAttribute("visibility")).toBe("visible");
    expect(left()).toBeGreaterThan(before);
    replace(5, ["e", "f"]);
    await frame();
    expect(band(host!)!.getAttribute("visibility")).toBe("hidden");
    // The second report waits out the throttle.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Python drops the first report: it was made before Python selected "d".
    const reports = model
      .messages("select")
      .map(({ selection, revision }) => [selection, revision]);
    expect(reports).toEqual([
      [null, 3],
      [null, 5],
    ]);
  });

  it("sends hover and click only when Python listens", async () => {
    const model = new MockModel({ _chart: snapshot(), _listening: [] });
    const [host] = mount(model);
    press(host!, "pointermove", 0.2);
    await frame();
    press(host!, "pointerdown", 0.2);
    press(host!, "pointerup", 0.2);
    expect(model.messages("hover")).toEqual([]);
    expect(model.messages("click")).toEqual([]);
    model.set("_listening", ["hover", "click"]);
    press(host!, "pointermove", 0.5);
    await frame();
    press(host!, "pointerdown", 0.5);
    press(host!, "pointerup", 0.5);
    const inspection = {
      axis: "x",
      value: 1,
      time: false,
      label: "1",
      points: [{ mark: 0, markId: null, key: '[0,"v"]', label: "v", row: 1, value: 3, text: "3" }],
    };
    expect(model.messages("hover")).toEqual([{ type: "hover", inspection }]);
    expect(model.messages("click")).toEqual([{ type: "click", inspection }]);
  });

  it("sends a 3D chart's camera and its points' values when Python listens", async () => {
    const chart = snapshot();
    chart.spec.marks = [{ type: "point3d", x: "t", y: "v", z: "v", data: "data" }];
    const model = new MockModel({ _chart: chart, _listening: ["camera", "click"] });
    const [host] = mount(model);
    const rect = host!.getBoundingClientRect();
    const drag = (type: string, x: number) =>
      host!.querySelector<HTMLElement>("[role=figure]")!.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: rect.left + x,
          clientY: rect.top + 100,
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    drag("pointerdown", 200);
    drag("pointermove", 220);
    drag("pointerup", 220);
    await frame();
    const [message] = model.messages("camera") as { camera: { azimuth: number } }[];
    expect(message!.camera.azimuth).toBeCloseTo(-60 - 20 * 0.4);
  });
});
