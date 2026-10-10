import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type { PointGeometry } from "../../src/scene/scene.ts";

function scene(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

const pointsOf = (config: ChartConfig) =>
  scene(config)
    .scene.panels[0]!.marks.filter((m): m is PointGeometry => m.kind === "point")
    .map((g) => g.count);

describe("marks over row views", () => {
  const requests = table({
    ms: [120, 340, 90, 410, 220, 60],
    size: [1, 2, 3, 4, 5, 6],
    host: ["a", "b", "a", "b", "a", "b"],
  });

  it("draw only the view's rows, reading the table's columns", () => {
    const slow = rowView(requests, { filter: col("ms").gt(200) });
    const { model } = scene({ marks: [point(slow, { x: "size", y: "ms" })] });
    expect(model.series()[0]!.length).toBe(3);
    expect(model.series()[0]!.rows).toEqual(Uint32Array.of(1, 3, 4));
    // The series reads the table's own column: nothing is copied.
    expect(model.series()[0]!.y).toBe(requests.numbers("ms"));
  });

  it("split series within the view's rows", () => {
    const slow = rowView(requests, { filter: col("ms").gt(100) });
    expect(pointsOf({ marks: [point(slow, { x: "size", y: "ms", series: "host" })] })).toEqual([
      2, 2,
    ]);
  });

  it("follow the view as its query changes and its table grows", () => {
    const t = table({ x: [1, 2, 3], y: [5, 6, 7] });
    const view = rowView(t, { filter: col("y").gt(5) });
    const mark = point(view, { x: "x", y: "y" });
    const model = new ChartModel({ marks: [mark] });
    model.setSize(400, 200, 1);
    const count = () => (model.scene(estimateText).panels[0]!.marks[0] as PointGeometry).count;
    expect(count()).toBe(2);
    view.setQuery({ filter: col("y").gt(6) });
    expect(count()).toBe(1);
    t.append({ x: [4, 5], y: [9, 1] });
    expect(count()).toBe(2);
  });

  it("show what a shared selection store says, filtered by one channel and restricted by another", () => {
    const store = selectionStore(requests);
    const view = rowView(requests);
    // The application decides how views follow the store's channels.
    store.subscribe(() => {
      view.setQuery({ filter: store.condition(["brush"]) });
      const picked = store.get("grid");
      view.restrict(picked?.kind === "rows" ? picked.rows : null);
    });
    const mark = point(view, { x: "size", y: "ms" });
    store.set("brush", selectWhere(col("ms").ge(100)));
    expect(pointsOf({ marks: [mark] })).toEqual([4]);
    store.set("grid", selectRows(new RowSet(requests).add(0).add(2).add(3)));
    // Rows 0 and 3 are picked and brushed; row 2 (90 ms) is outside the brush.
    expect(pointsOf({ marks: [mark] })).toEqual([2]);
  });

  it("keep their scene's positions when another reader catches the view up", () => {
    const t = table({ x: [1, 2, 3, 4], y: [1, 2, 3, 4] });
    const view = rowView(t, { filter: col("x").gt(1) });
    const { model } = scene({ marks: [point(view, { x: "x", y: "y" })] });
    const rows = model.series()[0]!.rows!;
    t.dropFirst(1);
    // A grid reading the view rebases its positions; the scene's stay as drawn.
    view.read();
    expect(Array.from(rows)).toEqual([1, 2, 3]);
  });

  it("refuse to be split by facets, which come from whole tables, but repeat in every panel", () => {
    const view = rowView(requests, { filter: col("ms").gt(100) });
    expect(() =>
      scene({ marks: [point(view, { x: "size", y: "ms" })], facet: facet("host") }),
    ).toThrow(/point facet: a row view cannot split into facets yet/);
    // Panels come from marks split over whole tables; the view's points repeat in each.
    const repeated = scene({
      marks: [
        point(requests, { x: "size", y: "ms" }),
        point(view, { x: "size", y: "ms", facet: "repeat" }),
      ],
      facet: facet("host"),
    });
    expect(repeated.scene.panels).toHaveLength(2);
  });

  it("refuse a view of another table", async () => {
    const { PointMark } = await import("../../src/marks/point.ts");
    expect(
      () =>
        new PointMark(
          { type: "point", x: "size", y: "ms" },
          requests as never,
          rowView(table({ ms: [1], size: [1] })) as never,
        ),
    ).toThrow("point: the view must be of the mark's table");
  });
});
