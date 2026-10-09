// Column layout in the DOM grid: resizing and moving columns by dragging
// headers, by keys, and from the column menu; pinned columns held at the
// edges as the others scroll; and hiding and showing columns.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { category } from "../../src/data/column.ts";
import { rowView } from "../../src/data/row-view.ts";
import { type Table, table } from "../../src/data/table.ts";
import { createGrid, type Grid } from "../../src/dom/grid.ts";
import { createGridModel, type GridColumn, MIN_COLUMN_WIDTH } from "../../src/grid/model.ts";

// Mouse input goes where the page shows it: the grids here fit in the frame.
const viewport = { width: window.innerWidth, height: window.innerHeight };
beforeAll(() => page.viewport(1000, 700));
afterAll(() => page.viewport(viewport.width, viewport.height));

const hosts: HTMLElement[] = [];
const grids: { destroy(): void }[] = [];
afterEach(() => {
  for (const grid of grids.splice(0)) grid.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

function mount(
  columns: readonly GridColumn[],
  data: Table = requests(200),
  size = "width:600px;height:300px",
): Grid {
  const host = document.createElement("div");
  host.style.cssText = size;
  document.body.append(host);
  hosts.push(host);
  const model = createGridModel({ data: rowView(data), columns, locale: "en-US" });
  const grid = createGrid(host, { model, ariaLabel: "Requests" });
  grids.push(grid);
  return grid;
}

/** Requests, as a table of any fields: the columns here are checked when the grid is made. */
function requests(rows: number, options: { maxRows?: number } = {}): Table {
  const t = table(
    {
      id: Float64Array.from({ length: rows }, (_, i) => i),
      ms: Float64Array.from({ length: rows }, (_, i) => (i * 37) % 500),
      at: Float64Array.from({ length: rows }, (_, i) => i * 1000),
      host: category(Array.from({ length: rows }, (_, i) => ["web", "api", "db"][i % 3]!)),
    },
    options,
  );
  return t as unknown as Table;
}

const COLUMNS = [
  { field: "id", width: 80 },
  { field: "ms", title: "Latency" },
  { field: "at" },
  { field: "host" },
] as GridColumn[];

/** A grid of 1,000 rows of 30 numbers, `f0` to `f29`, 100 pixels wide, pinned as given. */
function wide(pins: Record<string, "left" | "right">) {
  const rows = 1000;
  const fields = Object.fromEntries(
    Array.from({ length: 30 }, (_, f) => [
      `f${f}`,
      Float64Array.from({ length: rows }, (_, i) => i * 100 + f),
    ]),
  );
  const columns = Object.keys(fields).map((field) => ({
    field,
    width: 100,
    ...(pins[field] && { pin: pins[field] }),
  })) as GridColumn[];
  return mount(columns, table(fields) as unknown as Table, "width:620px;height:300px");
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async () => {
  await frame();
  await frame();
};

type Mounted = { readonly root: HTMLElement };
const scroller = (grid: Mounted) => grid.root.querySelector<HTMLElement>(".hg-scroller")!;
const header = (grid: Mounted, title: string) =>
  [...grid.root.querySelectorAll<HTMLElement>("[role=columnheader]")].find(
    (cell) => cell.firstChild?.textContent === title,
  )!;
const headers = (grid: Mounted) =>
  [...grid.root.querySelectorAll<HTMLElement>("[role=columnheader]")].map(
    (cell) => cell.firstChild?.textContent,
  );
const rowAt = (grid: Mounted, index: number) =>
  grid.root.querySelector<HTMLElement>(`.hg-body [aria-rowindex="${index + 2}"]`)!;
const cellsOf = (row: Element) => [...row.querySelectorAll<HTMLElement>("[role=gridcell]")];
const said = (grid: Mounted) => grid.root.querySelector("[aria-live]")!.textContent?.trim();
const menu = (grid: Mounted) => grid.root.querySelector<HTMLElement>("[role=menu]");
const items = (grid: Mounted) => [
  ...(menu(grid)?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []),
];
const item = (grid: Mounted, label: string) =>
  items(grid).find((element) => element.firstChild?.textContent === label)!;

/** Real mouse input through the browser: press at a point, move in steps, release. */
const mouse = {
  async send(
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    x: number,
    y: number,
    buttons: number,
  ) {
    const frame = window.frameElement?.getBoundingClientRect();
    await cdp().send("Input.dispatchMouseEvent", {
      type,
      x: x + (frame?.left ?? 0),
      y: y + (frame?.top ?? 0),
      button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  },
  async drag(from: [number, number], to: [number, number], { release = true, steps = 8 } = {}) {
    await this.send("mouseMoved", ...from, 0);
    await this.send("mousePressed", ...from, 1);
    for (let k = 1; k <= steps; k++) {
      const x = from[0] + ((to[0] - from[0]) * k) / steps;
      const y = from[1] + ((to[1] - from[1]) * k) / steps;
      await this.send("mouseMoved", x, y, 1);
    }
    if (release) await this.send("mouseReleased", ...to, 0);
  },
};

/** The middle of an element's box, or a point `dx` from its right edge. */
const middle = (element: Element): [number, number] => {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
};
const edge = (element: Element): [number, number] => {
  const box = element.getBoundingClientRect();
  return [box.right - 2, box.top + box.height / 2];
};

describe("resizing grid columns by dragging", () => {
  it("drags a header's edge, previewing the width as it goes, and says what it did", async () => {
    const grid = mount(COLUMNS);
    const latency = header(grid, "Latency");
    const [x, y] = edge(latency);
    await mouse.drag([x, y], [x + 60, y], { release: false });
    await frames();
    // Previewed while the pointer is down: the cells follow.
    expect(grid.model.columnLayout[1]!.width).toBe(180);
    expect(cellsOf(rowAt(grid, 0))[1]!.getBoundingClientRect().width).toBe(180);
    expect(cellsOf(rowAt(grid, 0))[2]!.getBoundingClientRect().left).toBe(
      latency.getBoundingClientRect().left + 180,
    );
    await mouse.send("mouseReleased", x + 60, y, 0);
    await frames();
    expect(grid.model.columns[1]!.width).toBe(180);
    expect(said(grid)).toBe("Latency, 180 pixels wide");
    // Neither the press on the edge nor the drag sorted.
    expect(grid.model.sort).toEqual([]);
    // Narrower than the minimum, it stops there.
    await mouse.drag(edge(latency), [latency.getBoundingClientRect().left - 50, y]);
    await frames();
    expect(grid.model.columns[1]!.width).toBe(MIN_COLUMN_WIDTH);
  });

  it("resizes once a frame however often the pointer moves, writing no cell's text", async () => {
    const grid = mount(COLUMNS);
    const handle = header(grid, "Latency").querySelector(".hg-resize")!;
    const [x, y] = edge(handle);
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(grid.root.querySelector(".hg-body")!, { characterData: true, subtree: true });
    let resizes = 0;
    const resize = grid.model.resizeColumn.bind(grid.model);
    grid.model.resizeColumn = (id, width) => {
      resizes++;
      resize(id, width);
    };
    const at = (dx: number) => ({
      bubbles: true,
      clientX: x + dx,
      clientY: y,
      pointerId: 1,
      buttons: 1,
    });
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...at(0), button: 0 }));
    for (let dx = 5; dx <= 50; dx += 5)
      scroller(grid).dispatchEvent(new PointerEvent("pointermove", at(dx)));
    expect(resizes).toBe(0);
    await frame();
    expect(resizes).toBe(1);
    expect(grid.model.columnLayout[1]!.width).toBe(170);
    scroller(grid).dispatchEvent(new PointerEvent("pointerup", at(50)));
    await frames();
    observer.disconnect();
    expect(changes).toEqual([]);
  });

  it("resizes a column pinned right from its left edge, which it keeps at the grid's right", async () => {
    const grid = wide({ f0: "left", f29: "right" });
    const last = header(grid, "f29");
    const handle = last.querySelector(".hg-resize")!;
    const right = last.getBoundingClientRect().right;
    const [x, y] = middle(handle);
    expect(x).toBeLessThan(last.getBoundingClientRect().left + 8);
    await mouse.drag([x, y], [x - 50, y]);
    await frames();
    expect(grid.model.columnLayout.at(-1)!.width).toBe(150);
    expect(header(grid, "f29").getBoundingClientRect().right).toBe(right);
    expect(header(grid, "f29").getBoundingClientRect().width).toBe(150);
  });

  it("puts back the width it had on Escape, though the grid narrowed meanwhile", async () => {
    const grid = mount(
      [
        { field: "id", pin: "left", width: 300 },
        { field: "ms", width: 200 },
        { field: "host", pin: "right", width: 100 },
      ] as GridColumn[],
      requests(20),
    );
    const [x, y] = edge(header(grid, "id"));
    await mouse.drag([x, y], [x - 200, y], { release: false });
    await frames();
    expect(grid.model.columnLayout[0]!.width).toBe(100);
    hosts[0]!.style.width = "400px";
    await frames();
    await userEvent.keyboard("{Escape}");
    await mouse.send("mouseReleased", x - 200, y, 0);
    await frames();
    // 300 pixels again, which a 400-pixel grid cannot hold at its edge.
    expect(grid.model.columnLayout[0]).toMatchObject({ id: "id", width: 300, pinned: null });
    hosts[0]!.style.width = "600px";
    await frames();
    expect(grid.model.columnLayout[0]).toMatchObject({ width: 300, pinned: "left" });
  });

  it("puts the width back on Escape", async () => {
    const grid = mount(COLUMNS);
    const latency = header(grid, "Latency");
    const [x, y] = edge(latency);
    await mouse.drag([x, y], [x + 80, y], { release: false });
    await frames();
    expect(grid.model.columnLayout[1]!.width).toBe(200);
    await userEvent.keyboard("{Escape}");
    await mouse.send("mouseReleased", x + 80, y, 0);
    await frames();
    expect(grid.model.columnLayout[1]!.width).toBe(120);
    expect(grid.model.sort).toEqual([]);
  });
});

describe("moving grid columns by dragging", () => {
  it("drops a header where the line shows, keeping the focus on its column, and never sorts", async () => {
    const grid = mount(COLUMNS);
    const at = header(grid, "at");
    const [, y] = middle(at);
    const [x0] = middle(header(grid, "id"));
    await mouse.drag(middle(at), [x0 - 20, y], { release: false });
    const line = grid.root.querySelector<HTMLElement>(".hg-drop")!;
    expect(line.hidden).toBe(false);
    expect(line.getBoundingClientRect().left).toBeCloseTo(
      header(grid, "id").getBoundingClientRect().left - 1,
      0,
    );
    await frames();
    expect(at.hasAttribute("data-moving")).toBe(true);
    await mouse.send("mouseReleased", x0 - 20, y, 0);
    await frames();
    expect(headers(grid)).toEqual(["at", "id", "Latency", "host"]);
    expect(line.hidden).toBe(true);
    expect(at.hasAttribute("data-moving")).toBe(false);
    expect(said(grid)).toBe("at, column 1 of 4");
    expect(grid.model.focus).toMatchObject({ rowIndex: -1, column: "at" });
    expect(document.activeElement).toBe(at);
    expect(grid.model.sort).toEqual([]);
    // A drag back to where it started is not a click.
    const [x, yy] = middle(at);
    await mouse.drag([x, yy], [x + 30, yy], { steps: 3 });
    await mouse.drag([x + 30, yy], [x, yy], { steps: 3 });
    await mouse.drag([x, yy], [x + 40, yy], { steps: 2, release: false });
    await mouse.send("mouseMoved", x, yy, 1);
    await mouse.send("mouseReleased", x, yy, 0);
    await frames();
    expect(grid.model.sort).toEqual([]);
    expect(headers(grid)).toEqual(["at", "id", "Latency", "host"]);
    // A press that does not move is a click, which sorts.
    await userEvent.click(at);
    expect(grid.model.sort).toEqual([{ field: "at", order: "ascending" }]);
  });

  it("end a press let go outside the grid, so passing over headers later drags nothing", async () => {
    const grid = mount(COLUMNS);
    const [x, y] = middle(header(grid, "at"));
    await mouse.send("mouseMoved", x, y, 0);
    await mouse.send("mousePressed", x, y, 1);
    // Straight out of the grid, and let go there.
    await mouse.send("mouseMoved", 900, y, 1);
    await mouse.send("mouseReleased", 900, y, 0);
    const [x0] = middle(header(grid, "id"));
    await mouse.send("mouseMoved", x0, y, 0);
    await mouse.send("mouseMoved", x0 - 20, y, 0);
    await frames();
    expect(grid.root.hasAttribute("data-dragging")).toBe(false);
    expect(grid.root.querySelector<HTMLElement>(".hg-drop")!.hidden).toBe(true);
    expect(headers(grid)).toEqual(["id", "Latency", "at", "host"]);
    await userEvent.click(header(grid, "host"));
    expect(grid.model.sort).toEqual([{ field: "host", order: "ascending" }]);
  });

  it("end a drag whose pointer the grid loses, moving nothing", async () => {
    const grid = mount(COLUMNS);
    const [x, y] = middle(header(grid, "at"));
    await mouse.drag([x, y], [x - 150, y], { release: false });
    expect(grid.root.dataset.dragging).toBe("move");
    scroller(grid).releasePointerCapture(1);
    // The loss is told before the pointer's next event.
    await mouse.send("mouseMoved", x - 160, y, 1);
    expect(grid.root.hasAttribute("data-dragging")).toBe(false);
    await mouse.send("mouseReleased", x - 150, y, 0);
    await frames();
    expect(headers(grid)).toEqual(["id", "Latency", "at", "host"]);
    expect(grid.model.sort).toEqual([]);
  });

  it("drops after the last column, and puts it back on Escape", async () => {
    const grid = mount(COLUMNS);
    const [x, y] = middle(header(grid, "id"));
    const [right] = edge(header(grid, "host"));
    await mouse.drag([x, y], [right, y]);
    await frames();
    expect(headers(grid)).toEqual(["Latency", "at", "host", "id"]);
    await mouse.drag(middle(header(grid, "id")), [x, y], { release: false });
    await userEvent.keyboard("{Escape}");
    expect(grid.root.querySelector<HTMLElement>(".hg-drop")!.hidden).toBe(true);
    await mouse.send("mouseReleased", x, y, 0);
    await frames();
    expect(headers(grid)).toEqual(["Latency", "at", "host", "id"]);
  });

  it("drop nothing when the columns were replaced while the pointer was down", async () => {
    const grid = mount(COLUMNS);
    const [x, y] = middle(header(grid, "host"));
    await mouse.drag([x, y], [middle(header(grid, "Latency"))[0] - 30, y], { release: false });
    grid.model.setColumns([{ field: "host" }, { field: "id" }]);
    await mouse.send("mouseReleased", x, y, 0);
    await frames();
    expect(headers(grid)).toEqual(["host", "id"]);
    expect(grid.model.sort).toEqual([]);
  });

  it("moves pinned columns among the pinned, and the others among themselves", async () => {
    const grid = wide({ f0: "left", f1: "left", f29: "right" });
    const [x, y] = middle(header(grid, "f3"));
    // Over the pinned columns, a scrolling column drops at the start of those that scroll.
    await mouse.drag([x, y], [middle(header(grid, "f0"))[0], y]);
    await frames();
    expect(grid.model.columnLayout.slice(0, 4).map(({ id }) => id)).toEqual([
      "f0",
      "f1",
      "f3",
      "f2",
    ]);
    await mouse.drag(middle(header(grid, "f1")), [middle(header(grid, "f0"))[0] - 30, y]);
    await frames();
    expect(grid.model.columnLayout.slice(0, 3).map(({ id, pinned }) => [id, pinned])).toEqual([
      ["f1", "left"],
      ["f0", "left"],
      ["f3", null],
    ]);
  });
});

describe("column keys on headers", () => {
  it("move a column with Shift and arrows within its region, keeping the focus on its header", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(-1, "ms");
    const cell = document.activeElement!;
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(headers(grid)).toEqual(["id", "at", "Latency", "host"]);
    expect(document.activeElement).toBe(cell);
    expect(said(grid)).toBe("Latency, column 3 of 4");
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    expect(headers(grid)).toEqual(["id", "at", "host", "Latency"]);
    expect(said(grid)).toBe("Latency, column 4 of 4");
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(headers(grid)).toEqual(["id", "at", "Latency", "host"]);
    // Plain arrows still move the focus, not the column.
    await userEvent.keyboard("{ArrowLeft}");
    expect(grid.model.focus!.column).toBe("at");
    expect(grid.model.sort).toEqual([]);
  });

  it("resize a column with Alt and arrows, in steps, no narrower than the minimum", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(-1, "ms");
    await userEvent.keyboard("{Alt>}{ArrowRight}{ArrowRight}{/Alt}");
    expect(grid.model.columnLayout[1]!.width).toBe(152);
    expect(said(grid)).toBe("Latency, 152 pixels wide");
    await userEvent.keyboard(`{Alt>}${"{ArrowLeft}".repeat(8)}{/Alt}`);
    expect(grid.model.columnLayout[1]!.width).toBe(MIN_COLUMN_WIDTH);
    expect(said(grid)).toBe(`Latency, ${MIN_COLUMN_WIDTH} pixels wide`);
    expect(grid.model.focus).toMatchObject({ rowIndex: -1, column: "ms" });
  });

  it("are header keys only: on body cells, Shift and arrows still select", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(1, "ms");
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(grid.model.selectedCount).toBe(2);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(headers(grid)).toEqual(["id", "Latency", "at", "host"]);
  });
});

