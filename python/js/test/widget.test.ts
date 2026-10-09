// The notebook widget's front end against a stand-in for anywidget's model:
// what Python sends is applied to the chart, and interaction reaches Python.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import widgetModule, { type Model, type Snapshot, type Update } from "../widget.ts";

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

  send(content: object) {
    this.sent.push(content as Record<string, unknown>);
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

  it("changes options of charts whose specs need a later version", () => {
    const resolved = snapshot({ version: 3, resolve: { x: "shared", y: "shared" } });
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
    press(first!, "pointerdown", 0.3);
    press(first!, "pointermove", 0.5);
    press(first!, "pointermove", 0.7);
    press(first!, "pointerup", 0.7);
    await frame();
    const [selected] = model.messages("select") as { range: { x: number[]; time: boolean } }[];
    const [lo, hi] = selected!.range.x;
    expect(selected!.range.time).toBe(false);
    expect(0 < lo! && lo! < hi! && hi! < 2).toBe(true);
    expect(band(second!)!.getAttribute("visibility")).toBe("visible");
    // A selection from Python is drawn without being echoed back.
    model.receive({ type: "select", revision: 1, x: [0.5, 1] });
    await frame();
    expect(model.messages("select")).toHaveLength(1);
    model.receive({ type: "select", revision: 2, x: null });
    await frame();
    expect(band(first!)!.getAttribute("visibility")).toBe("hidden");
  });

  it("starts from Python's viewport, reports zooming, and follows Python", async () => {
    const model = new MockModel({
      _chart: { ...snapshot({ interaction: { zoom: true } }), viewport: { x: [0.5, 1.5] } },
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
    expect(reset).toEqual({ type: "viewport", range: null, origin: reset!.origin, revision: 0 });
    expect(labels()).not.toBe(zoomed);
    // Python's broadcast of this browser's own range changes nothing here.
    model.receive({
      type: "viewport",
      revision: 1,
      x: [0.5, 1.5],
      origin: reset!.origin as string,
    });
    await frame();
    expect(labels()).not.toBe(zoomed);
    // A viewport from Python is drawn without being echoed back.
    model.receive({ type: "viewport", revision: 2, x: [0.5, 1.5] });
    await frame();
    expect(labels()).toBe(zoomed);
    expect(model.messages("viewport")).toHaveLength(1);
  });

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
    model.receive({ type: "viewport", revision: 1, x: [0.25, 0.75] });
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
    model.receive({ type: "select", revision: 1, x: ["a", "a"] });
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
    model.receive({ type: "select", revision: 4, x: ["d", "d"] });
    await frame();
    expect(band(host!)!.getAttribute("visibility")).toBe("visible");
    expect(left()).toBeGreaterThan(before);
    replace(5, ["e", "f"]);
    await frame();
    expect(band(host!)!.getAttribute("visibility")).toBe("hidden");
    // The second report waits out the throttle.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Python drops the first report: it was made before Python selected "d".
    const reports = model.messages("select").map(({ range, revision }) => [range, revision]);
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
      points: [{ series: "v", value: 3, text: "3" }],
    };
    expect(model.messages("hover")).toEqual([{ type: "hover", inspection }]);
    expect(model.messages("click")).toEqual([{ type: "click", inspection }]);
  });
});
