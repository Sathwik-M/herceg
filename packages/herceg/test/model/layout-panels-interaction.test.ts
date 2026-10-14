// Interaction with layout marks in facet panels and subplots: facet panels
// share one drill root, one view of a map's or network's plane, and one set
// of moved nodes; each subplot has its own. Maps and networks draw in panels
// too: a map's layers split their rows by the facet field (or repeat), and a
// network's facet panels share one layout of the whole network.

import { describe, expect, it } from "vitest";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { type SelectionStore, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { fieldReader } from "../../src/dom/tooltip-content.ts";
import { estimateText } from "../../src/layout/text.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { facet } from "../../src/model/facet.ts";
import type { ItemChanges } from "../../src/model/item-views.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { brushedRows, clickedRows, cursorRows } from "../../src/model/selected-rows.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type { TextGeometry } from "../../src/scene/scene.ts";

function build(config: ChartConfig, width = 800, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Every item of a panel, in reading order. */
function items(model: ChartModel, panel: string): ItemInspection[] {
  const out: ItemInspection[] = [];
  let key = model.stepItem(undefined, 1, panel);
  while (key !== undefined && !out.some((item) => item.key === key)) {
    out.push(model.inspectItem(key, panel) as ItemInspection);
    key = model.stepItem(key, 1, panel);
  }
  return out;
}
const labels = (model: ChartModel, panel: string) =>
  items(model, panel).map((item) => item.points[0]!.label);

/** The changes the chart's items report, as a mounted chart hears them. */
function heard(model: ChartModel) {
  const changes: [string, unknown][] = [];
  model.items!.changed = (type, change) => changes.push([type, change]);
  return changes;
}

/** A chart bound to a store, as a mounted chart binds it. */
function bound<S extends Schema>(config: ChartConfig, store: SelectionStore<S>) {
  const selection = rowSelection({ store, channel: "c" });
  const { model } = build({ ...config, rowSelection: selection });
  const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
  selection.mount(
    undefined,
    model,
    chart,
    { emit() {} },
    () => {},
    () => null,
    {
      textContent: null,
    },
  );
  return model;
}

// 2023: Europe 50 (France 40, Spain 10), Asia 30. 2024: Europe 20 (France), Asia 60 (Japan).
const sales = table({
  year: ["2023", "2023", "2023", "2024", "2024"],
  region: ["Europe", "Europe", "Asia", "Europe", "Asia"],
  country: ["France", "Spain", "Japan", "France", "Japan"],
  revenue: [40, 10, 30, 20, 60],
});
const tree = (options: { panel?: string; id?: string } = {}) =>
  treemap(sales, { path: ["region", "country"], value: "revenue", ...options });
const zoom = { interaction: { zoom: true } } as const;

describe("trees in facet panels", () => {
  it("share one drill root, each panel drawing its rows under it", () => {
    const { model } = build({ marks: [tree()], facet: facet("year"), ...zoom });
    const changes = heard(model);
    model.items!.setDrillRoot(["Europe"], "2024");
    model.scene(estimateText);
    expect(labels(model, "2023")).toEqual(["Europe / France", "Europe / Spain"]);
    expect(labels(model, "2024")).toEqual(["Europe / France"]);
    // France's share is of Europe in each panel.
    expect(items(model, "2023")[0]!.points[0]!.text).toBe("40 (80% in Europe)");
    expect(items(model, "2024")[0]!.points[0]!.text).toBe("20 (100% in Europe)");
    // One change, the chart's, which names no panel.
    expect(changes).toEqual([
      ["drill", { key: '[0,"Europe"]', path: [{ key: '[0,"Europe"]', label: "Europe" }] }],
    ]);
    expect(model.items!.drillRoot("2023")!.key).toBe('[0,"Europe"]');
    expect(model.items!.drillRoot()!.key).toBe('[0,"Europe"]');
  });

  it("show the path in a panel with nothing under the root, rather than another node", () => {
    const { model, scene } = build({ marks: [tree()], facet: facet("year"), ...zoom });
    void scene;
    model.items!.setDrillRoot(["Europe", "Spain"]);
    const next = model.scene(estimateText);
    expect(labels(model, "2023")).toEqual([]);
    // Spain has rows in 2023 only, and still is the root of 2024's panel.
    expect(model.items!.result("2024")!.drill!.key).toBe('[0,"Europe","Spain"]');
    expect(model.layoutSummary("2024")).toMatch(/in Europe \/ Spain, with nothing to show/);
    const path = next.panels[1]!.marks.filter(
      (m): m is TextGeometry => m.kind === "text" && m.key.includes("path"),
    );
    expect(path.flatMap((m) => m.labels)).toEqual(expect.arrayContaining(["All", "Spain"]));
    // A node opens where the panel has something under it.
    const drill = model.items!.result("2024")!.drill!;
    expect(drill.opens('[0,"Europe"]')).toBe(false);
  });

  it("give way to the nearest ancestor only when the whole tree loses the root", () => {
    const data = table({ year: ["a", "b"], region: ["X", "Y"], country: ["x1", "y1"] });
    const { model } = build({
      marks: [treemap(data, { path: ["region", "country"] })],
      facet: facet("year"),
    });
    model.items!.setDrillRoot(["X", "x1"]);
    model.scene(estimateText);
    data.reset({ year: ["a", "b"], region: ["X", "Y"], country: ["x2", "y1"] });
    model.scene(estimateText);
    expect(model.items!.drillRoot()!.key).toBe('[0,"X"]');
    expect(model.items!.reconciled()).toEqual({
      key: '[0,"X"]',
      path: [{ key: '[0,"X"]', label: "X" }],
    });
  });

  it("select a node's rows in its panel, and count each panel's selected rows", () => {
    const store = selectionStore(sales);
    const model = bound({ marks: [tree()], facet: facet("year") }, store);
    const tables = new Set([sales as unknown as Table]);
    const france = (panel: string) =>
      items(model, panel).find((item) => item.points[0]!.label === "Europe / France")!;
    const { px, py } = france("2024").points[0]!;
    expect(clickedRows(model, tables, px, py)?.rows).toEqual(Uint32Array.of(3));
    expect(
      cursorRows(model, tables, { panel: "2023", key: france("2023").key, position: 0 })?.rows,
    ).toEqual(Uint32Array.of(0));
    store.set("c", selectRows(new RowSet(sales).add(0)));
    model.scene(estimateText);
    expect(france("2023").points[0]!.text).toMatch(/1 of 1 row selected, revenue 40 of 40$/);
    expect(france("2024").points[0]!.text).toMatch(/0 of 1 row selected, revenue 0 of 20$/);
  });
});

describe("trees in subplots", () => {
  const two = () =>
    build({
      marks: [tree({ panel: "a" }), sunburst(sales, { path: ["region"], panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }]),
      ...zoom,
    }).model;

  it("drill each subplot's tree alone, naming the panel of each change", () => {
    const model = two();
    const changes = heard(model);
    expect(() => model.items!.setDrillRoot(["Asia"])).toThrow(
      'setDrillRoot: panel is required; the treemap or sunburst panels are "a", "b"',
    );
    model.items!.setDrillRoot(["Asia"], "b");
    model.scene(estimateText);
    expect(model.items!.drillRoot("a")!.key).toBeNull();
    expect(model.items!.drillRoot("b")!.key).toBe('[1,"Asia"]');
    expect(labels(model, "a")).toContain("Europe / France");
    expect(changes).toEqual([
      ["drill", { key: '[1,"Asia"]', path: [{ key: '[1,"Asia"]', label: "Asia" }], panels: ["b"] }],
    ]);
    expect(() => model.items!.drillRoot()).toThrow("getDrillRoot: panel is required");
  });

  it("drop a subplot's root once it is gone, and start afresh when it comes back", () => {
    const model = two();
    model.items!.setDrillRoot(["Asia"], "b");
    model.scene(estimateText);
    const without = {
      marks: [tree({ panel: "a" })],
      panels: panels([{ id: "a" }]),
      ...zoom,
    } satisfies ChartConfig;
    model.update(without);
    model.scene(estimateText);
    model.update({
      marks: [tree({ panel: "a" }), sunburst(sales, { path: ["region"], panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }]),
      ...zoom,
    });
    model.scene(estimateText);
    expect(model.items!.drillRoot("b")!.key).toBeNull();
  });

  it("refuse a panel without a tree, naming those with one", () => {
    const { model } = build({
      marks: [line(sales, { x: "revenue", y: "revenue", panel: "a" }), tree({ panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }]),
    });
    expect(() => model.items!.setDrillRoot(["Asia"], "a")).toThrow(
      'setDrillRoot: panel "a" has no treemap or sunburst; name one of "b"',
    );
    // The one tree needs no panel.
    expect(model.items!.setDrillRoot(["Asia"])!.panels).toEqual(["b"]);
  });
});

const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
/** Four countries in a row along the equator, each with its year's GDP. */
const countries = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [0, 1, 2, 3].map((i) => ({
    type: "Feature" as const,
    properties: { name: `C${i}`, year: i < 2 ? "2023" : "2024", gdp: i },
    geometry: { type: "Polygon" as const, coordinates: [ring(i * 10, -5, 10)] },
  })),
});
const projection = "equirectangular" as const;
const half = (d: readonly [number, number]) =>
  [d[0] + (d[1] - d[0]) / 4, d[1] - (d[1] - d[0]) / 4] as const;

