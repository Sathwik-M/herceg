import { describe, expect, it } from "vitest";
import type { ColumnInput } from "../../src/data/column.ts";
import { col } from "../../src/data/expr.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { type Table, table as typed } from "../../src/data/table.ts";

import { estimateText } from "../../src/layout/text.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { point } from "../../src/marks/point.ts";
import { rug } from "../../src/marks/rug.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import {
  type RowSelectionChange,
  rowSelection,
  type SelectionBinding,
} from "../../src/model/row-selection.ts";
import type { Brushed as Selection } from "../../src/model/selected-rows.ts";

/** Tables as charts read them, whatever their fields. */
const table = (columns: Record<string, ColumnInput>): Table => typed(columns) as unknown as Table;

const trips = table({ km: [1, 2, 3, 4], fare: [5, 9, 12, 20], kind: ["a", "b", "a", "b"] });

function drawn(config: ChartConfig): ChartModel {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 400, 1);
  model.scene(estimateText);
  return model;
}

/** A chart as its row selection sees it, without a DOM. */
function chart() {
  const element = new EventTarget() as never;
  return {
    selection: { x: [1, 2], y: null, lasso: null } as Selection | null,
    cleared: 0,
    select(selection: null) {
      this.selection = selection;
      this.cleared++;
    },
    render() {},
    root: element,
  };
}

function mounted(binding: Partial<SelectionBinding> = {}) {
  const store = binding.store ?? selectionStore(trips);
  const selection = rowSelection({ store, channel: "focus", ...binding });
  const model = drawn({
    marks: [point(trips, { x: "km", y: "fare" })],
    interaction: { brush: "x" },
    rowSelection: selection,
  });
  const host = chart();
  const changes: RowSelectionChange[] = [];
  const events = {
    emit: (_type: "rowSelection", change: RowSelectionChange) => changes.push(change),
  };
  let redrawn = 0;
  const live = { textContent: "" as string | null };
  const link = selection.mount(
    undefined,
    model,
    host,
    events,
    () => redrawn++,
    () => null,
    live,
  );
  return { store, selection, model, host, link, changes, redrawn: () => redrawn };
}

const brush = (x: readonly [number, number]): Selection => ({ x, y: null, lasso: null });
const noKeys = { shiftKey: false, ctrlKey: false, metaKey: false };

describe("row selection bindings", () => {
  it("refuse bindings that are not ones", () => {
    const store = selectionStore(trips);
    expect(() => rowSelection()).toThrow("rowSelection: expected a binding");
    expect(() => rowSelection({ store, channel: "" })).toThrow(
      'rowSelection channel: expected a name; received ""',
    );
    expect(() => rowSelection({ store, channel: "c", events: ["drag" as "brush"] })).toThrow(
      'rowSelection events: expected "brush", "lasso", or "click"; received "drag"',
    );
    expect(() => rowSelection({ store, channel: "c", effect: "filter" as "none" })).toThrow(
      'rowSelection effect: expected "highlight" or "none"; received "filter"',
    );
    expect(() =>
      rowSelection({ store, channel: "c" }, { store: selectionStore(trips), channel: "d" }),
    ).toThrow("binds each table once");
    expect(() => rowSelection({ store: {} as never, channel: "c" })).toThrow("SelectionStore");
  });

  it("refuse charts whose rows cannot be selected yet", () => {
    const bound = rowSelection({ store: selectionStore(trips), channel: "c" });
    expect(() => drawn({ marks: [gauge(trips, { value: "km" })], rowSelection: bound })).toThrow(
      "gauge rowSelection: cannot select rows yet",
    );
    const other = table({ x: [1] });
    expect(() => drawn({ marks: [point(other, { x: "x", y: "x" })], rowSelection: bound })).toThrow(
      'rowSelection store: no mark reads its table (channel "c")',
    );
    const counted = { marks: [histogram(trips, { x: "km" })], rowSelection: bound };
    expect(() => drawn({ ...counted, interaction: { brush: "lasso" } })).toThrow(
      'histogram brush: lassos cannot select its rows yet; leave "lasso" out of rowSelection events',
    );
    expect(() => drawn({ ...counted, interaction: { brush: "xy" } })).toThrow(
      "histogram brush: its y axis holds statistics; brush along x only",
    );
    expect(() => drawn({ ...counted, interaction: { brush: "x" } })).not.toThrow();
    const boxes = { marks: [boxplot(trips, { x: "kind", y: "fare" })], rowSelection: bound };
    expect(() => drawn({ ...boxes, interaction: { brush: "y" } })).toThrow(
      "y axis holds statistics",
    );
    // Rug ticks have a place along their own axis only, beside a scatter plot too.
    const ticks = {
      marks: [point(trips, { x: "km", y: "fare" }), rug(trips, { x: "km" })],
      rowSelection: bound,
    };
    for (const brush of ["y", "xy"] as const)
      expect(() => drawn({ ...ticks, interaction: { brush } })).toThrow(
        "rug brush: its ticks have no y value; brush along x only",
      );
    expect(() => drawn({ ...ticks, interaction: { brush: "x" } })).not.toThrow();
    expect(() => drawn({ ...ticks, interaction: { brush: "lasso" } })).not.toThrow();
    const sideways = { marks: [rug(trips, { y: "fare" })], rowSelection: bound };
    expect(() => drawn({ ...sideways, interaction: { brush: "x" } })).toThrow(
      "rug brush: its ticks have no x value; brush along y only",
    );
    // Cells are lassoed at their centers.
    const cells = { marks: [heatmap(trips, { x: "kind", y: "kind", color: "fare" })] };
    expect(() =>
      drawn({ ...cells, rowSelection: bound, interaction: { brush: "lasso" } }),
    ).not.toThrow();
    // Without the gesture in its events, a binding refuses nothing about it.
    const quiet = rowSelection({ store: selectionStore(trips), channel: "c", events: ["click"] });
    expect(() =>
      drawn({ ...counted, rowSelection: quiet, interaction: { brush: "xy" } }),
    ).not.toThrow();
  });

  it("compare as JSON by their stores' identities", () => {
    const store = selectionStore(trips);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    expect(same(rowSelection({ store, channel: "c" }), rowSelection({ store, channel: "c" }))).toBe(
      true,
    );
    expect(
      same(
        rowSelection({ store, channel: "c" }),
        rowSelection({ store: selectionStore(trips), channel: "c" }),
      ),
    ).toBe(false);
    expect(
      same(
        rowSelection({ store, channel: "c" }),
        rowSelection({ store, channel: "c", effect: "none" }),
      ),
    ).toBe(false);
  });
});

