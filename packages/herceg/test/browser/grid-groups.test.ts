// Grouped grids in the page: group rows as a tree grid, expanding and
// collapsing by pointer and keyboard, selecting groups' rows, sorting
// groups, and streaming into groups while scrolled.
import { afterEach, describe, expect, it } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { category } from "../../src/data/column.ts";
import { count, max, mean, min } from "../../src/data/derive.ts";
import { groupRows } from "../../src/data/groups.ts";
import { rowView } from "../../src/data/row-view.ts";
import { table } from "../../src/data/table.ts";
import { createGrid } from "../../src/dom/grid.ts";
import { createGridModel } from "../../src/grid/model.ts";

const hosts: HTMLElement[] = [];
const grids: { destroy(): void }[] = [];
afterEach(() => {
  for (const grid of grids.splice(0)) grid.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async () => {
  await frame();
  await frame();
};

const HOSTS = ["web", "api", "db", "cache"];
/** Each request's latency: about 33 for web, 13 for api, 43 for db, and 23 for cache. */
const latency = (i: number) => [30, 10, 40, 20][i % 4]! + (i % 7);

/** `rows` requests over four hosts, with a grid grouping them by host. */
function grouped(rows: number, options: { sort?: boolean } = {}) {
  const t = table({
    id: Float64Array.from({ length: rows }, (_, i) => i),
    host: category(Array.from({ length: rows }, (_, i) => HOSTS[i % 4]!)),
    ms: Float64Array.from({ length: rows }, (_, i) => latency(i)),
  });
  const view = rowView(t, options.sort ? { sort: [{ field: "id", order: "descending" }] } : {});
  const groups = groupRows(view, {
    by: ["host"],
    ops: { n: count(), avg: mean("ms"), worst: max("ms") },
  });
  const model = createGridModel({
    data: view,
    groups,
    columns: [
      { field: "host", width: 160 },
      { field: "id", width: 80 },
      { field: "ms", aggregate: "avg", format: { maximumFractionDigits: 1 } },
      { field: "ms", id: "worst", title: "Worst", aggregate: "worst" },
    ],
    locale: "en-US",
  });
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
  hosts.push(host);
  const grid = createGrid(host, { model, ariaLabel: "Requests" });
  grids.push(grid);
  return { t, view, groups, model, grid };
}

const scroller = (grid: { root: HTMLElement }) =>
  grid.root.querySelector<HTMLElement>(".hg-scroller")!;
const rowAt = (grid: { root: HTMLElement }, index: number) =>
  grid.root.querySelector<HTMLElement>(`.hg-body [aria-rowindex="${index + 2}"]`);
const texts = (row: Element | null) =>
  [...(row?.querySelectorAll("[role=gridcell]") ?? [])].map((cell) => cell.textContent);
const said = (grid: { root: HTMLElement }) =>
  grid.root.querySelector("[aria-live]")!.textContent?.trim();
const checkbox = (grid: { root: HTMLElement }, index: number) =>
  rowAt(grid, index)!.querySelector<HTMLElement>("[role=checkbox]")!;
/** The rows below the header, as their first cells read. */
function visibleFirstCells(grid: { root: HTMLElement }): string[] {
  const bottom = scroller(grid).getBoundingClientRect().bottom;
  const top = grid.root.querySelector(".hg-header")!.getBoundingClientRect().bottom;
  return [...grid.root.querySelectorAll<HTMLElement>(".hg-body [role=row]")]
    .filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > top + 1 && box.top < bottom - 1;
    })
    .sort(
      (a, b) => Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex")),
    )
    .map((row) => texts(row)[0]!);
}
function focused(): [number, number] {
  const cell = document.activeElement!;
  const row = cell.closest("[role=row]");
  return [
    Number(row?.getAttribute("aria-rowindex")) - 2,
    Number(cell.getAttribute("aria-colindex")) - 1,
  ];
}

