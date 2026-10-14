# @herceg/svelte

Svelte 5 components for [herceg](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md) charts.

```svelte
<script lang="ts">
  import { Chart, Line, Rule } from "@herceg/svelte";
  import { table, time } from "herceg";

  const metrics = table({ time: time(timestamps), p50, p99 });
</script>

<Chart title="Request latency" y={{ title: "ms" }} interaction={{ zoom: true }}>
  <Line data={metrics} x="time" y={["p50", "p99"]} />
  <Rule y={250} label="SLO" />
</Chart>
```

The `navigator` prop accepts `rangeNavigator()` from `herceg`. Its dense bar
strip preserves every column intersected by a bar's placed rectangle and
uses the same color rules as the core and static exports (see
[Range navigator](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md#range-navigator)).
The chart's text alternative describes its overview and current x range,
and its control of every panel's x when there are several.

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`tooltip`, `interaction`, `renderer`, `theme`, `width`, `height`, ...). Its
children are mark components: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<Contour>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`,
`<BoxPlot>`, `<Boxen>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`,
`<Radar>`, `<Sankey>`, `<Graph>`, `<GeoShape>`, `<GeoPoint>`, `<Point3D>`,
`<Line3D>`, `<Surface>`, `<Rule>`, `<Region>`, `<Text>`, and `<Custom>`, written directly, in `{#if}` and
`{#each}` blocks, or in components of your own, and drawn in template order.
Each mark component takes the table it reads as `data`, so svelte-check
checks field names against that table's columns; `<Graph>` takes its links as
`data` and a table of nodes as `nodes`; `<GeoShape>` and `<GeoPoint>` share a
chart with each other, projected by its `projection` prop, and `<Point3D>`,
`<Line3D>`, and `<Surface>` a 3D chart seen from its `camera` prop. Annotations (`<Rule>`,
`<Region>`, `<Text>`) take `data` only when they draw one item per row:
`<Rule data={deploys} x="time" textField="version" />`. Marks built with herceg's
functions can also be passed as a `marks` prop.

The chart fills its container's width and is 320 px tall unless `width`,
`height`, or `style` says otherwise; `class` and `style` go to the container
element. Chart events are callback props: `onviewport`, `onselect`,
`onhover`, `onclick`, `onrowselection` (a channel of the chart's `rowSelection` changed),
`oncamera` (a 3D chart turned), `ondrill` (a treemap or sunburst drilled into a node),
`onitemmove` (a network's node moved; with subplots, these and `onviewport` and
`onselect` events of a subplot's tree, map, or network name it in `panels`),
`onvisibility` (series hidden or
shown), and `onrender` (a frame of the data drawn, for overlays, the first one as the
chart mounts). A `rowSelection` binding made again is the same while it binds the same
stores and channels. The chart listens only
while a handler is given and calls the current one, so passing a new function does not
resubscribe. `bind:chart` gives the underlying chart, herceg's `Chart` (null until
mounted), for imperative calls (`setViewport`, `select`, `toPixel`, `setVisibility`,
`toSVG`, `toPNG`, and `renderToPDF(chart)` from `herceg/pdf`):

```svelte
<script lang="ts">
  import type { Chart as HercegChart } from "herceg";

  let chart = $state<HercegChart | null>(null);
  let range = $state<readonly [number, number] | null>(null);
  const exportSvg = () => chart?.toSVG();
</script>

<Chart bind:chart interaction={{ brush: "x" }} onselect={({ x }) => (range = x)}>
  <Line data={metrics} x="time" y="p50" />
</Chart>
```

`<Graph>` uses the same `interaction` prop as maps: `zoom: true` (or
`"xy"`) pans and zooms with wheel, drag, double-click, Shift+arrows,
plus/minus/0, and a toolbar. `onviewport` reports x and y ranges in layout
coordinates (y increases downwards); node radii stay fixed in pixels.
`brush: "lasso"` selects visible node centers through a `rowSelection`
bound to the nodes table, including duplicate node rows, and dims unselected
nodes and their links. In lasso mode, Shift-drag pans; its toolbar toggle
returns plain drags to navigation or node dragging. With `drag: true`,
nodes move while zoomed and `setItemPosition` still uses layout units.
When zoom is on, Alt+Shift+arrows moves the node read; Shift+arrows and 0
navigate the view. The toolbar restores moved nodes.

Several chart handles can be exported together with
`renderToPDF([chart1, chart2], { pageSize: "A4", title: "Report" })`
from `herceg/pdf`. Each chart retains its current zoom and visibility and
occupies one page; use subplots for several views on a page. The same function
accepts one handle and optional paper, margin, font, and metadata settings
(`title`, `subject`, `language`). Fitting clips each complete chart to its
rectangle; each chart's locale scopes its visible content while generated
alternatives retain their English language.

## Tooltips

Mark components take `tooltip={{ fields: [...] }}` for more of the row a
point is, and axes `tooltipFormat` for how tooltips write their values, as
in herceg (see [Tooltips](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md#tooltips)). For content of
your own, a `renderTooltip` snippet renders in the chart's box, which keeps
its placement, the crosshair and highlighted points, and the keyboard's
announcements. Only the content of what the tooltip is at renders, when
that changes, never a node per data point.

```svelte
<Chart>
  <Line data={latency} x="time" y="p99" tooltip={{ fields: ["requests"] }} />
  {#snippet renderTooltip(inspection)}
    <LatencyTip point={inspection.points[0]} />
  {/snippet}
</Chart>
```

Text halos on `<Text>`, `<Region>`, `<Bar>`, `<Funnel>`, `<Radar>`, `<Sankey>`,
and `<Graph>` accept `halo={false}`; graph node and link labels share it.
Halos use the background at 3:1 text contrast or higher, then the light/dark
fallback. The chart's navigator accepts `{ halo: false }` too. Isolated line
and area rows draw stroke-sized round dots, including step curves and lines
along y. Bars whose `series` names their category field keep full bands,
category colors and legends, and value labels. Time axes choose intervals
their `format` can distinguish and remove remaining duplicate labels;
`tooltipFormat` independently formats tooltip, keyboard, and crosshair values.
These behaviors carry through the engine's static SVG and PDF exports.

## Live data

Each mark component renders one empty `<template>` element, which keeps the
marks in template order, never one element per data point, and data updates
do not go through Svelte. Keep the table in a plain variable (`$state` does
not proxy class instances, so it does not change a table either) and change
it directly; the chart re-renders on the next animation frame, coalescing any
number of changes:

```svelte
<script lang="ts">
  import { onMount } from "svelte";

  const data = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
  onMount(() => {
    const timer = setInterval(() => data.appendRow({ time: Date.now(), cpu: readCpu() }), 100);
    return () => clearInterval(timer);
  });
</script>

<Chart>
  <Line {data} x="time" y="cpu" />
</Chart>
```

Props are the whole configuration: removing a prop restores its default.
When a prop changes, the chart compares the options and every mark's spec
and table, and is left alone when they are equal. Arrays and objects are
copied as the chart reads them, so changing `$state` in place
(`fields.push("p99")`) updates the chart as replacing it would. Changes are
applied in an effect that runs before the effects of the component around
the chart. Invalid props, such as a field the table does not have, throw
from that effect to the nearest `<svelte:boundary>`.

A custom mark's `draw` runs while the chart draws, outside Svelte's
dependency tracking. When it reads state, rebuild the mark as the state
changes, for example with `{#key}`:

```svelte
{#key selected}
  <Custom draw={({ text, x, y }) => text(x(1), y(2), selected)} />
{/key}
```

## Normalized stacks and streamgraphs

```svelte
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

`<Point3D>`, `<Line3D>`, and `<Surface>` accept `panel` to share a 3D
subplot beside panels with other marks. Pass `panels(...)` from `herceg`
to the chart, with a `camera` on each panel to override chart defaults.
Each 3D subplot has its own camera, toolbar, orbit gestures, and keyboard
turning; the description and exports show each panel's view. The chart
handle's `getCamera({ panel: "cloud" })` and
`setCamera({ azimuth: 40 }, { panel: "cloud" })` target it; a null camera
resets that panel. `oncamera` receives `{ camera, panels: [id] }` for a
subplot, or `{ camera }` for a standalone chart. Re-rendering with the
same configured cameras preserves user turns. Subplots use CPU rendering
with cached geometry and Canvas pixels; standalone charts retain WebGL
points, lines, and surfaces. 3D facets are refused.
