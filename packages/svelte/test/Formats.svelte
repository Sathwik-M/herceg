<!-- A chart whose y axis writes its tick labels with `format`, a function. -->
<script lang="ts">
  import type { Chart as HercegChart, Table, ValueFormatter } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    format,
    chart = $bindable(null),
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    format: ValueFormatter;
    chart?: HercegChart | null;
  } = $props();
</script>

<Chart bind:chart y={{ format }}>
  <Line {data} x="t" y="a" />
</Chart>
