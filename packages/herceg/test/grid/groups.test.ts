// Grouped grids: group header rows over a view's groups, expansion, focus,
// selection of groups' rows, group sorting, and streaming, without a DOM.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { count, max, mean, sum } from "../../src/data/derive.ts";
import { col } from "../../src/data/expression.ts";
import { groupRows } from "../../src/data/groups.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { type Schema, table } from "../../src/data/table.ts";
import { createGridModel, type GridModel } from "../../src/grid/model.ts";

/** Ten requests over three hosts and a missing one. */
const requests = () =>
  table({
    id: Float64Array.from({ length: 10 }, (_, i) => i),
    host: category(["web", "api", "web", "db", "api", "web", null, "db", "web", "api"]),
    ms: [12, 30, 8, 100, 45, 20, 5, 70, 16, 25],
    at: time(Float64Array.from({ length: 10 }, (_, i) => Date.UTC(2026, 0, 1, i))),
  });

/** What each row shows: a group's first cell, or a row's id. */
const shown = <S extends Schema>(model: GridModel<S>) =>
  Array.from({ length: model.rowCount }, (_, i) => {
    const row = model.row(i);
    return row.kind === "group" ? model.textAt(i, 0) : `  ${model.textAt(i, 0)}`;
  });

function grouped(options: { query?: object; ops?: object } = {}) {
  const t = requests();
  const view = rowView(t, options.query ?? {});
  const groups = groupRows(view, {
    by: ["host"],
    ops: { n: count(), total: sum("ms"), avg: mean("ms"), last: max("at") },
    ...options.ops,
  });
  const model = createGridModel({
    data: view,
    groups,
    columns: [
      { field: "id" },
      { field: "host" },
      { field: "ms", aggregate: "avg", format: { maximumFractionDigits: 1 } },
      { field: "at", aggregate: "last", format: { timeStyle: "short", hourCycle: "h23" } },
      { field: "id", id: "count", aggregate: "n" },
    ],
    locale: "en-US",
    timeZone: "UTC",
    rowHeight: 10,
  });
  model.setViewport(500, 50);
  return { t, view, groups, model };
}

