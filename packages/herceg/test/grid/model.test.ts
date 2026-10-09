import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { col } from "../../src/data/expression.ts";
import { geometry } from "../../src/data/geometry.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { type Schema, table } from "../../src/data/table.ts";
import { createGridModel, type GridModel } from "../../src/grid/model.ts";

const requests = () =>
  table({
    id: Float64Array.from({ length: 100 }, (_, i) => i),
    ms: Float64Array.from({ length: 100 }, (_, i) => (i * 37) % 100),
    host: category(Array.from({ length: 100 }, (_, i) => ["web", "api", "db"][i % 3]!)),
  });

/** Table positions of the rows shown, in order. */
const positions = <S extends Schema>(model: GridModel<S>) =>
  Array.from({ length: model.rowCount }, (_, i) => model.rowAt(i));

/** Values of a field down the grid. */
const column = <S extends Schema>(model: GridModel<S>, id: string) =>
  Array.from({ length: model.rowCount }, (_, i) => model.textAt(i, model.columnIndex(id)));

const selected = <S extends Schema>(model: GridModel<S>) =>
  Array.from({ length: model.rowCount }, (_, i) => i).filter((i) => model.isSelected(i));

describe("grid columns", () => {
  it("place shown columns side by side, with ids, titles, widths, and alignment", () => {
    const t = requests();
    const model = createGridModel({
      data: rowView(t),
      columns: [
        { field: "id", width: 60 },
        { field: "ms", title: "Latency", hidden: true },
        { field: "host", id: "server" },
        { field: "ms", id: "ms2", align: "center" },
      ],
    });
    expect(
      model.columnLayout.map(({ id, x, width, align, title }) => [id, x, width, align, title]),
    ).toEqual([
      ["id", 0, 60, "end", "id"],
      ["server", 60, 120, "start", "host"],
      ["ms2", 180, 120, "center", "ms"],
    ]);
    expect(model.width).toBe(300);
    expect(model.columns.map(({ id }) => id)).toEqual(["id", "ms", "server", "ms2"]);
    expect(model.columns[1]!.hidden).toBe(true);
  });

  it("refuse fields the table lacks or cannot show, repeated ids, and bad widths", () => {
    const square = {
      coordinates: Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
      ringOffsets: Int32Array.from([0, 4]),
      polygonOffsets: Int32Array.from([0, 1]),
      geometryOffsets: Int32Array.from([0, 1]),
    };
    const t = table({ x: [1], host: ["a"], shape: geometry(square) });
    const data = rowView(t);
    const make = (columns: never) => () => createGridModel({ data, columns });
    expect(make([{ field: "nope" }] as never)).toThrow(/Unknown grid field "nope"/);
    expect(make([{ field: "shape" }] as never)).toThrow(/cannot show geometry/);
    expect(make([{ field: "x" }, { field: "x" }] as never)).toThrow(
      /Two grid columns have the id "x"/,
    );
    expect(make([{ field: "x", width: 0 }] as never)).toThrow(/positive width/);
    expect(make([{ field: "host", format: { style: "percent" } }] as never)).toThrow(
      /take no format/,
    );
  });

  it("format numbers, times, categories, and missing values per column", () => {
    const t = table({
      v: [1234.567, 0.000123, Number.NaN, Number.POSITIVE_INFINITY, -2],
      at: time([Date.UTC(2026, 0, 2, 3, 4, 5), Number.NaN, 0, 8.64e15 + 1, Date.UTC(2026, 5, 1)]),
      host: ["web", null, "api", "web", "db"],
    });
    const model = createGridModel({
      data: rowView(t),
      columns: [
        { field: "v" },
        { field: "v", id: "pct", format: { style: "percent" } },
        { field: "at" },
        { field: "at", id: "day", format: { dateStyle: "medium" } },
        { field: "host" },
      ],
      locale: "en-US",
      timeZone: "UTC",
      missing: "–",
    });
    expect(column(model, "v")).toEqual(["1,234.57", "0.000123", "–", "∞", "-2"]);
    expect(column(model, "pct")).toEqual(["123,457%", "0%", "–", "∞%", "-200%"]);
    expect(column(model, "at")).toEqual([
      "Jan 2, 2026, 03:04:05",
      "–",
      "Jan 1, 1970, 00:00:00",
      // Past the range dates can show: the number itself.
      "8,640,000,000,000,001",
      "Jun 1, 2026, 00:00:00",
    ]);
    expect(column(model, "day")[0]).toBe("Jan 2, 2026");
    expect(column(model, "host")).toEqual(["web", "–", "api", "web", "db"]);
  });
});

