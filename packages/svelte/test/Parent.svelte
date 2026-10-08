<!-- Records what the chart shows when the parent's effects run. -->
<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    title,
    record,
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    title: string;
    record: (shown: string) => void;
  } = $props();
  let chart = $state<HercegChart | null>(null);

  $effect(() => {
    record(chart?.toSVG().includes(title) ? title : "stale");
  });
</script>

<Chart bind:chart {title}>
  <Line {data} x="t" y="a" />
</Chart>
