<!-- A chart whose options, marks, and handlers the tests change through props. -->
<script lang="ts">
  import type { ChartListener, ChartMark, DrawContext, Chart as HercegChart, Table } from "herceg";
  import { Chart, Custom, Line, Region, Rule } from "../src/index.js";
  import Pair from "./Pair.svelte";

  let {
    data,
    fields = ["a"],
    band = false,
    pair = false,
    limit,
    draw,
    marks,
    options = {},
    chart = $bindable(null),
    onselect,
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    fields?: ("a" | "b")[];
    band?: boolean;
    pair?: boolean;
    limit?: number;
    draw?: (context: DrawContext) => void;
    marks?: readonly ChartMark[];
    options?: Record<string, unknown>;
    chart?: HercegChart | null;
    onselect?: ChartListener<"select"> | undefined;
  } = $props();
</script>

<Chart bind:chart {marks} {onselect} {...options}>
  {#if band}
    <Region y1={1} y2={2} />
  {/if}
  {#each fields as field (field)}
    <Line {data} x="t" y={field} />
  {/each}
  {#if pair}
    <Pair {data} />
  {/if}
  {#if limit !== undefined}
    <Rule y={limit} label="limit" />
  {/if}
  {#if draw}
    <Custom {draw} />
  {/if}
</Chart>
