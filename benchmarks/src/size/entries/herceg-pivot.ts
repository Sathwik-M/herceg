import { count, mean, rowView, table, time } from "herceg";
import { pivotRows } from "herceg/pivot";

export function render(_element: HTMLElement, x: Float64Array, y: Float64Array) {
  const data = table({ t: time(x), v: y, k: Float64Array.from(x, (_, i) => i % 4) });
  const pivot = pivotRows(rowView(data), {
    rows: "t",
    pivot: "k",
    ops: { n: count(), avg: mean("v") },
  });
  return pivot.read();
}
