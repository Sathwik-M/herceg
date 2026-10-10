// The README examples, compiled by `npm run typecheck` so the docs stay true.
import { table, time } from "herceg";
import { useEffect, useMemo } from "react";
import { BoxPlot, Chart, Custom, Line, Point, Region, Rule, Text, Violin } from "../src/index.ts";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;
declare function readCpu(): number;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });

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

export function Strip() {
  return (
    <Chart>
      {/* A category field places points in its bands. */}
      <Point data={metrics} x="service" y="p50" />
      {/* @ts-expect-error point sizes are number fields */}
      <Point data={metrics} x="service" y="p50" r="service" />
    </Chart>
  );
}

const deploys = table({ at: time([Date.now()]), version: ["v2"] });

export function Annotated() {
  return (
    <Chart>
      <Region x1={new Date(0)} x2={new Date()} label="window" />
      <Line data={metrics} x="time" y="p50" />
      <Rule data={deploys} x="at" text="version" />
      <Text x={Date.now()} y={100} label="now" anchor="end" />
      <Text data={deploys} x="at" y={120} text="version" />
      {/* @ts-expect-error rule positions from data are number or time fields */}
      <Rule data={deploys} x="version" />
      {/* @ts-expect-error constant text needs a label */}
      <Text x={1} y={2} />
      {/* @ts-expect-error text from data needs a label or a text field */}
      <Text data={deploys} x="at" y={1} />
    </Chart>
  );
}

export function Drawn() {
  return (
    <Chart>
      <Custom draw={({ text, x, y }) => text(x(1), y(2), "label")} />
      <Custom data={metrics} x="time" draw={({ table: data }) => void data.numbers("p50")} />
      <Custom
        data={metrics}
        x="time"
        y="p50"
        series="service"
        pointText={(row, format, s) => format.y(s.y[row]!)}
        draw={({ series, circle, x, y }) => {
          for (const s of series) circle(x(s.x[0]!), y(s.y[0]!), 3, { fill: s.color });
        }}
      />
      {/* @ts-expect-error without data, draw gets no table */}
      <Custom draw={({ table: none }) => none} />
      {/* @ts-expect-error a custom mark's series field is a category field */}
      <Custom data={metrics} x="time" y="p50" series="p99" draw={() => {}} />
      {/* @ts-expect-error a draw that reads the table needs the table as data */}
      <Custom<typeof metrics> draw={({ table: data }) => void data.numbers("p50")} />
      <Custom data={metrics} x="time" y={["p50", "p99"]} series={false} draw={() => {}} />
    </Chart>
  );
}

// Optional props may be undefined, which takes the default.
declare const maybeTitle: string | undefined;
export const untitled = <Chart title={maybeTitle} legend={undefined} />;

const boxData = table({
  group: ["a"],
  low: [0],
  q1: [1],
  median: [2],
  q3: [3],
  high: [4],
  count: [20],
});
const boxFields = { low: "low", q1: "q1", median: "median", q3: "q3", high: "high" } as const;
export function Boxes() {
  return (
    <Chart>
      <BoxPlot data={boxData} x="group" {...boxFields} />
      <BoxPlot data={boxData} y="group" {...boxFields} count="count" notch />
      <BoxPlot data={boxData} x="group" y="median" whiskers="range" notch />
      <BoxPlot data={boxData} x="group" y="median" whiskers={2} />
      {/* @ts-expect-error raw and precomputed forms exclude each other */}
      <BoxPlot data={boxData} x="group" y="median" {...boxFields} />
      {/* @ts-expect-error precomputed whisker ends forbid whiskers */}
      <BoxPlot data={boxData} x="group" {...boxFields} whiskers="range" />
      {/* @ts-expect-error precomputed notches need count */}
      <BoxPlot data={boxData} x="group" {...boxFields} notch />
      {/* @ts-expect-error statistic fields must be numeric */}
      <BoxPlot data={boxData} x="group" {...boxFields} low="group" />
    </Chart>
  );
}

export function ViolinOptions() {
  return (
    <Chart>
      <Violin data={metrics} x="service" y="p50" series="service" split inner="quartiles" />
      <Violin data={metrics} x="p50" y="service" inner="none" />
      {/* @ts-expect-error inner takes only the supported interiors */}
      <Violin data={metrics} x="service" y="p50" inner="points" />
      {/* @ts-expect-error split is boolean */}
      <Violin data={metrics} x="service" y="p50" split="true" />
      {/* @ts-expect-error a series field is categorical */}
      <Violin data={metrics} x="service" y="p50" series="p50" split />
    </Chart>
  );
}
