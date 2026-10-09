import { count, mean, rowView, table, time } from "herceg";
import { createPivotGrid, createPivotGridModel } from "herceg/grid/pivot";
import { pivotRows } from "herceg/pivot";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const data = table({ t: time(x), v: y, k: Float64Array.from(x, (_, i) => i % 4) });
  const pivot = pivotRows(rowView(data), {
    rows: "t",
    pivot: "k",
    ops: { n: count(), avg: mean("v") },
  });
  const model = createPivotGridModel({ data: pivot });
  return createPivotGrid(element, { model, ariaLabel: "Values" });
}
