// The README examples, compiled by `npm run typecheck` so the docs stay true.
import { table, time } from "herceg";
import { useEffect, useMemo } from "react";
import { Chart, Line, Rule } from "../src/index.ts";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;
declare function readCpu(): number;

const metrics = table({ time: time(timestamps), p50, p99 });

export function Latency() {
  return (
    <Chart title="Request latency" y={{ label: "ms" }} interaction={{ zoom: true }}>
      <Line data={metrics} x="time" y={["p50", "p99"]} />
      <Rule y={250} label="SLO" />
    </Chart>
  );
}

export function Live() {
  const data = useMemo(
    () => table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 }),
    [],
  );
  useEffect(() => {
    const timer = setInterval(() => data.appendRow({ time: Date.now(), cpu: readCpu() }), 100);
    return () => clearInterval(timer);
  }, [data]);
  return (
    <Chart>
      <Line data={data} x="time" y="cpu" />
    </Chart>
  );
}

export function Checked() {
  return (
    <Chart>
      {/* @ts-expect-error fields are checked against the element's data */}
      <Line data={metrics} x="time" y="missing" />
    </Chart>
  );
}
