import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { days, p50, requests } from "../data.ts";

const traffic = table({ time: time(days), p50, requests });
const interaction = { zoom: "x", sync: "traffic" } as const;

export function Example() {
  return (
    <>
      <Chart title="Latency" interaction={interaction}>
        <Line data={traffic} x="time" y="p50" />
      </Chart>
      <Chart title="Requests" interaction={interaction}>
        <Line data={traffic} x="time" y="requests" />
      </Chart>
    </>
  );
}