describe("grid windows", () => {
  it("cover the rows and columns in view, with overscan, half open", () => {
    const t = requests();
    const model = createGridModel({
      data: rowView(t),
      columns: [{ field: "id" }, { field: "ms" }, { field: "host" }, { field: "id", id: "again" }],
      rowHeight: 20,
    });
    model.setViewport(200, 100);
    expect(model.visibleRange({ rows: 0, columns: 0 })).toEqual({
      rowStart: 0,
      rowEnd: 5,
      columnStart: 0,
      columnEnd: 2,
    });
    model.scrollTo({ top: 30, left: 130 });
    expect(model.visibleRange({ rows: 0, columns: 0 })).toEqual({
      rowStart: 1,
      rowEnd: 7,
      columnStart: 1,
      columnEnd: 3,
    });
    expect(model.visibleRange({ rows: 3, columns: 1 })).toEqual({
      rowStart: 0,
      rowEnd: 10,
      columnStart: 0,
      columnEnd: 4,
    });
    // Scrolling stops at the last row and column.
    model.scrollTo({ top: 1e9, left: 1e9 });
    expect([model.top, model.left]).toEqual([100 * 20 - 100, 4 * 120 - 200]);
    expect(model.visibleRange({ rows: 2 })).toMatchObject({ rowStart: 93, rowEnd: 100 });
  });

  it("reveal cells by scrolling as little as possible", () => {
    const model = createGridModel({
      data: rowView(requests()),
      columns: [{ field: "id" }, { field: "ms" }, { field: "host" }],
      rowHeight: 20,
    });
    model.setViewport(200, 100);
    model.reveal(10, "host");
    expect([model.top, model.left]).toEqual([11 * 20 - 100, 360 - 200]);
    model.reveal(2);
    expect(model.top).toBe(40);
    model.reveal(-1, "id");
    expect([model.top, model.left]).toEqual([40, 0]);
  });
});

describe("grid sorting", () => {
  it("cycles a column ascending, descending, and off, keeping the view's filter", () => {
    const t = table({ x: [3, 1, 2, 5], host: ["b", "a", "c", "a"] });
    const data = rowView(t, { filter: col("x").lt(5) });
    const model = createGridModel({ data, columns: [{ field: "x" }, { field: "host" }] });
    model.cycleSort("x");
    expect(model.sort).toEqual([{ field: "x", order: "ascending" }]);
    expect(positions(model)).toEqual([1, 2, 0]);
    model.cycleSort("x");
    expect(positions(model)).toEqual([0, 2, 1]);
    model.cycleSort("x");
    expect(model.sort).toEqual([]);
    expect(positions(model)).toEqual([0, 1, 2]);
    expect(data.query.filter).toEqual(["<", ["field", "x"], 5]);
  });

  it("add keys with additive cycling, and replace them with a plain one", () => {
    const t = table({ x: [3, 1, 2, 1], host: ["b", "a", "c", "a"] });
    const model = createGridModel({
      data: rowView(t),
      columns: [{ field: "x" }, { field: "host" }],
    });
    model.cycleSort("host");
    model.cycleSort("x", { additive: true });
    model.cycleSort("x", { additive: true });
    expect(model.sort).toEqual([
      { field: "host", order: "ascending" },
      { field: "x", order: "descending" },
    ]);
    model.cycleSort("x", { additive: true });
    expect(model.sort).toEqual([{ field: "host", order: "ascending" }]);
    model.cycleSort("x", { additive: true });
    model.cycleSort("x");
    expect(model.sort).toEqual([{ field: "x", order: "descending" }]);
    expect(() => model.cycleSort("nope")).toThrow(/No grid column/);
  });
});