describe("grouped grids", () => {
  it("draw group rows as a tree grid, with toggles, checkboxes, counts, and aggregates", () => {
    const { grid } = grouped(1000);
    const root = scroller(grid);
    expect(root.getAttribute("role")).toBe("treegrid");
    expect(root.getAttribute("aria-rowcount")).toBe("5");
    expect(document.getElementById(root.getAttribute("aria-describedby")!)!.textContent).toMatch(
      /Rows are grouped\. Enter on a group expands or collapses it/,
    );
    const first = rowAt(grid, 0)!;
    expect(
      ["aria-level", "aria-expanded", "aria-posinset", "aria-setsize", "aria-selected"].map(
        (name) => first.getAttribute(name),
      ),
    ).toEqual(["1", "false", "1", "4", null]);
    const web = Array.from({ length: 250 }, (_, k) => latency(4 * k));
    const mean = web.reduce((a, b) => a + b) / web.length;
    expect(texts(first)).toEqual([
      "web (250)",
      "",
      mean.toLocaleString("en-US", { maximumFractionDigits: 1 }),
      String(Math.max(...web)),
    ]);
    expect(checkbox(grid, 0).getAttribute("aria-checked")).toBe("false");
    expect(checkbox(grid, 0).getAttribute("aria-label")).toBe("Select");
    // The toggle is drawn, not read.
    expect(first.querySelector(".hg-toggle")!.getAttribute("aria-hidden")).toBe("true");
    expect(grid.root.querySelectorAll(".hg-body [role=row]")).toHaveLength(4);
  });

  it("expand and collapse with the toggle, Enter, and the arrows on a row's first cell, saying so", async () => {
    const { grid, model } = grouped(1000);
    await userEvent.click(rowAt(grid, 1)!.querySelector(".hg-toggle")!);
    expect(rowAt(grid, 1)!.getAttribute("aria-expanded")).toBe("true");
    expect(said(grid)).toBe("api (250) expanded");
    // Clicking the toggle expands without selecting.
    expect(model.selection.get("grid-rows")).toBeNull();
    const member = rowAt(grid, 2)!;
    expect(texts(member).slice(0, 2)).toEqual(["api", "1"]);
    expect(
      ["aria-level", "aria-posinset", "aria-setsize", "aria-expanded", "aria-selected"].map((n) =>
        member.getAttribute(n),
      ),
    ).toEqual(["2", "1", "250", null, "false"]);
    // Down to api's first row, then Left: to the group; Left again collapses it.
    await userEvent.keyboard("{ArrowDown}{ArrowLeft}");
    expect(focused()).toEqual([1, 0]);
    await userEvent.keyboard("{ArrowLeft}");
    expect(rowAt(grid, 1)!.getAttribute("aria-expanded")).toBe("false");
    expect(said(grid)).toBe("api (250) collapsed");
    expect(focused()).toEqual([1, 0]);
    await userEvent.keyboard("{ArrowRight}");
    expect(model.isExpanded(["api"])).toBe(true);
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toEqual([1, 1]);
    await userEvent.keyboard("{Enter}");
    expect(model.isExpanded(["api"])).toBe(false);
    expect(grid.root.querySelectorAll(".hg-body [role=row]")).toHaveLength(4);
  });

  it("move the focus to a group when it collapses under a focused row", async () => {
    const { grid, model } = grouped(1000);
    model.setExpanded(["web"], true);
    grid.focusCell(5, "id");
    const header = rowAt(grid, 0)!;
    await userEvent.click(header.querySelector(".hg-toggle")!);
    expect(focused()).toEqual([0, 0]);
    expect(document.activeElement!.closest("[role=row]")).toBe(header);
  });

  it("select a group's rows with its checkbox and Space, showing a partly selected group as mixed", async () => {
    const { grid, model } = grouped(1000);
    await userEvent.click(checkbox(grid, 2));
    expect(checkbox(grid, 2).getAttribute("aria-checked")).toBe("true");
    expect(rowAt(grid, 2)!.dataset.selection).toBe("all");
    expect(said(grid)).toBe("250 rows selected");
    expect(model.selectedCount).toBe(250);
    model.setExpanded(["db"], true);
    grid.render();
    // db's first row toggled off: the group is partly selected.
    grid.focusCell(3, "id");
    await userEvent.keyboard(" ");
    expect(rowAt(grid, 3)!.getAttribute("aria-selected")).toBe("false");
    expect(checkbox(grid, 2).getAttribute("aria-checked")).toBe("mixed");
    expect(rowAt(grid, 4)!.getAttribute("aria-selected")).toBe("true");
    // Space on the group selects all of it again.
    grid.focusCell(2, "id");
    await userEvent.keyboard(" ");
    expect(checkbox(grid, 2).getAttribute("aria-checked")).toBe("true");
    // A click on a group row selects only its rows; Shift and click adds the groups up to it.
    await userEvent.click(rowAt(grid, 0)!.querySelector("[aria-colindex='3']")!);
    expect(model.selectedCount).toBe(250);
    await userEvent.click(rowAt(grid, 1)!.querySelector("[aria-colindex='3']")!, {
      modifiers: ["Shift"],
    });
    expect(model.selectedCount).toBe(500);
    expect([0, 1, 2].map((i) => checkbox(grid, i).getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "false",
    ]);
  });

  it("sort groups by a column's aggregate with header clicks", async () => {
    const { grid } = grouped(1000);
    const worst = [...grid.root.querySelectorAll<HTMLElement>("[role=columnheader]")].find((cell) =>
      cell.textContent?.startsWith("ms"),
    )!;
    await userEvent.click(worst);
    expect(visibleFirstCells(grid)).toEqual(["api (250)", "cache (250)", "web (250)", "db (250)"]);
    await userEvent.click(worst);
    expect(visibleFirstCells(grid)).toEqual(["db (250)", "web (250)", "cache (250)", "api (250)"]);
  });

  it("stream rows into existing and new groups while scrolled, the rows in view staying put", async () => {
    const { t, grid, model } = grouped(400, { sort: true });
    model.expandAll();
    grid.render();
    scroller(grid).scrollTop = 28 * 150;
    await frames();
    const before = visibleFirstCells(grid);
    expect(before[0]).toBe("api");
    const ids = () =>
      [...grid.root.querySelectorAll(".hg-body [role=row]")].map((row) => texts(row)[1]);
    const mounted = ids();
    // New rows sort first (by id, descending): above the rows in view, in web's group and a new one.
    t.append({ id: [1000, 1001, 1002], host: ["web", "web", "new"], ms: [1, 2, 3] });
    await frames();
    expect(visibleFirstCells(grid)).toEqual(before);
    expect(ids()).toEqual(mounted);
    expect(scroller(grid).scrollTop).toBe(28 * 152);
    expect(model.textAt(0, 0)).toBe("web (102)");
    expect(scroller(grid).getAttribute("aria-rowcount")).toBe(String(400 + 5 + 3 + 1));
    expect(model.row(model.rowCount - 2)).toMatchObject({ kind: "group", key: ["new"] });
  });

  it("redraw headers for new groups whose keys are the old ones", () => {
    const { view, grid, model } = grouped(100);
    const web = Array.from({ length: 25 }, (_, k) => latency(4 * k));
    model.setGroups(
      groupRows(view, { by: ["host"], ops: { n: count(), avg: max("ms"), worst: min("ms") } }),
    );
    grid.render();
    expect(texts(rowAt(grid, 0))).toEqual([
      "web (25)",
      "",
      String(Math.max(...web)),
      String(Math.min(...web)),
    ]);
  });

  it("let go of groups they no longer show, which then stop following", async () => {
    const t = table({ g: ["a", "b"], v: [1, 2] });
    const view = rowView(t);
    const made = (() => {
      const groups = groupRows(view, { by: ["g"], ops: { n: count() } });
      const model = createGridModel({ data: view, groups, columns: [{ field: "g" }] });
      model.setExpanded(["a"], true);
      model.textAt(0, 0);
      model.select(0);
      model.selectionState(0);
      model.setGroups(null);
      return { model, ref: new WeakRef(groups) };
    })();
    // Removed by a listener of the selection the grid is changing.
    const removedWhileSelecting = (() => {
      const groups = groupRows(view, { by: ["g"], ops: { n: count() } });
      const model = createGridModel({ data: view, groups, columns: [{ field: "g" }] });
      model.selectionState(0);
      model.selection.subscribe(() => model.setGroups(null));
      model.select(0);
      return { model, ref: new WeakRef(groups) };
    })();
    await frames();
    await cdp().send("HeapProfiler.collectGarbage");
    await frames();
    await cdp().send("HeapProfiler.collectGarbage");
    expect(made.ref.deref()).toBeUndefined();
    expect(removedWhileSelecting.ref.deref()).toBeUndefined();
    t.append({ g: ["c"], v: [3] });
    expect(made.model.rowCount).toBe(3);
    expect(removedWhileSelecting.model.rowCount).toBe(3);
  });

  it("go back to plain rows, as a grid, without groups", async () => {
    const { grid, model } = grouped(100);
    model.setGroups(null);
    grid.render();
    const root = scroller(grid);
    expect(root.getAttribute("role")).toBe("grid");
    expect(root.getAttribute("aria-rowcount")).toBe("101");
    const first = rowAt(grid, 0)!;
    expect(first.hasAttribute("aria-level")).toBe(false);
    expect(first.querySelector(".hg-controls")).toBeNull();
    expect(texts(first)).toEqual(["web", "0", "30", "30"]);
  });
});
