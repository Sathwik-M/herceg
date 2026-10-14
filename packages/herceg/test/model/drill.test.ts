// Treemaps and sunbursts drilled into a node: the subtree under it laid out
// in the room, keys and colors kept, the path above it, and the rows a node
// stands for selected and highlighted.

import { describe, expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { type SelectionStore, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { DIM } from "../../src/marks/mark.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { clickedRows } from "../../src/model/selected-rows.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type { ArcGeometry, RectGeometry, Scene, TextGeometry } from "../../src/scene/scene.ts";

const sales = table({
  region: ["Europe", "Europe", "Europe", "Asia", "Asia"],
  country: ["France", "France", "Spain", "Japan", "India"],
  city: ["Paris", "Lyon", "Madrid", "Tokyo", "Delhi"],
  revenue: [40, 10, 20, 50, 30],
});

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 400, 1);
  return { model, scene: model.scene(estimateText) };
}

const rects = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is RectGeometry => m.kind === "rect");
const texts = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");

/** Every item, in keyboard order. */
function items(model: ChartModel): ItemInspection[] {
  const out: ItemInspection[] = [];
  let key = model.stepItem(undefined, 1);
  while (key !== undefined && !out.some((item) => item.key === key)) {
    out.push(model.inspectItem(key) as ItemInspection);
    key = model.stepItem(key, 1);
  }
  return out;
}

const tree = () => treemap(sales, { path: ["region", "country", "city"], value: "revenue" });

