import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { createRoot } from "react-dom/client";

// React and React DOM are excluded from this bundle: an application using the
// adapter already ships them. The entry measures herceg plus the adapter.
export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const data = table({ t: time(x), v: y });
  createRoot(element).render(
    <Chart>
      <Line data={data} x="t" y="v" />
    </Chart>,
  );
}
