import { afterEach, describe, expect, it } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { category, time } from "../../src/data/column.ts";
import { col } from "../../src/data/expression.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { createGrid, type Grid, type GridOptions } from "../../src/dom/grid.ts";
import { createGridModel, type GridColumn, type GridModel } from "../../src/grid/model.ts";
import { point } from "../../src/marks/point.ts";
import { resolveTheme } from "../../src/theme.ts";
import { modelOf } from "./helpers.ts";

const hosts: HTMLElement[] = [];
const grids: { destroy(): void }[] = [];
afterEach(() => {
  for (const grid of grids.splice(0)) grid.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

function host(size = "width:600px;height:300px"): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = size;
  document.body.append(element);
  hosts.push(element);
  return element;
}

function mount<S extends Schema>(
  model: GridModel<S>,
  options: Partial<GridOptions<S>> = {},
  size?: string,
): Grid<S> {
  const grid = createGrid(host(size), { model, ariaLabel: "Requests", ...options });
  grids.push(grid);
  return grid;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** A scroll event, then the frame it schedules. */
const frames = async () => {
  await frame();
  await frame();
};

/** `rows` rows: an id, a latency, a time, and a host. */
function requests(rows: number, options: { maxRows?: number } = {}) {
  const start = Date.UTC(2026, 0, 1);
  return table(
    {
      id: Float64Array.from({ length: rows }, (_, i) => i),
      ms: Float64Array.from({ length: rows }, (_, i) => ((i * 7919) % 1000) / 4),
      at: time(Float64Array.from({ length: rows }, (_, i) => start + i * 1000)),
      host: category(Array.from({ length: rows }, (_, i) => ["web", "api", "db"][i % 3]!)),
    },
    options,
  );
}
type Requests = ReturnType<typeof requests> extends Table<infer S> ? S : never;

const COLUMNS: GridColumn<Requests>[] = [
  { field: "id", width: 80 },
  { field: "ms", title: "Latency", format: { minimumFractionDigits: 2 } },
  { field: "at", format: { timeStyle: "medium", hourCycle: "h23" } },
  { field: "host" },
];

function model<S extends Schema>(
  t: Table<S>,
  columns: readonly GridColumn<S>[],
  query?: Parameters<typeof rowView<S>>[1],
) {
  return createGridModel({ data: rowView(t, query), columns, locale: "en-US", timeZone: "UTC" });
}

/** A grid of any schema, as the helpers read it. */
type Mounted = { readonly root: HTMLElement };

const scroller = (grid: Mounted) => grid.root.querySelector<HTMLElement>(".hg-scroller")!;
const bodyRows = (grid: Mounted) => [
  ...grid.root.querySelectorAll<HTMLElement>(".hg-body [role=row]"),
];
const rowAt = (grid: Mounted, index: number) =>
  grid.root.querySelector<HTMLElement>(`.hg-body [aria-rowindex="${index + 2}"]`);
const texts = (row: Element | null) =>
  [...(row?.querySelectorAll("[role=gridcell]") ?? [])].map((cell) => cell.textContent);
const header = (grid: Mounted, title: string) =>
  [...grid.root.querySelectorAll<HTMLElement>("[role=columnheader]")].find((cell) =>
    cell.textContent?.startsWith(title),
  )!;

/** Rows whose box shows below the header, by index. */
function visibleRows(grid: Mounted): number[] {
  const bottom = scroller(grid).getBoundingClientRect().bottom;
  const top = grid.root.querySelector(".hg-header")!.getBoundingClientRect().bottom;
  return bodyRows(grid)
    .filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > top + 1 && box.top < bottom - 1;
    })
    .map((row) => Number(row.getAttribute("aria-rowindex")) - 2)
    .sort((a, b) => a - b);
}

/** Where the page's focus is: [row index, column index], -1 for the header row. */
function focused(): [number, number] {
  const cell = document.activeElement!;
  const row = cell.closest("[role=row]");
  return [
    Number(row?.getAttribute("aria-rowindex")) - 2,
    Number(cell.getAttribute("aria-colindex")) - 1,
  ];
}

