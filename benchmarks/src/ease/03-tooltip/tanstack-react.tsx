import { defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react/tooltip";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const rows = daily.map((row) => ({ ...row, time: new Date(row.time) }));
const latency = defineChart({
  marks: [lineY(rows, { x: "time", y: "p99" })],
  scales: {
    x: { scale: scaleUtc },
    y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
  },
  focus: "group-x",
  tooltip,
});

export function Example() {
  return (
    <Chart
      definition={latency}
      ariaLabel="Request latency"
      renderTooltipBody={({ points }) => {
        const datum = points[0]?.datum;
        return (
          datum && (
            <>
              {date.format(datum.time)}: {datum.p99} ms, {datum.requests.toLocaleString("en-US")}{" "}
              requests
            </>
          )
        );
      }}
    />
  );
}