describe("grid focus", () => {
  const columns = [{ field: "id" }, { field: "ms" }, { field: "host" }] as const;

  it("starts at the header's first cell and moves as the keyboard does", () => {
    const model = createGridModel({ data: rowView(requests()), columns, rowHeight: 20 });
    model.setViewport(240, 100);
    expect(model.focus).toEqual({ rowIndex: -1, columnIndex: 0, column: "id" });
    const at = () => [model.focus!.rowIndex, model.focus!.columnIndex];
    model.moveFocus("down");
    model.moveFocus("right");
    expect(at()).toEqual([0, 1]);
    model.moveFocus("pageDown");
    expect(at()).toEqual([5, 1]);
    // Revealing the focus scrolled down.
    expect(model.top).toBe(6 * 20 - 100);
    model.moveFocus("rowEnd");
    model.moveFocus("right");
    expect(at()).toEqual([5, 2]);
    model.moveFocus("last");
    expect(at()).toEqual([99, 2]);
    expect(model.top).toBe(100 * 20 - 100);
    model.moveFocus("pageUp");
    model.moveFocus("rowStart");
    expect(at()).toEqual([94, 0]);
    model.moveFocus("first");
    expect(at()).toEqual([-1, 0]);
    model.moveFocus("up");
    model.moveFocus("left");
    expect(at()).toEqual([-1, 0]);
    expect(() => model.focusCell(100, "id")).toThrow(RangeError);
    expect(() => model.focusCell(0, "nope")).toThrow(/No shown grid column/);
  });

  it("keeps to its row as the view sorts, and to the row taking its place when it leaves", () => {
    const t = table({ x: [5, 3, 9, 1] }, { maxRows: 4 });
    const data = rowView(t);
    const model = createGridModel({ data, columns: [{ field: "x" }] });
    model.focusCell(1, "x");
    model.cycleSort("x");
    // Row 1 (3) is second in ascending order: 1, 3, 5, 9.
    expect(model.focus!.rowIndex).toBe(1);
    model.cycleSort("x");
    expect(model.focus!.rowIndex).toBe(2);
    expect(model.textAt(2, 0)).toBe("3");
    // Filtered out: the row now at its index takes the focus.
    data.setQuery({ ...data.query, filter: col("x").ne(3) });
    expect(model.focus!.rowIndex).toBe(2);
    expect(model.textAt(2, 0)).toBe("1");
    // Dropped from the window: the same. Rows are now 1, 7, 8, 2.
    model.focusCell(0, "x");
    expect(model.textAt(0, 0)).toBe("9");
    t.append({ x: [7, 8, 2] });
    expect(column(model, "x")).toEqual(["8", "7", "2", "1"]);
    expect(model.focus!.rowIndex).toBe(0);
    // Gone altogether: the header.
    t.reset({ x: [] });
    expect(model.focus).toEqual({ rowIndex: -1, columnIndex: 0, column: "x" });
  });

  it("follows its row as rows stream in above it, and moves to a shown column when its own is hidden", () => {
    const t = table({ x: [10, 20, 30], y: [1, 2, 3] });
    const model = createGridModel({
      data: rowView(t, { sort: [{ field: "x", order: "descending" }] }),
      columns: [{ field: "x" }, { field: "y" }],
    });
    model.focusCell(2, "y");
    t.append({ x: [40, 50, 5], y: [4, 5, 6] });
    expect(model.focus).toEqual({ rowIndex: 4, columnIndex: 1, column: "y" });
    model.setColumns([{ field: "x" }, { field: "y", hidden: true }]);
    expect(model.focus).toEqual({ rowIndex: 4, columnIndex: 0, column: "x" });
    model.setColumns([]);
    expect(model.focus).toBeNull();
  });
});

