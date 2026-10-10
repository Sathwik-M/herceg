import { type ChartPoint, createMark, defineChart, mountChart } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { scaleUtc } from "d3-scale";
import { daily } from "../data.ts";

type Day = { time: Date; p50: number };

// A lollipop per day: a stem from zero and a dot at the value, whose points
// the pointer, the keyboard, and the tooltip find.
function lollipops(rows: readonly Day[]) {
  return createMark<Day, Date, number>(({ markIndex }) => {
    const id = `lollipops-${markIndex}`;
    return {
      id,
      channels: {
        x: { scale: "x", values: rows.map((row) => row.time) },
        y: { scale: "y", values: rows.map((row) => row.p50), includeZero: true },
      },
      render({ scales, theme }) {
        const base = scales.y!.map(0);
        const color = theme.palette[0]!;
        const points: ChartPoint<Day, Date, number>[] = rows.map((row, i) => ({
          key: row.time.toISOString(),
          markId: id,
          group: null,
          groupLabel: "p50",
          datum: row,
          datumIndex: i,
          xValue: row.time,
          yValue: row.p50,
          x: scales.x!.map(row.time),
          y: scales.y!.map(row.p50),
          color,
        }));
        return {
          points,
          nodes: points.flatMap((point) => [
            {
              kind: "rule" as const,
              key: `stem-${point.key}`,
              x1: point.x,
              y1: base,
              x2: point.x,
              y2: point.y,
              style: { stroke: color },
            },
            {
              kind: "dot" as const,
              key: `dot-${point.key}`,
              x: point.x,
              y: point.y,
              radius: 3,
              style: { fill: color },
              interaction: { point, affinity: "x" as const },
            },
          ]),
        };
      },
    };
  });
}

export function render(container: HTMLElement) {
  const rows = daily.map((row) => ({ time: new Date(row.time), p50: row.p50 }));
  return mountChart(container, {
    ariaLabel: "Request latency",
    definition: defineChart({
      marks: [lollipops(rows)],
      scales: {
        x: { scale: scaleUtc },
        y: { scale: scaleLinear, nice: true, axis: { label: "ms" } },
      },
      focus: "nearest-x",
      tooltip,
    }),
  });
}
