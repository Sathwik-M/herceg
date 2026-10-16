// Layouts of panels in the browser: the linked crosshair as the layout
// changes, insets under the pointer and the wheel, and panels' legends.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { legend } from "../../src/guides/options.ts";
import { columns, inset, panel, rows } from "../../src/layout.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { panels } from "../../src/model/panels.ts";
import { MOUSE, modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:800px;height:500px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function pointer(chart: Chart, type: string, x: number, y: number) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: MOUSE,
    }),
  );
}

function wheel(chart: Chart, x: number, y: number) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -200,
      clientX: rect.left + x,
      clientY: rect.top + y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const visibleLines = (chart: Chart) =>
  [...chart.root.querySelectorAll("svg line")].filter(
    (l) => l.getAttribute("visibility") === "visible",
  );

const data = table({
  t: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  v: [3, 5, 4, 8, 6, 7, 9, 4, 5, 6, 1, 2, 2, 3, 2, 4, 3, 5, 4, 3],
  region: [...Array.from({ length: 10 }, () => "eu"), ...Array.from({ length: 10 }, () => "us")],
});
const marks = [
  line(data, { x: "t", y: "v", color: "region", panel: "a" }),
  line(data, { x: "t", y: "v", color: "region", panel: "b" }),
];

describe("layouts in the browser", () => {
  it("draw the crosshair across panels sharing x, also once the layout changes", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks,
      x: { scope: "chart" },
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    const check = async () => {
      const [a, b] = modelOf(chart).panels();
      pointer(chart, "pointermove", a!.x.map(4), a!.plot.y + a!.plot.height / 2);
      await frame();
      const lines = visibleLines(chart);
      // A vertical line in each panel, at the value's place on its own plot.
      const verticals = lines.filter((l) => l.getAttribute("x1") === l.getAttribute("x2"));
      expect(verticals.map((l) => Number(l.getAttribute("y1"))).sort((p, q) => p - q)).toEqual(
        [a!.plot.y, b!.plot.y].sort((p, q) => p - q),
      );
      for (const [l, p] of verticals.map((l, i) => [l, [a, b][i]!] as const))
        expect(Number(l.getAttribute("x1"))).toBeCloseTo(Math.round(p.x.map(4)) + 0.5, 3);
    };
    await check();
    chart.update({ panels: panels(rows([1, 1], [panel("a"), panel("b")])) });
    chart.render();
    pointer(chart, "pointerleave", 0, 0);
    await check();
    chart.destroy();
  });

  it("find insets under the pointer and zoom them alone, keeping the parent's crosshair off them", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      interaction: { zoom: true },
      marks: [
        line(data, { x: "t", y: "v", color: "region", panel: "main" }),
        line(data, { x: "t", y: "v", color: "region", panel: "detail" }),
      ],
      panels: panels(
        panel("main", [
          inset({ id: "detail", x: { domain: [2, 4] } }, { width: { fraction: 0.4 } }),
        ]),
      ),
    });
    const [main, detail] = modelOf(chart).panels();
    const center = [
      detail!.plot.x + detail!.plot.width / 2,
      detail!.plot.y + detail!.plot.height / 2,
    ] as const;
    // The wheel over the inset zooms its scale, not its parent's.
    wheel(chart, ...center);
    chart.render();
    expect(chart.getViewport({ panel: "detail" }).x).not.toBeNull();
    expect(chart.getViewport({ panel: "main" }).x).toBeNull();
    // The parent's crosshair at an x under the inset is cut where the inset is.
    pointer(chart, "pointermove", center[0], main!.plot.y + main!.plot.height - 4);
    await frame();
    const [cross] = visibleLines(chart).filter(
      (l) => l.getAttribute("x1") === l.getAttribute("x2"),
    );
    expect(cross?.getAttribute("clip-path")).toMatch(/url\(#.*-cut-/);
    chart.destroy();
  });

  it("keep a crosshair's clip only for panels with insets over them", async () => {
    const chart = createChart(host, { locale: "en-US", marks: [] });
    const cuts = () => chart.root.querySelectorAll('clipPath[id*="-cut-"]').length;
    for (let k = 0; k < 4; k++) {
      const [main, detail] = [`main${k}`, `detail${k}`];
      chart.update({
        marks: [
          line(data, { x: "t", y: "v", panel: main }),
          line(data, { x: "t", y: "v", panel: detail }),
        ],
        panels: panels(panel(main, [inset(detail, { place: { inside: "top-right" } })])),
      });
      chart.render();
      const [plot] = modelOf(chart).panels();
      pointer(chart, "pointermove", plot!.plot.x + 10, plot!.plot.y + plot!.plot.height - 10);
      await frame();
      expect(cuts()).toBe(1);
    }
    chart.destroy();
  });

  it("report, reset, and keep to themselves an inset's x scale beside the chart's", async () => {
    const insetMarks = [
      line(data, { x: "t", y: "v", panel: "main" }),
      line(table({ t: [100, 150, 200], v: [1, 2, 3] }), { x: "t", y: "v", panel: "detail" }),
    ];
    const layout = () => panels(panel("main", [inset("detail", { width: { fraction: 0.5 } })]));
    const chart = createChart(host, {
      locale: "en-US",
      interaction: { zoom: true, brush: "x", sync: { selection: "insets" } },
      x: { scope: "chart" },
      marks: insetMarks,
      panels: layout(),
    });
    const other = document.createElement("div");
    other.style.cssText = "width:400px;height:300px";
    document.body.append(other);
    const synced = createChart(other, {
      locale: "en-US",
      interaction: { brush: "x", sync: { selection: "insets" } },
      marks: [line(data, { x: "t", y: "v" })],
    });
    await chart.loading;
    chart.render();
    const views: unknown[] = [];
    chart.on("viewport", (event) => views.push(event));
    chart.setViewport([120, 130], { panel: "detail" });
    expect(views).toEqual([expect.objectContaining({ x: [120, 130], panels: ["detail"] })]);
    chart.setViewport([2, 4]);
    chart.render();
    // A double click on the inset resets its view alone.
    const detail = chart.getPanels().find(({ key }) => key === "detail")!.plot;
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: rect.left + detail.x + detail.width / 2,
        clientY: rect.top + detail.y + detail.height / 2,
      }),
    );
    await frame();
    expect(chart.getViewport({ panel: "detail" }).x).toBeNull();
    expect(chart.getViewport().x).toEqual([2, 4]);
    // A selection of the inset's scale is not the synced chart's.
    chart.select({ x: [120, 130], y: null, lasso: null }, { panel: "detail" });
    await frame();
    expect(synced.selection).toBeNull();
    chart.select({ x: [2, 3], y: null, lasso: null }, { panel: "main" });
    await frame();
    expect(synced.selection?.x).toEqual([2, 3]);
    // Giving every panel an x scale of its own while limits move the inset's view.
    chart.setViewport([120, 130], { panel: "detail" });
    expect(() =>
      chart.update({
        x: { scope: "panel" },
        interaction: { zoom: true, brush: "x", limits: { x: { extent: [0, 125] } } },
      }),
    ).not.toThrow();
    synced.destroy();
    other.remove();
    chart.destroy();
  });

  it("keep an inset's view from a synced chart's when it has the only axes", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      interaction: { zoom: true, sync: "insets-only" },
      x: { scope: "chart" },
      marks: [
        pie(data, { category: "region", value: "v", panel: "share" }),
        line(data, { x: "t", y: "v", panel: "detail" }),
      ],
      panels: panels(panel("share", [inset("detail", { width: { fraction: 0.5 } })])),
    });
    const other = document.createElement("div");
    other.style.cssText = "width:400px;height:300px";
    document.body.append(other);
    const synced = createChart(other, {
      locale: "en-US",
      interaction: { zoom: true, sync: "insets-only" },
      marks: [line(data, { x: "t", y: "v" })],
    });
    await chart.loading;
    chart.render();
    chart.setViewport([1, 2], { panel: "detail" });
    // The other chart zooms and resets its view, which this chart has none of.
    synced.setViewport([0, 5]);
    synced.setViewport(null);
    await frame();
    expect(chart.getViewport({ panel: "detail" }).x).toEqual([1, 2]);
    synced.destroy();
    other.remove();
    chart.destroy();
  });

  it("bound an inset's view by its own data, not its parent's", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      interaction: { zoom: true, limits: { x: { edge: true } } },
      x: { scope: "chart" },
      marks: [
        line(data, { x: "t", y: "v", panel: "main" }),
        line(table({ t: [100, 150, 200], v: [1, 2, 3] }), { x: "t", y: "v", panel: "detail" }),
      ],
      panels: panels(panel("main", [inset("detail", { width: { fraction: 0.5 } })])),
    });
    await chart.loading;
    const edges: { panels?: readonly string[] | undefined }[] = [];
    chart.on("edge", (event) => edges.push(event));
    chart.setViewport([120, 130], { panel: "detail" });
    chart.render();
    await frame();
    expect(edges.filter(({ panels }) => panels?.includes("detail"))).toEqual([]);
    chart.destroy();
  });

  it.each(["canvas", "svg"] as const)(
    "draw an inset over its parent's data, on %s",
    async (renderer) => {
      // A flat line through the inset's box, in the parent only.
      const flat = table({ t: [0, 10], v: [5, 5] });
      const chart = createChart(host, {
        renderer,
        theme: { tokens: { background: "#ffffff" } },
        marks: [
          line(flat, { x: "t", y: "v", panel: "main", stroke: "#ff0000", strokeWidth: 6 }),
          line(table({ t: [0, 1], v: [0, 1] }), {
            x: "t",
            y: "v",
            panel: "detail",
            stroke: "#0000ff",
          }),
        ],
        y: { domain: [0, 10] },
        panels: panels(
          panel("main", [
            inset("detail", {
              place: { inside: "right" },
              width: { fraction: 0.4 },
              height: { fraction: 0.5 },
            }),
          ]),
        ),
      });
      await chart.loading;
      chart.render();
      await frame();
      const [main, detail] = modelOf(chart).panels();
      const y = main!.y.map(5);
      const outside = { x: main!.plot.x + 20, y };
      const under = { x: detail!.plot.x + detail!.plot.width / 2, y };
      if (renderer === "canvas") {
        // Paint is read back from the chart's canvas.
        const drawn = chart.root.querySelector("canvas")!;
        const ratio = drawn.width / chart.root.clientWidth;
        const red = ({ x, y }: { x: number; y: number }) => {
          const [r, g, b] = drawn
            .getContext("2d")!
            .getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
          return r! > 200 && g! < 80 && b! < 80;
        };
        expect(red(outside)).toBe(true);
        // Under the inset, its box covers the parent's line.
        expect(red(under)).toBe(false);
      } else {
        // The parent's data is cut to the plot its inset leaves, and the
        // inset's box is drawn after it.
        const svg = chart.root.querySelector("svg")!;
        const layer = [...svg.children];
        const path = svg.querySelector('path[stroke="#ff0000"]')!;
        const data = layer.find((group) => group.contains(path))!;
        const clip = svg.querySelector(`[id="${data.getAttribute("clip-path")!.slice(5, -1)}"]`)!;
        const holds = ({ x, y }: { x: number; y: number }) =>
          [...clip.querySelectorAll("rect")].some((rect) => {
            const [rx, ry, w, h] = ["x", "y", "width", "height"].map((a) =>
              Number(rect.getAttribute(a)),
            );
            return x >= rx! && x <= rx! + w! && y >= ry! && y <= ry! + h!;
          });
        expect(holds(outside)).toBe(true);
        expect(holds(under)).toBe(false);
        const after = layer.slice(layer.indexOf(data) + 1);
        expect(after.some((group) => group.querySelector('rect[fill="#ffffff"]'))).toBe(true);
      }
      chart.destroy();
    },
  );

  it.each(["chart", false] as const)(
    "keep a parent's data with clip: %s off a transparent inset, on canvas",
    async (clip) => {
      const chart = createChart(host, {
        renderer: "canvas",
        theme: { tokens: { background: "transparent" } },
        marks: [
          line(table({ t: [0, 10], v: [5, 5] }), {
            x: "t",
            y: "v",
            panel: "main",
            stroke: "#ff0000",
            strokeWidth: 6,
            clip,
          }),
          line(table({ t: [0, 1], v: [0, 1] }), { x: "t", y: "v", panel: "detail" }),
        ],
        y: { domain: [0, 10] },
        panels: panels(
          panel("main", [
            inset("detail", {
              place: { inside: "right" },
              width: { fraction: 0.4 },
              height: { fraction: 0.5 },
            }),
          ]),
        ),
      });
      await chart.loading;
      chart.render();
      await frame();
      const [main, detail] = modelOf(chart).panels();
      const y = main!.y.map(5);
      const drawn = chart.root.querySelector("canvas")!;
      const ratio = drawn.width / chart.root.clientWidth;
      const red = (x: number) => {
        const [r, g, b, a] = drawn
          .getContext("2d")!
          .getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
        return r! > 200 && g! < 80 && b! < 80 && a! > 200;
      };
      expect(red(main!.plot.x + 20)).toBe(true);
      expect(red(detail!.plot.x + detail!.plot.width / 2)).toBe(false);
      chart.destroy();
    },
  );

  it("drop an inset's box when its panel moves to a cell of its own", async () => {
    const chart = createChart(host, {
      renderer: "svg",
      marks: [
        line(data, { x: "t", y: "v", panel: "main" }),
        line(data, { x: "t", y: "v", panel: "detail" }),
      ],
      panels: panels(panel("main", [inset("detail")])),
    });
    // The layer's groups: the grid under the data, each panel's data and
    // annotations, an inset's box, then the axes and the overlay.
    const groups = () => chart.root.querySelector("svg")!.querySelectorAll(":scope > g").length;
    expect(groups()).toBe(1 + 2 * 2 + 1 + 2);
    chart.update({ panels: panels(columns([1, 1], [panel("main"), panel("detail")])) });
    chart.render();
    expect(groups()).toBe(1 + 2 * 2 + 2);
    chart.destroy();
  });

  it("draw a selection on a panel its inset covers whole", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      interaction: { brush: "x" },
      marks: [
        line(data, { x: "t", y: "v", panel: "main" }),
        line(data, { x: "t", y: "v", panel: "detail" }),
      ],
      panels: panels(
        panel("main", [
          inset("detail", {
            place: { inside: "top-left", inset: 0 },
            width: { fraction: 1 },
            height: { fraction: 1 },
          }),
        ]),
      ),
    });
    await chart.loading;
    for (const x of [[1, 2] as const, [2, 3] as const]) {
      chart.select({ x, y: null, lasso: null }, { panel: "main" });
      chart.render();
      await frame();
    }
    expect(chart.selectionPanels).toEqual(["main"]);
    chart.destroy();
  });

  it("give the pointer to an inset over a pie, and to the pie around it", async () => {
    const shares = table({ k: ["a", "b"], n: [3, 1] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [
        pie(shares, { category: "k", value: "n", panel: "share" }),
        line(data, { x: "t", y: "v", panel: "trend" }),
      ],
      panels: panels(panel("share", [inset("trend", { place: { inside: "bottom-right" } })])),
    });
    await chart.loading;
    const heard: (string | undefined)[] = [];
    chart.on("hover", ({ inspection }) => heard.push(inspection?.panel));
    const trend = chart.getPanels().find(({ key }) => key === "trend")!;
    pointer(
      chart,
      "pointermove",
      trend.plot.x + trend.plot.width / 2,
      trend.plot.y + trend.plot.height / 2,
    );
    await frame();
    expect(heard.at(-1)).toBe("trend");
    // Over the pie around it, the slice's outline is cut around the inset.
    const share = chart.getPanels().find(({ key }) => key === "share")!;
    pointer(
      chart,
      "pointermove",
      share.plot.x + share.plot.width / 2 - 10,
      share.plot.y + share.plot.height / 2 - 10,
    );
    await frame();
    expect(heard.at(-1)).toBe("share");
    const outline = [...chart.root.querySelectorAll("svg path")].find(
      (path) =>
        path.getAttribute("visibility") === "visible" && path.getAttribute("fill") === "none",
    );
    expect(outline?.getAttribute("clip-path")).toMatch(/-cut-/);
    chart.destroy();
  });

  it("toggle a series in a panel's legend there only, and show the chart's entry as mixed", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks,
      guides: [legend({ panel: "a" }), legend({})],
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const heard: unknown[] = [];
    chart.on("visibility", (event) => heard.push(event));
    const buttons = () => [...chart.root.querySelectorAll("button")];
    // The chart's legend at its top, then the panel's above the panel.
    expect(buttons().map((b) => b.textContent)).toEqual(["eu", "us", "eu", "us"]);
    buttons()[2]!.click();
    chart.render();
    expect(chart.getHiddenKeys({ panel: "a" })).toHaveLength(1);
    expect(chart.getHiddenKeys({ panel: "b" })).toEqual([]);
    expect(chart.getHiddenKeys()).toEqual([]);
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "mixed",
      "true",
      "false",
      "true",
    ]);
    // A mixed entry's click shows its series everywhere, as its title says.
    expect(buttons()[0]!.title).toBe("Show eu");
    expect(heard).toHaveLength(1);
    // The chart's entry shows it everywhere again, letting go of the panel's setting.
    buttons()[0]!.click();
    chart.render();
    expect(chart.getHiddenKeys({ panel: "a" })).toEqual([]);
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "true",
      "true",
      "true",
    ]);
    chart.destroy();
  });

  it("press a panel's derived entries as its own entries left them, and toggle them back", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [
        line(data, { x: "t", y: "v", color: "region", panel: "a", id: "first" }),
        line(data, { x: "t", y: "v", color: "region", panel: "b" }),
      ],
      guides: [
        legend({ panel: "a" }),
        legend({
          panel: "a",
          entries: [{ key: "all", label: "All", targets: [{ mark: "first" }] }],
        }),
      ],
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const button = (label: string, k = 0) =>
      [...chart.root.querySelectorAll("button")].filter((b) => b.textContent === label)[k]!;
    // The custom entry hides the mark's series in panel a.
    button("All").click();
    chart.render();
    expect(button("All").getAttribute("aria-pressed")).toBe("false");
    // The panel's derived entries show them hidden (the chart's, drawn in b
    // too, mixed), and a click shows one again.
    expect(button("eu", 0).getAttribute("aria-pressed")).toBe("mixed");
    expect(button("eu", 1).getAttribute("aria-pressed")).toBe("false");
    button("eu", 1).click();
    chart.render();
    expect(button("eu", 1).getAttribute("aria-pressed")).toBe("true");
    expect(chart.getHiddenKeys({ panel: "a" })).toHaveLength(1);
    chart.destroy();
  });

  it("press the chart's own entry as a panel's own entry left a mark its legends leave out", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks: [
        line(data, { x: "t", y: "v", color: "region", panel: "a", id: "quiet", legend: false }),
        line(data, { x: "t", y: "v", color: "region", panel: "b" }),
      ],
      guides: [
        legend({
          panel: "a",
          entries: [{ key: "a", label: "In a", targets: [{ mark: "quiet" }] }],
        }),
        legend({ entries: [{ key: "all", label: "Quiet", targets: [{ mark: "quiet" }] }] }),
      ],
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const button = (label: string) =>
      [...chart.root.querySelectorAll("button")].find((b) => b.textContent === label)!;
    button("In a").click();
    chart.render();
    // Hidden in a, the only panel drawing it, the chart's entry is pressed out
    // and shows it at a click.
    expect(button("Quiet").getAttribute("aria-pressed")).toBe("false");
    expect(button("Quiet").title).toBe("Show Quiet");
    button("Quiet").click();
    chart.render();
    expect(button("In a").getAttribute("aria-pressed")).toBe("true");
    expect(chart.getHiddenKeys({ panel: "a" })).toEqual([]);
    chart.destroy();
  });

  it("set a panel's visibility by an entry's key over what its legend set, once, and say what is hidden there", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks,
      guides: [legend({ panel: "b" }), legend({})],
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const [eu] = chart.getLegend();
    const own = () => [...chart.root.querySelectorAll("button")].slice(2);
    // Hidden in b by its legend (its series there), then shown there by what they stand for.
    own()[0]!.click();
    chart.render();
    expect(chart.getHiddenKeys({ panel: "b" })).not.toEqual([]);
    chart.setVisibility(eu!.key, true, { panel: "b" });
    chart.render();
    expect(chart.getHiddenKeys({ panel: "b" })).toEqual([]);
    expect(own()[0]!.getAttribute("aria-pressed")).toBe("true");
    // Hidden in the chart and shown in b by its legend: not hidden in b.
    chart.setVisibility(eu!.key, false);
    chart.render();
    own()[0]!.click();
    chart.render();
    expect(chart.getHiddenKeys({ panel: "b" })).toEqual([]);
    expect(chart.getHiddenKeys({ panel: "a" })).toContain(eu!.key);
    // The same setting twice is one change.
    const heard: unknown[] = [];
    chart.on("visibility", (event) => heard.push(event));
    chart.setVisibility(eu!.key, false, { panel: "b" });
    chart.setVisibility(eu!.key, false, { panel: "b" });
    expect(heard).toHaveLength(1);
    chart.destroy();
  });

  it("hide at one click an entry hidden in the chart and shown in every panel", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks,
      legend: true,
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const [eu] = chart.getLegend();
    chart.setVisibility(eu!.key, false);
    for (const where of ["a", "b"]) chart.setVisibility(eu!.key, true, { panel: where });
    chart.render();
    const button = chart.root.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    chart.render();
    expect(chart.root.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
    for (const where of ["a", "b"])
      expect(chart.getHiddenKeys({ panel: where }).length).toBeGreaterThan(0);
    chart.destroy();
  });

  it("let go of what panels hid once their marks or panels are gone", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      marks,
      panels: panels(columns([1, 1], [panel("a"), panel("b")])),
    });
    await chart.loading;
    chart.render();
    const [eu] = chart.getLegend();
    chart.setVisibility(eu!.key, false, { panel: "a" });
    expect(chart.getHiddenKeys({ panel: "a" })).not.toEqual([]);
    chart.update({ marks: [] });
    chart.update({ marks });
    chart.render();
    expect(chart.getHiddenKeys({ panel: "a" })).toEqual([]);
    // A panel the layout no longer has keeps nothing either.
    chart.setVisibility(eu!.key, false, { panel: "b" });
    const heard: unknown[] = [];
    chart.on("visibility", (event) => heard.push(event));
    chart.update({
      marks: [marks[0]!],
      panels: panels(columns([1], [panel("a")])),
    });
    expect(heard).toEqual([{ hiddenKeys: [] }]);
    chart.destroy();
  });
});
