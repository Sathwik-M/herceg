// Pivot grids without a DOM: a pivot's rows and generated columns, their
// layout and focus kept by id as values come and go, sorting by generated
// columns, and rows selecting their rows of the view.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { count, mean } from "../../src/data/derive.ts";
import { pivotRows } from "../../src/data/pivot.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { type Schema, table } from "../../src/data/table.ts";
import type { PlacedColumn } from "../../src/grid/columns.ts";
import { createPivotGridModel, type PivotGridModel } from "../../src/grid/pivot.ts";

/** The headings over the shown columns, as the DOM grid draws them. */
const headings = <S extends Schema>(model: PivotGridModel<S>) =>
  (model.columnLayout as readonly PlacedColumn[]).map(({ content }) => content.heading?.title);

/** Requests by region and service. */
const requests = () =>
  table({
    region: category(["eu", "us", "eu", "ap", "us", "eu", null]),
    service: category(["api", "web", "web", "api", "api", "db", "api"]),
    ms: [10, 20, Number.NaN, 5, 7, 3, 1],
  });

function pivoted(
  options: { ops?: object; totals?: boolean; zeroFill?: "count"; limits?: object } = {},
) {
  const t = requests();
  const view = rowView(t);
  const pivot = pivotRows(view, {
    rows: "region",
    pivot: "service",
    ops: { n: count(), avg: mean("ms") },
    ...options,
  } as never);
  const model = createPivotGridModel({
    data: pivot,
    aggregates: { avg: { title: "Latency", format: { maximumFractionDigits: 1 } } },
    locale: "en-US",
    rowHeight: 10,
  });
  model.setViewport(400, 100);
  return { t, view, pivot, model };
}

/** Every row's cells as text. */
const cells = <S extends Schema>(model: PivotGridModel<S>) =>
  Array.from({ length: model.rowCount }, (_, row) =>
    model.columnLayout.map((_, column) => model.textAt(row, column)),
  );

const id = (value: string, aggregate: string) =>
  JSON.stringify([
    "pivot",
    "service",
    "category",
    value,
    aggregate,
    aggregate === "n" ? "count" : "mean",
    aggregate === "n" ? null : "ms",
  ]);

