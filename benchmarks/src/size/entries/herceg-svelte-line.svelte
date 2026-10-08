<script lang="ts">
  import { Chart, Line } from "@herceg/svelte";
  import { table, time } from "herceg";

  let { x, y }: { x: Float64Array; y: Float64Array } = $props();
  const data = $derived(table({ t: time(x), v: y }));
</script>

<Chart>
  <Line {data} x="t" y="v" />
</Chart>
