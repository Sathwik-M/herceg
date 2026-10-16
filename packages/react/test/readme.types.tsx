// The README examples, compiled by `npm run typecheck` so the docs stay true.
import { table, time, viridis } from "herceg";
import { useEffect, useMemo } from "react";
import { Legend } from "../src/guides.tsx";
import {
  Bar,
  Boxen,
  BoxPlot,
  Chart,
  Custom,
  Dendrogram,
  ErrorBar,
  Histogram,
  Line,
  Pie,
  Point,
  Region,
  Rug,
  Rule,
  Text,
  Violin,
} from "../src/index.ts";
import { Columns, Inset, Panel, Rows } from "../src/layout.tsx";

declare const timestamps: Float64Array;
declare const p50: Float64Array;
declare const p99: Float64Array;
declare function readCpu(): number;

const metrics = table({ time: time(timestamps), p50, p99, service: ["api", "db"] });

export function Latency() {
  return (
    <Chart title="Request latency" y={{ title: "ms" }} interaction={{ zoom: true }}>
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
      <Point data={metrics} x="service" y="p50" size="service" />
    </Chart>
  );
}

const deploys = table({ at: time([Date.now()]), version: ["v2"] });

export function Annotated() {
  return (
    <Chart>
      <Region x1={new Date(0)} x2={new Date()} label="window" />
      <Line data={metrics} x="time" y="p50" />
      <Rule data={deploys} x="at" label={{ field: "version" }} />
      <Text x={Date.now()} y={100} label={{ text: "now", style: { align: "end" } }} />
      <Text data={deploys} x="at" y={120} label={{ field: "version" }} />
      {/* @ts-expect-error rule positions from data are number or time fields */}
      <Rule data={deploys} x="version" />
      {/* @ts-expect-error constant text needs a label */}
      <Text x={1} y={2} />
      {/* @ts-expect-error text from data needs a label */}
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

const tips = table({ day: ["thu"], sex: ["f"], tip: [1], low: [0], high: [2] });
export function Tips() {
  return (
    <Chart>
      <Point data={tips} x="day" y="tip" series="sex" dodge jitter={{ width: 0.4 }} />
      <ErrorBar data={tips} x="day" y1="low" y2="high" series="sex" dodge />
      {/* A color column splits bars into series; series={false} colors each bar. */}
      <Bar data={tips} x="day" y="tip" color="sex" />
      <Bar data={tips} x="day" y="tip" color="sex" series={false} />
      {/* @ts-expect-error jitter takes a width */}
      <Point data={tips} x="day" y="tip" jitter={{ seed: 2 }} />
    </Chart>
  );
}

export function HistogramOptions() {
  return (
    <>
      <Histogram
        data={metrics}
        y="p50"
        bins={[0, 1, 2]}
        normalize="probability"
        commonNorm
        cumulative
        dodge
      />
      <Histogram data={metrics} x="time" axis="right" stack cumulative />
      {/* With x and y both, a 2D histogram's cells. */}
      <Histogram data={metrics} x="time" y="p50" bins={{ x: 20, y: 10 }} colors={viridis} />
      {/* @ts-expect-error 2D histograms take no stacks */}
      <Histogram data={metrics} x="time" y="p50" stack />
      {/* @ts-expect-error binned axis required */}
      <Histogram data={metrics} bins={10} />
      {/* @ts-expect-error binned fields are numeric or time */}
      <Histogram data={metrics} y="service" />
      {/* @ts-expect-error horizontal histograms cannot use the right axis */}
      <Histogram data={metrics} y="p50" axis="right" />
      {/* @ts-expect-error dodge and stack exclude each other */}
      <Histogram data={metrics} x="time" dodge stack />
    </>
  );
}
const linkage = table({ first: [0], second: [1], height: [2], label: ["a"], timestamp: time([0]) });
export function Trees() {
  return (
    <Chart>
      <Dendrogram
        data={linkage}
        first="first"
        second="second"
        height="height"
        leaves={["a", "b"]}
        side="right"
      />
    </Chart>
  );
}
const treeProps = {
  data: linkage,
  first: "first",
  second: "second",
  height: "height",
  leaves: ["a", "b"],
} as const;
// @ts-expect-error fields must exist
Dendrogram({ ...treeProps, first: "missing" });
// @ts-expect-error child ids are number fields
Dendrogram({ ...treeProps, first: "label" });
// @ts-expect-error heights cannot be time fields
Dendrogram({ ...treeProps, height: "timestamp" });
// @ts-expect-error leaves are string category labels
Dendrogram({ ...treeProps, leaves: [1, 2] });
// @ts-expect-error data is required
Dendrogram({ first: "first", second: "second", height: "height", leaves: [] });
Rug({ data: metrics, x: "time", side: "top", series: "service" });
Rug({ data: metrics, y: "p50", side: "right" });
// @ts-expect-error exactly one observed axis
Rug({ data: metrics, x: "time", y: "p50" });
// @ts-expect-error an observed axis is required
Rug({ data: metrics });
// @ts-expect-error rugs observe numeric or time fields
Rug({ data: metrics, x: "service" });
// @ts-expect-error x ticks stand at bottom or top
Rug({ data: metrics, x: "time", side: "left" });
// @ts-expect-error y rugs cannot use the right value axis
Rug({ data: metrics, y: "p50", axis: "right" });

export function BoxenOptions() {
  return (
    <Chart>
      <Boxen data={metrics} x="service" y="p50" series="service" depth="trustworthy" />
      <Boxen data={metrics} x="p50" y="service" depth={4} widthMethod="area" outliers={false} />
      {/* @ts-expect-error widthMethod takes the supported rules */}
      <Boxen data={metrics} x="service" y="p50" widthMethod="square" />
      {/* @ts-expect-error depth is a rule or a number of levels */}
      <Boxen data={metrics} x="service" y="p50" depth="quartiles" />
      {/* @ts-expect-error boxen takes no whiskers */}
      <Boxen data={metrics} x="service" y="p50" whiskers="tukey" />
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

function LatencyTip({ point }: { point: { text: string } | undefined }) {
  return <b>{point?.text} ms</b>;
}

export function Tooltips() {
  return (
    <Chart renderTooltip={(inspection) => <LatencyTip point={inspection.points[0]} />}>
      <Line data={metrics} x="time" y="p99" tooltip={{ fields: ["service"] }} />
      {/* @ts-expect-error tooltip fields are fields of the mark's data */}
      <Line data={metrics} x="time" y="p99" tooltip={{ fields: ["services"] }} />
    </Chart>
  );
}

// Layouts.
const regions = table({
  time: time(timestamps),
  p99,
  errors: p50,
  requests: p50,
  region: ["eu", "us"],
});
declare const start: number;
declare const end: number;

export function Dashboard() {
  return (
    <Chart height={600}>
      <Columns weights={[2, 1]}>
        <Rows weights={[2, 1]}>
          <Panel id="latency" title="p99">
            <Line data={regions} x="time" y="p99" color="region" />
            <Legend place={{ inside: "top-left" }} />
            <Inset id="detail" x={{ domain: [start, end] }} indicator>
              <Line data={regions} x="time" y="p99" color="region" />
            </Inset>
          </Panel>
          <Panel id="errors" title="Errors">
            <Bar data={regions} x="time" y="errors" color="region" />
          </Panel>
        </Rows>
        <Panel id="share" title="By region">
          <Pie data={regions} category="region" value="requests" />
        </Panel>
      </Columns>
    </Chart>
  );
}
