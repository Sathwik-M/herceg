// Charts bound to selection stores: brushes, lassos, clicks, and keys select
// rows there, and charts and grids sharing a channel show one selection.

import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { col } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import {
  type DataSelection,
  type SelectionStore,
  selectionStore,
  selectRows,
  selectWhere,
} from "../../src/data/selection.ts";
import { type Table, table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import type { ChartEvents } from "../../src/dom/events.ts";
import { createGrid, type Grid } from "../../src/dom/grid.ts";
import { createGridModel } from "../../src/grid/model.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import { DIM } from "../../src/model/highlight.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import type { PointGeometry } from "../../src/scene/scene.ts";
import { MOUSE, modelOf } from "./helpers.ts";

const mounted: { destroy(): void }[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const item of mounted.splice(0)) item.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

function host(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = "width:600px;height:300px";
  document.body.append(element);
  hosts.push(element);
  return element;
}

function chart(options: ChartOptions): Chart {
  const made = createChart(host(), { renderer: "svg", ...options });
  mounted.push(made);
  return made;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async () => {
  await frame();
  await frame();
};

/** `n` points along x, their y a scramble of x. */
function data(n: number, options: { maxRows?: number } = {}): Table {
  return table(
    {
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => (i * 7) % n),
    },
    options,
  ) as unknown as Table;
}

function press(target: Element, type: string, x: number, y: number, keys: PointerEventInit = {}) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: MOUSE,
      ...keys,
    }),
  );
}

/** Drags across a chart's plot from x value `from` to `to`, at mid height. */
function brush(target: Chart, from: number, to: number) {
  const [panel] = modelOf(target).panels();
  const y = panel!.plot.y + panel!.plot.height / 2;
  press(target.root, "pointerdown", panel!.x.map(from), y);
  press(target.root, "pointermove", panel!.x.map((from + to) / 2), y);
  press(target.root, "pointermove", panel!.x.map(to), y);
  press(target.root, "pointerup", panel!.x.map(to), y);
}

/** Clicks the point of row `row` of a chart of x and y. */
function click(target: Chart, source: Table, row: number, keys: PointerEventInit = {}) {
  const [panel] = modelOf(target).panels();
  const px = panel!.x.map(source.value("x", row) as number);
  const py = panel!.y.map(source.value("y", row) as number);
  press(target.root, "pointerdown", px, py, keys);
  press(target.root, "pointerup", px, py, keys);
}

/** The rows a selection holds now. */
function rowsOf(selection: DataSelection | null, source: Table): number[] {
  if (!selection) return [];
  if (selection.kind === "rows") return Array.from(selection.rows.positions());
  return Array.from({ length: source.length }, (_, row) => row).filter((row) => {
    const x = source.value("x", row) as number;
    // The brushes here bound x.
    const [, [, , lo], [, , hi]] = selection.expression as [
      string,
      [string, unknown, number],
      [string, unknown, number],
    ];
    return x >= lo && x <= hi;
  });
}

/** How many points a chart draws undimmed, and how many dimmed. */
function drawn(target: Chart): { full: number; dim: number } {
  const scene = modelOf(target).scene(() => 0);
  let [full, dim] = [0, 0];
  for (const mark of scene.panels[0]!.marks) {
    if (mark.kind !== "point") continue;
    const points = mark as PointGeometry;
    if (points.fillOpacity < 1) dim += points.count;
    else full += points.count;
  }
  return { full, dim };
}

function grid(source: Table, store: SelectionStore): Grid {
  const made = createGrid(host(), {
    model: createGridModel({
      data: rowView(source),
      columns: [{ field: "x" }, { field: "y" }],
      selectionStore: store,
      channel: "focus",
    }),
    ariaLabel: "Points",
  });
  mounted.push(made);
  return made;
}

const selectedInGrid = (made: Grid) =>
  [...made.root.querySelectorAll(".hg-body [aria-rowindex]")]
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => Number(row.getAttribute("aria-rowindex")) - 2);

