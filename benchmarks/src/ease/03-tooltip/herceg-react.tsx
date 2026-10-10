import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { days, p99, requests } from "../data.ts";

const latency = table({ time: time(days), p99, requests });

export function Example() {
  return (
    <Chart
      title="Request latency"
      locale="en-US"
      timeZone="UTC"
      x={{ tooltipFormat: { weekday: "short", month: "short", day: "numeric" } }}
      y={{ title: "ms", tooltipFormat: { style: "unit", unit: "millisecond" } }}
    >
      <Line data={latency} x="time" y="p99" tooltip={{ fields: ["requests"] }} />
    </Chart>
  );
}
