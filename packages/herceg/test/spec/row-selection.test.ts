import { describe, expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows } from "../../src/data/selection.ts";
import { Table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { ChartModel } from "../../src/model/model.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec, RowSelectionSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function spec(
  rowSelection: RowSelectionSpec | RowSelectionSpec[],
  extra: Partial<ChartSpec> = {},
): ChartSpec {
  return {
    data: { trips: { columns: { km: [1, 2, 3], fare: [4, 8, 12], kind: ["a", "b", "a"] } } },
    marks: [{ type: "point", x: "km", y: "fare" }],
    interaction: { brush: "x" },
    rowSelection,
    ...extra,
  };
}

describe("row selections in specs", () => {
  it("bind a store of the table the marks read, made for it or given", () => {
    const made = loadSpec(spec({ channel: "focus" }));
    const store = made.stores.get("trips")!;
    expect(store.source).toBe(made.tables.get("trips"));
    expect(made.config.rowSelection?.bindings).toEqual([
      { store, channel: "focus", events: ["brush", "lasso", "click"], effect: "highlight" },
    ]);
    // Given tables and stores are used in place of the spec's own.
    // Tables loaded from another spec, as a dashboard shares them.
    const trips = loadSpec(spec({ channel: "focus" })).tables.get("trips")!;
    const shared = selectionStore(trips);
    const loaded = loadSpec(spec({ channel: "focus", events: ["click"], effect: "none" }), [], {
      tables: new Map([["trips", trips]]),
      stores: new Map([["trips", shared]]),
    });
    expect(loaded.tables.get("trips")).toBe(trips);
    expect(loaded.stores.get("trips")).toBe(shared);
    expect(loaded.config.rowSelection?.bindings[0]).toMatchObject({
      store: shared,
      effect: "none",
    });
    // A chart drawn from it highlights what the store holds.
    shared.set("focus", selectRows(new RowSet(trips).add(1)));
    const model = new ChartModel(loaded.config);
    model.setSize(400, 300, 1);
    expect(model.scene(estimateText).panels[0]!.marks.length).toBe(1);
  });

  it("need the table named when the marks read several", () => {
    const two: Partial<ChartSpec> = {
      data: {
        a: { columns: { km: [1], fare: [1] } },
        b: { columns: { km: [2], fare: [2] } },
      },
      marks: [
        { type: "point", data: "a", x: "km", y: "fare" },
        { type: "line", data: "b", x: "km", y: "fare" },
      ],
    };
    expect(() => loadSpec(spec({ channel: "c" }, two))).toThrow(
      "spec.rowSelection.data: missing; the marks read several tables, so name one",
    );
    const loaded = loadSpec(
      spec(
        [
          { data: "a", channel: "c" },
          { data: "b", channel: "c" },
        ],
        two,
      ),
    );
    expect([...loaded.stores.keys()]).toEqual(["a", "b"]);
    expect(() => loadSpec(spec({ data: "z", channel: "c" }))).toThrow(
      'spec.rowSelection.data: no table "z" in spec.data; name one of "trips"',
    );
  });

  it("refuse stores of other tables and malformed bindings", () => {
    expect(() =>
      loadSpec(spec({ channel: "c" }), [], {
        stores: new Map([["trips", selectionStore(new Table({ x: [1] }))]]),
      }),
    ).toThrow('stores.trips: the store given is of another table; give a store of table "trips"');
    expect(() => validateSpec(spec({ channel: "" }))).toThrow(
      "spec.rowSelection.channel: expected a channel's name",
    );
    expect(() => validateSpec(spec({ channel: "c", events: ["drag" as "click"] }))).toThrow(
      'spec.rowSelection.events[0]: expected "brush", "lasso", or "click"; received "drag"',
    );
    expect(() => validateSpec(spec({ channel: "c", effect: "filter" as "none" }))).toThrow(
      "spec.rowSelection.effect",
    );
    expect(() => validateSpec({ ...spec({} as RowSelectionSpec) })).toThrow(
      "spec.rowSelection.channel: required",
    );
    expect(() => validateSpec(spec([]))).toThrow("expected a binding or a list of them");
    const pie = {
      ...spec({ channel: "c" }),
      marks: [{ type: "pie", category: "kind" }],
      interaction: {},
    };
    expect(() => new ChartModel(loadSpec(pie as ChartSpec).config)).toThrow(
      "pie rowSelection: cannot select rows yet",
    );
  });
});