describe("maps in facet panels", () => {
  it("split each layer's rows, fit every panel to all of them, and share one view", () => {
    const regions = fromGeoJSON(countries());
    const { model } = build({
      marks: [geoshape(regions, { labelField: "name", color: "gdp" })],
      facet: facet("year"),
      projection,
      ...zoom,
    });
    expect(labels(model, "2023")).toEqual(["C0", "C1"]);
    expect(labels(model, "2024")).toEqual(["C2", "C3"]);
    const [a, b] = ["2023", "2024"].map((panel) => model.items!.result(panel)!.plane!);
    // The same plane in both: the same place at the same pixels, relative to each room.
    for (const axis of ["x", "y"] as const)
      for (const [i, end] of a![axis].domain.entries())
        expect(b![axis].domain[i]).toBeCloseTo(end, 9);
    const changes = heard(model);
    model.items!.setView({ x: half(a!.x.domain), y: half(a!.y.domain) }, "2024");
    model.scene(estimateText);
    for (const panel of ["2023", "2024"])
      expect(model.items!.result(panel)!.plane!.zoom).toBeCloseTo(2, 6);
    expect(changes).toHaveLength(1);
    expect(changes[0]![1]).not.toHaveProperty("panels");
    // One color legend for the panels' scale.
    expect(model.scene(estimateText).colorLegends).toHaveLength(1);
  });

  it("draw a repeated base layer in every panel, under the layer that splits", () => {
    const regions = fromGeoJSON(countries());
    const cities = table({ lon: [5, 35], lat: [0, 0], year: ["2023", "2024"], city: ["a", "b"] });
    const { model } = build({
      marks: [
        geoshape(regions, { labelField: "name", facet: "repeat" }),
        geopoint(cities, { longitude: "lon", latitude: "lat", labelField: "city" }),
      ],
      facet: facet("year"),
      projection,
    });
    expect(labels(model, "2023")).toEqual(["C0", "C1", "C2", "C3", "a"]);
    expect(labels(model, "2024")).toEqual(["C0", "C1", "C2", "C3", "b"]);
    // Items name their layer among the chart's marks.
    expect(items(model, "2024").at(-1)!.points[0]!.mark).toBe(1);
  });

  it("refuse a layer that cannot split, and a map none of whose layers does", () => {
    const regions = fromGeoJSON(countries());
    const other = table({ lon: [1], lat: [1] });
    expect(() =>
      build({
        marks: [geoshape(regions), geopoint(other, { longitude: "lon", latitude: "lat" })],
        facet: facet("year"),
      }),
    ).toThrow(
      'geopoint: no field "year" to split into facet panels; give it facet: "repeat" to draw it whole in every panel',
    );
    expect(() =>
      build({ marks: [geoshape(regions, { facet: "repeat" })], facet: facet("year") }),
    ).toThrow("geoshape facet: every layer of the map repeats, so none splits into facet panels");
  });

  it("lasso the shared plane, selecting each panel's rows inside it", () => {
    const regions = fromGeoJSON(countries());
    const store = selectionStore(regions);
    const model = bound(
      {
        marks: [geoshape(regions, { labelField: "name" })],
        facet: facet("year"),
        projection,
        interaction: { brush: "lasso" },
      },
      store,
    );
    const owner = model.items!.select("2023")!;
    expect(owner.panels).toEqual(["2023", "2024"]);
    // Around the whole plane: every panel's regions.
    const { x, y } = model.items!.result("2023")!.plane!;
    const [x0, x1] = x.domain;
    const [y0, y1] = y.domain;
    const lasso = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as const;
    const rows = brushedRows(model, regions, { x: null, y: null, lasso }, owner);
    expect(rows?.kind === "rows" && Array.from(rows.rows.positions())).toEqual([0, 1, 2, 3]);
  });
});

