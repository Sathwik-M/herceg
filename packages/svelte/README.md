# @herceg/svelte

Svelte 5 components for [herceg](../herceg/README.md) charts.

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
[Range navigator](../herceg/README.md#range-navigator)).

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`tooltip`, `interaction`, `renderer`, `theme`, `width`, `height`, ...). Its
children are mark components: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`,
`<BoxPlot>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`,
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
`onitemmove` (a network's node moved), `onvisibility` (series hidden or
shown), and `onrender` (a frame of the data drawn, for overlays, the first one as the
chart mounts). A `rowSelection` binding made again is the same while it binds the same
stores and channels. The chart listens only
while a handler is given and calls the current one, so passing a new function does not
resubscribe. `bind:chart` gives the underlying chart, herceg's `Chart` (null until
mounted), for imperative calls (`setViewport`, `select`, `toPixel`, `setVisibility`,
`toSVG`):

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
