// Compile-time tests: checked by `npm run typecheck`, never executed.
import { expectTypeOf } from "vitest";
import { time } from "../../src/data/column.ts";
import { col } from "../../src/data/expression.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { type Schema, Table, table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { createGrid, type Grid } from "../../src/dom/grid.ts";
import { createGridModel, type GridColumn, type GridModel } from "../../src/grid/model.ts";
import { point } from "../../src/marks/point.ts";

const requests = table({
  at: time(new Float64Array(3)),
  latency: new Float64Array(3),
  host: ["a", "b", "c"],
});

const model = createGridModel({
  data: rowView(requests),
  columns: [
    { field: "at", format: { timeStyle: "short" } },
    { field: "latency", format: { maximumFractionDigits: 1 }, align: "center" },
    { field: "host", title: "Host" },
  ],
});
expectTypeOf(model).toEqualTypeOf<GridModel<{ at: "time"; latency: "number"; host: "category" }>>();
const grid = createGrid(document.body, { model, ariaLabel: "Requests" });
expectTypeOf(grid.model).toEqualTypeOf(model);

createGridModel({
  data: rowView(requests),
  // @ts-expect-error unknown field
  columns: [{ field: "missing" }],
});
createGridModel({
  data: rowView(requests),
  // @ts-expect-error categories take no format
  columns: [{ field: "host", format: { maximumFractionDigits: 1 } }],
});
createGridModel({
  data: rowView(requests),
  // @ts-expect-error a number field takes number formats, not date formats
  columns: [{ field: "latency", format: { dateStyle: "medium" } }],
});
model.setSort([{ field: "latency", order: "descending" }]);
// @ts-expect-error sort keys are the table's fields
model.setSort([{ field: "missing" }]);

// Tables whose fields are only known at runtime take any field and either format.
const loose = new Table({ x: [1] });
const columns: GridColumn<Schema>[] = [{ field: "anything", format: { dateStyle: "medium" } }];
createGridModel({ data: rowView(loose), columns });

// Helpers over grids of any table are generic: models and grids follow their schema exactly.
function focusFirst<S extends Schema>(target: Grid<S>) {
  const first = target.model.columnLayout[0];
  if (first) target.focusCell(0, first.id);
}
focusFirst(grid);

// The README's grid and chart linked both ways.
{
  const store = selectionStore(requests);
  const gridRows = rowView(requests);
  const chartRows = rowView(requests);
  createGrid(document.body, {
    model: createGridModel({
      data: gridRows,
      columns: [{ field: "at" }, { field: "latency" }],
      selection: store,
    }),
    ariaLabel: "Requests",
  });
  const chart = createChart(document.body, {
    marks: [point(chartRows, { x: "at", y: "latency" })],
    interaction: { brush: "x" },
  });
  store.subscribe(() => {
    const picked = store.get("grid-rows");
    chartRows.restrict(picked?.kind === "rows" ? picked.rows : null);
  });
  chart.on("select", ({ x }) =>
    gridRows.setQuery({
      ...gridRows.query,
      filter: x ? col("at").ge(x[0]).and(col("at").le(x[1])) : true,
    }),
  );
}