describe("maps in subplots", () => {
  const two = () => {
    const regions = fromGeoJSON(countries());
    return build({
      marks: [
        line(table({ x: [0, 1], y: [0, 1] }), { x: "x", y: "y", panel: "line" }),
        geoshape(regions, { labelField: "name", panel: "a" }),
        geoshape(regions, { labelField: "name", panel: "b", id: "second" }),
        geopoint(table({ lon: [5], lat: [0] }), { longitude: "lon", latitude: "lat", panel: "b" }),
      ],
      panels: panels([{ id: "line" }, { id: "a" }, { id: "b" }], { columns: 3 }),
      projection,
      ...zoom,
    }).model;
  };

  it("join the layers naming a panel, their items naming their marks", () => {
    const model = two();
    expect(labels(model, "a")).toEqual(["C0", "C1", "C2", "C3"]);
    expect(items(model, "b").map((item) => item.points[0]!.mark)).toEqual([2, 2, 2, 2, 3]);
    // Keys of the two maps' regions differ by their marks' identities.
    expect(items(model, "a")[0]!.key).toBe("[1,0]");
    expect(items(model, "b")[0]!.key).toBe('["second",0]');
  });

  it("read each layer's tooltip fields from its own rows", () => {
    const regions = fromGeoJSON(countries());
    const places = table({ lon: [5], lat: [0], rank: [7] });
    const model = new ChartModel({
      locale: "en-US",
      marks: [
        line(table({ x: [0, 1], y: [0, 1] }), { x: "x", y: "y", panel: "line" }),
        geoshape(regions, { labelField: "name", panel: "b", tooltip: { fields: ["gdp"] } }),
        geopoint(places, {
          longitude: "lon",
          latitude: "lat",
          panel: "b",
          tooltip: { fields: ["rank"] },
        }),
      ],
      panels: panels([{ id: "line" }, { id: "b" }]),
      projection,
    });
    // As a chart does once it has loaded what reads the fields.
    model.fields = fieldReader;
    model.setSize(800, 400, 1);
    model.scene(estimateText);
    const drawn = items(model, "b");
    expect(drawn[1]!.points[0]!.fields).toEqual([
      { field: "gdp", label: "gdp", kind: "number", value: 1, text: "1" },
    ]);
    expect(drawn.at(-1)!.points[0]!.fields).toEqual([
      { field: "rank", label: "rank", kind: "number", value: 7, text: "7" },
    ]);
  });

  it("view each map alone, naming its panel, the axes' view apart", () => {
    const model = two();
    const changes = heard(model);
    const b = model.items!.result("b")!.plane!;
    model.items!.setView({ x: half(b.x.domain), y: half(b.y.domain) }, "b");
    model.scene(estimateText);
    expect(model.items!.result("a")!.plane!.zoom).toBe(1);
    expect(model.items!.result("b")!.plane!.zoom).toBeCloseTo(2, 6);
    expect(changes.map(([, change]) => (change as ItemChanges["viewport"]).panels)).toEqual([
      ["b"],
    ]);
    // Without a panel, the view is the axes'; null resets every view.
    expect(model.items!.ownsView(undefined)).toBe(false);
    expect(model.items!.ownsView("b")).toBe(true);
    expect(model.items!.setView(null, undefined, true)).toBe(false);
    model.scene(estimateText);
    expect(model.items!.result("b")!.plane!.zoom).toBe(1);
  });

  it("refuse a lasso beside panels with axes, and take one when every panel is a map", () => {
    const regions = fromGeoJSON(countries());
    expect(() =>
      build({
        marks: [
          line(table({ x: [0, 1], y: [0, 1] }), { x: "x", y: "y", panel: "a" }),
          geoshape(regions, { panel: "b" }),
        ],
        panels: panels([{ id: "a" }, { id: "b" }]),
        interaction: { brush: "lasso" },
      }),
    ).toThrow('chart interaction: charts with panels zoom and brush along x only; use "x"');
    const { model } = build({
      marks: [geoshape(regions, { panel: "a" }), geoshape(regions, { panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }]),
      interaction: { brush: "lasso" },
    });
    expect(model.items!.select("b")!.panels).toEqual(["b"]);
    expect(() => model.items!.select(undefined)).toThrow("select: panel is required");
  });
});

