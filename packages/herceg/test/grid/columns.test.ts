import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { count, mean } from "../../src/data/derive.ts";
import { groupRows } from "../../src/data/groups.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type Table, table } from "../../src/data/table.ts";
import {
  createGridModel,
  type GridColumn,
  MIN_COLUMN_WIDTH,
  MIN_SCROLLING_WIDTH,
} from "../../src/grid/model.ts";

const requests = () =>
  table({
    id: Float64Array.from({ length: 50 }, (_, i) => i),
    ms: Float64Array.from({ length: 50 }, (_, i) => i * 1.5),
    at: Float64Array.from({ length: 50 }, (_, i) => i * 1000),
    host: category(Array.from({ length: 50 }, (_, i) => ["web", "api", "db"][i % 3]!)),
  });
type Requests = ReturnType<typeof requests> extends Table<infer S> ? S : never;

const COLUMNS = [
  { field: "id", width: 60 },
  { field: "ms", width: 100 },
  { field: "at", width: 100 },
  { field: "host", width: 80 },
] as const;

function model(columns: readonly GridColumn[] = COLUMNS as unknown as GridColumn[]) {
  return createGridModel({
    data: rowView(requests() as unknown as Table),
    columns,
    locale: "en-US",
  });
}

/** The shown columns: id, left edge, width, and pin. */
const placed = (m: ReturnType<typeof model>) =>
  m.columnLayout.map(({ id, x, width, pinned }) => [id, x, width, pinned]);
const ids = (m: ReturnType<typeof model>) => m.columnLayout.map(({ id }) => id);