describe("grid scrolling", () => {
  it("keeps the top row in place as a rolling window drops rows above it", () => {
    const t = table({ x: Float64Array.from({ length: 50 }, (_, i) => i) }, { maxRows: 50 });
    const model = createGridModel({ data: rowView(t), columns: [{ field: "x" }], rowHeight: 10 });
    model.setViewport(100, 100);
    model.scrollTo({ top: 205 });
    expect(model.textAt(20, 0)).toBe("20");
    t.append({ x: [50, 51, 52] });
    // Row "20" moved to index 17, and the scroll moved with it, 5 pixels into it as before.
    expect(model.top).toBe(175);
    expect(model.textAt(model.visibleRange({ rows: 0 }).rowStart, 0)).toBe("20");
    // Once the top row itself is dropped, the offset stays.
    t.append({ x: Float64Array.from({ length: 30 }, (_, i) => 53 + i) });
    expect(model.top).toBe(175);
    expect(model.textAt(17, 0)).toBe("50");
  });

  it("keeps the top row as sorted rows arrive above it, but not when the query changes", () => {
    const t = table({ x: Float64Array.from({ length: 40 }, (_, i) => i * 2) });
    const data = rowView(t, { sort: [{ field: "x" }] });
    const model = createGridModel({ data, columns: [{ field: "x" }], rowHeight: 10 });
    model.setViewport(100, 50);
    model.scrollTo({ top: 100 });
    t.append({ x: [1, 3, 5, 101] });
    expect(model.top).toBe(130);
    expect(model.textAt(13, 0)).toBe("20");
    model.cycleSort("x");
    expect(model.top).toBe(130);
    expect(model.textAt(13, 0)).toBe("54");
  });

  it("stays clamped when rows go and the view resizes", () => {
    const t = requests();
    const data = rowView(t);
    const model = createGridModel({ data, columns: [{ field: "id" }], rowHeight: 10 });
    model.setViewport(100, 100);
    model.scrollTo({ top: 900 });
    data.setQuery({ filter: col("id").lt(30) });
    expect(model.top).toBe(200);
    model.setViewport(100, 400);
    expect(model.top).toBe(0);
  });
});

