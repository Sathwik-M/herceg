# @herceg/vue

Vue 3 components for [herceg](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md) charts.

```vue
<script setup lang="ts">
import { Chart, Line, Rule } from "@herceg/vue";
import { table, time } from "herceg";

const metrics = table({ time: time(timestamps), p50, p99 });
</script>

<template>
  <Chart title="Request latency" :y="{ title: 'ms' }" :interaction="{ zoom: true }">
    <Line :data="metrics" x="time" :y="['p50', 'p99']" />
    <Rule :y="250" label="SLO" />
  </Chart>
</template>
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
slot holds mark components: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<Contour>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`,
`<BoxPlot>`, `<Boxen>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`,
`<Radar>`, `<Sankey>`, `<Graph>`, `<GeoShape>`, `<GeoPoint>`, `<Point3D>`,
`<Line3D>`, `<Surface>`, `<Rule>`, `<Region>`, `<Text>`, and `<Custom>`, also from `v-if` and `v-for`, drawn in
template order. Each mark component takes the table it reads as `data`, so
vue-tsc checks field names against that table's columns; `<Graph>` takes its
links as `data` and a table of nodes as `nodes`; `<GeoShape>` and `<GeoPoint>`
share a chart with each other, projected by its `projection` prop, and
`<Point3D>`, `<Line3D>`, and `<Surface>` a 3D chart seen from its `camera`
prop. Annotations
(`<Rule>`, `<Region>`, `<Text>`) take `data` only when they draw one item per
row: `<Rule :data="deploys" x="time" textField="version" />`. Marks built with
herceg's functions can also be passed as a `marks` prop. Options may be
written in kebab-case (`:stroke-width="2"`), and boolean options as bare
attributes (`<Area stack />`). The slot holds mark components directly:
components of your own that render marks are not read.

The chart fills its container's width and is 320 px tall unless `width`,
`height`, or a style says otherwise; `class`, `style`, and other attributes
go to the container element. Chart events are Vue events: `@viewport`,
`@select`, `@hover`, `@camera` (a 3D chart turned), `@drill` (a treemap or sunburst
drilled into a node), `@item-move` (a network's node moved; with subplots, these and
`@viewport` and `@select` events of a subplot's tree, map, or network name it in
`panels`), `@visibility` (series hidden or shown),
`@render` (a frame of the data drawn, for overlays, the first one as the chart mounts), `@row-selection` (a channel of
the chart's `rowSelection` changed), and `@click` (the chart's click, with the
data under the pointer, not the element's). A `:row-selection` binding made again,
or kept in reactive state, is the same while it binds the same stores and channels. A template ref exposes the underlying chart,
herceg's `Chart`, as `chart` (null until mounted) for imperative calls (`setViewport`,
`select`, `toPixel`, `setVisibility`, `toSVG`, `toPNG`, and `renderToPDF(chart)` from `herceg/pdf`,
which export the chart as it shows, a highlighted row selection included):

```vue
<script setup lang="ts">
import { shallowRef, useTemplateRef } from "vue";

const view = useTemplateRef("view");
const range = shallowRef<readonly [number, number] | null>(null);
const exportSvg = () => view.value?.chart?.toSVG();
</script>

<template>
  <Chart ref="view" :interaction="{ brush: 'x' }" @select="({ x }) => (range = x)">
    <Line :data="metrics" x="time" y="p50" />
  </Chart>
</template>
```

`<Graph>` uses the same `interaction` prop as maps: `zoom: true` (or
`"xy"`) pans and zooms with wheel, drag, double-click, Shift+arrows,
plus/minus/0, and a toolbar. `@viewport` reports x and y ranges in layout
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
again with a new mark over the same or new tables: `<Graph :data="reports" source="manager" target="report" layout="layered" />`.

Several chart handles can be exported together with
`renderToPDF([chart1, chart2], { pageSize: "A4", title: "Report" })`
from `herceg/pdf`. Each chart retains its current zoom and visibility and
occupies one page; use subplots for several views on a page. The same function
accepts one handle and optional paper, margin, font, and metadata settings
(`title`, `subject`, `language`). Fitting clips each complete chart to its
rectangle; each chart's locale scopes its visible content while generated
alternatives retain their English language.

`Line` and `Rule` accept `dash="-"`, `"--"`, `":"`, or `"-."`, as well
as pixel arrays. String patterns scale with `strokeWidth` (the theme's
line width when omitted on `Line`); arrays stay in CSS pixels. `Custom`
shape styles accept the same values. See the engine's [dash patterns](../herceg/README.md#marks).

## Tooltips