describe("a mounted chart's row selection", () => {
  it("writes a brush's rows, reports them, and clears them while the channel still holds them", () => {
    const { store, link, changes } = mounted();
    const written = link.brushed(brush([1.5, 3.5]), null, true);
    const condition = selectWhere(col("km").ge(1.5).and(col("km").le(3.5)));
    expect(store.get("focus")).toEqual(condition);
    expect(written?.rows).toEqual([{ table: trips, channel: "focus", selection: condition }]);
    expect(changes).toEqual(written?.rows);
    expect(link.brushed(null, null, true)?.rows).toEqual([
      { table: trips, channel: "focus", selection: null },
    ]);
    expect(store.get("focus")).toBeNull();
    // Clearing a brush whose rows another writer replaced leaves theirs.
    link.brushed(brush([1.5, 3.5]), null, true);
    const grid = selectRows(new RowSet(trips).add(0));
    store.set("focus", grid);
    expect(link.brushed(null, null, true)).toBeUndefined();
    expect(store.get("focus")).toBe(grid);
  });

  it("lets go of its brush when another writer replaces its rows", async () => {
    const { store, link, host, redrawn } = mounted();
    link.brushed(brush([1.5, 3.5]), null, true);
    const before = redrawn();
    store.set("focus", selectRows(new RowSet(trips).add(0)));
    // Once the change is reported: views showing the writer's brush let theirs go first.
    expect(host.cleared).toBe(0);
    await Promise.resolve();
    expect(host.cleared).toBe(1);
    expect(redrawn()).toBe(before + 1);
    // Another channel's change changes nothing here.
    store.set("other", selectRows(new RowSet(trips)));
    expect(host.cleared).toBe(1);
  });

  it("lets go of its brush when it shows a selection it does not write", async () => {
    const { store, link, host } = mounted();
    link.brushed(brush([1.5, 3.5]), null, true);
    // Another view writes its brush's rows, and this one shows that brush as the change is reported.
    store.set("focus", selectRows(new RowSet(trips).add(0)));
    expect(link.brushed(brush([0, 1]), null, false)).toBeUndefined();
    await Promise.resolve();
    expect(host.cleared).toBe(0);
    expect(link.brushed(null, null, true)).toBeUndefined();
    expect(store.get("focus")).not.toBeNull();
  });

  it("selects clicked rows: only them, added with Shift, toggled with Ctrl or Cmd", () => {
    const { store, link, model } = mounted();
    const [panel] = model.panels();
    const at = (row: number) =>
      [
        panel!.x.map(trips.value("km", row) as number),
        panel!.y.map(trips.value("fare", row) as number),
      ] as const;
    const rows = () => {
      const held = store.get("focus");
      return held?.kind === "rows" ? Array.from(held.rows.positions()) : held;
    };
    link.clicked(...at(1), noKeys);
    expect(rows()).toEqual([1]);
    link.clicked(...at(3), { ...noKeys, shiftKey: true });
    expect(rows()).toEqual([1, 3]);
    link.clicked(...at(1), { ...noKeys, metaKey: true });
    expect(rows()).toEqual([3]);
    // A brush's condition becomes its rows as they are when a click adds to it.
    link.brushed(brush([0, 2.5]), null, true);
    link.clicked(...at(3), { ...noKeys, ctrlKey: true });
    expect(rows()).toEqual([0, 1, 3]);
    // Off the data: a modified click changes nothing, a plain one clears.
    expect(link.clicked(5, 5, { ...noKeys, shiftKey: true })?.rows).toEqual([]);
    expect(rows()).toEqual([0, 1, 3]);
    expect(link.clicked(5, 5, noKeys)?.rows).toEqual([
      { table: trips, channel: "focus", selection: null },
    ]);
    expect(rows()).toBeNull();
  });

  it("writes only the gestures in its events", () => {
    const { store, link } = mounted({ events: ["click"] });
    expect(link.brushes).toBe(false);
    expect(link.brushed(brush([1, 2]), null, true)).toBeUndefined();
    expect(store.get("focus")).toBeNull();
    const reading = mounted({ events: [] });
    expect(reading.link.clicked(5, 5, noKeys)).toBeUndefined();
    expect(mounted().link.brushes).toBe(true);
  });

  it("highlights only with effect highlight, and lets go of the model when disposed", () => {
    const { link, model } = mounted();
    expect(model.highlight).toBeDefined();
    link.dispose();
    expect(model.highlight).toBeUndefined();
    expect(mounted({ effect: "none" }).model.highlight).toBeUndefined();
  });

  it("is kept for the same row selection, and replaced for another", () => {
    const { selection, link, model, host } = mounted();
    const events = { emit: () => {} };
    const live = { textContent: null };
    expect(
      selection.mount(
        link,
        model,
        host,
        events,
        () => {},
        () => null,
        live,
      ),
    ).toBe(link);
    const other = rowSelection({ store: selectionStore(trips), channel: "focus" });
    const replaced = other.mount(
      link,
      model,
      host,
      events,
      () => {},
      () => null,
      live,
    );
    expect(replaced).not.toBe(link);
    expect(replaced.selection).toBe(other);
  });

  it("keeps what its brush wrote through a binding of the same channel that replaces it", () => {
    const { store, selection, link, model, host } = mounted();
    link.brushed(brush([1.5, 3.5]), null, true);
    // The same store and channel, without highlighting: an adapter's new prop.
    const quiet = rowSelection({ store, channel: "focus", effect: "none" });
    expect(quiet.toJSON()).not.toEqual(selection.toJSON());
    const replaced = quiet.mount(
      link,
      model,
      host,
      { emit: () => {} },
      () => {},
      () => null,
      { textContent: null },
    );
    expect(replaced.brushed(null, null, true)?.rows).toEqual([
      { table: trips, channel: "focus", selection: null },
    ]);
    expect(store.get("focus")).toBeNull();
  });

  it("lets go of a brush another writer replaced while its binding was being replaced", async () => {
    const { store, link, model, host } = mounted();
    link.brushed(brush([1.5, 3.5]), null, true);
    store.set("focus", selectRows(new RowSet(trips).add(0)));
    // Before the check of that change, a binding of the same channel replaces this one.
    rowSelection({ store, channel: "focus", effect: "none" }).mount(
      link,
      model,
      host,
      { emit: () => {} },
      () => {},
      () => null,
      { textContent: null },
    );
    await Promise.resolve();
    expect(host.cleared).toBe(1);
  });

  it("lets go of its brush when a listener replaces its rows as they are written", () => {
    const { store, link, host } = mounted();
    const grid = selectRows(new RowSet(trips).add(0));
    const stop = store.subscribe(() => {
      if (store.get("focus")?.kind === "predicate") store.set("focus", grid);
    });
    link.brushed(brush([1.5, 3.5]), null, true);
    stop();
    expect(store.get("focus")).toBe(grid);
    expect(host.cleared).toBe(1);
  });

  it("reports a row set changed in place and written again", () => {
    const { store, changes } = mounted();
    const set = new RowSet(trips).add(0);
    const rows = selectRows(set);
    store.set("focus", rows);
    set.add(1);
    store.set("focus", rows);
    expect(changes).toHaveLength(2);
  });

  it("reports changes of its channels by any writer, once each", () => {
    const { store, changes } = mounted();
    const rows = selectRows(new RowSet(trips).add(2));
    store.set("focus", rows);
    store.set("other", rows);
    store.set("focus", rows);
    expect(changes).toEqual([{ table: trips, channel: "focus", selection: rows }]);
  });
});