describe("grid selection", () => {
  it("selects as clicks do, ranges in display order", () => {
    const t = table({ x: [4, 1, 3, 2, 0] });
    const model = createGridModel({
      data: rowView(t, { sort: [{ field: "x" }] }),
      columns: [{ field: "x" }],
    });
    // Display order: 0, 1, 2, 3, 4 at positions 4, 1, 3, 2, 0.
    model.select(1);
    expect(selected(model)).toEqual([1]);
    model.select(3, "range");
    expect(selected(model)).toEqual([1, 2, 3]);
    const rows = model.selection.get("grid-rows");
    expect(rows?.kind === "rows" && Array.from(rows.rows.positions())).toEqual([1, 2, 3]);
    model.select(0, "toggle");
    model.select(2, "toggle");
    expect(selected(model)).toEqual([0, 1, 3]);
    // The anchor is the last row clicked or toggled.
    model.select(4, "addRange");
    expect(selected(model)).toEqual([0, 1, 2, 3, 4]);
    model.select(4);
    expect(selected(model)).toEqual([4]);
    expect(model.selectedCount).toBe(1);
    expect(model.clearSelection()).toBe(true);
    expect(model.clearSelection()).toBe(false);
    expect(model.selection.get("grid-rows")).toBeNull();
  });

  it("extends from the anchor with Shift moves, and selects every row the view shows", () => {
    const t = requests();
    const model = createGridModel({
      data: rowView(t, { filter: col("host").eq("api") }),
      columns: [{ field: "id" }],
    });
    model.focusCell(2, "id");
    model.moveFocus("down", { extend: true });
    model.moveFocus("down", { extend: true });
    expect(selected(model)).toEqual([2, 3, 4]);
    model.moveFocus("up", { extend: true });
    expect(selected(model)).toEqual([2, 3]);
    // Plain moves leave the selection alone.
    model.moveFocus("down");
    expect(selected(model)).toEqual([2, 3]);
    model.selectAll();
    expect(model.selectedCount).toBe(33);
    expect(selected(model)).toHaveLength(33);
  });

  it("shows a condition someone else put in the channel, and toggles its rows as a row set", () => {
    const t = table({ x: [1, 5, 9, 2] });
    const store = selectionStore(t);
    const model = createGridModel({
      data: rowView(t),
      columns: [{ field: "x" }],
      selection: store,
    });
    store.set("grid-rows", selectWhere(col("x").gt(3)));
    expect(selected(model)).toEqual([1, 2]);
    expect(model.selectedCount).toBe(2);
    model.select(3, "toggle");
    expect(store.get("grid-rows")?.kind).toBe("rows");
    expect(selected(model)).toEqual([1, 2, 3]);
    // Rows set later are not selected by a row set.
    t.append({ x: [10] });
    expect(selected(model)).toEqual([1, 2, 3]);
  });

  it("leaves row sets it did not publish alone, and starts afresh after a reset", () => {
    const t = table({ x: [1, 2, 3, 4] });
    const store = selectionStore(t);
    const model = createGridModel({
      data: rowView(t),
      columns: [{ field: "x" }],
      selection: store,
    });
    const theirs = new RowSet(t).add(0);
    store.set("grid-rows", selectRows(theirs));
    model.select(2, "toggle");
    expect(Array.from(theirs.positions())).toEqual([0]);
    expect(selected(model)).toEqual([0, 2]);
    t.reset({ x: [7, 8, 9] });
    expect(selected(model)).toEqual([]);
    model.select(1, "toggle");
    expect(selected(model)).toEqual([1]);
    expect(() =>
      createGridModel({
        data: rowView(t),
        columns: [],
        selection: selectionStore(table({ x: [1] })),
      }),
    ).toThrow(/selection store must be of its view's table/);
  });
});

describe("grid models", () => {
  it("are current inside listeners of the table that run before the view's", () => {
    const t = table({ x: [3, 1, 2] });
    let seen: string[] = [];
    // Subscribed before the view, so it runs before the view is told.
    t.subscribe(() => {
      seen = Array.from({ length: model.rowCount }, (_, i) => model.textAt(i, 0));
    });
    const model = createGridModel({
      data: rowView(t, { sort: [{ field: "x" }] }),
      columns: [{ field: "x" }],
    });
    expect(model.rowCount).toBe(3);
    t.reset({ x: [9] });
    expect(seen).toEqual(["9"]);
  });

  it("move the focus with columns as the rows are now, changes pending or not", () => {
    const t = table({ x: [40, 10, 30, 20], y: [1, 2, 3, 4] });
    const model = createGridModel({
      data: rowView(t, { sort: [{ field: "x" }] }),
      columns: [{ field: "x" }, { field: "y" }],
    });
    model.focusCell(0, "y");
    t.append({ x: [5, 50], y: [5, 6] });
    model.setColumns([{ field: "y" }, { field: "x" }]);
    expect(model.focus).toEqual({ rowIndex: 1, columnIndex: 0, column: "y" });
    expect(model.textAt(1, 1)).toBe("10");
    expect(model.rowIndexOf(model.identityAt(1))).toBe(1);
  });

  it("tell listeners of every change, read inside them without looping, and stop when disposed", () => {
    const t = requests();
    const model = createGridModel({ data: rowView(t), columns: [{ field: "id" }] });
    let calls = 0;
    model.subscribe(() => {
      calls++;
      // Reading catches up; it must not notify again.
      void model.rowCount;
      void model.focus;
    });
    t.append({ id: [100], ms: [1], host: ["web"] });
    model.setViewport(100, 100);
    model.focusCell(0, "id");
    model.select(0);
    model.cycleSort("id");
    expect(calls).toBe(5);
    model.dispose();
    t.append({ id: [101], ms: [1], host: ["web"] });
    expect(calls).toBe(5);
  });
});
