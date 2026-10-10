import { createChart, custom, table, time } from "herceg";
import { days, p50 } from "../data.ts";

export function render(container: HTMLElement) {
  const latency = table({ time: time(days), p50 });
  // A lollipop per day: a stem from zero and a dot at the value.
  const lollipops = custom(latency, {
    x: "time",
    y: "p50",
    zero: "y",
    draw({ series, x, y, line, circle }) {
      for (const s of series) {
        for (let k = 0; k < s.length; k++) {
          const row = s.rowAt(k);
          const [px, py] = [x(s.x[row]!), y(s.y[row]!)];
          line(px, y(0), px, py, { stroke: s.color });
          circle(px, py, 3, { fill: s.color });
        }
      }
    },
  });
  return createChart(container, {
    title: "Request latency",
    marks: [lollipops],
    y: { title: "ms" },
  });
}
