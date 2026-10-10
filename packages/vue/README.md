# @herceg/vue

Vue 3 components for [herceg](../herceg/README.md) charts.

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

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`tooltip`, `interaction`, `renderer`, `theme`, `width`, `height`, ...). Its
slot holds mark components: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`,
`<BoxPlot>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`,
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
drilled into a node), `@item-move` (a network's node moved), `@visibility` (series hidden or shown),
`@render` (a frame of the data drawn, for overlays, the first one as the chart mounts), `@row-selection` (a channel of
the chart's `rowSelection` changed), and `@click` (the chart's click, with the
data under the pointer, not the element's). A `:row-selection` binding made again,
or kept in reactive state, is the same while it binds the same stores and channels. A template ref exposes the underlying chart,
herceg's `Chart`, as `chart` (null until mounted) for imperative calls (`setViewport`,
`select`, `toPixel`, `setVisibility`, `toSVG`):

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
option objects are fine. Arrays and objects are copied as the chart reads
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