// A ring a - b - c - a in 2023, and a - b twice with b - d in 2024.
const links = table({
  year: ["2023", "2023", "2023", "2024", "2024", "2024"],
  from: ["a", "b", "c", "a", "a", "b"],
  to: ["b", "c", "a", "b", "b", "d"],
  weight: [1, 1, 1, 2, 3, 1],
});
const network = (options: { panel?: string } = {}) =>
  graph(links, { source: "from", target: "to", value: "weight", ...options });

describe("networks in facet panels", () => {
  it("lay out the whole network once, each panel drawing its links and the nodes they join", () => {
    const { model, scene } = build({ marks: [network()], facet: facet("year") });
    const nodes = (panel: string) =>
      items(model, panel).filter((item) => (JSON.parse(item.key) as unknown[]).length === 2);
    expect(nodes("2023").map((item) => item.points[0]!.label)).toEqual(["a", "b", "c"]);
    expect(nodes("2024").map((item) => item.points[0]!.label)).toEqual(["a", "b", "d"]);
    // Each node at the same place in its room in both panels.
    const [first, second] = scene.panels;
    const place = (panel: string, name: string, plot: { x: number; y: number }) => {
      const { px, py } = model.inspectItem(JSON.stringify([0, name]), panel)!.points[0]!;
      return [px - plot.x, py - plot.y];
    };
    for (const name of ["a", "b"]) {
      const [ax, ay] = place("2023", name, first!.plot);
      const [bx, by] = place("2024", name, second!.plot);
      expect(bx).toBeCloseTo(ax!, 6);
      expect(by).toBeCloseTo(ay!, 6);
    }
    // Links total their panel's rows.
    expect(model.inspectItem('[0,"a","b"]', "2023")!.points[0]!.text).toBe("1");
    expect(model.inspectItem('[0,"a","b"]', "2024")!.points[0]!.text).toBe("5");
    expect(model.layoutSummary("2024")).toMatch(/^Network of 3 nodes and 2 links/);
  });

  it("share moved nodes and the view, and select a link's rows in its panel", () => {
    const store = selectionStore(links);
    const model = bound({ marks: [network()], facet: facet("year") }, store);
    const plane = model.items!.result("2023")!.plane!;
    const at = { x: plane.x.invert(10), y: plane.y.invert(10) };
    model.items!.setItemPosition('[0,"a"]', at, "2024");
    model.scene(estimateText);
    expect(model.items!.movedItems().size).toBe(1);
    expect(model.items!.positions("2023")).toEqual(model.items!.positions("2024"));
    const tables = new Set([links as unknown as Table]);
    const ab = model.inspectItem('[0,"a","b"]', "2024")!.points[0]!;
    expect(clickedRows(model, tables, ab.px, ab.py)?.rows).toEqual(Uint32Array.of(3, 4));
  });

  it("move a node only a later panel draws, there or without naming a panel", () => {
    const { model } = build({ marks: [network()], facet: facet("year") });
    const changes = heard(model);
    const { layout } = model.items!.result("2024")!.moves!;
    // A drag's move, made in the layout the panel drew.
    expect(model.items!.setItemPosition('[0,"d"]', { x: 1, y: 2 }, "2024", layout)).toEqual({
      key: '[0,"d"]',
      position: { x: 1, y: 2 },
    });
    expect(model.items!.setItemPosition('[0,"d"]', { x: 3, y: 4 })).toEqual({
      key: '[0,"d"]',
      position: { x: 3, y: 4 },
    });
    expect(() => model.items!.setItemPosition('[0,"d"]', { x: 5, y: 6 }, "2023")).toThrow(
      /setItemPosition: no node .* in the network/,
    );
    model.items!.drag('[0,"d"]', [7, 8], "2024");
    model.scene(estimateText);
    expect(model.items!.positions("2023")).toEqual({ '[0,"d"]': { x: 3, y: 4 } });
    expect(changes).toHaveLength(2);
  });
});

