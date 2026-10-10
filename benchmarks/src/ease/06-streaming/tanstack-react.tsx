import { defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { useEffect, useMemo, useState } from "react";
import { reading } from "../data.ts";

type Reading = { time: Date; cpu: number };

export function Example() {
  const [rows, setRows] = useState<Reading[]>([]);
  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      const { time, cpu } = reading(i++);
      setRows((last) => [...last.slice(-299), { time: new Date(time), cpu }]);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  const definition = useMemo(
    () =>
      defineChart({
        marks: [lineY(rows, { x: "time", y: "cpu" })],
        scales: { x: { scale: scaleUtc }, y: { scale: scaleLinear, nice: true } },
        focus: "group-x",
        tooltip,
      }),
    [rows],
  );
  return <Chart definition={definition} ariaLabel="CPU" />;
}
