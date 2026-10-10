// Compile-time tests: checked by `npm run typecheck`, never executed.
import { expectTypeOf } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { createRemoteGrid } from "../../src/dom/grid-remote.ts";
import { memorySource } from "../../src/grid/memory.ts";
import type { GridAggregate } from "../../src/grid/query.ts";
import { createRemoteGridModel, type RemoteGridModel } from "../../src/grid/remote.ts";

const requests = table({
  id: new Float64Array(3),
  at: time(new Float64Array(3)),
  host: category(["a", "b", "c"]),
});
const source = memorySource(requests, { key: "id" });

const model = createRemoteGridModel({
  source,
  query: { sort: [{ field: "at", order: "descending" }] },
  columns: [{ field: "at", format: { timeStyle: "short" } }, { field: "host" }],
});
expectTypeOf(model).toEqualTypeOf<
  RemoteGridModel<{ id: "number"; at: "time"; host: "category" }>
>();
const grid = createRemoteGrid(document.body, { model, ariaLabel: "Requests" });
expectTypeOf(grid.model).toEqualTypeOf(model);

createRemoteGridModel({
  source,
  // @ts-expect-error unknown field
  columns: [{ field: "missing" }],
});
createRemoteGridModel({
  source,
  // @ts-expect-error categories take no format
  columns: [{ field: "host", format: { maximumFractionDigits: 1 } }],
});
createRemoteGridModel({
  source,
  columns: [{ field: "host" }],
  // @ts-expect-error sort keys are the source's fields
  query: { sort: [{ field: "missing" }] },
});
model.setSort([{ field: "host" }]);
// @ts-expect-error sort keys are the source's fields
model.setSort([{ field: "nope" }]);

// Aggregates other than count need a field.
const sum: GridAggregate = { op: "sum", field: "latency", as: "total" };
// @ts-expect-error a sum needs a field
const fieldless: GridAggregate = { op: "sum", as: "total" };
void sum;
void fieldless;
