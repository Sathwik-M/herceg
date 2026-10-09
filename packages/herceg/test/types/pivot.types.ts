// Compile-time tests of pivots: checked by `npm run typecheck`, never executed.
import { expectTypeOf } from "vitest";
import { time } from "../../src/data/column.ts";
import { count, max, mean, median, sum } from "../../src/data/derive.ts";
import { pivotRows } from "../../src/data/pivot.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";
import { createPivotGrid } from "../../src/dom/grid-pivot.ts";
import { createPivotGridModel, type PivotGridModel } from "../../src/grid/pivot.ts";
import { bar } from "../../src/marks/bar.ts";

const requests = table({
  at: time(new Float64Array(3)),
  latency: new Float64Array(3),
  host: ["a", "b", "c"],
  region: ["x", "y", "z"],
});
type Requests = { at: "time"; latency: "number"; host: "category"; region: "category" };

const pivot = pivotRows(rowView(requests), {
  rows: "region",
  pivot: "host",
  ops: { n: count(), avg: mean("latency"), last: max("at"), total: sum("latency") },
});
// The long table has both fields and every aggregate; a time's maximum stays a time.
expectTypeOf(pivot.table.kind)
  .parameter(0)
  .toEqualTypeOf<"region" | "host" | "n" | "avg" | "last" | "total">();
expectTypeOf(pivot.rowTable.kind)
  .parameter(0)
  .toEqualTypeOf<"region" | "n" | "avg" | "last" | "total">();
bar(pivot.table, { x: "region", y: "avg", series: "host" });
// @ts-expect-error the rows' table has no pivot field
bar(pivot.rowTable, { x: "host", y: "n" });

// @ts-expect-error unknown fields
pivotRows(rowView(requests), { rows: "missing", pivot: "host", ops: { n: count() } });
// @ts-expect-error pivots have no medians
pivotRows(rowView(requests), { rows: "region", pivot: "host", ops: { m: median("latency") } });
// @ts-expect-error categories have no sums
pivotRows(rowView(requests), { rows: "region", pivot: "host", ops: { s: sum("host") } });
pivotRows(rowView(requests), {
  rows: "region",
  pivot: "host",
  ops: { n: count() },
  // @ts-expect-error counts are the only zeros filled
  zeroFill: "sum",
});

const model = createPivotGridModel({
  data: pivot,
  aggregates: { avg: { title: "Latency", format: { maximumFractionDigits: 1 } }, n: { width: 80 } },
  selection: selectionStore(requests),
});
expectTypeOf(model).toEqualTypeOf<PivotGridModel<Requests>>();
createPivotGridModel({
  data: pivot,
  // @ts-expect-error aggregates by the pivot's names
  aggregates: { missing: { title: "?" } },
});
createPivotGridModel({
  data: pivot,
  // @ts-expect-error a store of another table
  selection: selectionStore(table({ x: [1] })),
});
// Sort keys and columns name the crosstab's fields: generated ids too.
model.setSort([{ field: '["pivot","host","category","a","n","count",null]', order: "descending" }]);
model.cycleSort("region");
// @ts-expect-error pivot grids have no groups to set
model.setGroups(null);
// @ts-expect-error nor table rows
model.rowAt(0);

const grid = createPivotGrid(document.body, { model, ariaLabel: "Requests" });
expectTypeOf(grid.model).toEqualTypeOf(model);