describe("networks in subplots", () => {
  it("move each subplot's nodes alone, naming its panel", () => {
    const { model } = build({
      marks: [network({ panel: "a" }), network({ panel: "b" })],
      panels: panels([{ id: "a" }, { id: "b" }]),
      interaction: { drag: true },
    });
    const changes = heard(model);
    expect(() => model.items!.setItemPosition('[1,"a"]', { x: 1, y: 2 })).toThrow(
      'setItemPosition: panel is required; the network panels are "a", "b"',
    );
    expect(model.items!.setItemPosition('[1,"a"]', { x: 1, y: 2 }, "b")).toEqual({
      key: '[1,"a"]',
      position: { x: 1, y: 2 },
      panels: ["b"],
    });
    model.scene(estimateText);
    expect(model.items!.positions("a")).toEqual({});
    expect(model.items!.positions("b")).toEqual({ '[1,"a"]': { x: 1, y: 2 } });
    expect(changes).toHaveLength(1);
  });
});

describe("networks too large to lay out in subplots", () => {
  it("keep their view for when they are drawn", () => {
    const growing = table({ from: ["n0"], to: ["hub"] });
    const { model } = build({
      marks: [
        graph(growing, { source: "from", target: "to", panel: "a" }),
        network({ panel: "b" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
    });
    // Grown past what a network draws.
    const names = Array.from({ length: 5000 }, (_, i) => `n${i + 1}`);
    growing.append({ from: names, to: names.map(() => "hub") });
    model.scene(estimateText);
    expect(model.items!.result("a")!.plane).toBeUndefined();
    expect(model.items!.ownsView("a")).toBe(true);
    expect(model.items!.setView({ x: [0, 1], y: [2, 3] }, "a", true)).toBe(true);
    expect(model.items!.view("a")).toEqual({ x: [0, 1], y: [2, 3], yRight: null });
  });
});

describe("layout marks in panels refuse", () => {
  it("3D charts, drags without networks, and options of axes they lack", () => {
    const spatial = table({ x: [0, 1], y: [0, 1], z: [0, 1], year: ["a", "b"] });
    expect(() =>
      build({ marks: [point3d(spatial, { x: "x", y: "y", z: "z" })], facet: facet("year") }),
    ).toThrow("point3d facet: 3D marks cannot split into facets; use separate marks in subplots");
    const shares = pie(sales, { category: "region", value: "revenue" });
    expect(() =>
      build({ marks: [shares], facet: facet("year"), interaction: { drag: true } }),
    ).toThrow("pie drag: no nodes to drag; drop interaction.drag");
    expect(() =>
      build({ marks: [shares], facet: facet("year"), resolve: { x: "independent" } }),
    ).toThrow("pie resolve: its panels have no scales to resolve; drop resolve");
    expect(() =>
      build({ marks: [shares], facet: facet("year"), resolve: { y: "shared" } }),
    ).not.toThrow();
    expect(() =>
      build({ marks: [tree()], facet: facet("year"), interaction: { zoom: "x" } }),
    ).toThrow('treemap zoom: expected interaction.zoom true; received "x"');
  });
});

describe("exports of layout marks in panels", () => {
  it("draw each panel's drill root and view", () => {
    const { model } = build({ marks: [tree()], facet: facet("year"), ...zoom });
    model.items!.setDrillRoot(["Asia"]);
    const svg = renderSvg(model.scene(estimateText));
    // Each panel's path says where it is.
    expect(svg.match(/>Asia</g)?.length).toBeGreaterThanOrEqual(2);
  });
});
