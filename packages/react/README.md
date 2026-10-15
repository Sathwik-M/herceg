# @herceg/react

React components for [herceg](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md) charts.

```tsx
import { Chart, Line, Rule } from "@herceg/react";
import { table, time } from "herceg";

const metrics = table({ time: time(timestamps), p50, p99 });

export function Latency() {
  return (
    <Chart title="Request latency" y={{ title: "ms" }} interaction={{ zoom: true }}>
      <Line data={metrics} x="time" y={["p50", "p99"]} />
      <Rule y={250} label="SLO" />
    </Chart>
  );
}
```

The `navigator` prop accepts `rangeNavigator()` from `herceg`. Its dense bar
strip preserves every column intersected by a bar's placed rectangle and
uses the same color rules as the core and static exports (see
[Range navigator](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md#range-navigator)).
The chart's text alternative describes its overview and current x range,
and its control of every panel's x when there are several.

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`scales`, `guides`, `padding`, `tooltip`, `interaction`, `renderer`, `theme`,
`fonts`, `width`, `height`, ...). Its
children are mark elements: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<Contour>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`,
`<BoxPlot>`, `<Boxen>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`,
`<Radar>`, `<Sankey>`, `<Graph>`, `<GeoShape>`, `<GeoPoint>`, `<Point3D>`,
`<Line3D>`, `<Surface>`, `<Rule>`, `<Region>`, `<Text>`, and `<Custom>`.
Each mark element takes the table it reads as `data`, so field names are checked against that table's
columns; `<Graph>` takes its links as `data` and a table of nodes as `nodes`.
`<GeoShape>` and `<GeoPoint>` share a chart with each other, projected by the
chart's `projection` prop: `<Chart projection="equal-earth"><GeoShape
data={countries} color="gdp" /></Chart>`. `<Point3D>`, `<Line3D>`, and
`<Surface>` share a 3D chart, seen from its `camera` prop; a re-render with the same camera
keeps the view the user turned to, a different one shows it.
Annotations (`<Rule>`, `<Region>`, `<Text>`) take `data` only when
they draw one item per row: `<Rule data={deploys} x="time" textField="version" />`. Marks built
with herceg's functions can also be passed as a `marks` prop.

The chart fills its container's width and is 320 px tall unless `width`,
`height`, or `style` says otherwise. A `ref` gives the underlying chart, herceg's
`Chart`, for imperative calls (`setViewport`, `select`, `toPixel`, `setVisibility`,
`toSVG`, `toPNG`, and `renderToPDF(chart)` from `herceg/pdf`, which export the chart as
it shows, a highlighted row selection included). Chart events are props: `onViewport`, `onSelect`, `onHover`, `onClick`,
`onRowSelection` (a channel of the chart's `rowSelection` changed),
`onCamera`, `onDrill` (a treemap or sunburst drilled into a node), `onItemMove` (a
network's node moved; with subplots, these and `onViewport` and `onSelect` events of a
subplot's tree, map, or network name it in `panels`), `onVisibility` (series hidden or shown), and `onRender` (a frame
of the data drawn, for overlays, the first one once the ref is set); the latest handler
is called, so inline functions do not resubscribe. A `rowSelection` prop
(`rowSelection({ store, channel })`) made again each render is the same binding while it
binds the same stores and channels, so it neither updates nor resubscribes the chart.

`<Graph>` uses the same `interaction` prop as maps: `zoom: true` (or
`"xy"`) pans and zooms with wheel, drag, double-click, Shift+arrows,
plus/minus/0, and a toolbar. `onViewport` reports x and y ranges in layout
coordinates (y increases downwards); node radii stay fixed in pixels.
`brush: "lasso"` selects visible node centers through a `rowSelection`
bound to the nodes table, including duplicate node rows, and dims unselected
nodes and their links. In lasso mode, Shift-drag pans; its toolbar toggle
returns plain drags to navigation or node dragging. With `drag: true`,
nodes move while zoomed and `setItemPosition` still uses layout units.
When zoom is on, Alt+Shift+arrows moves the node read; Shift+arrows and 0
navigate the view. The toolbar restores moved nodes.

`layout` places a network's nodes: `"force"` (the default; in it, the nodes
near a moved one settle around it once it is dropped, unless `{ type:
"force", settle: false }`), `"circular"`, or `"layered"` (for trees and
directed acyclic networks), as in the core (see
[Networks](../herceg/README.md#networks)). Nodes keep their places, and
moved nodes stay, while the data changes, and while the component renders
again with a new mark over the same or new tables: `<Graph data={reports} source="manager" target="report" layout="layered" />`.

`Line` and `Rule` accept `dash="-"`, `"--"`, `":"`, or `"-."`, as well
as pixel arrays. String patterns scale with `strokeWidth` (the theme's
line width when omitted on `Line`); arrays stay in CSS pixels. `Custom`
shape styles accept the same values. See the engine's [dash patterns](../herceg/README.md#marks).

## Tooltips

Mark elements take `tooltip={{ fields: [...] }}` for more of the row a
point is, and axes `tooltipFormat` for how tooltips write their values, as
in herceg (see [Tooltips](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md#tooltips)). For content of
your own, `renderTooltip` returns React content, which renders, with the
application's context, in the chart's box: it keeps its placement, the
crosshair and highlighted points, and the keyboard's announcements. Only
the content of what the tooltip is at renders, when that changes, never an
element per data point, and data changes still redraw without React.

```tsx
<Chart renderTooltip={(inspection) => <LatencyTip point={inspection.points[0]} />}>
  <Line data={latency} x="time" y="p99" tooltip={{ fields: ["requests"] }} />
</Chart>
```

Several chart handles can be exported together with
`renderToPDF([chart1, chart2], { pageSize: "A4", title: "Report" })`
from `herceg/pdf`. Each chart retains its current zoom and visibility and
occupies one page; use subplots for several views on a page. The same function
accepts one handle and optional paper, margin, font, and metadata settings
(`title`, `subject`, `language`). Fitting clips each complete chart to its
rectangle; each chart's locale scopes its visible content while generated
alternatives retain their English language.

Text halos on `<Text>`, `<Region>`, `<Bar>`, `<Funnel>`, `<Radar>`, `<Sankey>`,
and `<Graph>` take `halo`: `"auto"` (the default: the surface under the text at
3:1 text contrast or higher, else white or black), `halo={false}` for none, or
`{ color, width, opacity }`; graph node and link labels share it, and the
chart's navigator takes it too. Marks on the chart's scales take `clip`
(`"plot"`, `"chart"`, or `false`). Isolated line
and area rows draw stroke-sized round dots, including step curves and lines
along y. Bars whose `series` names their category field keep full bands,
category colors and legends, and value labels. Time axes choose intervals
their `format` can distinguish and remove remaining duplicate labels;
`tooltipFormat` independently formats tooltip, keyboard, and crosshair values.
These behaviors carry through the engine's static SVG and PDF exports.

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

## Normalized stacks and streamgraphs

```tsx
<Area data={usage} x="time" y={["user", "system"]} stack="wiggle" stackOrder="inside-out" />
<Bar data={sales} x="region" y={["q1", "q2"]} stack="fill" labels={{ style: "percent" }} />
```

`Area` accepts `stack={true}`, `"fill"`, `"center"`, and
`"wiggle"`; `Bar` accepts true or `"fill"`. Fill normalizes nonnegative values
at each position to shares on a 0–1 value axis; its `format: { style: "percent" }`
shows percent ticks. Center and wiggle keep raw thickness with shifted baselines
and raw axis extents. `stackOrder="inside-out"` applies to
the three nonnegative area modes. Negative values require ordinary `stack: true`.
Missing values keep their layer's gaps and count as zero. `stackGaps` resolves
absent rows before offsets. These options also work for areas with `orient="y"`
and horizontal bars. Tooltips and keyboard text show both share and raw value
for fill; bar labels show shares. Streams report raw values. Legend toggles,
facets, subplots, zoom, streaming, and static export use the core engine's stack.
Wiggle and inside-out recompute over the retained window; inside-out updates
and areas along y display changed values immediately.

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
and option objects inline is fine. Functions in options (tick generators,
formatters) are compared by identity: an inline function updates the chart
on every render, so define it outside the component or memoize it. Changes are applied during React's layout
phase, so a parent's layout effect can already read them through `ref`.

## Grids

`<Grid>`, from `@herceg/react/grid` so that applications drawing only charts
never load it, shows a grid model (see herceg's README, "Grids"). The
application makes the model and owns it; data changes, scrolling, focus,
selection, sorting, and column layout (resizing, moving, pinning, hiding) go
through the model and the grid, never through React; to keep a user's
layout, read `model.columns` in a `model.subscribe` listener. A new `model` makes a new grid; `ariaLabel`, `theme`, and
`headerHeight` change in place. A model no one keeps any more stops following
its view on its own, so a model made with `useMemo` needs no cleanup.

```tsx
import { rowView } from "herceg";
import { createGridModel } from "herceg/grid";
import { Grid } from "@herceg/react/grid";

function Requests({ data }: { data: typeof requests }) {
  const model = useMemo(
    () => createGridModel({ data: rowView(data), columns: [{ field: "time" }, { field: "latency" }] }),
    [data],
  );
  return <Grid model={model} ariaLabel="Requests" style={{ height: 400 }} />;
}
```

`<Point3D>`, `<Line3D>`, and `<Surface>` accept `panel` to share a 3D
subplot beside panels with other marks. Pass `panels(...)` from `herceg`
to the chart, with a `camera` on each panel to override chart defaults.
Each 3D subplot has its own camera, toolbar, orbit gestures, and keyboard
turning; the description and exports show each panel's view. The chart
handle's `getCamera({ panel: "cloud" })` and
`setCamera({ azimuth: 40 }, { panel: "cloud" })` target it; a null camera
resets that panel. `onCamera` receives `{ camera, panels: [id] }` for a
subplot, or `{ camera }` for a standalone chart. Re-rendering with the
same configured cameras preserves user turns. Subplots use CPU rendering
with cached geometry and Canvas pixels; standalone charts retain WebGL
points, lines, and surfaces. 3D facets are refused.