describe("column menus", () => {
  it("open from a header with Alt and Down, move, resize, pin, and hide, and give the focus back", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(-1, "at");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(menu(grid)!.getAttribute("aria-label")).toBe("at column");
    expect(document.activeElement).toBe(item(grid, "Move left"));
    expect(items(grid).map((element) => element.firstChild?.textContent)).toEqual([
      "Move left",
      "Move right",
      "Narrower",
      "Wider",
      "Pin to the left",
      "Pin to the right",
      "Hide column",
      "id",
      "Latency",
      "at",
      "host",
    ]);
    expect(item(grid, "Move left").getAttribute("aria-keyshortcuts")).toBe("Shift+ArrowLeft");
    // Down to "Pin to the left".
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(menu(grid)).toBeNull();
    expect(grid.model.columnLayout.map(({ id, pinned }) => [id, pinned])[0]).toEqual([
      "at",
      "left",
    ]);
    expect(said(grid)).toBe("at pinned to the left");
    expect(document.activeElement).toBe(header(grid, "at"));
    // Pinned, it offers to unpin.
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(item(grid, "Unpin")).toBeDefined();
    expect(item(grid, "Pin to the left")).toBeUndefined();
    await userEvent.keyboard("{Escape}");
    expect(menu(grid)).toBeNull();
    expect(document.activeElement).toBe(header(grid, "at"));
    // Wider, from the menu.
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(grid.model.columnLayout[0]!.width).toBe(136);
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}{End}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(item(grid, "Hide column"));
    await userEvent.keyboard("{Enter}");
    expect(headers(grid)).toEqual(["id", "Latency", "host"]);
    expect(said(grid)).toBe("at hidden");
    // The focus goes to the nearest shown column's header.
    expect(document.activeElement).toBe(header(grid, "id"));
  });

  it("show hidden columns again with their checks, staying open, and keep the last one shown", async () => {
    const grid = mount(COLUMNS.map((column) => ({ ...column, hidden: column.field !== "id" })));
    expect(headers(grid)).toEqual(["id"]);
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    const checks = () =>
      items(grid)
        .filter((element) => element.getAttribute("role") === "menuitemcheckbox")
        .map((element) => [
          element.firstChild?.textContent,
          element.getAttribute("aria-checked"),
          element.getAttribute("aria-disabled"),
        ]);
    expect(checks()).toEqual([
      ["id", "true", "true"],
      ["Latency", "false", null],
      ["at", "false", null],
      ["host", "false", null],
    ]);
    expect(item(grid, "Hide column").getAttribute("aria-disabled")).toBe("true");
    // The last shown column cannot be hidden.
    item(grid, "id").focus();
    await userEvent.keyboard("{Enter}");
    expect(headers(grid)).toEqual(["id"]);
    await userEvent.keyboard("{ArrowDown}{Enter}{ArrowDown}{ArrowDown} ");
    expect(menu(grid)).not.toBeNull();
    expect(document.activeElement).toBe(item(grid, "host"));
    expect(checks()).toEqual([
      ["id", "true", null],
      ["Latency", "true", null],
      ["at", "false", null],
      ["host", "true", null],
    ]);
    await frames();
    expect(headers(grid)).toEqual(["id", "Latency", "host"]);
    expect(said(grid)).toBe("host shown");
    await userEvent.keyboard("{Tab}");
    expect(menu(grid)).toBeNull();
  });

  it("open on a right click and from the header's button, and close when the focus leaves", async () => {
    const grid = mount(COLUMNS);
    await userEvent.click(header(grid, "host"), { button: "right" });
    expect(menu(grid)!.getAttribute("aria-label")).toBe("host column");
    expect(grid.model.sort).toEqual([]);
    const outside = document.createElement("button");
    document.body.append(outside);
    hosts.push(outside);
    outside.focus();
    expect(menu(grid)).toBeNull();
    const latency = header(grid, "Latency");
    await userEvent.hover(latency);
    await userEvent.click(latency.querySelector(".hg-menu-button")!);
    expect(menu(grid)!.getAttribute("aria-label")).toBe("Latency column");
    expect(grid.model.sort).toEqual([]);
    await userEvent.click(item(grid, "Move left"));
    expect(headers(grid)).toEqual(["Latency", "id", "at", "host"]);
    expect(menu(grid)).toBeNull();
  });

  it("keep the focus on their items in a shadow root as checks change", async () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    hosts.push(outer);
    const shadow = outer.attachShadow({ mode: "open" });
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    shadow.append(host);
    const model = createGridModel({ data: rowView(requests(20)), columns: COLUMNS });
    const grid = createGrid(host, { model, ariaLabel: "Requests" });
    grids.push(grid);
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}{End}");
    const last = () => shadow.activeElement?.firstChild?.textContent;
    expect(last()).toBe("host");
    await userEvent.keyboard(" ");
    expect(model.columnLayout.map(({ id }) => id)).toEqual(["id", "ms", "at"]);
    // Still on the same item, now unchecked, in a menu still open.
    expect(last()).toBe("host");
    expect(shadow.activeElement!.getAttribute("aria-checked")).toBe("false");
    await userEvent.keyboard(" ");
    expect(model.columnLayout.map(({ id }) => id)).toEqual(["id", "ms", "at", "host"]);
  });

  it("offer no pin the grid is too narrow to hold", async () => {
    const grid = mount(
      [
        { field: "id", width: 250, pin: "left" },
        { field: "ms", width: 300 },
        { field: "host" },
      ] as GridColumn[],
      requests(10),
      "width:600px;height:200px",
    );
    grid.focusCell(-1, "ms");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(item(grid, "Pin to the left").getAttribute("aria-disabled")).toBe("true");
    item(grid, "Pin to the left").focus();
    await userEvent.keyboard("{Enter}");
    expect(grid.model.columns[1]!.pin).toBeUndefined();
  });

  it("say what can be done as columns change while they are open, doing nothing stale", async () => {
    const grid = mount(COLUMNS, requests(10), "width:600px;height:200px");
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(item(grid, "Hide column").hasAttribute("aria-disabled")).toBe(false);
    for (const id of ["ms", "at", "host"]) grid.model.setColumnVisible(id, false);
    // Chosen before the menu is written again: nothing happens.
    item(grid, "Hide column").focus();
    await userEvent.keyboard("{Enter}");
    expect(headers(grid)).toEqual(["id"]);
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    grid.model.setColumnVisible("ms", true);
    await frames();
    // Written again on the next frame, keeping the focus on the first item.
    expect(document.activeElement).toBe(item(grid, "Move left"));
    expect(item(grid, "Move right").hasAttribute("aria-disabled")).toBe(false);
    expect(item(grid, "Latency").getAttribute("aria-checked")).toBe("true");
    // A grid narrowed with the menu open offers no pin it cannot hold.
    expect(item(grid, "Pin to the left").hasAttribute("aria-disabled")).toBe(false);
    hosts[0]!.style.width = "150px";
    await frames();
    expect(item(grid, "Pin to the left").getAttribute("aria-disabled")).toBe("true");
  });

  it("keep the focus on the same item as columns move, go, and pin while they are open", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    item(grid, "Latency").focus();
    grid.model.moveColumn("ms", null);
    await frames();
    expect(document.activeElement).toBe(item(grid, "Latency"));
    await userEvent.keyboard(" ");
    expect(headers(grid)).toEqual(["id", "at", "host"]);
    // Gone with the column it named, last in the menu: the item now last.
    grid.model.setColumns(COLUMNS.filter(({ field }) => field !== "ms"));
    await frames();
    expect(document.activeElement).toBe(item(grid, "host"));
    // An action the menu no longer offers: the item now in its place.
    item(grid, "Pin to the left").focus();
    grid.model.pinColumn("id", "left");
    await frames();
    expect(
      items(grid)
        .map((element) => element.firstChild?.textContent)
        .slice(4, 7),
    ).toEqual(["Pin to the right", "Unpin", "Hide column"]);
    expect(document.activeElement).toBe(item(grid, "Pin to the right"));
  });

  it("close when their column goes, giving the focus to the grid, and with the grid", async () => {
    const grid = mount(COLUMNS);
    grid.focusCell(-1, "at");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    grid.model.setColumnVisible("at", false);
    await frames();
    expect(menu(grid)).toBeNull();
    expect(document.activeElement).toBe(header(grid, "host"));
    grid.focusCell(-1, "id");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    const open = menu(grid)!;
    grid.destroy();
    expect(open.isConnected).toBe(false);
  });
});

