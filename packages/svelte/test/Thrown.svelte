<!-- A chart made to throw, inside a boundary: what fails later is thrown there too. -->
<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    onerror,
  }: {
    data: Table<{ t: "number"; v: "number"; kind: "category"; g: "category" }>;
    onerror: (error: unknown) => void;
  } = $props();
</script>

<svelte:boundary {onerror}>
  <Chart errorMode="throw" height={200}>
    <Line {data} x="t" y="v" series="g" color="kind" />
  </Chart>
  {#snippet failed(error)}
    <p>{String(error)}</p>
  {/snippet}
</svelte:boundary>