const said = (grid: Mounted) => grid.root.querySelector("[aria-live]")!.textContent?.trim();
const COMMAND = navigator.platform.startsWith("Mac") ? "Meta" : "Control";

describe("grids", () => {
  it("draw a header and the rows in view, numbers at the end", () => {
    const grid = mount(model(requests(1000), COLUMNS));
    const root = scroller(grid);
    expect(root.getAttribute("aria-label")).toBe("Requests");
    expect(root.getAttribute("aria-rowcount")).toBe("1001");
    expect(root.getAttribute("aria-colcount")).toBe("4");
    expect(
      [...grid.root.querySelectorAll("[role=columnheader]")].map((h) => h.textContent),
    ).toEqual(["id", "Latency", "at", "host"]);
    // 300 px less a 32 px header shows 10 rows of 28 px; ten more below.
    expect(bodyRows(grid)).toHaveLength(20);
    expect(texts(rowAt(grid, 0))).toEqual(["0", "0.00", "00:00:00", "web"]);
    expect(texts(rowAt(grid, 1))).toEqual(["1", "229.75", "00:00:01", "api"]);
    const latency = rowAt(grid, 0)!.querySelector("[aria-colindex='2']")!;
    expect(getComputedStyle(latency).textAlign).toBe("end");
    expect(visibleRows(grid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("show missing values, and an empty grid as its header", () => {
    const t = table({ v: [1, Number.NaN], tag: ["a", null] });
    const grid = mount(
      createGridModel({
        data: rowView(t),
        columns: [{ field: "v" }, { field: "tag" }],
        missing: "n/a",
      }),
    );
    expect(texts(rowAt(grid, 1))).toEqual(["n/a", "n/a"]);
    const empty = mount(model(table({ v: [] as number[] }), [{ field: "v" }]));
    expect(scroller(empty).getAttribute("aria-rowcount")).toBe("1");
    expect(bodyRows(empty)).toHaveLength(0);
    expect(empty.root.querySelectorAll("[role=columnheader]")).toHaveLength(1);
  });

  it("mount only the rows in view as they scroll, in display order", async () => {
    const grid = mount(model(requests(100_000), COLUMNS));
    const root = scroller(grid);
    root.scrollTop = 28 * 50_000 + 5;
    await frames();
    expect(visibleRows(grid)[0]).toBe(50_000);
    expect(texts(rowAt(grid, 50_000))[0]).toBe("50,000");
    expect(bodyRows(grid).length).toBeLessThanOrEqual(31);
    // The DOM order is the display order, for screen readers.
    const order = bodyRows(grid).map((row) => Number(row.getAttribute("aria-rowindex")));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    root.scrollTop -= 28 * 3;
    await frames();
    expect(visibleRows(grid)[0]).toBe(49_997);
    const after = bodyRows(grid).map((row) => Number(row.getAttribute("aria-rowindex")));
    expect(after).toEqual([...after].sort((a, b) => a - b));
  });

  it("reach the last of a million rows, scrolling scaled past what browsers draw", async () => {
    const grid = mount(model(requests(1_000_000), COLUMNS));
    const root = scroller(grid);
    // 28 million pixels of rows in a spacer of 8 million.
    expect(root.scrollHeight).toBeLessThan(8_000_100);
    root.scrollTop = root.scrollHeight;
    await frames();
    const last = rowAt(grid, 999_999);
    expect(texts(last)).toEqual(["999,999", "20.25", "13:46:39", "web"]);
    expect(visibleRows(grid).at(-1)).toBe(999_999);
    expect(
      Math.abs(last!.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom),
    ).toBeLessThan(1);
    root.scrollTop = (root.scrollHeight - root.clientHeight) / 2;
    await frames();
    const middle = visibleRows(grid);
    expect(Math.abs(middle[0]! - 500_000)).toBeLessThan(20);
    expect(texts(rowAt(grid, middle[0]!))[0]).toBe(middle[0]!.toLocaleString("en-US"));
    // The keyboard reaches the end exactly.
    root.focus();
    await userEvent.keyboard(`{${COMMAND}>}{End}{/${COMMAND}}`);
    expect(focused()).toEqual([999_999, 3]);
    expect(visibleRows(grid).at(-1)).toBe(999_999);
  });

  it("mount only the columns in view of wide tables", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 100 }, (_, f) => [
        `f${f}`,
        Float64Array.from({ length: 50 }, (_, i) => i * 100 + f),
      ]),
    );
    const t = table(fields);
    const grid = mount(
      model(
        t,
        Object.keys(fields).map((field) => ({ field, width: 100 })),
      ),
      {},
      "width:600px;height:300px",
    );
    const cells = () => [...rowAt(grid, 0)!.querySelectorAll("[role=gridcell]")];
    // Six columns in view, two more on the right.
    expect(cells().map((c) => c.textContent)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(rowAt(grid, 0)!.querySelectorAll("[role=gridcell]")).toHaveLength(8);
    scroller(grid).scrollLeft = 5000;
    await frames();
    const shown = cells().map((cell) => Number(cell.getAttribute("aria-colindex")));
    expect(shown).toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
    expect(cells()[2]!.textContent).toBe("50");
    expect(header(grid, "f50").getAttribute("aria-colindex")).toBe("51");
  });
});

describe("grid focus", () => {
  it("roves with the keyboard from one tab stop, scrolling the target in first", async () => {
    const grid = mount(model(requests(1000), COLUMNS));
    const root = scroller(grid);
    root.focus();
    expect(focused()).toEqual([-1, 0]);
    expect(grid.root.querySelectorAll("[tabindex='0']")).toHaveLength(1);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(focused()).toEqual([1, 1]);
    await userEvent.keyboard("{PageDown}");
    // 268 px of rows make a page of 9.
    expect(focused()).toEqual([10, 1]);
    expect(visibleRows(grid)).toContain(10);
    await userEvent.keyboard("{End}");
    expect(focused()).toEqual([10, 3]);
    await userEvent.keyboard(`{${COMMAND}>}{End}{/${COMMAND}}`);
    expect(focused()).toEqual([999, 3]);
    expect(visibleRows(grid).at(-1)).toBe(999);
    await userEvent.keyboard(`{${COMMAND}>}{Home}{/${COMMAND}}`);
    expect(focused()).toEqual([-1, 0]);
    expect(visibleRows(grid)[0]).toBe(0);
    expect(grid.root.querySelectorAll("[tabindex='0']")).toHaveLength(1);
  });

  it("keeps the focused cell mounted while scrolled away, and comes back to it", async () => {
    const grid = mount(model(requests(10_000), COLUMNS));
    const root = scroller(grid);
    grid.focusCell(2, "ms");
    const cell = document.activeElement!;
    root.scrollTop = 28 * 5000;
    await frames();
    expect(document.activeElement).toBe(cell);
    expect(cell.isConnected).toBe(true);
    expect(cell.textContent).toBe("209.50");
    // In DOM order, before the rows in view.
    expect(bodyRows(grid)[0]).toBe(cell.parentElement);
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toEqual([3, 1]);
    expect(visibleRows(grid)).toContain(3);
  });

  it("gives up the kept cell when the focus leaves, and returns to it on Tab", async () => {
    const grid = mount(model(requests(10_000), COLUMNS));
    const after = document.createElement("button");
    after.textContent = "after";
    hosts[0]!.after(after);
    hosts.push(after);
    const root = scroller(grid);
    grid.focusCell(2, "ms");
    root.scrollTop = 28 * 5000;
    await frames();
    after.focus();
    await frames();
    expect(rowAt(grid, 2)).toBeNull();
    // The grid is the tab stop until its focused cell is mounted again.
    expect(root.tabIndex).toBe(0);
    await userEvent.tab({ shift: true });
    expect(focused()).toEqual([2, 1]);
    expect(visibleRows(grid)).toContain(2);
  });

  it("follows its row through sorting and streaming without moving the page's focus", async () => {
    const t = requests(200);
    const grid = mount(model(t, COLUMNS));
    grid.focusCell(4, "id");
    const cell = document.activeElement!;
    grid.model.cycleSort("ms");
    await frames();
    // Row 4 (169.00) sorts to index 135, out of view: its cell stays focused.
    expect(document.activeElement).toBe(cell);
    expect(cell.textContent).toBe("4");
    expect(cell.closest("[role=row]")!.getAttribute("aria-rowindex")).toBe(
      String(grid.model.focus!.rowIndex + 2),
    );
    t.append({ id: [500], ms: [0], at: [0], host: ["web"] });
    await frames();
    expect(document.activeElement).toBe(cell);
    expect(grid.model.focus!.rowIndex).toBe(grid.model.data.indexOf(4));
  });
});

describe("grid selection", () => {
  const selectedRows = (grid: Mounted) =>
    bodyRows(grid)
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => Number(row.getAttribute("aria-rowindex")) - 2);
  const cellOf = (grid: Mounted, row: number) =>
    rowAt(grid, row)!.querySelector("[role=gridcell]")!;

  it("selects rows as clicks do and says so", async () => {
    const grid = mount(model(requests(100), COLUMNS));
    expect(rowAt(grid, 0)!.getAttribute("aria-selected")).toBe("false");
    await userEvent.click(cellOf(grid, 2));
    expect(selectedRows(grid)).toEqual([2]);
    expect(said(grid)).toBe("1 row selected");
    expect(focused()).toEqual([2, 0]);
    await userEvent.click(cellOf(grid, 4), { modifiers: [COMMAND] });
    expect(selectedRows(grid)).toEqual([2, 4]);
    await userEvent.click(cellOf(grid, 6), { modifiers: ["Shift"] });
    expect(selectedRows(grid)).toEqual([4, 5, 6]);
    expect(said(grid)).toBe("3 rows selected");
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("selects with Space, Shift and arrows, and every row with Control A", async () => {
    const grid = mount(model(requests(100), COLUMNS));
    grid.focusCell(1, "id");
    await userEvent.keyboard(" ");
    expect(selectedRows(grid)).toEqual([1]);
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selectedRows(grid)).toEqual([1, 2, 3]);
    expect(said(grid)).toBe("3 rows selected");
    await userEvent.keyboard("{ArrowDown} ");
    expect(selectedRows(grid)).toEqual([1, 2, 3, 4]);
    await userEvent.keyboard(" ");
    expect(selectedRows(grid)).toEqual([1, 2, 3]);
    await userEvent.keyboard(`{${COMMAND}>}a{/${COMMAND}}`);
    expect(said(grid)).toBe("100 rows selected");
    await userEvent.keyboard("{Escape}");
    expect(selectedRows(grid)).toEqual([]);
    expect(said(grid)).toBe("No rows selected");
  });
});

describe("grids whose rows change before they redraw", () => {
  it("act on the row a clicked cell shows, not on the place it was drawn at", async () => {
    const t = table({ x: [1, 2, 3] });
    const grid = mount(model(t, [{ field: "x" }]));
    const cell = rowAt(grid, 1)!.querySelector("[role=gridcell]")!;
    expect(cell.textContent).toBe("2");
    t.dropFirst(1);
    // Not redrawn yet: the cell still shows "2", now the first row.
    await userEvent.click(cell);
    const selection = grid.model.selection.get("grid-rows");
    expect(selection?.kind === "rows" && Array.from(selection.rows.positions())).toEqual([0]);
    expect(document.activeElement!.textContent).toBe("2");
  });

  it("drop the rows from before a reset, whatever the reset leaves", async () => {
    const t = table({ x: [1, 2, 3] });
    const grid = mount(model(t, [{ field: "x" }]));
    t.reset({ x: [10, 20] });
    await frames();
    expect(bodyRows(grid).map((row) => texts(row)[0])).toEqual(["10", "20"]);
    t.reset({ x: [] });
    await frames();
    expect(bodyRows(grid)).toHaveLength(0);
    t.reset({ x: [7] });
    await frames();
    expect(bodyRows(grid).map((row) => texts(row)[0])).toEqual(["7"]);
  });

  it("keep rows anchored when the scroll they asked for is reported after", async () => {
    const t = table({ x: Float64Array.from({ length: 1000 }, (_, i) => i) });
    const grid = mount(model(t, [{ field: "x" }], { sort: [{ field: "x" }] }));
    grid.focusCell(100, "x");
    const top = grid.model.top;
    // Sorted in above the top row before the scroll event arrives, and
    // nothing reads the model before it does.
    t.append({ x: [-2, -1] });
    await frames();
    expect(grid.model.top).toBe(top + 56);
    expect(visibleRows(grid)).toContain(102);
  });
});

describe("grids whose listeners change the rows", () => {
  it("focus the row clicked when the selection's listeners restrict the view to it", async () => {
    const t = table({ x: Float64Array.from({ length: 20 }, (_, i) => i) });
    const data = rowView(t);
    const grid = mount(createGridModel({ data, columns: [{ field: "x" }] }));
    grid.model.selection.subscribe(() => {
      const selected = grid.model.selection.get("grid-rows");
      data.restrict(selected?.kind === "rows" ? selected.rows : null);
    });
    await userEvent.click(rowAt(grid, 5)!.querySelector("[role=gridcell]")!);
    expect(grid.model.rowCount).toBe(1);
    expect(grid.model.focus).toEqual({ rowIndex: 0, columnIndex: 0, column: "x" });
    expect(document.activeElement!.textContent).toBe("5");
  });
});

describe("grid columns", () => {
  it("keep the focused cell's element when columns move", async () => {
    const t = table({ x: [1, 2], y: [3, 4] });
    const grid = mount(model(t, [{ field: "x" }, { field: "y" }]));
    grid.focusCell(0, "y");
    const cell = document.activeElement!;
    let blurred = 0;
    cell.addEventListener("blur", () => blurred++);
    grid.model.setColumns([{ field: "y" }, { field: "x" }]);
    grid.render();
    expect(document.activeElement).toBe(cell);
    expect(blurred).toBe(0);
    expect([cell.textContent, cell.getAttribute("aria-colindex")]).toEqual(["3", "1"]);
  });

  it("ignore a header drawn for a field its column id no longer names", async () => {
    const t = table({ x: [2, 1], y: [3, 4] });
    const grid = mount(model(t, [{ field: "x", id: "col" }]));
    const cell = header(grid, "x");
    grid.model.setColumns([{ field: "y", id: "col" }]);
    // Clicked before the grid redraws it: it still says "x".
    cell.click();
    expect(grid.model.sort).toEqual([]);
  });

  it("keep their place while no column is shown, and focus it when columns return", async () => {
    const grid = mount(model(requests(1000), COLUMNS));
    grid.focusCell(100, "id");
    const top = grid.model.top;
    grid.model.setColumns(COLUMNS.map((column) => ({ ...column, hidden: true })));
    await frames();
    expect(grid.model.top).toBe(top);
    grid.model.setColumns(COLUMNS);
    await frames();
    expect(grid.model.top).toBe(top);
    expect(focused()).toEqual([100, 0]);
    expect(visibleRows(grid)).toContain(100);
  });

  it("are a named group with nothing in it while no column is shown", async () => {
    const t = table({ x: [1, 2] });
    const grid = mount(model(t, [{ field: "x" }]));
    grid.focusCell(1, "x");
    grid.model.setColumns([{ field: "x", hidden: true }]);
    grid.render();
    const root = scroller(grid);
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Requests");
    expect(grid.root.querySelectorAll("[role=row],[role=rowgroup]")).toHaveLength(0);
    expect(document.activeElement).toBe(root);
    grid.model.setColumns([{ field: "x" }]);
    grid.render();
    expect(root.getAttribute("role")).toBe("grid");
    expect(texts(rowAt(grid, 1))).toEqual(["2"]);
  });
});

describe("grid sorting", () => {
  it("cycles with header clicks and Enter, marking the order", async () => {
    const grid = mount(model(requests(100), COLUMNS));
    const latency = header(grid, "Latency");
    await userEvent.click(latency);
    expect(latency.getAttribute("aria-sort")).toBe("ascending");
    expect(latency.textContent).toBe("Latency▲");
    expect(texts(rowAt(grid, 0))[1]).toBe("0.00");
    expect(said(grid)).toBe("Sorted by Latency, ascending");
    await userEvent.keyboard("{Enter}");
    expect(latency.getAttribute("aria-sort")).toBe("descending");
    expect(texts(rowAt(grid, 0))[1]).toBe("245.25");
    await userEvent.click(header(grid, "host"), { modifiers: ["Shift"] });
    expect(said(grid)).toBe("Sorted by Latency, descending, then host, ascending");
    expect(header(grid, "host").textContent).toBe("host▲2");
    // One header at a time carries aria-sort.
    expect(header(grid, "host").hasAttribute("aria-sort")).toBe(false);
    // A plain click on a descending key ends the sort.
    await userEvent.click(latency);
    expect(latency.hasAttribute("aria-sort")).toBe(false);
    expect(said(grid)).toBe("Not sorted");
  });
});

describe("streaming grids", () => {
  it("keep the rows in view in place as a rolling window drops rows above them", async () => {
    const t = requests(500, { maxRows: 500 });
    const grid = mount(model(t, COLUMNS));
    const root = scroller(grid);
    root.scrollTop = 28 * 200;
    await frames();
    const before = visibleRows(grid).map((row) => texts(rowAt(grid, row))[0]);
    expect(before[0]).toBe("200");
    const n = 30;
    t.append({
      id: Float64Array.from({ length: n }, (_, i) => 500 + i),
      ms: new Float64Array(n),
      at: new Float64Array(n),
      host: Array.from({ length: n }, () => "web"),
    });
    await frames();
    expect(visibleRows(grid).map((row) => texts(rowAt(grid, row))[0])).toEqual(before);
    expect(root.scrollTop).toBe(28 * 170);
  });

  it("write no text when rows arrive below the ones in view", async () => {
    const t = requests(1000);
    const grid = mount(model(t, COLUMNS));
    scroller(grid).scrollTop = 28 * 400;
    await frames();
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(grid.root.querySelector(".hg-body")!, {
      characterData: true,
      subtree: true,
      childList: true,
    });
    t.append({ id: [1000, 1001], ms: [1, 2], at: [0, 0], host: ["web", "db"] });
    await frames();
    observer.disconnect();
    expect(changes).toEqual([]);
    expect(scroller(grid).getAttribute("aria-rowcount")).toBe("1003");
  });

  it("keep the top row as sorted rows arrive above it, and follow filters", async () => {
    const t = requests(300);
    const data = rowView(t, { sort: [{ field: "id", order: "descending" }] });
    const grid = mount(createGridModel({ data, columns: [{ field: "id" }] }));
    scroller(grid).scrollTop = 28 * 100;
    await frames();
    expect(texts(rowAt(grid, visibleRows(grid)[0]!))).toEqual(["199"]);
    t.append({ id: [400, 401, 402], ms: [0, 0, 0], at: [0, 0, 0], host: ["a", "a", "a"] });
    await frames();
    expect(texts(rowAt(grid, visibleRows(grid)[0]!))).toEqual(["199"]);
    data.setQuery({ ...data.query, filter: col("id").lt(50) });
    await frames();
    expect(scroller(grid).getAttribute("aria-rowcount")).toBe("51");
    expect(visibleRows(grid).at(-1)).toBe(49);
  });
});

describe("grid layout", () => {
  it("follow their container's size, and are 320 pixels tall without one", async () => {
    const grid = mount(model(requests(1000), COLUMNS));
    hosts[0]!.style.height = "600px";
    await frames();
    expect(grid.model.viewportHeight).toBe(568);
    expect(visibleRows(grid)).toHaveLength(21);
    const auto = mount(model(requests(10), COLUMNS), {}, "width:400px");
    expect(auto.root.getBoundingClientRect().height).toBe(320);
  });

  it("take the theme's colors, and follow updates", () => {
    const grid = mount(model(requests(10), COLUMNS), { theme: "dark" });
    const dark = resolveTheme("dark");
    const style = grid.root.style;
    expect(style.getPropertyValue("--hg-text")).toBe(dark.text);
    expect(style.getPropertyValue("--hg-surface")).toBe(dark.tooltipBackground);
    grid.update({ theme: "high-contrast", ariaLabel: "Latest" });
    expect(style.getPropertyValue("--hg-text")).toBe("#000000");
    expect(style.getPropertyValue("--hg-surface")).toBe("#ffffff");
    expect(scroller(grid).getAttribute("aria-label")).toBe("Latest");
    grid.update({ theme: undefined, headerHeight: 40 });
    expect(style.getPropertyValue("--hg-text")).toBe(resolveTheme("light").text);
    expect(grid.root.querySelector<HTMLElement>(".hg-header")!.getBoundingClientRect().height).toBe(
      40,
    );
    expect(() => grid.update({ headerHeight: 0 })).toThrow(/headerHeight/);
  });
});

describe("grids linked to charts", () => {
  it("share a table's rows both ways through views and a selection store", async () => {
    const t = table({
      x: Float64Array.from({ length: 50 }, (_, i) => i),
      y: Float64Array.from({ length: 50 }, (_, i) => (i * 7) % 50),
    });
    const store = selectionStore(t);
    const gridView = rowView(t);
    const chartView = rowView(t);
    const grid = mount(
      createGridModel({
        data: gridView,
        columns: [{ field: "x" }, { field: "y" }],
        selection: store,
      }),
    );
    const chart = createChart(host(), {
      renderer: "svg",
      marks: [point(chartView, { x: "x", y: "y" })],
      interaction: { brush: "x" },
    });
    grids.push(chart);
    // The application decides: the grid's selected rows restrict the chart,
    // and the chart's brush filters the grid.
    store.subscribe(() => {
      const selected = store.get("grid-rows");
      chartView.restrict(selected?.kind === "rows" ? selected.rows : null);
    });
    chart.on("select", ({ x }) =>
      gridView.setQuery({ filter: x ? col("x").ge(x[0]).and(col("x").le(x[1])) : true }),
    );
    await userEvent.click(rowAt(grid, 2)!.querySelector("[role=gridcell]")!);
    await userEvent.click(rowAt(grid, 5)!.querySelector("[role=gridcell]")!, {
      modifiers: ["Shift"],
    });
    await frames();
    expect(modelOf(chart).series()[0]!.length).toBe(4);
    chart.select([10, 19.5]);
    await frames();
    expect(scroller(grid).getAttribute("aria-rowcount")).toBe("11");
    expect(texts(rowAt(grid, 0))[0]).toBe("10");
    // The grid's rows filtered away stay selected, and the chart still shows them.
    expect(modelOf(chart).series()[0]!.length).toBe(4);
  });
});

describe("destroyed grids", () => {
  it("remove themselves and leave the model, view, and table working", () => {
    const t = requests(100);
    const m = model(t, COLUMNS);
    const container = host();
    const grid = createGrid(container, { model: m, ariaLabel: "x" });
    grid.destroy();
    grid.destroy();
    expect(container.childElementCount).toBe(0);
    t.append({ id: [100], ms: [1], at: [0], host: ["web"] });
    expect(m.rowCount).toBe(101);
    // A new grid over the same model starts where it left off.
    const again = mount(m);
    expect(scroller(again).getAttribute("aria-rowcount")).toBe("102");
  });

  it("are collected once destroyed: nothing they listened to keeps them", async () => {
    const t = requests(1000);
    const m = model(t, COLUMNS);
    const container = host();
    // Chrome's intersection observers hold the first element they ever
    // observed (one per page, charts' too); that is not the grids' doing.
    createGrid(container, { model: m, ariaLabel: "x" }).destroy();
    // Made in a function of its own, so no frame of this one holds a grid.
    const refs = (() => {
      const made: WeakRef<object>[] = [];
      for (let i = 0; i < 20; i++) {
        const grid = createGrid(container, { model: m, ariaLabel: "x", theme: "auto" });
        grid.focusCell(1, "id");
        scroller(grid).scrollTop = 500;
        made.push(new WeakRef(grid), new WeakRef(grid.root));
        grid.destroy();
      }
      // Chrome remembers the element that last had the focus, wherever it went.
      const button = document.createElement("button");
      container.append(button);
      button.focus();
      button.remove();
      return made;
    })();
    await frames();
    // Changes reaching the model reach no destroyed grid.
    t.append({ id: [1], ms: [1], at: [0], host: ["web"] });
    await frames();
    await cdp().send("HeapProfiler.collectGarbage");
    await frames();
    await cdp().send("HeapProfiler.collectGarbage");
    expect(refs.flatMap((ref, i) => (ref.deref() !== undefined ? [i] : []))).toEqual([]);
  });
});
