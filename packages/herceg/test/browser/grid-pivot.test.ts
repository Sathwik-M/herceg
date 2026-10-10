// Pivot grids in the page: generated columns virtualized under a row of
// pivot values, headers split where columns are pinned or moved apart, the
// keyboard, layout kept by column id as values stream in, and the notice of
// a pivot that stopped at a limit.
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { category } from "../../src/data/column.ts";
import { count, mean } from "../../src/data/derive.ts";
import type { NamedAggregate } from "../../src/data/groups.ts";
import { pivotColumnId, pivotRows } from "../../src/data/pivot.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type Table, table } from "../../src/data/table.ts";
import { createPivotGrid } from "../../src/dom/grid-pivot.ts";
import { createPivotGridModel } from "../../src/grid/pivot.ts";
import { collectGarbage } from "./helpers.ts";

const hosts: HTMLElement[] = [];
const grids: { destroy(): void }[] = [];
afterEach(() => {
  for (const grid of grids.splice(0)) grid.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const OPS = { n: count(), avg: mean("ms") };
const N = { name: "n", op: "count", field: undefined } as const;
const AVG = { name: "avg", op: "mean", field: "ms" } as const;
/** A generated column's id, for a category pivot value. */
const id = (value: string, aggregate: NamedAggregate = N) =>
  pivotColumnId("service", "category", value, aggregate);

/** A grid of `regions` rows by `services` pivot values of two aggregates each. */
function pivoted(services: number, regions = 6, options: { limits?: object; width?: number } = {}) {
  const rows = services * 2;
  const t = table({
    region: category(Array.from({ length: rows }, (_, i) => `r${i % regions}`)),
    service: category(Array.from({ length: rows }, (_, i) => `s${i % services}`)),
    ms: Float64Array.from({ length: rows }, (_, i) => (i * 37) % 100),
  });
  const pivot = pivotRows(rowView(t), {
    rows: "region",
    pivot: "service",
    ops: OPS,
    ...(options.limits && { limits: options.limits }),
  });
  const model = createPivotGridModel({
    data: pivot,
    aggregates: { avg: { title: "Latency", format: { maximumFractionDigits: 0 } } },
    locale: "en-US",
  });
  const host = document.createElement("div");
  host.style.cssText = `width:${options.width ?? 700}px;height:300px`;
  document.body.append(host);
  hosts.push(host);
  const grid = createPivotGrid(host, { model, ariaLabel: "Requests" });
  grids.push(grid);
  return { t, pivot, model, grid };
}

const band = (grid: { root: HTMLElement }) => [
  ...grid.root.querySelectorAll<HTMLElement>(".hg-band > *"),
];
const leaves = (grid: { root: HTMLElement }) => [
  ...grid.root.querySelectorAll<HTMLElement>(".hg-header > :last-child [role=columnheader]"),
];
const said = (grid: { root: HTMLElement }) =>
  grid.root.querySelector("[aria-live]")!.textContent?.trim();
/** The band's value headers as their text and the columns they span. */
const spans = (grid: { root: HTMLElement }) =>
  band(grid)
    .filter((cell) => cell.getAttribute("role") === "columnheader")
    .map((cell): [string | null, number, number] => {
      const start = Number(cell.getAttribute("aria-colindex"));
      return [cell.textContent, start, start + Number(cell.getAttribute("aria-colspan")) - 1];
    });

describe("pivot grids", () => {
  it("draw 1,024 generated columns under their values, mounting only those in view", async () => {
    const { model, grid } = pivoted(512);
    await frame();
    const scroller = grid.root.querySelector("[role=grid]")!;
    expect(scroller.getAttribute("aria-colcount")).toBe("1025");
    expect(scroller.getAttribute("aria-rowcount")).toBe(String(model.rowCount + 2));
    expect(grid.root.querySelector(".hg-body [role=row]")!.getAttribute("aria-rowindex")).toBe("3");
    expect(leaves(grid).length).toBeLessThan(12);
    expect(band(grid).length).toBeLessThan(8);
    expect(spans(grid).slice(0, 2)).toEqual([
      ["s0", 2, 3],
      ["s1", 4, 5],
    ]);
    model.scrollTo({ left: model.width / 2 });
    grid.render();
    const mounted = leaves(grid).map((cell) => Number(cell.getAttribute("aria-colindex")));
    expect(Math.min(...mounted.slice(1))).toBeGreaterThan(500);
    // Every mounted column under a value has its value's header over it.
    for (const column of mounted.slice(1))
      expect(spans(grid).some(([, start, end]) => start <= column && column <= end)).toBe(true);
    // The headers are as tall as two rows; the rows start under them.
    const header = grid.root.querySelector(".hg-header")!.getBoundingClientRect();
    expect(header.height).toBe(64);
    expect(model.viewportHeight).toBe(300 - 64 - (300 - scroller.clientHeight));
  });

  it("split a value's header where its columns are pinned or moved apart", async () => {
    // Wide enough to mount every column.
    const { model, grid } = pivoted(4, 6, { width: 1200 });
    model.pinColumn(id("s1"), "left");
    model.moveColumn(id("s0", AVG), null);
    grid.render();
    // Pinned columns show first, then region, which has no value over it.
    expect(spans(grid)).toEqual([
      ["s1", 1, 1],
      ["s0", 3, 3],
      ["s1", 4, 4],
      ["s2", 5, 6],
      ["s3", 7, 8],
      ["s0", 9, 9],
    ]);
    // A blank holds the pinned region's place over the region column, read by no one.
    model.pinColumn("region", "left");
    grid.render();
    const [blank] = band(grid);
    expect(blank!.getAttribute("aria-hidden")).toBe("true");
    expect(blank!.getAttribute("data-pin")).toBe("left");
    expect(leaves(grid)[1]!.getAttribute("aria-label")).toBe("s1, n");
    expect(leaves(grid)[0]!.hasAttribute("aria-label")).toBe(false);
    await frame();
  });

  it("count one header row once no column shown has a value over it, and two again after", async () => {
    const { model, grid } = pivoted(2);
    await frame();
    const scroller = grid.root.querySelector("[role=grid]")!;
    const indexes = () =>
      [...grid.root.querySelectorAll(".hg-body [role=row]")].map((row) =>
        Number(row.getAttribute("aria-rowindex")),
      );
    expect(indexes()[0]).toBe(3);
    for (const column of model.columns.slice(1)) model.setColumnVisible(column.id!, false);
    grid.render();
    expect(grid.root.querySelector(".hg-band")).toBeNull();
    expect(scroller.getAttribute("aria-rowcount")).toBe(String(model.rowCount + 1));
    expect(indexes()).toEqual(Array.from({ length: model.rowCount }, (_, i) => i + 2));
    model.setColumnVisible(model.columns[1]!.id!, true);
    grid.render();
    expect(scroller.getAttribute("aria-rowcount")).toBe(String(model.rowCount + 2));
    expect(indexes()[0]).toBe(3);
  });

  it("sort, select, and move between cells from the keyboard, expanding nothing", async () => {
    const { model, grid } = pivoted(4);
    grid.focusCell(-1, id("s1"));
    await userEvent.keyboard("{Enter}");
    expect(model.sort).toEqual([{ field: id("s1"), order: "ascending" }]);
    expect(said(grid)).toBe("Sorted by s1, n, ascending");
    expect(leaves(grid)[3]!.getAttribute("aria-sort")).toBe("ascending");
    await userEvent.keyboard("{ArrowDown}{Home}{ArrowRight}");
    expect(model.focus).toMatchObject({ rowIndex: 0, column: id("s0") });
    await userEvent.keyboard(" ");
    expect(said(grid)).toBe("2 rows selected");
    const check = grid.root.querySelector(".hg-body [aria-rowindex='3'] [role=checkbox]")!;
    expect(check.getAttribute("aria-checked")).toBe("true");
    expect(grid.root.querySelector(".hg-toggle")).toBeNull();
  });

  it("keep a column's width, pin, and focus with its id as values arrive before it", async () => {
    const t = table({ region: category(["eu", "us"]), service: [20, 30], ms: [1, 2] });
    const pivot = pivotRows(rowView(t), { rows: "region", pivot: "service", ops: { n: count() } });
    const model = createPivotGridModel({ data: pivot, locale: "en-US" });
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.body.append(host);
    hosts.push(host);
    const grid = createPivotGrid(host, { model, ariaLabel: "Requests" });
    grids.push(grid);
    const twenty = pivotColumnId("service", "number", 20, N);
    grid.focusCell(-1, twenty);
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    model.pinColumn(twenty, "right");
    t.append({ region: ["eu"], service: [10], ms: [3] });
    grid.render();
    expect(model.columnLayout.map(({ title }) => title)).toEqual(["region", "10", "30", "20"]);
    const cell = leaves(grid).find((header) => header.textContent?.startsWith("20"))!;
    expect(cell.style.width).toBe("136px");
    expect(cell.getAttribute("data-pin")).toBe("right");
    expect(document.activeElement).toBe(cell);
    // One aggregate: a header row of values alone.
    expect(grid.root.querySelector(".hg-band")).toBeNull();
    expect(grid.root.querySelector(".hg-body [role=row]")!.getAttribute("aria-rowindex")).toBe("2");
  });

  it("let go of pivots no one keeps, with their tables and grids", async () => {
    const made = (() => {
      const { t, pivot, model, grid } = pivoted(3);
      model.select(0);
      grid.render();
      grid.destroy();
      grids.splice(grids.indexOf(grid), 1);
      return [new WeakRef(t), new WeakRef(pivot), new WeakRef(model)];
    })();
    // The view and groups let go of the table from finalizers, which run
    // after a collection. The refs are read only after: `deref` keeps what
    // it returns until the page's task ends, which in Firefox, and in WebKit
    // at times, outlasts a collection.
    for (let round = 0; round < 4; round++) {
      await frame();
      await collectGarbage();
    }
    expect(made.map((ref) => ref.deref() === undefined)).toEqual([true, true, true]);
  });

  it("let go of the table's arrays a reset replaced, while the pivot stays", async () => {
    const fields = ["a", "b", "c", "d"] as const;
    const columns = (rows: number) =>
      Object.fromEntries(
        fields.map((field) => [field, Float64Array.from({ length: rows }, (_, i) => i)]),
      );
    const t = table({
      region: new Float64Array(500),
      key: new Float64Array(500),
      ...columns(500),
    }) as unknown as Table;
    const view = rowView(t, { sort: fields.map((field) => ({ field })) });
    const pivot = pivotRows(
      view as never,
      {
        rows: "region",
        pivot: "key",
        ops: { n: count() },
        limits: { ownedBytes: 1_000_000 },
      } as never,
    );
    pivot.members(0);
    t.append({ region: [0], key: [0], ...columns(1) } as never);
    view.setQuery({});
    const old = fields.map((field) => new WeakRef(t.numbers(field).buffer));
    t.reset({ region: [0], key: [0], ...columns(1) } as never);
    pivot.read();
    for (let round = 0; round < 4; round++) {
      await frame();
      await collectGarbage();
    }
    expect(old.map((ref) => ref.deref() === undefined)).toEqual([true, true, true, true]);
    expect(pivot.read().rowCount).toBe(1);
  });

  it("say when the pivot stopped at a limit, keeping what it showed", async () => {
    const { t, grid } = pivoted(2, 2, { limits: { generatedColumns: 4 } });
    await frame();
    const notice = grid.root.querySelector<HTMLElement>(".hg-notice")!;
    expect(notice.hidden).toBe(true);
    const before = grid.root.querySelector(".hg-body")!.textContent;
    t.append({ region: ["r0"], service: ["s9"], ms: [1] });
    await frame();
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe(
      "Not updating: A pivot of 6 generated columns passes its limit of 4 (limits.generatedColumns).",
    );
    expect(grid.root.querySelector(".hg-body")!.textContent).toBe(before);
  });
});
