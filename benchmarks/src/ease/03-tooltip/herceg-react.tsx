import { Chart, Line } from "@herceg/react";
import { type Chart as HercegChart, type InspectedPoint, table, time } from "herceg";
import { useRef, useState } from "react";
import { days, p99, requests } from "../data.ts";

const latency = table({ time: time(days), p99, requests });
const date = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

interface Tip {
  point: InspectedPoint;
  row: number;
  /** Left of the point past the chart's middle, to stay inside it. */
  flip: boolean;
}

export function Example() {
  const chart = useRef<HercegChart>(null);
  const [tip, setTip] = useState<Tip>();
  return (
    // The tooltip's position is from the chart's top left corner, which is this box's.
    <div style={{ position: "relative" }}>
      <Chart
        ref={chart}
        title="Request latency"
        y={{ title: "ms" }}
        tooltip={false}
        onHover={({ inspection }) => {
          const point = inspection?.points[0];
          const flip = point !== undefined && point.px > chart.current!.root.clientWidth / 2;
          setTip(point?.row === undefined ? undefined : { point, row: point.row, flip });
        }}
      >
        <Line data={latency} x="time" y="p99" />
      </Chart>
      {tip && (
        <div
          style={{
            position: "absolute",
            left: tip.point.px,
            top: tip.point.py,
            transform: tip.flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            background: "#fff",
            border: "1px solid #ccc",
          }}
        >
          {date.format(latency.numbers("time")[tip.row])}: {tip.point.value} ms,{" "}
          {latency.numbers("requests")[tip.row]!.toLocaleString("en-US")} requests
        </div>
      )}
    </div>
  );
}