Mark components take `:tooltip="{ fields: [...] }"` for more of the row a
point is, and axes `tooltipFormat` for how tooltips write their values, as
in herceg (see [Tooltips](https://github.com/op55-org/herceg/blob/main/packages/herceg/README.md#tooltips)). For content of
your own, the `renderTooltip` slot renders in the chart's box, which keeps
its placement, the crosshair and highlighted points, and the keyboard's
announcements. Only the content of what the tooltip is at renders, when
that changes, never a node per data point.

```vue
<Chart>
  <Line :data="latency" x="time" y="p99" :tooltip="{ fields: ['requests'] }" />
  <template #renderTooltip="{ inspection }">
    <LatencyTip :point="inspection.points[0]" />
  </template>
</Chart>
```

Text halos on `<Text>`, `<Region>`, `<Bar>`, `<Funnel>`, `<Radar>`, `<Sankey>`,
and `<Graph>` take `halo`: `"auto"` (the default: the surface under the text at
3:1 text contrast or higher, else white or black), `:halo="false"` for none, or
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
them. Mark components may sit in fragments, `v-for`, and `v-if`, but not
inside components of your own, whose output the chart cannot see. To reuse
a group of marks, build them with herceg's functions and pass them as
`marks`:

```ts
import { line, rule, type Table } from "herceg";

export const latencyMarks = (data: Table) => [
  line(data, { x: "time", y: ["p50", "p99"] }),
  rule({ y: 250, label: "SLO" }),
];
```

```vue
<Chart title="Checkout" :marks="latencyMarks(checkout)" />
```

## Normalized stacks and streamgraphs

```vue
<Area :data="usage" x="time" :y="['user', 'system']" stack="wiggle" stack-order="inside-out" />
<Bar :data="sales" x="region" :y="['q1', 'q2']" stack="fill" :labels="{ style: 'percent' }" />
```

`Area` accepts `:stack="true"`, `"fill"`, `"center"`, and
`"wiggle"`; `Bar` accepts true or `"fill"`. Fill normalizes nonnegative values
at each position to shares on a 0–1 value axis; its `format: { style: "percent" }`
shows percent ticks. Center and wiggle keep raw thickness with shifted baselines
and raw axis extents. `stack-order="inside-out"` applies to
the three nonnegative area modes. Negative values require ordinary `stack: true`.
Missing values keep their layer's gaps and count as zero. `stackGaps` resolves
absent rows before offsets. These options also work for areas with `orient="y"`
and horizontal bars. Tooltips and keyboard text show both share and raw value
for fill; bar labels show shares. Streams report raw values. Legend toggles,
facets, subplots, zoom, streaming, and static export use the core engine's stack.
Wiggle and inside-out recompute over the retained window; inside-out updates
and areas along y display changed values immediately.

## Live data

Mark components render nothing and do not create one component per data
point, and data updates do not go through Vue. Keep the table out of deep
reactive state (a plain `const`, a `shallowRef`, or `markRaw`) and change it
directly; the chart re-renders on the next animation frame, coalescing any
number of changes:

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const data = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => data.appendRow({ time: Date.now(), cpu: readCpu() }), 100);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <Chart>
    <Line :data="data" x="time" y="cpu" />
  </Chart>
</template>
```

Tables keep private fields, which Vue's deep proxies cannot reach. The
chart unwraps a table it receives through `ref()` or `reactive()`, but
methods such as `appendRow` fail when called on the proxy.

Props are the whole configuration: removing a prop restores its default.
They are compared on each render of the chart, and when neither the options
nor any mark's spec or table changed, the chart is left alone, so inline
option objects are fine. Functions in options (tick generators, formatters)
are compared by identity: a function made anew on each render updates the
chart, so define it once in `<script setup>`. Arrays and objects are copied as the chart reads
them, so changing reactive state in place (`fields.push("p99")`) updates the
chart as replacing it would. Changes are applied once Vue has patched the
DOM, before the parent's `onUpdated` hooks run. Invalid props, such as a
field the table does not have, are reported to Vue's error handler from
those hooks; the chart keeps showing its last valid state until they are
fixed.

A custom mark's `draw` runs while the chart draws, outside Vue's dependency
tracking. Read the reactive values it needs outside the function, for
example in a `computed` that returns it, so that a change re-renders the
chart:

```ts
const draw = computed(() => {
  const label = selected.value;
  return ({ text, x, y }: DrawContext) => text(x(1), y(2), label);
});
```

`<Point3D>`, `<Line3D>`, and `<Surface>` accept `panel` to share a 3D
subplot beside panels with other marks. Pass `panels(...)` from `herceg`
to the chart, with a `camera` on each panel to override chart defaults.
Each 3D subplot has its own camera, toolbar, orbit gestures, and keyboard
turning; the description and exports show each panel's view. The chart
handle's `getCamera({ panel: "cloud" })` and
`setCamera({ azimuth: 40 }, { panel: "cloud" })` target it; a null camera
resets that panel. `@camera` receives `{ camera, panels: [id] }` for a
subplot, or `{ camera }` for a standalone chart. Re-rendering with the
same configured cameras preserves user turns. Subplots use CPU rendering
with cached geometry and Canvas pixels; standalone charts retain WebGL
points, lines, and surfaces. 3D facets are refused.