describe("resizing grid columns", () => {
  it("sets widths no narrower than the minimum, and places the columns after them", () => {
    const m = model();
    let calls = 0;
    m.subscribe(() => calls++);
    m.resizeColumn("ms", 150);
    expect(placed(m)).toEqual([
      ["id", 0, 60, null],
      ["ms", 60, 150, null],
      ["at", 210, 100, null],
      ["host", 310, 80, null],
    ]);
    expect(m.width).toBe(390);
    m.resizeColumn("id", 2);
    expect(m.columnLayout[0]!.width).toBe(MIN_COLUMN_WIDTH);
    // The same width again changes nothing.
    m.resizeColumn("id", MIN_COLUMN_WIDTH);
    expect(calls).toBe(2);
    expect(() => m.resizeColumn("ms", Number.NaN)).toThrow(RangeError);
    expect(() => m.resizeColumn("ms", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => m.resizeColumn("nope", 100)).toThrow(/No grid column "nope"/);
  });

  it("resize hidden columns too, which keep their width for when they show", () => {
    const m = model();
    m.setColumnVisible("at", false);
    m.resizeColumn("at", 200);
    expect(ids(m)).toEqual(["id", "ms", "host"]);
    m.setColumnVisible("at", true);
    expect(placed(m)[2]).toEqual(["at", 160, 200, null]);
  });

  it("keep what columns show and their cells' text while they resize, move, pin, and hide", () => {
    const m = model([
      { field: "id" },
      { field: "ms", format: { minimumFractionDigits: 2 } },
    ] as GridColumn[]);
    const content = (id: string) =>
      (m.columnLayout[m.columnIndex(id)] as unknown as { content: unknown }).content;
    const before = content("ms");
    m.resizeColumn("ms", 200);
    m.moveColumn("ms", "id");
    m.pinColumn("ms", "right");
    m.setColumnVisible("id", false);
    m.setColumnVisible("id", true);
    expect(content("ms")).toBe(before);
    expect(m.textAt(3, m.columnIndex("ms"))).toBe("4.50");
    // New columns are new content, though the same as before.
    m.setColumns(m.columns);
    expect(content("ms")).not.toBe(before);
  });
});

describe("moving grid columns", () => {
  it("moves a column before another, or last, keeping the focus on it", () => {
    const m = model();
    m.focusCell(3, "at");
    m.moveColumn("at", "id");
    expect(ids(m)).toEqual(["at", "id", "ms", "host"]);
    expect(m.focus).toEqual({ rowIndex: 3, columnIndex: 0, column: "at" });
    m.moveColumn("at", null);
    expect(ids(m)).toEqual(["id", "ms", "host", "at"]);
    expect(m.focus!.columnIndex).toBe(3);
    expect(m.columnLayout.map(({ x }) => x)).toEqual([0, 60, 160, 240]);
    expect(m.columns.map(({ id }) => id)).toEqual(["id", "ms", "host", "at"]);
  });

  it("change nothing when the column stays where it is, and refuse unknown columns", () => {
    const m = model();
    let calls = 0;
    m.subscribe(() => calls++);
    m.moveColumn("ms", "at");
    m.moveColumn("host", null);
    m.moveColumn("ms", "ms");
    expect(calls).toBe(0);
    expect(() => m.moveColumn("nope", null)).toThrow(/No grid column "nope"/);
    expect(() => m.moveColumn("ms", "nope")).toThrow(/No grid column "nope"/);
  });

  it("move among hidden columns as the columns' order says", () => {
    const m = model();
    m.setColumnVisible("ms", false);
    m.moveColumn("host", "ms");
    expect(m.columns.map(({ id }) => id)).toEqual(["id", "host", "ms", "at"]);
    expect(ids(m)).toEqual(["id", "host", "at"]);
  });
});

describe("pinning grid columns", () => {
  it("shows pinned columns first or last, each side in the columns' order, and unpins back", () => {
    const m = model();
    m.pinColumn("host", "left");
    m.pinColumn("id", "right");
    m.pinColumn("ms", "left");
    expect(placed(m)).toEqual([
      ["ms", 0, 100, "left"],
      ["host", 100, 80, "left"],
      ["at", 180, 100, null],
      ["id", 280, 60, "right"],
    ]);
    expect(m.columns.map(({ id, pin }) => [id, pin])).toEqual([
      ["id", "right"],
      ["ms", "left"],
      ["at", undefined],
      ["host", "left"],
    ]);
    m.pinColumn("ms", null);
    expect(ids(m)).toEqual(["host", "ms", "at", "id"]);
    expect(() => m.pinColumn("ms", "top" as never)).toThrow(/"left" or "right"/);
  });

  it("are taken from the columns, and refused there when not a side", () => {
    const m = model([
      { field: "id", pin: "right" },
      { field: "ms" },
      { field: "host", pin: "left" },
    ] as GridColumn[]);
    expect(ids(m)).toEqual(["host", "ms", "id"]);
    expect(() => m.setColumns([{ field: "id", pin: "middle" } as never])).toThrow(
      /pins to "left" or "right"/,
    );
  });

  it("scroll only the others: ranges and reveals leave the held columns out", () => {
    const m = model([
      { field: "id", pin: "left", width: 100 },
      ...Array.from({ length: 10 }, (_, i) => ({ field: "ms", id: `c${i}`, width: 100 })),
      { field: "host", pin: "right", width: 100 },
    ] as GridColumn[]);
    m.setViewport(500, 200);
    // 300 pixels between the pins show three of the ten.
    expect(m.visibleRange({ rows: 0, columns: 0 })).toMatchObject({ columnStart: 1, columnEnd: 4 });
    expect(m.visibleRange({ rows: 0, columns: 2 })).toMatchObject({ columnStart: 1, columnEnd: 6 });
    m.scrollTo({ left: 150 });
    expect(m.visibleRange({ rows: 0, columns: 0 })).toMatchObject({ columnStart: 2, columnEnd: 6 });
    m.scrollTo({ left: 1e6 });
    // The columns are 1,200 wide in all; the scroll stops when the last scrolling one meets the right pin.
    expect(m.left).toBe(700);
    expect(m.visibleRange({ rows: 0, columns: 4 })).toMatchObject({
      columnStart: 4,
      columnEnd: 11,
    });
    m.reveal(0, "c0");
    expect(m.left).toBe(0);
    m.reveal(0, "c5");
    // c5 spans 600 to 700, which must end where the right pin starts: at 400 in view.
    expect(m.left).toBe(300);
    m.reveal(0, "host");
    m.reveal(0, "id");
    expect(m.left).toBe(300);
    m.reveal(0, "c3");
    expect(m.left).toBe(300);
    m.reveal(0, "c2");
    // c2 starts at 300, which must start where the left pin ends.
    expect(m.left).toBe(200);
  });

  it("let pins go while the grid is too narrow to hold them, and hold them again when it widens", () => {
    const m = model([
      { field: "id", pin: "left", width: 200 },
      { field: "ms", width: 300 },
      { field: "host", pin: "right", width: 100 },
    ] as GridColumn[]);
    // Not measured yet: held.
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual(["left", null, "right"]);
    m.setViewport(300 + MIN_SCROLLING_WIDTH, 100);
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual(["left", null, "right"]);
    m.setViewport(299 + MIN_SCROLLING_WIDTH, 100);
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual([null, null, null]);
    // Let go, they scroll with the others, in the same order.
    expect(m.columnLayout.map(({ x }) => x)).toEqual([0, 200, 500]);
    expect(m.visibleRange({ rows: 0, columns: 0 })).toMatchObject({ columnStart: 0, columnEnd: 2 });
    m.scrollTo({ left: 1000 });
    expect(m.left).toBe(600 - 299 - MIN_SCROLLING_WIDTH);
    expect(m.canPin("ms")).toBe(false);
    // Pinned columns can change sides meanwhile.
    m.pinColumn("host", "left");
    m.pinColumn("host", "right");
    // Held again, but with no room for one more: pinning it is refused.
    m.setViewport(700, 100);
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual(["left", null, "right"]);
    expect(m.canPin("ms")).toBe(false);
    expect(() => m.pinColumn("ms", "left")).toThrow(/less than 120 pixels/);
    expect(m.columns[1]!.pin).toBeUndefined();
    expect(m.canPin("id")).toBe(true);
    m.setViewport(600 + MIN_SCROLLING_WIDTH, 100);
    expect(m.canPin("ms")).toBe(true);
    m.pinColumn("ms", "left");
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual(["left", "left", "right"]);
    // Restoring a layout takes pins as given, held or not.
    m.setViewport(500, 100);
    m.setColumns(m.columns.map((column) => ({ ...column, pin: "left" as const })));
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual([null, null, null]);
    m.setViewport(800, 100);
    expect(m.columnLayout.map(({ pinned }) => pinned)).toEqual(["left", "left", "left"]);
  });

  it("widen a held column only as far as the pins leave the others room", () => {
    const m = model([
      { field: "id", pin: "left", width: 100 },
      { field: "ms", width: 300 },
      { field: "host", pin: "right", width: 100 },
    ] as GridColumn[]);
    m.setViewport(600, 100);
    m.resizeColumn("id", 1000);
    expect(m.columnLayout[0]!.width).toBe(600 - MIN_SCROLLING_WIDTH - 100);
    expect(m.columnLayout[0]!.pinned).toBe("left");
    // Columns that scroll have no limit.
    m.resizeColumn("ms", 5000);
    expect(m.columnLayout[1]!.width).toBe(5000);
    // Nor before the grid is measured, or while pins are let go.
    m.setViewport(300, 100);
    m.resizeColumn("host", 400);
    expect(m.columnLayout[2]!.width).toBe(400);
  });
});

describe("hiding grid columns", () => {
  it("hides and shows columns, the focus going to the nearest shown one", () => {
    const m = model();
    m.focusCell(2, "ms");
    m.setColumnVisible("ms", false);
    expect(ids(m)).toEqual(["id", "at", "host"]);
    expect(m.focus).toEqual({ rowIndex: 2, columnIndex: 1, column: "at" });
    expect(m.columns[1]).toMatchObject({ id: "ms", hidden: true });
    m.setColumnVisible("ms", true);
    expect(ids(m)).toEqual(["id", "ms", "at", "host"]);
    expect("hidden" in m.columns[1]!).toBe(false);
    let calls = 0;
    m.subscribe(() => calls++);
    m.setColumnVisible("ms", true);
    expect(calls).toBe(0);
  });
});

describe("grid column layouts", () => {
  it("come back from the columns the model gives", () => {
    const m = model();
    m.resizeColumn("ms", 140);
    m.moveColumn("host", "id");
    m.pinColumn("at", "left");
    m.setColumnVisible("id", false);
    const again = model(m.columns as readonly GridColumn[]);
    expect(placed(again)).toEqual(placed(m));
  });

  it("refuse widths below the minimum", () => {
    expect(() => model([{ field: "id", width: MIN_COLUMN_WIDTH - 1 }] as GridColumn[])).toThrow(
      /at least 32 pixels/,
    );
  });

  it("keep group headers naming their group in the first column, wherever columns move", () => {
    const t = requests();
    const view = rowView(t);
    const m = createGridModel<Requests>({
      data: view,
      groups: groupRows(view, { by: ["host"], ops: { n: count(), avg: mean("ms") } }),
      columns: [{ field: "host" }, { field: "id" }, { field: "ms", aggregate: "avg" }],
      locale: "en-US",
    });
    expect([m.textAt(0, 0), m.textAt(0, 2)]).toEqual(["web (17)", "36"]);
    m.moveColumn("ms", "host");
    expect([m.textAt(0, 0), m.textAt(0, 1)]).toEqual(["web (17)", "web"]);
    m.pinColumn("id", "left");
    expect([m.textAt(0, 0), m.textAt(0, 1)]).toEqual(["web (17)", "36"]);
  });
});
