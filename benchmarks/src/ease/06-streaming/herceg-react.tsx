import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
import { useEffect, useMemo } from "react";
import { reading } from "../data.ts";

export function Example() {
  const cpu = useMemo(() => table({ time: time([]), cpu: [] as number[] }, { maxRows: 300 }), []);
  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => cpu.appendRow(reading(i++)), 100);
    return () => clearInterval(timer);
  }, [cpu]);
  return (
    <Chart title="CPU">
      <Line data={cpu} x="time" y="cpu" />
    </Chart>
  );
}