describe("grouped grids", () => {
  it("show a header row per group, collapsed, with its key, row count, and aggregates", () => {
    const { model } = grouped();
    expect(model.rowCount).toBe(4);
    expect(shown(model)).toEqual(["web (4)", "api (3)", "db (2)", "(missing) (1)"]);
    expect(model.row(1)).toEqual({
      kind: "group",
      group: 1,
      key: ["api"],
      id: '["api"]',
      rows: 3,
      expanded: false,
      level: 1,
      setIndex: 1,
      setSize: 4,
    });
    // The grouping field's column shows the key; others their aggregate, in
    // the column's format when the aggregate keeps the field's kind, and
    // plainly for counts.
    expect([1, 2, 3, 4].map((c) => model.textAt(1, c))).toEqual(["api", "33.3", "09:00", "3"]);
    expect(() => model.rowAt(0)).toThrow(/group's header/);
    expect(() => model.identityAt(0)).toThrow(/group's header/);
  });

  it("expand and collapse groups by key, showing their rows in the view's order", () => {
    const { model } = grouped({ query: { sort: [{ field: "ms", order: "descending" }] } });
    model.setExpanded(["web"], true);
    expect(model.isExpanded(["web"])).toBe(true);
    expect(shown(model)).toEqual([
      "web (4)",
      "  5",
      "  8",
      "  0",
      "  2",
      "api (3)",
      "db (2)",
      "(missing) (1)",
    ]);
    expect(model.row(2)).toEqual({
      kind: "row",
      position: 8,
      identity: 8,
      group: 0,
      level: 2,
      setIndex: 1,
      setSize: 4,
    });
    expect(model.rowIndexOf(2)).toBe(4);
    expect(model.rowIndexOf(1)).toBe(-1);
    expect(model.rowIndexOfGroup(["db"])).toBe(6);
    model.expandAll();
    expect(model.rowCount).toBe(14);
    model.setExpanded(["api"], false);
    expect(model.rowCount).toBe(11);
    expect(model.rowIndexOf(1)).toBe(-1);
    model.collapseAll();
    expect(model.rowCount).toBe(4);
    expect(model.isExpanded(["web"])).toBe(false);
  });

  it("move the focus to a group's header when the group collapses, and treat a row's first cell as the tree's", () => {
    const { model } = grouped();
    model.setExpanded(["api"], true);
    // api's rows are 1, 4, 9 at rows 2 to 4.
    model.focusCell(3, "ms");
    expect(model.row(3)).toMatchObject({ kind: "row", position: 4 });
    model.setExpanded(["api"], false);
    expect(model.focus).toEqual({ rowIndex: 1, columnIndex: 2, column: "ms" });
    // Right on a collapsed group's first cell expands it; again, moves right.
    model.focusCell(1, "id");
    model.moveFocus("right");
    expect(model.isExpanded(["api"])).toBe(true);
    expect(model.focus!.columnIndex).toBe(0);
    model.moveFocus("down");
    model.moveFocus("down");
    // Left on a row's first cell goes to its group; on the expanded group, collapses it.
    model.moveFocus("left");
    expect(model.focus).toEqual({ rowIndex: 1, columnIndex: 0, column: "id" });
    model.moveFocus("left");
    expect(model.isExpanded(["api"])).toBe(false);
    model.moveFocus("right");
    model.moveFocus("right");
    expect(model.focus).toEqual({ rowIndex: 1, columnIndex: 1, column: "host" });
  });

  it("select a group's rows, collapsed or not, into the channel's row set, and say how much of it is selected", () => {
    const { t, model } = grouped();
    model.select(0);
    const rows = () => {
      const selection = model.selection.get("grid-rows");
      return selection?.kind === "rows" ? Array.from(selection.rows.positions()) : [];
    };
    expect(rows()).toEqual([0, 2, 5, 8]);
    expect(model.selectionState(0)).toBe("all");
    expect(model.isSelected(0)).toBe(true);
    expect(model.selectedCount).toBe(4);
    model.setExpanded(["web"], true);
    // A row of the group toggled off leaves the group partly selected.
    model.select(2, "toggle");
    expect(model.selectionState(0)).toBe("some");
    expect(model.isSelected(0)).toBe(false);
    expect(model.selectionState(1)).toBe("all");
    expect(model.selectionState(2)).toBe("none");
    // Toggling a group not wholly selected selects it all; wholly selected, clears it.
    model.select(0, "toggle");
    expect(model.selectionState(0)).toBe("all");
    model.select(0, "toggle");
    expect(model.selectionState(0)).toBe("none");
    expect(rows()).toEqual([]);
    // Ranges add every row of the groups whose headers they cover, and the rows in them.
    model.select(3);
    model.select(6, "range");
    // Rows 3 to 4 are web's rows 5 and 8, then api's header (1, 4, 9) and db's (3, 7).
    expect(rows()).toEqual([1, 3, 4, 5, 7, 8, 9]);
    expect([5, 6, 7].map((i) => model.selectionState(i))).toEqual(["all", "all", "none"]);
    expect(model.selectionState(0)).toBe("some");
    // Rows appended later are not selected; their groups count them.
    t.append({ id: [10, 11], host: ["api", "cache"], ms: [1, 2], at: [0, 0] });
    expect(model.selectionState(5)).toBe("some");
    expect(model.row(8)).toMatchObject({ kind: "group", key: ["cache"] });
    expect(model.selectionState(8)).toBe("none");
  });

  it("count a condition in the channel, and selections made elsewhere, per group", () => {
    const t = requests();
    const store = selectionStore(t);
    const view = rowView(t);
    const model = createGridModel({
      data: view,
      groups: groupRows(view, { by: ["host"] }),
      columns: [{ field: "id" }],
      selection: store,
    });
    store.set("grid-rows", selectWhere(col("ms").gt(20)));
    expect([0, 1, 2, 3].map((i) => model.selectionState(i))).toEqual([
      "none",
      "all",
      "all",
      "none",
    ]);
    // A condition takes rows appended later.
    t.append({ id: [10], host: ["web"], ms: [99], at: [0] });
    expect(model.selectionState(0)).toBe("some");
    store.set("grid-rows", selectRows(new RowSet(t).add(6)));
    expect(model.selectionState(3)).toBe("all");
    // Rows the view leaves out count for no group.
    view.setQuery({ filter: col("id").ne(6) });
    expect(model.rowCount).toBe(3);
    expect([0, 1, 2].map((i) => model.selectionState(i))).toEqual(["none", "none", "none"]);
  });

  it("count again when the store's listeners change the view", () => {
    const { view, model } = grouped();
    model.setExpanded(["web"], true);
    expect(model.selectionState(0)).toBe("none");
    let filter = true;
    model.selection.subscribe(() => {
      if (!filter) return;
      filter = false;
      view.setQuery({ filter: col("id").ne(0) });
    });
    // web's first row (id 0), which the listener then filters out.
    model.select(1);
    expect(model.row(0)).toMatchObject({ key: ["web"], rows: 3 });
    expect(model.selectionState(0)).toBe("none");
  });

  it("count a row set put in the channel again after it changed", () => {
    const t = requests();
    const store = selectionStore(t);
    const view = rowView(t);
    const model = createGridModel({
      data: view,
      groups: groupRows(view, { by: ["host"] }),
      columns: [{ field: "id" }],
      selection: store,
    });
    // db's rows are 3 and 7.
    const rows = new RowSet(t).add(3);
    const selection = selectRows(rows);
    store.set("grid-rows", selection);
    expect(model.selectionState(2)).toBe("some");
    rows.add(7);
    store.set("grid-rows", selection);
    expect(model.selectionState(2)).toBe("all");
    rows.delete(3).delete(7);
    store.set("grid-rows", selection);
    expect(model.selectionState(2)).toBe("none");
    // Toggling the group then selects all of it.
    model.select(2, "toggle");
    expect(model.selectionState(2)).toBe("all");
  });

  it("sort groups by a column's aggregate or key, and rows within them by its field", () => {
    const { model } = grouped();
    model.setExpanded(["db"], true);
    model.cycleSort("ms");
    expect(model.sort).toEqual([{ field: "ms", order: "ascending" }]);
    expect(model.groupSort).toEqual([{ field: "avg", order: "ascending" }]);
    // Means: missing 5, web 14, api 33.3, db 85.
    expect(shown(model)).toEqual(["(missing) (1)", "web (4)", "api (3)", "db (2)", "  7", "  3"]);
    model.cycleSort("host");
    expect(model.groupSort).toEqual([{ field: "host", order: "ascending" }]);
    expect(shown(model).filter((text) => !text.startsWith(" "))).toEqual([
      "api (3)",
      "db (2)",
      "web (4)",
      "(missing) (1)",
    ]);
    model.cycleSort("count", { additive: true });
    expect(model.groupSort).toEqual([
      { field: "host", order: "ascending" },
      { field: "n", order: "ascending" },
    ]);
    // A column without an aggregate sorts rows and leaves groups as they came.
    model.cycleSort("id");
    expect(model.groupSort).toEqual([]);
    model.setGroupSort([{ field: "total", order: "descending" }]);
    expect(model.row(0)).toMatchObject({ key: ["db"] });
    expect(() => model.setGroupSort([{ field: "ms" }])).toThrow(/no field "ms"/);
  });

  it("keep the focused group and the top row as rows stream into existing and new groups", () => {
    const { t, model } = grouped();
    model.setViewport(500, 20);
    model.setGroupSort([{ field: "n", order: "descending" }]);
    model.setExpanded(["db"], true);
    // web 4, api 3, db 2 (rows 3 and 7), missing 1.
    model.focusCell(2, "id");
    expect(model.row(2)).toMatchObject({ kind: "group", key: ["db"] });
    // db's first row at the top, 5 pixels into it.
    model.scrollTo({ top: 35 });
    t.append({
      id: [10, 11, 12, 13],
      host: ["db", "db", "db", "new"],
      ms: [1, 2, 3, 4],
      at: [0, 0, 0, 0],
    });
    // db now leads with 5 rows: its header moves to the top, the focus with it.
    expect(model.row(0)).toMatchObject({ kind: "group", key: ["db"], rows: 5 });
    expect(model.focus!.rowIndex).toBe(0);
    expect(model.row(model.rowCount - 1)).toMatchObject({ kind: "group", key: ["new"] });
    expect(shown(model).slice(0, 6)).toEqual(["db (5)", "  3", "  7", "  10", "  11", "  12"]);
    // The top row stayed at the top, 5 pixels in.
    expect(model.top).toBe(15);
    expect(model.textAt(1, 0)).toBe("3");
  });

  it("order groups by their final aggregates when listeners of the groups' table read the grid", () => {
    const { t, groups, model } = grouped();
    model.setGroupSort([{ field: "total", order: "descending" }]);
    expect(model.row(0)).toMatchObject({ key: ["db"] });
    // A listener of the groups' table reads the grid as the change is told.
    const first: unknown[] = [];
    groups.table.subscribe(() => first.push(model.row(0).kind === "group" && model.row(0)));
    t.append({ id: [10], host: ["web"], ms: [200], at: [0] });
    expect(first).toEqual([expect.objectContaining({ key: ["web"] })]);
    expect(model.row(0)).toMatchObject({ key: ["web"] });
  });

  it("keep expansion and the focused group by key through a reset, and drop rows that leave", () => {
    const { t, model } = grouped();
    model.setExpanded(["db"], true);
    model.focusCell(model.rowIndexOfGroup(["db"]), "id");
    t.reset({
      id: [0, 1, 2],
      host: ["db", "x", "db"],
      ms: [1, 2, 3],
      at: [0, 0, 0],
    });
    expect(shown(model)).toEqual(["db (2)", "  0", "  2", "x (1)"]);
    expect(model.focus!.rowIndex).toBe(0);
    // A focused row that leaves gives the focus to the row now at its place.
    model.focusCell(2, "id");
    t.set("host", 2, "x");
    expect(shown(model)).toEqual(["db (1)", "  0", "x (2)"]);
    expect(model.focus!.rowIndex).toBe(2);
  });

  it("go back to plain rows without groups, and refuse groups of another view or aggregates they lack", () => {
    const { t, view, model } = grouped();
    model.setExpanded(["web"], true);
    model.focusCell(2, "id");
    model.setGroups(null);
    expect(model.rowCount).toBe(10);
    // The focused row keeps the focus.
    expect(model.focus!.rowIndex).toBe(model.rowIndexOf(model.identityAt(model.focus!.rowIndex)));
    expect(model.textAt(model.focus!.rowIndex, 0)).toBe("2");
    expect(() => model.setGroups(groupRows(rowView(t), { by: ["host"] }))).toThrow(/of its view/);
    expect(() =>
      createGridModel({
        data: view,
        groups: groupRows(view, { by: ["host"] }),
        columns: [{ field: "ms", aggregate: "nope" }],
      }),
    ).toThrow(/"ms" shows "nope", which the groups lack/);
    // Aggregates are ignored without groups.
    expect(() =>
      createGridModel({ data: view, columns: [{ field: "ms", aggregate: "nope" }] }),
    ).not.toThrow();
  });
});

/** Ten requests over two regions and a missing one, each over hosts. */
const regional = (options: { maxRows?: number } = {}) =>
  table(
    {
      id: Float64Array.from({ length: 10 }, (_, i) => i),
      region: category(["eu", "us", "eu", "us", "eu", "eu", "us", null, "eu", "us"]),
      host: category(["web", "api", "api", "api", "web", "db", "web", "web", "api", "api"]),
      ms: [12, 30, 8, 100, 45, 20, 5, 70, 16, 25],
    },
    options,
  );

function nested(t = regional(), query: object = {}) {
  const view = rowView(t, query);
  const groups = groupRows(view, {
    by: ["region", "host"],
    ops: { n: count(), avg: mean("ms") },
  });
  const model = createGridModel({
    data: view,
    groups,
    columns: [
      { field: "id" },
      { field: "region" },
      { field: "host" },
      { field: "ms", aggregate: "avg", format: { maximumFractionDigits: 1 } },
      { field: "id", id: "count", aggregate: "n" },
    ],
    locale: "en-US",
    rowHeight: 10,
  });
  model.setViewport(500, 50);
  return { t, view, groups, model };
}

/** What each row shows, indented by its level: a group's first cell, or a row's id. */
const tree = <S extends Schema>(model: GridModel<S>) =>
  Array.from({ length: model.rowCount }, (_, i) => {
    const row = model.row(i);
    return `${"  ".repeat(row.level - 1)}${model.textAt(i, 0)}`;
  });

describe("nested grouped grids", () => {
  // eu: web (0, 4), api (2, 8), db (5); us: api (1, 3, 9), web (6); missing: web (7).
  it("show each level's groups under their parents, with their own keys and aggregates", () => {
    const { model } = nested();
    expect(tree(model)).toEqual(["eu (5)", "us (4)", "(missing) (1)"]);
    model.setExpanded(["eu"], true);
    expect(tree(model)).toEqual([
      "eu (5)",
      "  web (2)",
      "  api (2)",
      "  db (1)",
      "us (4)",
      "(missing) (1)",
    ]);
    expect(model.row(0)).toEqual({
      kind: "group",
      group: 0,
      key: ["eu"],
      id: '["eu"]',
      rows: 5,
      expanded: true,
      level: 1,
      setIndex: 0,
      setSize: 3,
    });
    expect(model.row(2)).toMatchObject({ key: ["eu", "api"], level: 2, setIndex: 1, setSize: 3 });
    // A grouping field's column shows its value on its level and below; aggregates are each level's.
    expect([1, 2, 3, 4].map((c) => model.textAt(0, c))).toEqual(["eu", "", "20.2", "5"]);
    expect([1, 2, 3, 4].map((c) => model.textAt(2, c))).toEqual(["eu", "api", "12", "2"]);
    model.setExpanded(["eu", "api"], true);
    expect(tree(model).slice(2, 5)).toEqual(["  api (2)", "    2", "    8"]);
    expect(model.row(3)).toMatchObject({
      kind: "row",
      position: 2,
      level: 3,
      setIndex: 0,
      setSize: 2,
    });
    expect(model.rowIndexOfGroup(["eu", "db"])).toBe(5);
    expect(model.rowIndexOf(8)).toBe(4);
    // Collapsing a parent hides its groups, which keep their own expansion.
    model.setExpanded(["eu"], false);
    expect([model.rowCount, model.rowIndexOf(8), model.rowIndexOfGroup(["eu", "api"])]).toEqual([
      3, -1, -1,
    ]);
    expect(model.isExpanded(["eu", "api"])).toBe(true);
    model.expandAll();
    expect(model.rowCount).toBe(3 + 6 + 10);
    model.collapseAll();
    expect(model.rowCount).toBe(3);
  });

  it("move the focus to the collapsing group above, and between levels with the arrows", () => {
    const { model } = nested();
    model.setExpanded(["eu"], true);
    model.setExpanded(["eu", "api"], true);
    // Row 8, eu's second api row.
    model.focusCell(4, "ms");
    model.setExpanded(["eu"], false);
    expect(model.focus).toEqual({ rowIndex: 0, columnIndex: 3, column: "ms" });
    model.setExpanded(["eu"], true);
    // From a row's first cell, Left goes to its group, collapses it, then goes to the group above.
    model.focusCell(4, "id");
    model.moveFocus("left");
    expect(model.focus!.rowIndex).toBe(2);
    model.moveFocus("left");
    expect(model.isExpanded(["eu", "api"])).toBe(false);
    model.moveFocus("left");
    expect(model.focus!.rowIndex).toBe(0);
    model.moveFocus("left");
    expect(model.isExpanded(["eu"])).toBe(false);
    model.moveFocus("left");
    expect(model.focus).toEqual({ rowIndex: 0, columnIndex: 0, column: "id" });
    model.moveFocus("right");
    model.moveFocus("down");
    model.moveFocus("right");
    expect(model.isExpanded(["eu", "web"])).toBe(true);
    expect(tree(model).slice(1, 4)).toEqual(["  web (2)", "    0", "    4"]);
  });

  it("select a group's rows at every level, and say how much of each group is selected", () => {
    const { model } = nested();
    const selected = () => {
      const selection = model.selection.get("grid-rows");
      return selection?.kind === "rows" ? Array.from(selection.rows.positions()) : [];
    };
    model.select(0);
    expect(selected()).toEqual([0, 2, 4, 5, 8]);
    model.setExpanded(["eu"], true);
    model.setExpanded(["eu", "api"], true);
    expect([0, 1, 2, 3, 6].map((i) => model.selectionState(i))).toEqual([
      "all",
      "all",
      "all",
      "all",
      "none",
    ]);
    // Row 8 toggled off: its group and the one above are partly selected.
    model.select(4, "toggle");
    expect([0, 1, 2, 5].map((i) => model.selectionState(i))).toEqual([
      "some",
      "all",
      "some",
      "all",
    ]);
    // Counted again from the store, the counts agree.
    model.selection.set("grid-rows", model.selection.get("grid-rows"));
    expect([0, 1, 2, 5].map((i) => model.selectionState(i))).toEqual([
      "some",
      "all",
      "some",
      "all",
    ]);
    // Toggling the partly selected group above selects all of it again.
    model.select(0, "toggle");
    expect(model.selectionState(2)).toBe("all");
    model.select(0, "toggle");
    expect(selected()).toEqual([]);
    // A range from eu's api rows to us's header takes those rows, db, and all of us.
    model.select(3);
    model.select(6, "range");
    expect(selected()).toEqual([1, 2, 3, 5, 6, 8, 9]);
    expect([0, 6, 7].map((i) => model.selectionState(i))).toEqual(["some", "all", "none"]);
  });

  it("sort each level's groups among their siblings, by aggregates or by their own key", () => {
    const { model } = nested();
    model.expandAll();
    model.setGroupSort([{ field: "n", order: "descending" }]);
    const groupsShown = () => tree(model).filter((text) => !/^ *\d+$/.test(text));
    // Ties keep the order groups appeared in.
    expect(groupsShown()).toEqual([
      "eu (5)",
      "  web (2)",
      "  api (2)",
      "  db (1)",
      "us (4)",
      "  api (3)",
      "  web (1)",
      "(missing) (1)",
      "  web (1)",
    ]);
    // A grouping field's column orders its own level; the levels above keep their order.
    model.cycleSort("host");
    expect(model.groupSort).toEqual([{ field: "host", order: "ascending" }]);
    expect(groupsShown().slice(0, 7)).toEqual([
      "eu (5)",
      "  api (2)",
      "  db (1)",
      "  web (2)",
      "us (4)",
      "  api (3)",
      "  web (1)",
    ]);
    model.cycleSort("region");
    model.cycleSort("region");
    expect(groupsShown().filter((text) => !text.startsWith(" "))).toEqual([
      "us (4)",
      "eu (5)",
      "(missing) (1)",
    ]);
    // Rows sort within their group.
    model.setSort([{ field: "ms", order: "descending" }]);
    expect(tree(model).slice(1, 5)).toEqual(["  api (3)", "    3", "    1", "    9"]);
  });

  it("order groups by every level's final aggregates when listeners of a level's table read the grid", () => {
    const t = table({ g: ["a", "a"], h: ["x", "y"], v: [10, 20] });
    const view = rowView(t);
    const groups = groupRows(view, { by: ["g", "h"], ops: { total: sum("v") } });
    const model = createGridModel({
      data: view,
      groups,
      columns: [{ field: "g" }, { field: "v", aggregate: "total" }],
    });
    model.setExpanded(["a"], true);
    model.setGroupSort([{ field: "total" }]);
    groups.tableOf("g").subscribe(() => model.rowCount);
    // x's total passes y's.
    t.append({ g: ["a"], h: ["x"], v: [20] });
    expect([1, 2].map((i) => model.row(i))).toEqual([
      expect.objectContaining({ key: ["a", "y"] }),
      expect.objectContaining({ key: ["a", "x"] }),
    ]);
  });

  it("stream a rolling window into expanded groups, keeping the top row, the focus, and each group's rows current", () => {
    const random = (() => {
      let seed = 9;
      return () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
    })();
    const t = regional({ maxRows: 60 });
    const { model, groups } = nested(t, { sort: [{ field: "ms" }] });
    model.setGroupSort([{ field: "region" }, { field: "host" }]);
    model.expandAll();
    model.setViewport(500, 100);
    let id = 10;
    for (let step = 0; step < 30; step++) {
      // A row of the table near the middle at the top, 3 pixels in, and focused.
      const rows = Array.from({ length: model.rowCount }, (_, i) => i).filter(
        (i) => model.row(i).kind === "row",
      );
      const top = rows[rows.length >> 1]!;
      const identity = model.identityAt(top);
      model.scrollTo({ top: top * 10 + 3 });
      model.focusCell(top, "ms", { reveal: false });
      const n = 1 + Math.floor(random() * 8);
      t.append({
        id: Array.from({ length: n }, () => id++),
        region: Array.from(
          { length: n },
          () => ["eu", "us", "ap", null][Math.floor(random() * 4)]!,
        ),
        host: Array.from({ length: n }, () => ["web", "api", "db"][Math.floor(random() * 3)]!),
        ms: Array.from({ length: n }, () => Math.floor(random() * 100)),
      });
      const fresh = nested(t, { sort: [{ field: "ms" }] }).model;
      fresh.setGroupSort([{ field: "region" }, { field: "host" }]);
      fresh.expandAll();
      expect(tree(model)).toEqual(tree(fresh));
      expect(groups.length).toBe(fresh.groups!.length);
      const at = model.rowIndexOf(identity);
      if (at >= 0) {
        expect(model.top).toBe(Math.min(at * 10 + 3, model.contentHeight - 100));
        expect(model.focus!.rowIndex).toBe(at);
      }
    }
  });
});
