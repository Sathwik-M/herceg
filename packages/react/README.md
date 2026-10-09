# @herceg/react

React components for [herceg](../herceg/README.md) charts.

```tsx
import { Chart, Line, Rule } from "@herceg/react";
import { table, time } from "herceg";

const metrics = table({ time: time(timestamps), p50, p99 });

export function Latency() {
  return (
    <Chart title="Request latency" y={{ label: "ms" }} interaction={{ zoom: true }}>
      <Line data={metrics} x="time" y={["p50", "p99"]} />
      <Rule y={250} label="SLO" />
    </Chart>
  );
}
```

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`tooltip`, `interaction`, `renderer`, `theme`, `width`, `height`, ...). Its
children are mark elements: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`, `<BoxPlot>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`, `<Radar>`, `<Sankey>`, `<Graph>`, `<GeoShape>`, `<GeoPoint>`, `<Rule>`, `<Region>`, `<Text>`, and `<Custom>`. Each mark element takes the
table it reads as `data`, so field names are checked against that table's
columns; `<Graph>` takes its links as `data` and a table of nodes as `nodes`.
`<GeoShape>` and `<GeoPoint>` share a chart with each other, projected by the
chart's `projection` prop: `<Chart projection="equal-earth"><GeoShape
data={countries} color="gdp" /></Chart>`.
Annotations (`<Rule>`, `<Region>`, `<Text>`) take `data` only when
they draw one item per row: `<Rule data={deploys} x="time" text="version" />`. Marks built
with herceg's functions can also be passed as a `marks` prop.

The chart fills its container's width and is 320 px tall unless `width`,
`height`, or `style` says otherwise. A `ref` gives the underlying chart for imperative
calls (`setViewport`, `select`, `toSVG`). Chart events are props:
`onViewportChange`, `onSelect`, `onHover`, and `onClick`; the latest handler
is called, so inline functions do not resubscribe.

## Reusing groups of marks

`<Chart>` reads its children's props to build marks; it does not render
them. Mark elements may sit in fragments and arrays, but not inside
components of your own (`<LatencyMarks />` throws), whose output the chart
cannot see. To reuse a group of marks, call a function that returns them,
or build them with herceg's functions and pass them as `marks`:

```tsx
function latencyMarks(data: typeof metrics) {
  return (
    <>
      <Line data={data} x="time" y={["p50", "p99"]} />
      <Rule y={250} label="SLO" />
    </>
  );
}

<Chart title="Checkout">{latencyMarks(checkout)}</Chart>;
<Chart title="Search" marks={[line(search, { x: "time", y: "p50" }), rule({ y: 250 })]} />;
```

## Live data

Mark elements do not create one React element per data point, and data
updates do not go through React. Keep the table outside render (module
scope, a ref, or `useMemo`) and change it directly; the chart re-renders on
the next animation frame, coalescing any number of changes:

```tsx
function Live() {
  const data = useMemo(() => table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 }), []);
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
```

Props are the chart's whole configuration: removing a prop restores its
default. They are compared on each render, and when neither the options nor
any mark's spec or table changed, the chart is left alone, so writing marks
and option objects inline is fine. Changes are applied during React's layout
phase, so a parent's layout effect can already read them through `ref`.
