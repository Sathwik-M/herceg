import { rowView, table, time } from "herceg";
import { createGrid, createGridModel } from "herceg/grid";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const data = table({ t: time(x), v: y });
  const model = createGridModel({ data: rowView(data), columns: [{ field: "t" }, { field: "v" }] });
  return createGrid(element, { model, ariaLabel: "Values" });
}
