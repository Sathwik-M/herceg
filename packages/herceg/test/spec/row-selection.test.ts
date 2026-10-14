import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows } from "../../src/data/selection.ts";
import { Table } from "../../src/data/table.ts";
import { specToPDF, specToSVG } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { membership } from "../../src/model/highlight.ts";
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
    const gauge = {
      ...spec({ channel: "c" }),
      marks: [{ type: "gauge", value: "km" }],
      interaction: {},
    };
    expect(() => new ChartModel(loadSpec(gauge as ChartSpec).config)).toThrow(
      "gauge rowSelection: cannot select rows yet",
    );
  });

  it("start a store they make with the selection a binding gives, which exports draw", () => {
    const rows = loadSpec(spec({ channel: "focus", selection: { kind: "rows", rows: [0, 2] } }));
    const trips = rows.tables.get("trips")!;
    const held = rows.stores.get("trips")!.get("focus")!;
    expect(held.kind).toBe("rows");
    expect(Array.from(membership(trips, held))).toEqual([1, 0, 1]);
    // From a buffer of uint32 positions, too.
    const buffered = loadSpec(spec({ channel: "focus", selection: { kind: "rows", rows: 0 } }), [
      Uint32Array.of(1),
    ]);
    const fromBuffer = buffered.stores.get("trips")!.get("focus")!;
    expect(Array.from(membership(buffered.tables.get("trips")!, fromBuffer))).toEqual([0, 1, 0]);
    const condition = loadSpec(
      spec({
        channel: "focus",
        selection: { kind: "predicate", expression: [">", ["field", "fare"], 5] },
      }),
    );
    expect(condition.stores.get("trips")!.get("focus")).toEqual({
      kind: "predicate",
      expression: [">", ["field", "fare"], 5],
    });
    // A store given keeps what it holds, nothing included.
    const given = selectionStore(trips);
    const kept = loadSpec(spec({ channel: "focus", selection: { kind: "rows", rows: [0] } }), [], {
      tables: { trips },
      stores: { trips: given },
    });
    expect(kept.stores.get("trips")!.get("focus")).toBeNull();
    // Static exports draw the selection: the unselected rows dimmed.
    const plain = specToSVG(spec({ channel: "focus" }));
    const svg = specToSVG(spec({ channel: "focus", selection: { kind: "rows", rows: [0] } }));
    expect(plain).not.toContain('fill-opacity="0.25"');
    expect(svg).toContain('fill-opacity="0.25"');
    expect(svg).toContain("1 of 3 rows selected.");
    // PDF too, a line's unselected span faded and its selected one clipped.
    const lined = (selection?: RowSelectionSpec["selection"]) =>
      spec(
        { channel: "focus", ...(selection && { selection }) },
        {
          marks: [{ type: "line", x: "km", y: "fare" }],
        },
      );
    const pdf = (bytes: Uint8Array) => {
      const text = Buffer.from(bytes).toString("latin1");
      const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) =>
        inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"),
      );
      return `${text}\n${streams.join("\n")}`;
    };
    const faded = pdf(specToPDF(lined({ kind: "rows", rows: [0, 1] })));
    expect(faded).toMatch(/\/CA 0\.25/);
    expect(faded).toMatch(/ re W n/);
    expect(pdf(specToPDF(lined()))).not.toMatch(/\/CA 0\.25/);
    // Dimmed points' rings fade with their fill.
    const ringed = pdf(
      specToPDF(
        spec(
          { channel: "focus", selection: { kind: "rows", rows: [0] } },
          { marks: [{ type: "point", x: "km", y: "fare", stroke: "black" }] },
        ),
      ),
    );
    expect(ringed).toMatch(/\/ca 0\.25 \/CA 0\.25/);
  });

  it("refuse selections of rows the table lacks, and conditions it cannot test", () => {
    expect(() =>
      validateSpec(spec({ channel: "c", selection: { kind: "rows", rows: [-1] } })),
    ).toThrow(
      "spec.rowSelection.selection.rows[0]: expected a row position, 0 or more; received -1",
    );
    expect(() => validateSpec(spec({ channel: "c", selection: { kind: "row" } as never }))).toThrow(
      'spec.rowSelection.selection.kind: expected "predicate" or "rows"; received "row"',
    );
    expect(() =>
      validateSpec(spec({ channel: "c", selection: { kind: "rows", rowz: [1] } as never })),
    ).toThrow("spec.rowSelection.selection.rows: required");
    expect(() => loadSpec(spec({ channel: "c", selection: { kind: "rows", rows: [3] } }))).toThrow(
      "spec.rowSelection.selection.rows[0]: expected a position among the table's 3 rows; received 3",
    );
    expect(() =>
      loadSpec(
        spec({
          channel: "c",
          selection: { kind: "predicate", expression: [">", ["field", "speed"], 1] },
        }),
      ),
    ).toThrow('spec.rowSelection.selection.expression: expression: no field "speed"');
    expect(() =>
      loadSpec(
        spec({ channel: "c", selection: { kind: "predicate", expression: ["field", "km"] } }),
      ),
    ).toThrow(
      "spec.rowSelection.selection.expression: A selection needs a true or false condition",
    );
  });
});
