import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { serviceColumns } from "../data.ts";

const latency = table({ ...serviceColumns, time: time(serviceColumns.time) });

export function Example() {
  return (
    <Chart title="Latency by service" y={{ title: "ms" }}>
      <Line data={latency} x="time" y="latency" series="service" />
    </Chart>
  );
}
