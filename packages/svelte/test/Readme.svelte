<!-- The README's examples, checked by `npm run typecheck` so the docs stay true. -->
<script lang="ts" module>
  declare const timestamps: Float64Array;
  declare const p50: Float64Array;
  declare const p99: Float64Array;
  declare function readCpu(): number;
</script>

<script lang="ts">
  import { type Chart as HercegChart, table, time } from "herceg";
  import { onMount } from "svelte";
  import { Chart, Custom, Line, Region, Rule, Text } from "../src/index.js";

  let { selected }: { selected: string } = $props();

  const metrics = table({ time: time(timestamps), p50, p99 });
  const deploys = table({ at: time([Date.now()]), version: ["v2"] });

  let chart = $state<HercegChart | null>(null);
  let range = $state<readonly [number, number] | null>(null);
  export const exportSvg = () => chart?.toSVG();

  const data = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
  onMount(() => {
    const timer = setInterval(() => data.appendRow({ time: Date.now(), cpu: readCpu() }), 100);
    return () => clearInterval(timer);
  });
</script>

<Chart title="Request latency" y={{ title: "ms" }} interaction={{ zoom: true }}>
  <Line data={metrics} x="time" y={["p50", "p99"]} />
  <Rule y={250} label="SLO" />
</Chart>

<Chart bind:chart interaction={{ brush: "x" }} onselect={({ x }) => (range = x)}>
  <Line data={metrics} x="time" y="p50" />
</Chart>

<Chart>
  <Region x1={new Date(0)} x2={new Date()} label="window" />
  <Line data={metrics} x="time" y="p50" />
  <Rule data={deploys} x="at" textField="version" />
  <Text x={Date.now()} y={100} label="now" anchor="end" />
  <Text data={deploys} x="at" y={120} textField="version" />
  {#key selected}
    <Custom draw={({ text, x, y }) => text(x(1), y(2), selected)} />
  {/key}
</Chart>

<Chart>
  <Line {data} x="time" y="cpu" />
</Chart>
