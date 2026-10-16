// Trees, maps, and networks in facet panels and subplots, navigated with
// real pointer and keyboard input: facet panels move together, each subplot
// alone, and the pointer and keys act in the panel they are in.

import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import type { ChartEvents } from "../../src/dom/events.ts";
import { grid } from "../../src/layout.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { facet } from "../../src/model/facet.ts";
import type { ItemInspection } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { accessibilityTree, MOUSE, modelOf, pageOrigin, realMouse } from "./helpers.ts";

const mounted: Chart[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const chart of mounted.splice(0)) chart.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

async function mount(options: ChartOptions): Promise<Chart> {
  const host = document.createElement("div");
  // Within the test frame's 414 pixels: input beyond them lands nowhere.
  host.style.cssText = "width:400px;height:300px";
  document.body.append(host);
  hosts.push(host);
  const chart = createChart(host, { locale: "en-US", renderer: "svg", ...options });
  mounted.push(chart);
  // Controls load the first time a chart draws a mark that has them.
  await chart.loading;
  return chart;
}

async function mouse(
  chart: Chart,
  type: "press" | "move" | "release" | "wheel",
  x: number,
  y: number,
  deltaY = 0,
) {
  const at = pageOrigin(chart.root);
  // The wheel zooms with Control held.
  const ctrl = type === "wheel";
  await realMouse({ type, x: at.x + x, y: at.y + y, clickCount: 1, deltaY, shift: false, ctrl });
}

async function click(chart: Chart, x: number, y: number) {
  await mouse(chart, "move", x, y);
  await mouse(chart, "press", x, y);
  await mouse(chart, "release", x, y);
}