describe("drilled treemaps", () => {
  it("lay out the subtree under the node in the room, keeping keys and colors", () => {
    const { model, scene } = build({ marks: [tree()] });
    const before = items(model);
    const paris = before.find((item) => item.points[0]!.label === "Europe / France / Paris")!;
    const drilled = model.items!.setDrillRoot(["Europe"]);
    expect(drilled).toEqual({
      key: '[0,"Europe"]',
      path: [{ key: '[0,"Europe"]', label: "Europe" }],
    });
    const next = model.scene(estimateText);
    const after = items(model);
    expect(after.map((item) => item.points[0]!.label)).toEqual([
      "Europe / France",
      "Europe / France / Paris",
      "Europe / France / Lyon",
      "Europe / Spain",
      "Europe / Spain / Madrid",
    ]);
    const again = after.find((item) => item.key === paris.key)!;
    expect(again.points[0]!.color).toBe(paris.points[0]!.color);
    // Shares are of the node drilled into.
    expect(again.points[0]!.text).toBe("40 (57.1% in Europe)");
    // France fills more of the room than it did.
    const area = (item: ItemInspection) => {
      const [, , w, h] = item.outline.match(/-?[\d.]+/g)!.map(Number);
      return w! * h!;
    };
    expect(area(again)).toBeGreaterThan(area(paris) * 1.5);
    expect(rects(next).length).toBeGreaterThan(0);
    expect(model.layoutSummary()).toMatch(
      /^Treemap of revenue by region \/ country \/ city in Europe:/,
    );
    void scene;
  });

  it("draw the path above them where the chart drills, even at the top", () => {
    const plain = build({ marks: [tree()] });
    expect(texts(plain.scene).some((t) => t.labels.includes("All"))).toBe(false);
    const { model, scene } = build({ marks: [tree()], interaction: { zoom: true } });
    expect(texts(scene).find((t) => t.labels.includes("All"))).toBeDefined();
    expect(model.items!.result()!.drill!.crumbs.map(({ key, label }) => [key, label])).toEqual([
      [null, "All"],
    ]);
    model.items!.setDrillRoot('[0,"Europe","France"]');
    const next = model.scene(estimateText);
    const crumbs = model.items!.result()!.drill!.crumbs;
    expect(crumbs.map(({ label }) => label)).toEqual(["All", "Europe", "France"]);
    // The path strip is above the tree, its steps left to right.
    const top = Math.min(
      ...rects(next).flatMap((r) => Array.from(r.rects.filter((_, i) => i % 4 === 1))),
    );
    expect(crumbs.every(({ y, height }) => y + height <= top)).toBe(true);
    expect(crumbs[1]!.x).toBeGreaterThan(crumbs[0]!.x + crumbs[0]!.width);
    expect(texts(next).flatMap((t) => t.labels)).toEqual(
      expect.arrayContaining(["All", " / ", "Europe", "France"]),
    );
  });

  it("fold a deep path into the room, every step still a crumb", () => {
    // Department 1 holds Department 2, and so on down to 9, each with a team of its own.
    const names = Array.from({ length: 9 }, (_, i) => `Department ${i + 1}`);
    const org = table({
      name: [...names, ...names.map((name) => `${name} team`)],
      boss: [null, ...names.slice(0, -1), ...names],
      cost: [...names.map(() => 0), ...names.map(() => 1)],
    });
    for (const mark of [
      treemap(org, { node: "name", parent: "boss", value: "cost" }),
      sunburst(org, { node: "name", parent: "boss", value: "cost" }),
    ]) {
      const model = new ChartModel({ locale: "en-US", marks: [mark], interaction: { zoom: true } });
      model.setSize(320, 300, 1);
      model.scene(estimateText);
      model.items!.setDrillRoot(names.slice(0, 8));
      const scene = model.scene(estimateText);
      const { plot } = scene.panels[0]!;
      const crumbs = model.items!.result()!.drill!.crumbs;
      expect(crumbs.map(({ label }) => label)).toEqual(["All", ...names.slice(0, 8)]);
      // Within the room, the parent and the node drilled into last and named in full.
      for (const { x, width } of crumbs) {
        expect(x).toBeGreaterThanOrEqual(plot.x - 2);
        expect(x + width).toBeLessThanOrEqual(plot.x + plot.width + 2);
      }
      const path = texts(scene).filter((t) => t.key.includes("-path"));
      const labels = path.flatMap((t) => t.labels);
      expect(labels).toEqual(expect.arrayContaining(["All", "…", "Department 7", "Department 8"]));
      expect(labels).not.toContain("Department 2");
      // Folded steps' crumbs lie over the fold.
      const fold = path.find((t) => t.labels.includes("…"))!;
      const foldX = fold.coords[fold.labels.indexOf("…") * 2]!;
      expect(crumbs[1]!.x).toBeCloseTo(foldX - 2, 6);
      expect(renderSvg(scene)).toContain("…");

      // Narrower than "All / … / parent / node" with every name cut: less is shown, nothing past the room.
      for (const width of [100, 40]) {
        const narrow = new ChartModel({
          locale: "en-US",
          marks: [mark],
          interaction: { zoom: true },
          theme: { fontSize: 20 },
        });
        narrow.setSize(width, 300, 1);
        narrow.scene(estimateText);
        narrow.items!.setDrillRoot(names.slice(0, 8));
        const drawn = narrow.scene(estimateText);
        const room = drawn.panels[0]!.plot;
        const steps = narrow.items!.result()!.drill!.crumbs;
        expect(steps.map(({ label }) => label)).toEqual(["All", ...names.slice(0, 8)]);
        for (const { x, width } of steps)
          expect(x + width).toBeLessThanOrEqual(room.x + room.width + 2);
      }
    }
  });

  it("drill by key or names, refuse nodes they do not have, and go back out", () => {
    const { model } = build({ marks: [tree()] });
    expect(model.items!.drillRoot()).toEqual({ key: null, path: [] });
    expect(() => model.items!.setDrillRoot(["Mars"])).toThrow(
      'setDrillRoot: no node ["Mars"] in the tree',
    );
    model.items!.setDrillRoot(["Asia", "Japan"]);
    model.scene(estimateText);
    expect(model.items!.drillRoot()!.path.map(({ label }) => label)).toEqual(["Asia", "Japan"]);
    // The same root again changes nothing.
    expect(model.items!.setDrillRoot('[0,"Asia","Japan"]')).toBeUndefined();
    expect(model.items!.setDrillRoot(null)).toEqual({ key: null, path: [] });
    model.scene(estimateText);
    // Two regions, four countries, and five cities.
    expect(items(model)).toHaveLength(11);
  });

  it("fall back to the nearest node the data still has", () => {
    const data = table({ region: ["A", "A", "B"], country: ["x", "y", "z"] });
    const { model } = build({ marks: [treemap(data, { path: ["region", "country"] })] });
    model.items!.setDrillRoot(["A", "x"]);
    model.scene(estimateText);
    data.reset({ region: ["A", "B"], country: ["y", "z"] });
    model.scene(estimateText);
    expect(model.items!.drillRoot()!.key).toBe('[0,"A"]');
  });

  it("drill trees of node and parent fields, whose groups have rows of their own", () => {
    const org = table({
      name: ["CEO", "CTO", "Dev", "CFO"],
      boss: [null, "CEO", "CTO", "CEO"],
      cost: [5, 3, 2, 4],
    });
    const { model } = build({
      marks: [treemap(org, { node: "name", parent: "boss", value: "cost" })],
    });
    model.items!.setDrillRoot(["CEO", "CTO"]);
    model.scene(estimateText);
    expect(model.items!.drillRoot()!.key).toBe('[0,"CTO"]');
    expect(items(model).map((item) => item.key)).toEqual(['[0,"Dev"]']);
  });
});

describe("drilled sunbursts", () => {
  it("put the node drilled into in the middle, read first, a click there its own", () => {
    const { model } = build({
      marks: [sunburst(sales, { path: ["region", "country", "city"], value: "revenue" })],
    });
    model.items!.setDrillRoot(["Europe"]);
    const scene = model.scene(estimateText);
    const center = scene.panels[0]!.marks.find(
      (m): m is ArcGeometry => m.kind === "arc" && m.key === "sunburst-root",
    )!;
    const [cx, cy] = [center.arcs[0]!, center.arcs[1]!];
    const middle = model.inspect(cx, cy) as ItemInspection;
    expect(middle.key).toBe('[0,"Europe"]');
    expect(middle.points[0]!.text).toBe("70");
    const [first, second] = items(model);
    expect(first!.key).toBe('[0,"Europe"]');
    expect(second!.points[0]!.label).toBe("Europe / France");
    // The rings start at the root's children.
    expect(texts(scene).flatMap((t) => t.labels)).toContain("France");
  });
});

