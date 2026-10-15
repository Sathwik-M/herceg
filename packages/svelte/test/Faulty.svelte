<!-- A line over a field the test may name wrongly: shown in the chart's place, or inside a boundary, thrown. -->
<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    field,
    bounded = false,
    onerror,
    heard,
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    field: string;
    bounded?: boolean;
    onerror?: (error: unknown) => void;
    heard?: (error: { code: string }) => void;
  } = $props();
</script>

{#snippet chart()}
  <Chart errorMode={bounded ? "throw" : "inline"} onerror={heard}>
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