async function drag(chart: Chart, from: [number, number], to: [number, number]) {
  await mouse(chart, "move", ...from);
  await mouse(chart, "press", ...from);
  for (const t of [0.25, 0.5, 0.75, 1])
    await mouse(chart, "move", from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
  await mouse(chart, "release", ...to);
}

/** Events of one type, as they come. */
function heard<K extends keyof ChartEvents>(chart: Chart, type: K): ChartEvents[K][] {
  const events: ChartEvents[K][] = [];
  chart.on(type, (event) => events.push(event));
  return events;
}

/** The item of `panel` drawn as `label`, in keyboard order. */
function itemNamed(chart: Chart, panel: string, label: string): ItemInspection {
  const model = modelOf(chart);
  let key = model.stepItem(undefined, 1, panel);
  const seen = new Set<string>();
  while (key !== undefined && !seen.has(key)) {
    seen.add(key);
    const item = model.inspectItem(key, panel) as ItemInspection;
    if (item.points[0]!.label === label) return item;
    key = model.stepItem(key, 1, panel);
  }
  throw new Error(`No item ${label} in panel ${panel}`);
}

/** Inside a treemap node's rectangle, by its top left corner. */
function corner(item: ItemInspection): [number, number] {
  const [x, y] = item.outline.match(/-?[\d.]+/g)!.map(Number);
  return [x! + 4, y! + 4];
}

const sales = () =>
  table({
    year: ["2023", "2023", "2023", "2024", "2024"],
    region: ["Europe", "Europe", "Asia", "Europe", "Asia"],
    country: ["France", "Spain", "Japan", "France", "Japan"],
    revenue: [40, 10, 30, 20, 60],
  });
const tree = (options: { panel?: string } = {}) =>
  treemap(sales(), { path: ["region", "country"], value: "revenue", ...options });

describe("trees in facet panels", () => {
  it("drill every panel at once by a click in one, with one change", async () => {
    const chart = await mount({
      marks: [tree()],
      facet: facet("year"),
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    await click(chart, ...corner(itemNamed(chart, "2024", "Europe")));
    expect(drills).toEqual([
      { key: '[0,"Europe"]', path: [{ key: '[0,"Europe"]', label: "Europe" }] },
    ]);
    expect(chart.getDrillRoot({ panel: "2023" })?.key).toBe('[0,"Europe"]');
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toMatch(/^Europe, in every panel\. Treemap of revenue/);
    // One path the keyboard reaches, and one toolbar for every panel.
    const navs = [...chart.root.querySelectorAll("nav nav")];
    expect(navs).toHaveLength(2);
    expect(navs[0]!.getAttribute("aria-hidden")).toBeNull();
    expect(navs[1]!.getAttribute("aria-hidden")).toBe("true");
    expect(navs[1]!.querySelector("button")!.tabIndex).toBe(-1);
    expect(chart.root.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    // The second panel's "All" goes back for both.
    const all = navs[1]!.querySelector("button")!;
    const box = all.getBoundingClientRect();
    const at = chart.root.getBoundingClientRect();
    await click(chart, box.left - at.left + box.width / 2, box.top - at.top + box.height / 2);
    expect(drills.at(-1)!.key).toBeNull();
  });

  it("drill the node read with Enter in the panel the keyboard is in", async () => {
    const chart = await mount({
      marks: [tree()],
      facet: facet("year"),
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    chart.root.focus();
    // The first panel's largest region, then down into the second panel's.
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(drills.at(-1)!.key).toBe('[0,"Asia"]');
    // One toolbar goes up in every panel.
    const nodes = await accessibilityTree("figure", []);
    expect(nodes.filter((line) => line.includes('toolbar "Tree"'))).toHaveLength(1);
    await userEvent.keyboard("{Backspace}");
    expect(drills.at(-1)!.key).toBeNull();
  });

  it("describe the trees as drilled once drawn", async () => {
    const chart = await mount({
      marks: [tree()],
      facet: facet("year"),
      interaction: { zoom: true },
    });
    const description = () =>
      document.getElementById(chart.root.getAttribute("aria-describedby")!)!.textContent;
    // Past the second within which descriptions refresh once.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const whole = description();
    chart.setDrillRoot(["Europe"]);
    chart.render();
    expect(description()).not.toBe(whole);
    expect(description()).not.toContain("Asia");
  });

  it("act with the toolbar in the panels drawn now, once the first is gone", async () => {
    const chart = await mount({
      marks: [tree()],
      facet: facet("year"),
      interaction: { zoom: true },
    });
    chart.setDrillRoot(["Europe"]);
    const later = table({
      year: ["2024", "2024"],
      region: ["Europe", "Asia"],
      country: ["France", "Japan"],
      revenue: [20, 60],
    });
    chart.update({ marks: [treemap(later, { path: ["region", "country"], value: "revenue" })] });
    chart.render();
    expect(chart.getPanels().map(({ key }) => key)).toEqual(["2024"]);
    const drills = heard(chart, "drill");
    chart.root.querySelector<HTMLButtonElement>('[aria-label="Show the whole tree"]')!.click();
    expect(drills).toEqual([{ key: null, path: [] }]);
  });
});

describe("trees in subplots", () => {
  it("drill each subplot alone, each with a toolbar in its corner", async () => {
    const chart = await mount({
      marks: [tree({ panel: "a" }), tree({ panel: "b" })],
      panels: panels([
        { id: "a", title: "First" },
        { id: "b", title: "Second" },
      ]),
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    await click(chart, ...corner(itemNamed(chart, "b", "Asia")));
    expect(drills).toEqual([
      { key: '[1,"Asia"]', path: [{ key: '[1,"Asia"]', label: "Asia" }], panels: ["b"] },
    ]);
    expect(chart.getDrillRoot({ panel: "a" })?.key).toBeNull();
    expect(() => chart.getDrillRoot()).toThrow("getDrillRoot: panel is required");
    const toolbars = [...chart.root.querySelectorAll('[role="toolbar"]')];
    expect(toolbars.map((toolbar) => toolbar.getAttribute("aria-label"))).toEqual([
      "Tree, First",
      "Tree, Second",
    ]);
    // Only the drilled subplot's toolbar shows.
    expect(toolbars.map((toolbar) => (toolbar as HTMLElement).style.display)).toEqual([
      "none",
      "flex",
    ]);
    const up = toolbars[1]!.querySelector("button")!;
    up.click();
    expect(drills.at(-1)).toEqual({ key: null, path: [], panels: ["b"] });
  });
});

const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const countries = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [0, 1, 2, 3].map((i) => ({
    type: "Feature" as const,
    properties: { name: `C${i}`, year: i < 2 ? "2023" : "2024" },
    geometry: { type: "Polygon" as const, coordinates: [ring(i * 10, -5, 10)] },
  })),
});

describe("maps in subplots", () => {
  it("zoom and pan the map under the pointer alone, naming its panel", async () => {
    const regions = fromGeoJSON(countries());
    const chart = await mount({
      marks: [
        geoshape(regions, { labelField: "name", panel: "a" }),
        geoshape(regions, { labelField: "name", panel: "b" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
      projection: "equirectangular",
      interaction: { zoom: true },
    });
    const views = heard(chart, "viewport");
    const [, b] = chart.getPanels();
    const middle = [b!.plot.x + b!.plot.width / 2, b!.plot.y + b!.plot.height / 2] as const;
    await mouse(chart, "move", ...middle);
    await mouse(chart, "wheel", ...middle, -300);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((view) => view.panels?.join() === "b")).toBe(true);
    expect(chart.getViewport({ panel: "a" })).toEqual({ x: null, y: null, yRight: null });
    expect(chart.getViewport({ panel: "b" }).x).not.toBeNull();
    const zoomed = chart.getViewport({ panel: "b" });
    await drag(chart, [middle[0], middle[1]], [middle[0] - 40, middle[1]]);
    expect(chart.getViewport({ panel: "b" }).x![0]).toBeGreaterThan(zoomed.x![0]);
    // Double-click shows the whole map again, there only.
    chart.setViewport({ x: [0, 0.1] }, { panel: "a" });
    await mouse(chart, "move", ...middle);
    await realMouse({
      type: "press",
      ...offset(chart, middle),
      clickCount: 2,
      deltaY: 0,
      shift: false,
    });
    await realMouse({
      type: "release",
      ...offset(chart, middle),
      clickCount: 2,
      deltaY: 0,
      shift: false,
    });
    expect(chart.getViewport({ panel: "b" }).x).toBeNull();
    expect(chart.getViewport({ panel: "a" }).x).toEqual([0, 0.1]);
    expect(() => chart.getViewport()).toThrow("getViewport: panel is required");
  });

  it("end a pan of a subplot that goes while it pans", async () => {
    const regions = fromGeoJSON(countries());
    const chart = await mount({
      marks: [geoshape(regions, { panel: "a" }), geoshape(regions, { panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
      projection: "equirectangular",
      interaction: { zoom: true },
    });
    const [a] = chart.getPanels();
    const middle = [a!.plot.x + a!.plot.width / 2, a!.plot.y + a!.plot.height / 2] as const;
    await mouse(chart, "move", ...middle);
    await mouse(chart, "press", ...middle);
    await mouse(chart, "move", middle[0] + 20, middle[1]);
    chart.update({
      marks: [geoshape(regions, { panel: "b" })],
      panels: panels([{ id: "b" }]),
    });
    // Before the next frame draws without it, then after.
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: rect.left + middle[0] + 30,
        clientY: rect.top + middle[1],
        pointerId: MOUSE,
      }),
    );
    chart.render();
    await mouse(chart, "move", middle[0] + 40, middle[1]);
    await mouse(chart, "release", middle[0] + 40, middle[1]);
    expect(chart.getViewport({ panel: "b" }).x).toBeNull();
  });

  it("clear a subplot's lasso naming its panel, or none", async () => {
    const regions = fromGeoJSON(countries());
    const chart = await mount({
      marks: [geoshape(regions, { panel: "a" }), geoshape(regions, { panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
      projection: "equirectangular",
      interaction: { brush: "lasso" },
    });
    const lasso = {
      x: null,
      y: null,
      lasso: [
        [0, 0],
        [1, 0],
        [1, 1],
      ] as [number, number][],
    };
    chart.select(lasso, { panel: "b" });
    expect(chart.selectionPanels).toEqual(["b"]);
    chart.select(null, { panel: "b" });
    expect(chart.selection).toBeNull();
    chart.select(lasso, { panel: "b" });
    chart.select(null);
    expect(chart.selection).toBeNull();
  });
});

describe("networks in subplots", () => {
  it("keep dragging a node while another subplot's view changes", async () => {
    const links = table({ from: ["a", "b"], to: ["b", "c"] });
    const network = (panel: string) =>
      graph(links, { source: "from", target: "to", labels: false, panel });
    const chart = await mount({
      marks: [network("a"), network("b")],
      panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
      interaction: { drag: true },
    });
    const moves = heard(chart, "itemMove");
    const { px, py } = modelOf(chart).inspectItem('[1,"b"]', "b")!.points[0]!;
    await mouse(chart, "move", px, py);
    await mouse(chart, "press", px, py);
    await mouse(chart, "move", px + 10, py + 5);
    chart.setViewport({ x: [0, 0.5] }, { panel: "a" });
    await mouse(chart, "move", px + 20, py + 10);
    await mouse(chart, "release", px + 20, py + 10);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ key: '[1,"b"]', panels: ["b"] });
    // A change of its own view ends a drag without a move.
    await mouse(chart, "move", px + 20, py + 10);
    await mouse(chart, "press", px + 20, py + 10);
    await mouse(chart, "move", px + 30, py + 10);
    chart.setViewport({ x: [0, 0.5] }, { panel: "b" });
    await mouse(chart, "move", px + 40, py + 10);
    await mouse(chart, "release", px + 40, py + 10);
    expect(moves).toHaveLength(1);
  });
});

/** A point of the chart in the page. */
function offset(chart: Chart, [x, y]: readonly [number, number]) {
  const at = pageOrigin(chart.root);
  return { x: at.x + x, y: at.y + y };
}

describe("maps in facet panels", () => {
  it("zoom every panel at once, and lasso rows of each into a row selection", async () => {
    const regions = fromGeoJSON(countries());
    const store = selectionStore(regions);
    const chart = await mount({
      marks: [geoshape(regions, { labelField: "name" })],
      facet: facet("year"),
      projection: "equirectangular",
      interaction: { zoom: true, brush: "lasso" },
      rowSelection: rowSelection({ store, channel: "picked" }),
    });
    const views = heard(chart, "viewport");
    const selections = heard(chart, "select");
    chart.setViewport({ x: [0, 0.4] }, { panel: "2024" });
    expect(views.at(-1)).toEqual({ x: [0, 0.4], y: null, yRight: null });
    chart.setViewport(null);
    chart.render();
    // A lasso around the first panel's plot, on the plane both panels share.
    const [first] = chart.getPanels();
    const { x, y, width, height } = first!.plot;
    const points: [number, number][] = [
      [x + 2, y + 2],
      [x + width - 2, y + 2],
      [x + width - 2, y + height - 2],
      [x + 2, y + height - 2],
    ];
    await mouse(chart, "move", ...points[0]!);
    await mouse(chart, "press", ...points[0]!);
    for (const point of [...points.slice(1), points[0]!]) await mouse(chart, "move", ...point);
    await mouse(chart, "release", ...points[0]!);
    expect(selections.at(-1)?.lasso).not.toBeNull();
    expect(selections.at(-1)).not.toHaveProperty("panels");
    expect(chart.selectionPanels).toEqual(["2023", "2024"]);
    // Every region of both panels is inside the shared plane's lasso.
    const held = store.get("picked");
    expect(held?.kind === "rows" && [...held.rows.positions()]).toEqual([0, 1, 2, 3]);
    // Drawn in both panels.
    const outlines = [...chart.root.querySelectorAll("path[clip-path]")].filter(
      (path) => path.getAttribute("visibility") === "visible",
    );
    expect(outlines).toHaveLength(2);
  });

  it("act with the toolbar in the panels drawn now, once the first is gone", async () => {
    const chart = await mount({
      marks: [geoshape(fromGeoJSON(countries()), { labelField: "name" })],
      facet: facet("year"),
      projection: "equirectangular",
      interaction: { zoom: true },
    });
    const later = { ...countries(), features: countries().features.slice(2) };
    chart.update({ marks: [geoshape(fromGeoJSON(later), { labelField: "name" })] });
    chart.render();
    expect(chart.getPanels().map(({ key }) => key)).toEqual(["2024"]);
    chart.root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
    expect(chart.getViewport({ panel: "2024" }).x).not.toBeNull();
  });
});

describe("networks in facet panels", () => {
  it("move a node dragged in one panel in every panel, with one change", async () => {
    const links = table({
      year: ["2023", "2023", "2024", "2024"],
      from: ["a", "b", "a", "b"],
      to: ["b", "c", "b", "d"],
    });
    const chart = await mount({
      marks: [graph(links, { source: "from", target: "to", labels: false })],
      facet: facet("year"),
      interaction: { drag: true },
    });
    const moves = heard(chart, "itemMove");
    const model = modelOf(chart);
    const { px, py } = model.inspectItem('[0,"a"]', "2024")!.points[0]!;
    await drag(chart, [px, py], [px + 20, py + 15]);
    expect(moves).toHaveLength(1);
    expect(moves[0]).not.toHaveProperty("panels");
    expect(Object.keys(chart.getItemPositions())).toEqual(['[0,"a"]']);
    const [first, second] = chart.getPanels();
    const at = (panel: string, plot: { x: number; y: number }) => {
      const point = model.inspectItem('[0,"a"]', panel)!.points[0]!;
      return [point.px - plot.x, point.py - plot.y];
    };
    const [ax, ay] = at("2023", first!.plot);
    const [bx, by] = at("2024", second!.plot);
    expect(ax).toBeCloseTo(bx!, 3);
    expect(ay).toBeCloseTo(by!, 3);
    // A node only the second panel draws moves as well.
    const d = model.inspectItem('[0,"d"]', "2024")!.points[0]!;
    await drag(chart, [d.px, d.py], [d.px - 15, d.py - 10]);
    expect(moves).toHaveLength(2);
    expect(Object.keys(chart.getItemPositions()).sort()).toEqual(['[0,"a"]', '[0,"d"]']);
    const svg = chart.toSVG();
    expect(svg).toContain("<svg");
  });
});