/** A chart bound to a store of `sales`, as a mounted chart binds it. */
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

describe("tree row selection", () => {
  it("selects a node's rows: its own and those under it", () => {
    const store = selectionStore(sales);
    const model = bound({ marks: [tree()] }, store);
    const europe = items(model).find((item) => item.points[0]!.label === "Europe")!;
    // Europe's header strip, along the top of its box, is Europe's own.
    const [x, y] = europe.outline.match(/-?[\d.]+/g)!.map(Number);
    const tables = new Set([sales as unknown as Table]);
    expect(clickedRows(model, tables, x! + 3, y! + 3)?.rows).toEqual(Uint32Array.of(0, 1, 2));
    const paris = items(model).find((item) => item.points[0]!.label.endsWith("Paris"))!;
    const { px, py } = paris.points[0]!;
    expect(clickedRows(model, tables, px, py)?.rows).toEqual(Uint32Array.of(0));
  });

  it("draw each node's selected share, dimming the rest, saying how much of a node is selected", () => {
    const store = selectionStore(sales);
    const model = bound({ marks: [tree()] }, store);
    store.set("c", selectRows(new RowSet(sales).add(0)));
    const scene = model.scene(estimateText);
    const dimmed = rects(scene).filter((r) => r.key.endsWith("-dimmed"));
    expect(dimmed.length).toBeGreaterThan(0);
    expect(dimmed.every((r) => r.fillOpacity < 1 * DIM + 1e-9)).toBe(true);
    const france = items(model).find((item) => item.points[0]!.label === "Europe / France")!;
    expect(france.points[0]!.text).toBe("50 (33.3%); 1 of 2 rows selected, revenue 40 of 50");
    const sun = bound(
      { marks: [sunburst(sales, { path: ["region", "country"], value: "revenue" })] },
      store,
    );
    const arcs = sun.scene(estimateText).panels[0]!.marks.filter((m) => m.kind === "arc");
    expect(arcs.map((m) => m.key)).toEqual([
      "sunburst-1-dimmed",
      "sunburst-1",
      "sunburst-2-dimmed",
      "sunburst-2",
    ]);
  });
});

describe("drill roots", () => {
  it("draw a drilled treemap's branches under keys of their own", () => {
    const { model } = build({ marks: [tree()] });
    model.items!.setDrillRoot(["Europe"]);
    const marks = model.scene(estimateText).panels[0]!.marks;
    const keys = marks.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    // France and Spain: a group and a leaf geometry each.
    expect(marks.filter((m) => m.kind === "rect")).toHaveLength(4);
  });

  it("compare a change with the root set, though not drawn yet", () => {
    const { model } = build({ marks: [tree()] });
    expect(model.items!.setDrillRoot(["Europe"])!.key).toBe('[0,"Europe"]');
    expect(model.items!.drillRoot()!.key).toBe('[0,"Europe"]');
    expect(model.items!.setDrillRoot(null)).toEqual({ key: null, path: [] });
    expect(model.items!.setDrillRoot(null)).toBeUndefined();
    model.scene(estimateText);
    expect(model.items!.drillRoot()).toEqual({ key: null, path: [] });
    expect(model.items!.reconciled()).toBeUndefined();
  });

  it("fall back to the nearest ancestor that remains, also by node and parent, and say so once", () => {
    const org = table({
      name: ["CEO", "CTO", "Dev", "CFO"],
      boss: [null, "CEO", "CTO", "CEO"],
      cost: [5, 3, 2, 4],
    });
    const { model } = build({
      marks: [treemap(org, { node: "name", parent: "boss", value: "cost" })],
    });
    model.items!.setDrillRoot(["CEO", "CTO", "Dev"]);
    model.scene(estimateText);
    expect(model.items!.drillRoot()!.key).toBe('[0,"Dev"]');
    // Dev and CTO go; CEO stays.
    org.reset({ name: ["CEO", "CFO"], boss: [null, "CEO"], cost: [5, 4] });
    model.scene(estimateText);
    expect(model.items!.drillRoot()).toEqual({
      key: '[0,"CEO"]',
      path: [{ key: '[0,"CEO"]', label: "CEO" }],
    });
    expect(model.items!.reconciled()!.key).toBe('[0,"CEO"]');
    expect(model.items!.reconciled()).toBeUndefined();
  });
});

describe("drill changes the data makes", () => {
  it("are not reported once the chart drilled again", () => {
    const data = table({ region: ["A", "A", "B"], country: ["x", "y", "z"] });
    const { model } = build({ marks: [treemap(data, { path: ["region", "country"] })] });
    model.items!.setDrillRoot(["A", "x"]);
    model.scene(estimateText);
    data.reset({ region: ["A", "B"], country: ["y", "z"] });
    model.scene(estimateText);
    model.items!.setDrillRoot(["B"]);
    expect(model.items!.reconciled()).toBeUndefined();
  });
});
