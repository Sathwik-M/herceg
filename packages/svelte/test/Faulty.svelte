<!-- A line over a field the test may name wrongly, optionally inside a boundary. -->
<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    field,
    bounded = false,
    onerror,
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    field: string;
    bounded?: boolean;
    onerror?: (error: unknown) => void;
  } = $props();
</script>

{#snippet chart()}
  <Chart>
    <Line {data} x="t" y={field as "a"} />
  </Chart>
{/snippet}

{#if bounded}
  <svelte:boundary {onerror}>
    {@render chart()}
    {#snippet failed(_, reset)}
      <button onclick={reset}>retry</button>
    {/snippet}
  </svelte:boundary>
{:else}
  {@render chart()}
{/if}