describe("pivot grids", () => {
  it("show a row per row key and a column per value and aggregate, absent cells blank", () => {
    const { model } = pivoted({ totals: true });
    expect(model.columnLayout.map(({ title }) => title)).toEqual([
      "region",
      "n",
      "Latency",
      "n",
      "Latency",
      "n",
      "Latency",
      "n",
      "Latency",
    ]);
    expect(model.columns.map(({ title }) => title)).toEqual([
      "region",
      "api, n",
      "api, Latency",
      "web, n",
      "web, Latency",
      "db, n",
      "db, Latency",
      "Total, n",
      "Total, Latency",
    ]);
    expect(headings(model)).toEqual([
      undefined,
      "api",
      "api",
      "web",
      "web",
      "db",
      "db",
      "Total",
      "Total",
    ]);
    expect(cells(model)).toEqual([
      ["eu", "1", "10", "1", "", "1", "3", "3", "6.5"],
      ["us", "1", "7", "1", "20", "", "", "2", "13.5"],
      ["ap", "1", "5", "", "", "", "", "1", "5"],
      ["(missing)", "1", "1", "", "", "", "", "1", "1"],
    ]);
    expect(model.row(0)).toMatchObject({ kind: "group", key: ["eu"], rows: 3, expanded: false });
  });

  it("head each column with its value alone when there is one aggregate, and fill counts when asked", () => {
    const { model } = pivoted({ ops: { n: count() }, zeroFill: "count" });
    expect(model.columnLayout.map(({ title }) => title)).toEqual(["region", "api", "web", "db"]);
    expect(headings(model).some((heading) => heading !== undefined)).toBe(false);
    expect(cells(model)[2]).toEqual(["ap", "1", "0", "0"]);
  });

  it("keep widths, pins, hidden columns, and the focus with their columns as values arrive", () => {
    const { t, model } = pivoted();
    model.resizeColumn(id("web", "n"), 200);
    model.pinColumn(id("db", "avg"), "right");
    model.setColumnVisible(id("api", "avg"), false);
    model.focusCell(1, id("web", "avg"));
    // "cache" sorts before nothing new; "auth" is new to the dictionary too.
    t.append({ region: ["eu", "us"], service: ["cache", "auth"], ms: [1, 2] });
    expect(model.rowCount).toBe(4);
    const columns = Object.fromEntries(model.columns.map((column) => [column.id, column]));
    expect(columns[id("web", "n")]!.width).toBe(200);
    expect(columns[id("db", "avg")]!.pin).toBe("right");
    expect(columns[id("api", "avg")]!.hidden).toBe(true);
    expect(columns[id("cache", "n")]).toMatchObject({ title: "cache, n" });
    expect(model.focus?.column).toBe(id("web", "avg"));
    expect(model.columns.map(({ id }) => id)).toEqual([
      "region",
      id("api", "n"),
      id("api", "avg"),
      id("web", "n"),
      id("web", "avg"),
      id("db", "n"),
      id("db", "avg"),
      id("cache", "n"),
      id("cache", "avg"),
      id("auth", "n"),
      id("auth", "avg"),
    ]);
  });

  it("put columns arriving after a move next to their neighbors, keeping the order the user chose", () => {
    const { t, model } = pivoted();
    model.moveColumn(id("db", "n"), id("api", "n"));
    model.moveColumn(id("db", "avg"), id("api", "n"));
    t.append({ region: ["eu"], service: ["cache"], ms: [1] });
    expect(model.columns.map(({ id }) => id)).toEqual([
      "region",
      id("db", "n"),
      id("db", "avg"),
      id("api", "n"),
      id("api", "avg"),
      id("web", "n"),
      id("web", "avg"),
      id("cache", "n"),
      id("cache", "avg"),
    ]);
  });

  it("restore a saved layout by id, holding that of columns not generated yet until they are", () => {
    const { t, model } = pivoted();
    const saved = [
      { field: "region", id: "region", width: 90, pin: "left" as const },
      { field: id("cache", "n"), id: id("cache", "n"), width: 70 },
    ];
    model.setColumns(saved);
    expect(model.columns[0]).toMatchObject({ id: "region", width: 90, pin: "left" });
    expect(model.columns.some(({ id: other }) => other === id("cache", "n"))).toBe(false);
    t.append({ region: ["eu"], service: ["cache"], ms: [1] });
    expect(model.columns.find(({ id: other }) => other === id("cache", "n"))?.width).toBe(70);
    expect(() => model.setColumns([saved[0]!, saved[0]!])).toThrow("Two grid columns");
    expect(() => model.setColumns([{ field: "region", width: 4 }])).toThrow(RangeError);
  });

  it("keep the first column in view in place as columns arrive before it", () => {
    const { t, model } = pivoted();
    model.scrollTo({ left: 360 });
    const first = model.columnLayout[model.visibleRange({ columns: 0 }).columnStart]!;
    const offset = first.x - model.left;
    t.append({ region: ["eu"], service: ["aaa"], ms: [1] });
    // "aaa" is last in the dictionary, so it goes last; one before in canonical order moves things.
    expect(model.columnLayout.find(({ id }) => id === first.id)!.x - model.left).toBe(offset);
  });

  it("sort rows by a generated column, absent and missing values last either way, and leave the view alone", () => {
    const { view, model } = pivoted({ zeroFill: "count" });
    const keys = () => Array.from({ length: model.rowCount }, (_, row) => model.textAt(row, 0));
    model.cycleSort(id("web", "avg"));
    // eu's web latency is missing; ap and (missing) have no web.
    expect(keys()).toEqual(["us", "eu", "ap", "(missing)"]);
    model.cycleSort(id("web", "avg"));
    expect(keys()).toEqual(["us", "eu", "ap", "(missing)"]);
    expect(model.sort).toEqual([{ field: id("web", "avg"), order: "descending" }]);
    // Filled counts sort as the zeros they show.
    model.cycleSort(id("db", "n"));
    expect(keys()).toEqual(["us", "ap", "(missing)", "eu"]);
    model.cycleSort("region", { additive: true });
    expect(model.sort).toHaveLength(2);
    model.setSort([{ field: "region", order: "descending" }]);
    expect(keys()).toEqual(["us", "eu", "ap", "(missing)"]);
    expect(view.query.sort).toBeUndefined();
    expect(() => model.setSort([{ field: "nope" }])).toThrow();
  });

  it("select a row's rows of the view into the store, partly once rows join it", () => {
    const { t, view, pivot } = pivoted();
    const store = selectionStore(t);
    const model = createPivotGridModel({ data: pivot, selection: store });
    model.setViewport(400, 100);
    model.select(0);
    const picked = store.get("grid-rows");
    expect(picked?.kind === "rows" && [...picked.rows.positions()]).toEqual([0, 2, 5]);
    expect(model.selectionState(0)).toBe("all");
    expect(model.selectedCount).toBe(3);
    t.append({ region: ["eu"], service: ["api"], ms: [1] });
    expect(model.selectionState(0)).toBe("some");
    // eu's four rows, us's two, and ap's.
    model.select(2, "range");
    expect(model.selectedCount).toBe(7);
    model.selectAll();
    expect(model.selectedCount).toBe(view.length);
    expect(() => (model as never as { setGroups(g: null): void }).setGroups(null)).toThrow();
  });

  it("move the focus between a row's cells with Left and Right, expanding nothing", () => {
    const { model } = pivoted();
    model.focusCell(0, "region");
    model.moveFocus("right");
    expect(model.focus?.column).toBe(id("api", "n"));
    model.moveFocus("left");
    expect(model.focus?.column).toBe("region");
    expect(model.rowCount).toBe(4);
  });

  it("show what a pivot held when it stopped at a limit, and select nothing more", () => {
    const { t, model } = pivoted({ limits: { generatedColumns: 6 } });
    model.select(0);
    const before = cells(model);
    t.append({ region: ["eu", "us"], service: ["cache", "api"], ms: [1, 2] });
    expect(cells(model)).toEqual(before);
    expect(model.selectionState(0)).toBe("all");
    const revision = model.selection.revision;
    model.select(1);
    model.selectAll();
    expect(model.selection.revision).toBe(revision);
  });

  it("select nothing from a change the pivot refused, even from a listener told of it first", () => {
    const t = table({ region: category(["eu"]), service: category(["api"]), ms: [1] });
    const pivot = pivotRows(rowView(t), {
      rows: "region",
      pivot: "service",
      ops: { n: count() },
      limits: { generatedColumns: 1 },
    });
    const model = createPivotGridModel({ data: pivot });
    model.subscribe(() => model.selectAll());
    t.append({ region: ["eu"], service: ["web"], ms: [2] });
    expect(pivot.failure).not.toBeNull();
    expect(model.selectedCount).toBe(0);
  });

  it("sort by a column generated since the model was last read", () => {
    const t = table({ region: category(["eu"]), service: [20], ms: [1] });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "service", ops: { n: count() } });
    const model = createPivotGridModel({ data: pivot });
    model.columnLayout;
    t.append({ region: ["us"], service: [10], ms: [2] });
    const ten = pivot.read().columns[0]!.id;
    model.cycleSort(ten);
    expect(model.sort).toEqual([{ field: ten, order: "ascending" }]);
  });

  it("drop the sort keys of columns gone, so sorting goes on by the others", () => {
    const t = table(
      { region: category(["eu", "us"]), service: [10, 20], ms: [1, 2] },
      { maxRows: 10 },
    );
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "service", ops: { n: count() } });
    const model = createPivotGridModel({ data: pivot });
    const [ten, twenty] = pivot.read().columns.map(({ id }) => id);
    model.cycleSort(ten!);
    t.dropFirst(1);
    // Read at once, the keys are of the columns there are, and can be given back.
    expect(model.sort).toEqual([]);
    model.setSort([...model.sort, { field: twenty! }]);
    model.cycleSort(twenty!, { additive: true });
    expect(model.sort).toEqual([{ field: twenty, order: "descending" }]);
  });

  it("read a pivot's columns as they are now, before any row is read", () => {
    const t = table({ region: category(["eu"]), service: [20], ms: [1] });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "service", ops: { n: count() } });
    const model = createPivotGridModel({ data: pivot, locale: "en-US" });
    t.append({ region: ["eu", "eu"], service: [10, 10], ms: [2, 3] });
    expect(model.columns.map(({ title }) => title)).toEqual(["region", "10", "20"]);
    t.append({ region: ["eu"], service: [5], ms: [4] });
    // The cell read first is of the column at that place now.
    expect(model.textAt(0, 2)).toBe("2");
  });

  it("refuse widths too narrow, and a rows field named like a generated column", () => {
    const { pivot } = pivoted();
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        createPivotGridModel({ data: pivot, aggregates: { n: { width } } } as never),
      ).toThrow(RangeError);
    expect(() => createPivotGridModel({ data: pivot, rowColumn: { width: 8 } })).toThrow(
      RangeError,
    );
    const odd = '["pivot","p","category","x","n","count",null]';
    const t = table({ [odd]: category(["a"]), p: category(["x"]) });
    const named = pivotRows(rowView(t), { rows: odd, pivot: "p", ops: { n: count() } } as never);
    expect(() => createPivotGridModel({ data: named })).toThrow("named like its columns");
  });

  it("put columns of a saved layout back where it had them when they arrive", () => {
    const { t, model } = pivoted();
    model.setColumns([
      { field: "region", id: "region" },
      { field: id("cache", "n"), id: id("cache", "n"), width: 70 },
      { field: id("db", "n"), id: id("db", "n") },
      { field: id("web", "n"), id: id("web", "n") },
      { field: id("api", "n"), id: id("api", "n") },
    ]);
    t.append({ region: ["eu"], service: ["cache"], ms: [1] });
    // In the saved order; the columns it left out go by their own order among them.
    const saved = ["region", id("cache", "n"), id("db", "n"), id("web", "n"), id("api", "n")];
    const ids = model.columns.map((column) => column.id!);
    expect(ids.filter((other) => saved.includes(other))).toEqual(saved);
    expect(model.columns[1]).toMatchObject({ id: id("cache", "n"), width: 70 });
  });
});
