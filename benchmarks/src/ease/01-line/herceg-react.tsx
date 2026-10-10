import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { days, p50 } from "../data.ts";

const latency = table({ time: time(days), p50 });

export function Example() {
  return (
    <Chart title="Request latency" y={{ title: "ms" }}>
      <Line data={latency} x="time" y="p50" />
    </Chart>
  );
}
