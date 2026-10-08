# @herceg/svelte

Svelte 5 components for [herceg](../herceg/README.md) charts.

```svelte
<script lang="ts">
  import { Chart, Line, Rule } from "@herceg/svelte";
  import { table, time } from "herceg";

  const metrics = table({ time: time(timestamps), p50, p99 });
</script>

<Chart title="Request latency" y={{ label: "ms" }} interaction={{ zoom: true }}>
  <Line data={metrics} x="time" y={["p50", "p99"]} />
  <Rule y={250} label="SLO" />
</Chart>
```

`<Chart>` accepts every chart option as a prop (`title`, `x`, `y`, `legend`,
`tooltip`, `interaction`, `renderer`, `theme`, `width`, `height`, ...). Its
children are mark components: `<Line>`, `<Area>`, `<Bar>`, `<Point>`,
`<Heatmap>`, `<ErrorBar>`, `<Candlestick>`, `<Histogram>`, `<Pie>`, `<BoxPlot>`, `<Violin>`, `<Treemap>`, `<Sunburst>`, `<Gauge>`, `<Funnel>`, `<Radar>`, `<Rule>`,
`<Region>`, `<Text>`, and `<Custom>`, written directly, in `{#if}` and
`{#each}` blocks, or in components of your own, and drawn in template order.
Each mark component takes the table it reads as `data`, so svelte-check
checks field names against that table's columns. Annotations (`<Rule>`,
`<Region>`, `<Text>`) take `data` only when they draw one item per row:
`<Rule data={deploys} x="time" text="version" />`. Marks built with herceg's
functions can also be passed as a `marks` prop.

The chart fills its container's width and is 320 px tall unless `width`,
`height`, or `style` says otherwise; `class` and `style` go to the container
element. Chart events are callback props: `onviewport`, `onselect`,
`onhover`, and `onclick`. The chart listens only while a handler is given
and calls the current one, so passing a new function does not resubscribe.
`bind:chart` gives the underlying chart (null until mounted) for imperative
calls (`setViewport`, `select`, `toSVG`):

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
