import { Chart, Line, Region, Rule } from "@herceg/react";
import { table, time } from "herceg";
import { days, incident, p99, SLO } from "../data.ts";

const latency = table({ time: time(days), p99 });

export function Example() {
  return (
    <Chart title="Request latency" y={{ title: "ms" }}>
      <Region x1={incident.start} x2={incident.end} label={incident.label} />
      <Line data={latency} x="time" y="p99" />
      <Rule y={SLO} label="SLO" />
    </Chart>
  );
}