describe("row selection across charts and grids", () => {
  it("brushes in one chart highlight in another and in a grid, rows streamed in too", async () => {
    const source = data(20);
    const store = selectionStore(source);
    const bound = rowSelection({ store, channel: "focus" });
    const a = chart({
      marks: [point(source, { x: "x", y: "y" })],
      interaction: { brush: "x" },
      rowSelection: bound,
    });
    const b = chart({
      marks: [point(source, { x: "x", y: "y" })],
      rowSelection: rowSelection({ store, channel: "focus", events: [] }),
    });
    const list = grid(source, store);
    await a.loading;
    const written: ChartEvents["select"][] = [];
    a.on("select", (event) => written.push(event));
    brush(a, 2.5, 6.5);
    await frames();
    expect(rowsOf(store.get("focus"), source)).toEqual([3, 4, 5, 6]);
    expect(written.at(-1)!.rows).toEqual([
      { table: source, channel: "focus", selection: store.get("focus") },
    ]);
    expect(drawn(b)).toEqual({ full: 4, dim: 16 });
    expect(selectedInGrid(list)).toEqual([3, 4, 5, 6]);
    // The brush's condition holds rows appended later.
    source.append({ x: [4.5, 30], y: [1, 1] });
    await frames();
    expect(drawn(b)).toEqual({ full: 5, dim: 17 });
    expect(drawn(a)).toEqual({ full: 5, dim: 17 });
    // Dimmed points are drawn at a fraction of their opacity.
    const dimmed = b.root.querySelector(`svg g[fill-opacity="${DIM}"]`);
    expect(dimmed).not.toBeNull();
  });

  it("show a grid's rows, and add clicked points to them", async () => {
    const source = data(10);
    const store = selectionStore(source);
    const a = chart({
      marks: [point(source, { x: "x", y: "y" })],
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    const list = grid(source, store);
    await userEvent.click(list.root.querySelector('.hg-body [aria-rowindex="4"] [role=gridcell]')!);
    await frames();
    expect(rowsOf(store.get("focus"), source)).toEqual([2]);
    expect(drawn(a)).toEqual({ full: 1, dim: 9 });
    const clicks: ChartEvents["click"][] = [];
    a.on("click", (event) => clicks.push(event));
    click(a, source, 7, { shiftKey: true });
    await frames();
    expect(rowsOf(store.get("focus"), source)).toEqual([2, 7]);
    expect(clicks.at(-1)!.rows![0]!.selection).toBe(store.get("focus"));
    expect(selectedInGrid(list)).toEqual([2, 7]);
    // A grid toggling a row of the chart's selection keeps the others.
    await userEvent.click(
      list.root.querySelector('.hg-body [aria-rowindex="9"] [role=gridcell]')!,
      {
        modifiers: [navigator.platform.startsWith("Mac") ? "Meta" : "Control"],
      },
    );
    await frames();
    expect(rowsOf(store.get("focus"), source)).toEqual([2]);
    // A click off the data clears: the plot's top left corner is empty.
    const [panel] = modelOf(a).panels();
    press(a.root, "pointerdown", panel!.plot.x + 3, panel!.plot.y + 3);
    press(a.root, "pointerup", panel!.plot.x + 3, panel!.plot.y + 3);
    expect(store.get("focus")).toBeNull();
    await frames();
    expect(drawn(a)).toEqual({ full: 10, dim: 0 });
  });

  it("let go of a brush whose rows another view replaced, and never zoom to it", async () => {
    const source = data(20);
    const store = selectionStore(source);
    const a = chart({
      marks: [line(source, { x: "x", y: "y" })],
      interaction: { brush: "x", zoom: "x" },
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    await a.loading;
    brush(a, 2, 8);
    await frames();
    // A bound brush selects rows rather than zooming.
    expect(a.getViewport().x).toBeNull();
    const [lo, hi] = a.selection!.x!;
    expect([lo, hi].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([2, 8]);
    store.set("focus", selectRows(new RowSet(source).add(1)));
    await Promise.resolve();
    expect(a.selection).toBeNull();
    // Clearing a brush that no longer holds the channel leaves the channel be.
    const kept = store.get("focus");
    a.select(null);
    expect(store.get("focus")).toBe(kept);
    // A listener replacing the rows as the brush writes them: events report where it ends.
    const events: (readonly [number, number] | null)[] = [];
    a.on("select", ({ x }) => events.push(x));
    const stop = store.subscribe(() => {
      if (store.get("focus")?.kind === "predicate") store.set("focus", kept);
    });
    a.select([3, 5]);
    stop();
    expect(events).toEqual([null]);
    expect(a.selection).toBeNull();
    // The same brush shown again without writing, as mirrored from another view, is not its own.
    a.select([3, 5]);
    a.select([3, 5], { rows: false });
    store.set("focus", selectRows(new RowSet(source).add(2)));
    await Promise.resolve();
    expect(a.selection?.x).toEqual([3, 5]);
  });

  it("clear the rows of a brush the chart lets go of as its panels change", async () => {
    const source = table({
      t: [0, 1, 2, 3, 10, 11, 12, 13],
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      region: ["a", "a", "a", "a", "b", "b", "b", "b"],
    });
    const store = selectionStore(source);
    const options: ChartOptions = {
      marks: [line(source, { x: "t", y: "v" })],
      facet: facet("region"),
      interaction: { brush: "x" },
      rowSelection: rowSelection({ store, channel: "focus" }),
    };
    const faceted = chart({ ...options, resolve: { x: "independent" } });
    await faceted.loading;
    faceted.select([1, 2], { panel: "a" });
    expect(store.get("focus")?.kind).toBe("predicate");
    // Panels sharing x now: the brush in panel a's own x goes, and its rows with it.
    faceted.update({ ...options, resolve: { x: "shared" } });
    faceted.render();
    await frames();
    expect(faceted.selection).toBeNull();
    expect(store.get("focus")).toBeNull();
  });

  it("draw translucent colors as they are where spans cannot say what is selected", async () => {
    const translucent = "rgba(255, 0, 0, 0.5)";
    // x that does not ascend, all selected; rows at one x, selected in part; an
    // outline over its translucent fill; and overlapping series of one mark.
    const cases: {
      marks: (source: Table) => ChartMark[];
      x: number[];
      rows: number[];
      at: number;
    }[] = [
      {
        marks: (t) => [line(t, { x: "x", y: "y", stroke: translucent, strokeWidth: 8 })],
        x: [0, 2, 1, 3],
        rows: [0, 1, 2, 3],
        at: 1.5,
      },
      {
        marks: (t) => [line(t, { x: "x", y: "y", stroke: translucent, strokeWidth: 8 })],
        x: [0, 1, 1, 2],
        rows: [0, 1],
        at: 0.5,
      },
      {
        marks: (t) => [
          area(t, {
            x: "x",
            y: "y",
            fill: "rgba(0, 0, 255, 0.5)",
            fillOpacity: 1,
            stroke: translucent,
            strokeWidth: 8,
          }),
        ],
        x: [0, 2, 1, 3],
        rows: [0, 1, 2, 3],
        at: 1.5,
      },
      {
        marks: (t) => [line(t, { x: "x", y: ["y", "z"], strokeWidth: 8 })],
        x: [0, 2, 1, 3],
        rows: [0, 1, 2, 3],
        at: 1.5,
      },
    ];
    for (const { marks, x, rows, at } of cases) {
      const source = table({ x, y: [1, 1, 1, 1], z: [1, 1, 1, 1] });
      const store = selectionStore(source);
      const made = chart({
        renderer: "canvas",
        theme: { palette: [translucent, "rgba(0, 0, 255, 0.5)"] },
        y: { domain: [0, 2] },
        marks: marks(source as unknown as Table),
        rowSelection: rowSelection({ store, channel: "focus" }),
      });
      await made.loading;
      made.render();
      const [panel] = modelOf(made).panels();
      const canvas = made.root.querySelector("canvas")!;
      const ratio = canvas.width / made.root.clientWidth;
      const pixel = () =>
        Array.from(
          canvas
            .getContext("2d")!
            .getImageData(
              Math.round(panel!.x.map(at) * ratio),
              Math.round(panel!.y.map(1) * ratio),
              1,
              1,
            ).data,
        );
      const plain = pixel();
      store.set("focus", selectRows(new RowSet(source).addAll(rows)));
      made.render();
      const lit = pixel();
      const label = `${marks(source as unknown as Table)[0]!.spec.type} over x ${x}`;
      for (let i = 0; i < 4; i++)
        expect.soft(Math.abs(lit[i]! - plain[i]!), label).toBeLessThanOrEqual(2);
    }
  });

  it("select with the keyboard: Shift and arrows a range, Space a point", async () => {
    const source = data(10);
    const store = selectionStore(source);
    const a = chart({
      marks: [point(source, { x: "x", y: "y" })],
      interaction: { brush: "x" },
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    await a.loading;
    a.root.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await userEvent.keyboard(" ");
    const said = () => a.root.querySelector("[aria-live]")!.textContent;
    expect(rowsOf(store.get("focus"), source)).toEqual([1]);
    expect(said()).toBe("1 row selected");
    await userEvent.keyboard("{ArrowRight}{Shift>} {/Shift}");
    expect(rowsOf(store.get("focus"), source)).toEqual([1, 2]);
    expect(said()).toBe("2 rows selected");
    await userEvent.keyboard("{Escape}");
    expect(store.get("focus")).toBeNull();
    // Shift and arrows brush a range from where the cursor starts again, writing its condition.
    await userEvent.keyboard("{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    expect(store.get("focus")?.kind).toBe("predicate");
    expect(rowsOf(store.get("focus"), source)).toEqual([0, 1, 2]);
  });

  it("select with Space what the chart shows once pending changes are drawn", async () => {
    const source = data(10);
    const store = selectionStore(source);
    const view = rowView(source);
    const a = chart({
      marks: [point(view, { x: "x", y: "y" })],
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    a.root.focus();
    await userEvent.keyboard("{ArrowRight}");
    // The view changes before the next frame: Space reads the chart as drawn then.
    view.restrict(new RowSet(source).addAll([4, 7]));
    await userEvent.keyboard(" ");
    expect(rowsOf(store.get("focus"), source)).toEqual([4]);
    // A selection shown without writing its rows leaves the channel be.
    a.select([1, 2], { rows: false });
    expect(rowsOf(store.get("focus"), source)).toEqual([4]);
  });

  it("select a lasso's rows, and leave synced charts' selections unwritten", async () => {
    const source = data(10);
    const store = selectionStore(source);
    const options = { marks: [point(source, { x: "x", y: "y" })], renderer: "svg" as const };
    const a = chart({
      ...options,
      interaction: { brush: "lasso", sync: "rows" },
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    const b = chart({
      ...options,
      interaction: { brush: "lasso", sync: "rows" },
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    await a.loading;
    const [panel] = modelOf(a).panels();
    const { plot } = panel!;
    // Around x up to 4.5, the plot's whole height.
    const [left, right] = [plot.x + 1, panel!.x.map(4.5)];
    const [top, bottom] = [plot.y + 1, plot.y + plot.height - 1];
    const outline = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const;
    press(a.root, "pointerdown", ...outline[0]!);
    for (const point of [...outline.slice(1), outline[0]!]) press(a.root, "pointermove", ...point);
    press(a.root, "pointerup", ...outline[0]!);
    const held = store.get("focus");
    expect(held?.kind).toBe("rows");
    expect(rowsOf(held, source)).toEqual([0, 1, 2, 3, 4]);
    // B shows the synced outline, but writes nothing of its own.
    expect(b.selection?.lasso).not.toBeNull();
    expect(store.get("focus")).toBe(held);
  });

  it("highlight on canvas, and stop following the store once destroyed", async () => {
    const source = data(5000);
    const store = selectionStore(source);
    const a = chart({
      marks: [point(source, { x: "x", y: "y" })],
      renderer: "canvas",
      rowSelection: rowSelection({ store, channel: "focus" }),
    });
    store.set("focus", selectWhere(col("x").lt(100)));
    await frames();
    expect(drawn(a)).toEqual({ full: 100, dim: 4900 });
    const changes: unknown[] = [];
    a.on("rowSelection", (change) => changes.push(change));
    store.set("focus", null);
    expect(changes).toHaveLength(1);
    a.destroy();
    store.set("focus", selectWhere(col("x").lt(5)));
    expect(changes).toHaveLength(1);
  });
});