describe("pinned columns", () => {
  it("stay at the edges as the others scroll under them, in one row in visual order", async () => {
    const grid = wide({ f0: "left", f1: "left", f29: "right" });
    const root = scroller(grid);
    const row = () => rowAt(grid, 3);
    const lefts = () => cellsOf(row()).map((cell) => Math.round(cell.getBoundingClientRect().left));
    const start = root.getBoundingClientRect().left;
    expect(lefts().slice(0, 4)).toEqual([start, start + 100, start + 200, start + 300]);
    root.scrollLeft = 2000;
    await frames();
    const cells = cellsOf(row());
    // Pinned cells kept their place; the others moved under them.
    expect(lefts().slice(0, 2)).toEqual([start, start + 100]);
    expect(lefts().at(-1)).toBe(start + root.clientWidth - 100);
    expect(cells[0]!.textContent).toBe("300");
    expect(cells.at(-1)!.textContent).toBe("329");
    // DOM order is the visual order, and the logical order.
    const indices = cells.map((cell) => Number(cell.getAttribute("aria-colindex")));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.slice(0, 2)).toEqual([1, 2]);
    expect(indices.at(-1)).toBe(30);
    const scrolling = cells.slice(2, -1).map((cell) => cell.getBoundingClientRect().left);
    expect(scrolling).toEqual([...scrolling].sort((a, b) => a - b));
    // The header is one row of all the shown header cells mounted, in the same order.
    const heads = [...grid.root.querySelectorAll("[role=columnheader]")].map((cell) =>
      Number(cell.getAttribute("aria-colindex")),
    );
    expect(heads).toEqual(indices);
    // Mounted: the pinned columns, the four scrolling ones in view, and two more on each side.
    const { columnStart, columnEnd } = grid.model.visibleRange();
    expect(columnEnd - columnStart).toBe(4 + 4);
    expect(cells.length).toBe(3 + 8);
  });

  it("keep the focus in view: keys reveal scrolling columns beside the pins, not under them", async () => {
    const grid = wide({ f0: "left", f29: "right" });
    const root = scroller(grid);
    grid.focusCell(5, "f0");
    root.scrollLeft = 1500;
    await frames();
    const focusedCell = document.activeElement!;
    expect(focusedCell.getBoundingClientRect().left).toBe(root.getBoundingClientRect().left);
    await userEvent.keyboard("{ArrowRight}");
    // f1 comes back into view right after the pin.
    expect(grid.model.left).toBe(0);
    const f1 = document.activeElement!;
    expect(f1.getBoundingClientRect().left).toBe(root.getBoundingClientRect().left + 100);
    await userEvent.keyboard("{End}");
    expect(grid.model.focus!.column).toBe("f29");
    // The pinned last column needs no scroll.
    expect(grid.model.left).toBe(0);
    await userEvent.keyboard("{ArrowLeft}");
    // f28 ends where the right pin starts.
    const f28 = document.activeElement!.getBoundingClientRect();
    expect(f28.right).toBe(root.getBoundingClientRect().left + root.clientWidth - 100);
  });

  it("follow streaming rows, rewriting no text of rows that stay", async () => {
    const t = requests(500, { maxRows: 500 });
    const grid = mount(
      [
        { field: "id", pin: "left", width: 80 },
        { field: "ms" },
        { field: "at" },
        { field: "host" },
        { field: "ms", id: "ms2" },
        { field: "at", id: "at2" },
        { field: "id", id: "id2", pin: "right", width: 80 },
      ] as GridColumn[],
      t,
    );
    const root = scroller(grid);
    root.scrollTop = 28 * 100;
    root.scrollLeft = 100;
    await frames();
    const pinned = () =>
      [...grid.root.querySelectorAll(".hg-body [role=row]")]
        .map((row) => [row.firstElementChild!.textContent, row.lastElementChild!.textContent])
        .filter(([left]) => Number(left) >= 100 && Number(left) < 110);
    const before = pinned();
    expect(before[0]).toEqual(["100", "100"]);
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(grid.root.querySelector(".hg-body")!, { characterData: true, subtree: true });
    t.append({ id: [500, 501, 502], ms: [0, 0, 0], at: [0, 0, 0], host: ["web", "web", "web"] });
    await frames();
    observer.disconnect();
    // Three rows dropped above: the rows in view stayed, with their text.
    expect(changes).toEqual([]);
    expect(pinned()).toEqual(before);
    expect(root.scrollTop).toBe(28 * 97);
    expect(root.scrollLeft).toBe(100);
    expect(rowAt(grid, 97).firstElementChild!.getBoundingClientRect().left).toBe(
      root.getBoundingClientRect().left,
    );
  });

  it("pinned right reach the grid's right edge when the columns are narrower than the grid", async () => {
    const grid = mount(
      [
        { field: "id", width: 100 },
        { field: "ms", width: 100 },
        { field: "host", width: 100, pin: "right" },
      ] as GridColumn[],
      requests(20),
    );
    const root = scroller(grid);
    const right = () => root.getBoundingClientRect().left + root.clientWidth;
    expect(header(grid, "host").getBoundingClientRect().right).toBe(right());
    expect(cellsOf(rowAt(grid, 0)).at(-1)!.getBoundingClientRect().right).toBe(right());
    // Nothing scrolls past the columns.
    expect(root.scrollWidth).toBe(root.clientWidth);
    grid.model.setColumnVisible("ms", false);
    await frames();
    expect(cellsOf(rowAt(grid, 0)).at(-1)!.getBoundingClientRect().right).toBe(right());
    expect(root.scrollWidth).toBe(root.clientWidth);
  });

  it("scroll with the others while the grid is too narrow to hold them", async () => {
    const grid = mount(
      [
        { field: "id", pin: "left", width: 200 },
        { field: "ms", width: 200 },
        { field: "host", pin: "right", width: 200 },
      ] as GridColumn[],
      requests(20),
      "width:500px;height:200px",
    );
    const first = () => cellsOf(rowAt(grid, 0))[0]!;
    expect(first().dataset.pin).toBeUndefined();
    scroller(grid).scrollLeft = 100;
    await frames();
    expect(first().getBoundingClientRect().left).toBe(
      scroller(grid).getBoundingClientRect().left - 100,
    );
    hosts[0]!.style.width = "800px";
    await frames();
    expect(first().dataset.pin).toBe("left");
    expect(cellsOf(rowAt(grid, 0)).at(-1)!.dataset.pin).toBe("right");
  });
});
