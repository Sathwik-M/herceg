import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expression.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore, selectRows, selectWhere } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";

describe("selection stores", () => {
  it("keep each channel's selection, and filter views by their conditions", () => {
    const t = table({ t: [0, 1, 2, 3, 4], host: ["a", "b", "a", "b", "a"] });
    const store = selectionStore(t);
    let changes = 0;
    store.subscribe(() => changes++);
    store.set("brush", selectWhere(col("t").ge(1).and(col("t").le(3))));
    store.set("legend", selectWhere(col("host").eq("a")));
    store.set("grid", selectRows(new RowSet(t).add(0)));
    expect(store.channels).toEqual(["brush", "legend", "grid"]);
    const view = rowView(t, { filter: store.condition(["brush", "legend"]) });
    expect(Array.from(view.read().indices!)).toEqual([2]);
    store.set("brush", null);
    store.set("brush", null);
    expect(changes).toBe(4);
    expect(store.condition(["brush", "grid"])).toBeUndefined();
  });

  it("refuse selections of another table, and conditions that are not true or false", () => {
    const store = selectionStore(table({ x: [1] }));
    expect(() => store.set("grid", selectRows(new RowSet(table({ x: [1] }))))).toThrow(
      /store's table/,
    );
    expect(() => store.set("brush", selectWhere(col("x")))).toThrow(/true or false/);
  });
});
