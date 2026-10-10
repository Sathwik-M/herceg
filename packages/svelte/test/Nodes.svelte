<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Chart, Graph, Treemap } from "../src/index.js";

  let {
    sales,
    talks,
    chart = $bindable(null),
    ondrill,
    onitemmove,
  }: {
    sales?: Table<{ region: "category"; country: "category"; v: "number" }>;
    talks?: Table<{ from: "category"; to: "category" }>;
    chart?: HercegChart | null;
    ondrill?: (event: { key: string | null }) => void;
    onitemmove?: (event: { position: unknown }) => void;
  } = $props();
</script>

{#if sales}
  <Chart bind:chart interaction={{ zoom: true }} {ondrill}>
    <Treemap data={sales} path={["region", "country"]} value="v" />
  </Chart>
{:else if talks}
  <Chart bind:chart interaction={{ drag: true }} {onitemmove}>
    <Graph data={talks} source="from" target="to" />
  </Chart>
{/if}
