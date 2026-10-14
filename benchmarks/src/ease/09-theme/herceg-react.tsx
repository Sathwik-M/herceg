import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { serviceColumns } from "../data.ts";

const latency = table({ ...serviceColumns, time: time(serviceColumns.time) });
const theme = { extends: "dark", tokens: { palette: ["#5b8def", "#f08a4b", "#3fbf8f"] } } as const;

export function Example() {
  return (
    <Chart title="Latency by service" y={{ title: "ms" }} theme={theme}>
      <Line data={latency} x="time" y="latency" series="service" />
    </Chart>
  );
}
